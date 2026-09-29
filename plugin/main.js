/*
 * Shade Tracker -- plugin entry point.
 *
 * Module scope runs at Premiere launch, with no panel open (proven in
 * premiere-events: an installed plugin loaded at launch and ran 10+ hours,
 * and kept running after its panel was closed). So the panel is a status
 * window and the place to enter the API key -- nothing else depends on it.
 * Its create/show/hide/destroy hooks say nothing about visibility and are
 * not used to decide anything.
 */

/*
 * Requires are guarded and reported. A require that throws at module scope
 * aborts the file silently: no log, no panel, nothing to debug against.
 */
let log, attach, recent, dataFolderPath, shade, store, resolve, sync, tracker, uxp, entrypoints;
let loadError = null;
try {
  ({ log, attach, recent, dataFolderPath } = require("./log.js"));
  shade = require("./shade.js");
  store = require("./store.js");
  resolve = require("./resolve.js");
  sync = require("./sync.js");
  tracker = require("./tracker.js");
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
  resolve.forgetDrives();
  sync.forgetSchemas();
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

  const onOpened = () => {
    bindDirtyToActiveProject();
    tracker.requestNow("project_opened");
  };

  const wire = (label, name, handler) => {
    if (!name) { log(`skipped ${label}: no such constant in this Premiere`); return; }
    bind(label, () => em.addGlobalEventListener(name, handler, false));
  };

  wire("ProjectEvent.OPENED", PE.OPENED, onOpened);
  wire("ProjectEvent.ACTIVATED", PE.ACTIVATED, onOpened);
  wire("OperationCompleteEvent.IMPORT_MEDIA_COMPLETE", OE.IMPORT_MEDIA_COMPLETE,
       () => tracker.requestNow("import"));
  wire("SequenceEvent.ACTIVATED", SE.ACTIVATED, () => tracker.request("sequence_activated"));

  log(`bound ${bound.length} global event(s): ${bound.join(", ") || "none"}`);
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
    em.addEventListener(project, PE.DIRTY, () => tracker.request("dirty"), false);
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
  await store.load();

  // Every run reports which project it saw, so a switch that arrived without
  // an OPENED event still moves DIRTY to the right project.
  tracker.init(ppro, {
    hasKey: async () => !!(await getKey()),
    onProjectSeen: (guid) => { if (guid !== dirtyBoundTo) bindDirtyToActiveProject(); }
  });

  wireGlobalEvents();
  await bindDirtyToActiveProject();

  if (!(await getKey())) log("no API key yet: open the Shade Tracker panel to add one");
  // Whatever is already open is unknown until it is scanned, and there will
  // be no DIRTY until someone touches it.
  tracker.requestNow("startup");
}

/* ------------------------------------------------------------------ panel */

let wired = false;
let renderTimer = null;

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
    $("keyrow").style.display = key ? "none" : "flex";
    $("changekey").style.display = key ? "block" : "none";

    let bad = null;
    if (!ppro) bad = "premierepro unavailable";
    else if (!key) bad = "add your Shade API key";
    else if (st.lastError) bad = st.lastError;

    lamp.className = "lamp " + (bad ? "bad" : "ok");
    set("state", bad || (st.running ? "syncing…" : "tracking"), "state" + (bad ? " bad" : ""));

    const s = st.lastSummary;
    const t = st.lastScan;
    const num = (id, v) => set(id, v === undefined || v === null ? "—" : String(v),
                               "v" + (v ? "" : " zero"));
    set("n-project", st.project || "—", "v");
    num("n-files", t ? t.files : null);
    num("n-shade", s ? s.onShade : null);
    num("n-used", t ? t.used : null);
    num("n-written", s ? s.written : null);

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

  on("savekey", async () => {
    const input = $("key");
    await setKey(input.value);
    input.value = "";
    note("checking key…");
    const workspaces = await shade.listWorkspaces();
    note(`key saved · sees ${workspaces.length} workspace(s)`);
    tracker.requestNow("key_saved");
    render();
  });

  on("changekey", () => {
    $("keyrow").style.display = "flex";
    $("changekey").style.display = "none";
  });

  on("sync", () => {
    bindDirtyToActiveProject();
    tracker.requestNow("manual");
    note("");
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
