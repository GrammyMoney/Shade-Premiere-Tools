/*
 * Shade Linker -- plugin entry point.
 *
 * Module scope runs at Premiere launch, with no panel open (proven in
 * premiere-events: an installed plugin loaded at launch and ran 10+ hours,
 * and kept running after its panel was closed). So the panel is a status
 * window, the Settings tab (which features run: settings.js) and the place
 * to enter the API key -- nothing else depends on it being open.
 * Its create/show/hide/destroy hooks say nothing about visibility and are
 * not used to decide anything.
 */

/*
 * Requires are guarded and reported. A require that throws at module scope
 * aborts the file silently: no log, no panel, nothing to debug against.
 */
let log, attach, recent, dataFolderPath, shade, settings, enable, link, projectpins, uxp, entrypoints;
let loadError = null;
try {
  ({ log, attach, recent, dataFolderPath } = require("./log.js"));
  shade = require("./shade.js");
  settings = require("./settings.js");
  link = require("./link.js");
  projectpins = require("./projectpins.js");
  enable = require("./enable.js");
  uxp = require("uxp");
  ({ entrypoints } = uxp);
} catch (e) {
  loadError = e;
  // eslint-disable-next-line no-console
  console.error("Shade Linker failed to load a module:", e && (e.stack || e.message));
}

let ppro = null;
try { ppro = require("premierepro"); } catch (e) { /* reported in boot() */ }

/* ---------------------------------------------------------------- the key */

/*
 * The user's own sk_ key, in UXP's secure storage (the OS keychain). It has
 * every permission its owner has, so it never touches a plain file or a log
 * line.
 */
const KEY_ITEM = "shadeApiKey";
let cachedKey = null;

async function getKey() {
  if (cachedKey) return cachedKey;
  try {
    const raw = await uxp.storage.secureStorage.getItem(KEY_ITEM);
    if (!raw) return null;
    // getItem returns bytes. The key is ASCII, so this is exact.
    cachedKey = typeof raw === "string" ? raw : String.fromCharCode.apply(null, Array.from(raw));
    return cachedKey || null;
  } catch (e) {
    return null;
  }
}

async function setKey(value) {
  const key = String(value || "").trim();
  if (!/^sk_\S+$/.test(key)) throw new Error("that does not look like a Shade key (sk_...)");
  await uxp.storage.secureStorage.setItem(KEY_ITEM, key);
  cachedKey = key;
  link.forget();
}

/* ----------------------------------------------------------------- events */

const bound = [];
let dirtyBoundTo = null;

function bind(label, register) {
  try { register(); bound.push(label); return true; }
  catch (e) { log(`could not bind ${label}: ${e.message}`); return false; }
}

/*
 * Measured on 26.5.1, and silent when wrong:
 *  - constants live under ppro.Constants and are dotted strings; any string
 *    registers cleanly, so a guessed name "works" and never fires;
 *  - ProjectEvent.DIRTY never arrives on a global listener -- it has to be
 *    bound to the Project itself, and re-bound when the project changes;
 *  - SequenceEvent.SELECTION_CHANGED fires constantly and tells us nothing.
 */
function wireGlobalEvents() {
  const em = ppro.EventManager;
  if (!em || typeof em.addGlobalEventListener !== "function") {
    log("EventManager unavailable; nothing is linked or pinned automatically");
    return;
  }
  const C = ppro.Constants || {};
  const PE = C.ProjectEvent || {};
  const OE = C.OperationCompleteEvent || {};

  // Opening a project seeds linking (what is already there is left alone),
  // asks once whether to pin its Shade media, and, with linking on, checks
  // its drive for the link fields. Each is a no-op when switched off.
  const onOpened = () => {
    bindDirtyToActiveProject();
    link.seed(ppro);
    projectpins.offerSoon(ppro);
    enable.onProjectOpened();
  };

  const wire = (label, name, handler) => {
    if (!name) { log(`skipped ${label}: no such constant in this Premiere`); return; }
    bind(label, () => em.addGlobalEventListener(name, handler, false));
  };

  wire("ProjectEvent.OPENED", PE.OPENED, onOpened);
  wire("ProjectEvent.ACTIVATED", PE.ACTIVATED, onOpened);
  wire("ProjectEvent.CLOSED", PE.CLOSED, (event) => projectpins.onClosed(event));
  wire("OperationCompleteEvent.IMPORT_MEDIA_COMPLETE", OE.IMPORT_MEDIA_COMPLETE, () => {
    bindDirtyToActiveProject();
    link.onImport(ppro);
  });

  log(`bound ${bound.length} global event(s): ${bound.join(", ") || "none"}`);
}

/*
 * Linking's backstop for imports the import event missed, and the walk that
 * finds clips newly put on a timeline (pinWhen "timeline"). Debounced, on a
 * timer Premiere may throttle when idle -- fine, since the import event is
 * the fast path.
 */
const LINK_SETTLE_MS = 2000;
let linkTimer = null;
function onDirty() {
  clearTimeout(linkTimer);
  linkTimer = setTimeout(() => link.onDirty(ppro), LINK_SETTLE_MS);
}

async function bindDirtyToActiveProject() {
  const em = ppro.EventManager;
  const PE = (ppro.Constants || {}).ProjectEvent || {};
  if (!em || typeof em.addEventListener !== "function" || !PE.DIRTY) return;
  try {
    const project = await ppro.Project.getActiveProject();
    if (!project) return;
    const guid = String(await project.guid);
    if (guid === dirtyBoundTo) return;
    em.addEventListener(project, PE.DIRTY, onDirty, false);
    dirtyBoundTo = guid;
    log(`DIRTY bound to "${await project.name}"`);
  } catch (e) {
    log("could not bind DIRTY:", e.message);
  }
}

/* -------------------------------------------------------------- lifecycle */

async function boot() {
  if (loadError) return;
  log(`Shade Linker starting (premierepro: ${ppro ? "ok" : "UNAVAILABLE"})`);
  log("data folder:", await dataFolderPath());
  if (!ppro) return;

  shade.setKeyProvider(getKey);
  await settings.load();
  // Files pinned on import belong to their project, so its unpin covers them.
  link.setOnPinned(projectpins.remember);
  link.setOnNeedsSetup((driveId) => enable.onNeedsSetup(driveId));
  enable.init(ppro, { hasKey: async () => !!(await getKey()) });

  wireGlobalEvents();
  await bindDirtyToActiveProject();

  if (!(await getKey()) && settings.get("linking")) {
    log("no API key yet: add one in the Shade Linker panel's Settings tab");
  }
  // Whatever is already open is seen now, so only what arrives later is
  // linked or pinned; there will be no DIRTY until someone touches it.
  link.seed(ppro);
  projectpins.offerSoon(ppro);
  enable.onProjectOpened();
}

/* ------------------------------------------------------------------ panel */

let wired = false;
let renderTimer = null;
// The key field is open because the user asked to change the key. render()
// runs every second and would otherwise close it again straight away,
// since a key is already saved (reported 2026-09-29: it showed for half a
// second and vanished).
let editingKey = false;


/*
 * Auto-pinning is one picker, Off / on import / when used in a timeline,
 * over two settings: autoPin (whether) and pinWhen (when). Off keeps
 * pinWhen, so switching back on returns to the same choice.
 */
const PIN_MODES = ["off", "import", "timeline"];
const pinModeOf = (on) => (on.autoPin ? on.pinWhen : "off");
async function setPinMode(mode) {
  if (!PIN_MODES.includes(mode)) throw new Error(`"${mode}" is not a choice for auto-pinning`);
  if (mode !== "off") await settings.set("pinWhen", mode);
  await settings.set("autoPin", mode !== "off");
}
const PIN_ABOUT = {
  off: "Nothing is pinned or unpinned, and nothing is asked.",
  import: "Offers to pin a project's Shade media when it opens and to unpin it when it closes; new clips are pinned as they are imported.",
  timeline: "Offers to pin a project's timeline media when it opens and to unpin it when it closes; new clips are pinned when first placed in a timeline, not on import."
};
let toggling = false;         // a switch-on check is in flight; don't redraw the boxes

function wirePanel() {
  if (wired) return;
  const lamp = document.getElementById("lamp");
  if (!lamp) return;
  wired = true;

  const $ = (id) => document.getElementById(id);
  const set = (id, text, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    if (cls !== undefined) el.className = cls;
  };
  const note = (text) => set("note", text || "");

  if (loadError) {
    set("state", "plugin failed to load", "state bad");
    lamp.className = "lamp bad";
    note((loadError.stack || loadError.message || "").slice(0, 400));
    return;
  }

  async function render() {
    const key = await getKey();
    const on = settings.get();
    const ls = link.status();
    const ps = projectpins.status();
    $("keyrow").style.display = !key || editingKey ? "flex" : "none";
    $("changekey").style.display = key ? "block" : "none";
    set("changekey", editingKey ? "cancel" : "change API key");
    if (!toggling) $("set-linking").checked = !!on.linking;
    renderPicker("pinMode", pinModeOf(on));
    set("pinModeAbout", PIN_ABOUT[pinModeOf(on)]);

    // Only what is switched on is shown. Pinning needs no key; linking does.
    const show = (id, yes, how) => { $(id).style.display = yes ? (how || "block") : "none"; };
    show("g-linking", on.linking, "flex");
    show("g-autopin", on.autoPin, "flex");
    show("pinactions", on.autoPin, "flex");

    let bad = null;
    if (!ppro) bad = "premierepro unavailable";
    else if (!key && on.linking) bad = "add your Shade API key in Settings";
    else if ((on.linking || on.autoPin) && ls.lastError) bad = ls.lastError;
    else if (on.autoPin && ps.lastError) bad = ps.lastError;

    lamp.className = "lamp " + (bad ? "bad" : "ok");
    const idle = on.linking && on.autoPin ? "linking · pinning"
               : on.linking ? "linking" : on.autoPin ? "pinning" : "all features off";
    set("state", bad || idle, "state" + (bad ? " bad" : ""));

    const num = (id, v) => set(id, v === undefined || v === null ? "—" : String(v),
                               "v" + (v ? "" : " zero"));
    num("n-mounts", ls.mounts);
    num("n-linked", ls.linked);
    num("n-pinned", ls.pinned + ps.pinned);
    num("n-failed", ls.failed);

    set("meta", ls.last && ls.lastAt
      ? `last: ${ls.last} at ${new Date(ls.lastAt).toTimeString().slice(0, 8)}`
      : "nothing new this session");
  }

  const on = (id, fn) => {
    const el = $(id);
    if (el) el.onclick = () => Promise.resolve().then(fn).catch((e) => note(e.message));
  };

  // Tabs.
  const showTab = (name) => {
    for (const t of ["status", "settings"]) {
      $("tab-" + t).className = "tab" + (t === name ? " on" : "");
      $("view-" + t).style.display = t === name ? "block" : "none";
    }
  };
  on("tab-status", () => showTab("status"));
  on("tab-settings", () => showTab("settings"));

  // The linking switch. Turning it on checks the active project's drive
  // first and may ask to add fields (enable.js); it can come back off, and
  // the note says why.
  // A property, not addEventListener: the panel can be wired again after
  // destroy(), and a second listener would run every switch twice.
  $("set-linking").onchange = (e) => {
    const want = !!(e.target && e.target.checked);
    toggling = true;
    Promise.resolve()
      .then(async () => {
        await settings.set("linking", want);
        if (!want) return note(`${enable.LABEL} is off`);
        note("checking the drive…");
        note(await enable.switchOn());
      })
      .catch((err) => note(err.message))
      .then(() => { toggling = false; render(); });
  };

  on("savekey", async () => {
    const input = $("key");
    await setKey(input.value);
    input.value = "";
    editingKey = false;
    note("checking key…");
    const workspaces = await shade.listWorkspaces();
    note(`key saved · sees ${workspaces.length} workspace(s)`);
    render();
  });

  on("changekey", () => {
    editingKey = !editingKey;          // the link doubles as "cancel"
    $("key").value = "";
    render();
  });

  on("pinproject", async () => {
    note("counting…");
    note(await projectpins.offerPin(ppro, { always: true }));
  });

  // The auto-pinning picker (Settings): select the item matching the setting.
  function renderPicker(key, value) {
    const picker = $("set-" + key);
    if (!picker) return;
    for (const item of picker.querySelectorAll("sp-menu-item")) {
      if ((item.getAttribute("value") === value) !== item.hasAttribute("selected")) {
        if (item.getAttribute("value") === value) item.setAttribute("selected", "");
        else item.removeAttribute("selected");
      }
    }
  }
  const PICKED = { off: "auto-pinning is off", import: "auto-pinning: on import",
                   timeline: "auto-pinning: when used in a timeline" };
  $("set-pinMode").onchange = (e) => {
    const t = e && e.target;
    const value = (t && t.value) || (t && t.selectedIndex >= 0 && PIN_MODES[t.selectedIndex]);
    setPinMode(value)
      .then(() => { note(PICKED[value]); render(); })
      .catch((err) => note(err.message));
  };

  on("unpinproject", async () => {
    note("checking…");
    note(await projectpins.unpinActive(ppro));
  });

  on("logs", async () => {
    note("…");
    note(await exportLog(recent().join("\n")));
  });

  render();
  clearInterval(renderTimer);
  renderTimer = setInterval(render, 1000);
}

/*
 * No clipboard and no shell in UXP on 26.5.1; a save dialog is the one way
 * to hand the user a file.
 */
async function exportLog(text) {
  try {
    const file = await uxp.storage.localFileSystem.getFileForSaving("shade-linker.log", {
      types: ["log", "txt"]
    });
    if (!file) return "cancelled";
    await file.write(text);
    return `saved ${recent().length} lines`;
  } catch (e) {
    return "log file: " + (await dataFolderPath());
  }
}

if (entrypoints) entrypoints.setup({
  panels: {
    shadeLinkerPanel: {
      create() { wirePanel(); },
      show() { wirePanel(); },
      hide() {},
      destroy() {
        wired = false;
        clearInterval(renderTimer);
        renderTimer = null;
        attach(null);
      }
    }
  }
});

boot();
