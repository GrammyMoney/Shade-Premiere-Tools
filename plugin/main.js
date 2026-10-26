/*
 * Shade Tracker -- plugin entry point.
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
let log, attach, recent, dataFolderPath, shade, resolve, sync, settings, enable, tracker, link, projectpins, exporter, comments, uxp, entrypoints;
let loadError = null;
try {
  ({ log, attach, recent, dataFolderPath } = require("./log.js"));
  shade = require("./shade.js");
  resolve = require("./resolve.js");
  sync = require("./sync.js");
  settings = require("./settings.js");
  tracker = require("./tracker.js");
  link = require("./link.js");
  projectpins = require("./projectpins.js");
  enable = require("./enable.js");
  exporter = require("./export.js");
  comments = require("./comments.js");
  uxp = require("uxp");
  ({ entrypoints } = uxp);
} catch (e) {
  loadError = e;
  // eslint-disable-next-line no-console
  console.error("Shade Tracker failed to load a module:", e && (e.stack || e.message));
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
  resolve.forget();
  sync.forget();
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
    log("EventManager unavailable; syncing is manual only");
    return;
  }
  const C = ppro.Constants || {};
  const PE = C.ProjectEvent || {};
  const SE = C.SequenceEvent || {};
  const OE = C.OperationCompleteEvent || {};

  // Opening a project seeds linking (what is already there is left alone),
  // asks once whether to pin its Shade media, and checks its drive for the
  // fields of whatever features are on. Each is a no-op when switched off.
  const onOpened = () => {
    bindDirtyToActiveProject();
    tracker.requestNow("project_opened");
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
    tracker.afterImport();
    link.onImport(ppro);
  });
  wire("SequenceEvent.ACTIVATED", SE.ACTIVATED, () => tracker.request("sequence_activated"));

  log(`bound ${bound.length} global event(s): ${bound.join(", ") || "none"}`);
}

/*
 * Linking's backstop for imports the import event missed. Its own settle
 * time, separate from tracking's debounce, and like it a timer that Premiere
 * may throttle when idle -- fine, since the import event is the fast path.
 */
const LINK_SETTLE_MS = 2000;
let linkTimer = null;
function onDirty() {
  tracker.request("dirty");
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
  log(`Shade Tracker starting (premierepro: ${ppro ? "ok" : "UNAVAILABLE"})`);
  log("data folder:", await dataFolderPath());
  if (!ppro) return;

  shade.setKeyProvider(getKey);
  await settings.load();
  // Files pinned on import belong to their project, so its unpin covers them.
  link.setOnPinned(projectpins.remember);
  // Shade Desktop knows which drive it mounted where; tracking asks it before
  // matching volume names, which go stale when a drive is renamed.
  resolve.setMountSource(() => require("./shadefs.js").mounts());

  // Every run reports which project it saw, so a switch that arrived without
  // an OPENED event still moves DIRTY to the right project.
  tracker.init(ppro, {
    hasKey: async () => !!(await getKey()),
    onProjectSeen: (guid) => { if (guid !== dirtyBoundTo) bindDirtyToActiveProject(); },
    onNeedsSetup: (driveId) => enable.onNeedsSetup("tracking", driveId),
    onOtherDrives: (others, scan) => enable.warnOtherDrives(others, scan)
  });
  link.setOnNeedsSetup((driveId) => enable.onNeedsSetup("linking", driveId));
  enable.init(ppro, { hasKey: async () => !!(await getKey()) });
  exporter.init(ppro, { hasKey: async () => !!(await getKey()) });
  comments.init(ppro, { hasKey: async () => !!(await getKey()) });
  // Shade comments on clips just imported, after linking and pinning.
  link.setOnAfterImport((clips) => comments.onImported(clips));

  wireGlobalEvents();
  await bindDirtyToActiveProject();

  if (!(await getKey()) && (settings.get("tracking") || settings.get("linking"))) {
    log("no API key yet: add one in the Shade Tracker panel's Settings tab");
  }
  // Whatever is already open is unknown until it is scanned, and there will
  // be no DIRTY until someone touches it.
  tracker.requestNow("startup");
  link.seed(ppro);
  projectpins.offerSoon(ppro);
  enable.onProjectOpened();
}

/* ------------------------------------------------------------------ panel */

let wired = false;
let renderTimer = null;
let shownWhy = null;         // the not-tracking reason currently in the note
// The key field is open because the user asked to change the key. render()
// runs every second and would otherwise close it again straight away,
// since a key is already saved (reported 2026-09-29: it showed for half a
// second and vanished).
let editingKey = false;

const FEATURES = ["autoPin", "tracking", "linking"];
const FEATURE_LABEL = { autoPin: "auto-pinning", tracking: "project tracking", linking: "proxy linking" };
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
    const st = tracker.status();
    const key = await getKey();
    const on = settings.get();
    $("keyrow").style.display = !key || editingKey ? "flex" : "none";
    $("changekey").style.display = key ? "block" : "none";
    set("changekey", editingKey ? "cancel" : "change API key");
    if (!toggling) for (const f of FEATURES) $("set-" + f).checked = !!on[f];
    renderPicker(on.sourceComments);

    const ex = exporter.status();
    $("export").className = "export" + (ex.busy ? " busy" : "");
    set("export", ex.busy ? "Exporting…" : "Export to Shade");
    if (ex.text) set("exportnote", ex.text);

    // Only what is switched on is shown. Pinning needs no key; tracking
    // and linking do.
    const show = (id, yes, how) => { $(id).style.display = yes ? (how || "block") : "none"; };
    show("g-tracking", on.tracking);
    show("g-linking", on.linking, "flex");
    show("g-autopin", on.autoPin, "flex");
    show("sync", on.tracking);
    show("pinactions", on.autoPin, "flex");

    const needs = on.tracking ? ((st.lastSummary && st.lastSummary.needsSetup) || []) : [];
    let bad = null;
    if (!ppro) bad = "premierepro unavailable";
    else if (!key && (on.tracking || on.linking)) bad = "add your Shade API key in Settings";
    else if (needs.length) bad = `"${resolve.driveName(needs[0])}" isn't set up`;
    else if (on.tracking && st.lastError) bad = st.lastError;
    else if (on.linking && link.status().lastError) bad = link.status().lastError;

    // Not tracking a local project is correct behaviour, not a fault: the
    // lamp stays green and the reason is shown in place of "tracking".
    const skip = on.tracking && st.lastSummary && st.lastSummary.status !== "tracked" && st.lastSummary.status;
    lamp.className = "lamp " + (bad ? "bad" : "ok");
    const idle = on.tracking ? (skip ? "not tracking" : "tracking")
               : (on.linking || on.autoPin) ? "on" : "all features off";
    set("state", bad || (st.running ? "syncing…" : idle), "state" + (bad ? " bad" : ""));
    // Shown in the note line, but never over a message from a button.
    const noteEl = $("note");
    const why = !bad && skip ? tracker.notTrackedText(skip) : null;
    if (why && (noteEl.textContent === "" || noteEl.textContent === shownWhy)) {
      note(why);
      shownWhy = why;
    } else if (!why && shownWhy && noteEl.textContent === shownWhy) {
      note("");
      shownWhy = null;
    }

    const s = st.lastSummary;
    const t = st.lastScan;
    const num = (id, v) => set(id, v === undefined || v === null ? "—" : String(v),
                               "v" + (v ? "" : " zero"));
    set("n-project", st.project || "—", "v");
    num("n-files", t ? t.files : null);
    num("n-shade", s ? s.onShade : null);
    num("n-used", t ? t.used : null);
    num("n-written", s ? s.written : null);
    const ls = link.status();
    num("n-linked", ls.linked);
    num("n-pinned", ls.pinned + projectpins.status().pinned);

    if (st.lastRunAt) {
      set("meta", `last sync ${new Date(st.lastRunAt).toTimeString().slice(0, 8)} · ${st.runs} this session`);
    } else {
      set("meta", st.running ? "syncing…" : "not synced yet");
    }
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

  // Feature switches. Turning tracking or linking on checks the active
  // project's drive first and may ask to add fields (enable.js); it can
  // come back off, and the note says why.
  for (const f of FEATURES) {
    // A property, not addEventListener: the panel can be wired again after
    // destroy(), and a second listener would run every switch twice.
    $("set-" + f).onchange = (e) => {
      const want = !!(e.target && e.target.checked);
      toggling = true;
      Promise.resolve()
        .then(async () => {
          await settings.set(f, want);
          if (!want) return note(`${FEATURE_LABEL[f]} is off`);
          if (f === "autoPin") return note("auto-pinning is on");
          note("checking the drive…");
          note(await enable.switchOn(f));
        })
        .catch((err) => note(err.message))
        .then(() => { toggling = false; render(); });
    };
  }

  on("savekey", async () => {
    const input = $("key");
    await setKey(input.value);
    input.value = "";
    editingKey = false;
    note("checking key…");
    const workspaces = await shade.listWorkspaces();
    note(`key saved · sees ${workspaces.length} workspace(s)`);
    tracker.requestNow("key_saved");
    render();
  });

  on("changekey", () => {
    editingKey = !editingKey;          // the link doubles as "cancel"
    $("key").value = "";
    render();
  });

  on("sync", () => {
    bindDirtyToActiveProject();
    tracker.requestNow("manual");
    note("");
  });

  on("pinproject", async () => {
    note("counting…");
    note(await projectpins.offerPin(ppro, { always: true }));
  });

  // The source-comments picker: select the item matching the setting.
  function renderPicker(value) {
    const picker = $("set-sourceComments");
    if (!picker) return;
    for (const item of picker.querySelectorAll("sp-menu-item")) {
      if ((item.getAttribute("value") === value) !== item.hasAttribute("selected")) {
        if (item.getAttribute("value") === value) item.setAttribute("selected", "");
        else item.removeAttribute("selected");
      }
    }
  }
  const picker = $("set-sourceComments");
  if (picker) picker.onchange = (e) => {
    const t = e && e.target;
    const value = (t && t.value) || (t && t.selectedIndex >= 0 && ["ask", "always", "never"][t.selectedIndex]);
    settings.set("sourceComments", value)
      .then(() => note(`comments on imported clips: ${value}`))
      .catch((err) => note(err.message));
  };

  on("export", async () => {
    if (exporter.status().busy) return;
    note("");
    note(await exporter.run());
    render();
  });

  on("importcomments", async () => {
    note("reading comments…");
    note(await comments.importTimeline());
  });

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
    const file = await uxp.storage.localFileSystem.getFileForSaving("shade-tracker.log", {
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
    shadeTrackerPanel: {
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
