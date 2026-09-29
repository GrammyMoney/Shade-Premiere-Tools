/*
 * Turns "something changed" into one scan and one sync.
 *
 * Debounced, because Premiere's only signal is ProjectEvent.DIRTY and it
 * fires constantly while someone edits. The wait lets a burst of changes
 * settle into one walk; a walk itself is ~24ms.
 *
 * This debounce is a timer, and Premiere throttles timers hard when it is
 * idle or in the background: measured at up to 29 minutes for a nominal 10
 * seconds. So Shade becomes right eventually, not promptly. Nothing may
 * assume otherwise -- and nobody is editing a backgrounded Premiere.
 */

const { log } = require("./log.js");
const { scanProject } = require("./scan.js");
const sync = require("./sync.js");

const DEBOUNCE_MS = 3000;

/*
 * A short wait rather than none: IMPORT_MEDIA_COMPLETE fires before the
 * imported item is queryable (measured 100-217ms later), and scanning
 * immediately reliably finds nothing.
 */
const SETTLE_MS = 400;

/*
 * ...but 400ms is not always enough. Measured on first load: a scan 400ms
 * after IMPORT_MEDIA_COMPLETE found 0 files, and the clip was only picked up
 * 10s later by an unrelated event. So an import also gets one follow-up.
 */
const IMPORT_FOLLOWUP_MS = 2500;

/*
 * A .prproj on a Shade drive is indexed by Shade seconds after it is saved
 * (measured: 3s and 18s after the pass that looked for it), and without an
 * edit there would be no later pass to link it. So retry on our own, a few
 * times, then give up until the next event.
 */
const PROJECT_FILE_RETRY_MS = 20000;
const PROJECT_FILE_RETRIES = 6;

let ppro = null;
let onProjectSeen = null;
let hasKey = async () => false;
let timer = null;
let running = false;
let rerun = null;
let followTimer = null;      // one-off follow-ups; separate from the debounce
let fileRetries = 0;
let lastGuid = null;
let lastNotTracked = null;

const NOT_TRACKED = {
  unsaved: "not saved yet -- save it to a Shade drive to track it",
  local: "the project file is not on a Shade drive",
  waiting: "its drive is not recognised as Shade yet"
};

const state = {
  lastRunAt: null, lastScan: null, lastSummary: null, lastError: null,
  runs: 0, project: null
};

function init(pproModule, opts = {}) {
  ppro = pproModule;
  onProjectSeen = opts.onProjectSeen || null;
  hasKey = opts.hasKey || hasKey;
}

function schedule(reason, ms) {
  if (running) { rerun = reason; return; }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; run(reason); }, ms);
}

/* Repeated calls inside the window collapse into one. */
const request = (reason) => schedule(reason, DEBOUNCE_MS);

/* For deliberate actions: the editor should not wait three seconds. */
const requestNow = (reason) => schedule(reason, SETTLE_MS);

/*
 * A pass at a set time, whatever else happens. Not the debounce timer: a
 * stream of DIRTY events must not push this back indefinitely.
 */
function followUp(reason, ms) {
  if (followTimer) clearTimeout(followTimer);
  followTimer = setTimeout(() => { followTimer = null; requestNow(reason); }, ms);
}

function afterImport() {
  requestNow("import");
  followUp("import_followup", IMPORT_FOLLOWUP_MS);
}

async function run(reason) {
  if (!ppro) return;
  running = true;
  try {
    if (!(await hasKey())) {
      state.lastError = "no API key";
      return;
    }
    const project = await ppro.Project.getActiveProject();
    if (!project) { state.project = null; return; }

    const scan = await scanProject(ppro, project);
    if (!scan || !scan.guid) { log("scan produced nothing usable"); return; }
    state.project = scan.name;
    if (scan.guid !== lastGuid) { lastGuid = scan.guid; fileRetries = 0; }
    if (onProjectSeen) {
      try { onProjectSeen(scan.guid); } catch (e) { /* never break a run */ }
    }

    const summary = await sync.run(scan);
    state.lastScan = scan.timing;
    state.lastSummary = summary;
    state.lastRunAt = Date.now();
    state.lastError = summary.problems.length ? summary.problems[0] : null;
    state.runs++;

    if (summary.projectFileWaiting && fileRetries < PROJECT_FILE_RETRIES) {
      fileRetries++;
      followUp("project_file", PROJECT_FILE_RETRY_MS);
    } else if (!summary.projectFileWaiting) {
      fileRetries = 0;
    }

    if (summary.notTracked) {
      // Logged once per project and reason, not on every DIRTY.
      const note = scan.guid + ":" + summary.notTracked;
      if (note !== lastNotTracked) {
        lastNotTracked = note;
        log(`not tracking "${scan.name}": ${NOT_TRACKED[summary.notTracked]}`);
      }
      return;
    }
    lastNotTracked = null;

    log(`sync (${reason}) "${scan.name}": ${scan.timing.files} files, ` +
        `${summary.onShade} on Shade, ${summary.written} written` + sync.describeChanges(summary) + ", " +
        `${summary.skipped} not on Shade, walk ${scan.timing.ms}ms` +
        (summary.projectFileWaiting ? `, project file not indexed yet (retry ${fileRetries}/${PROJECT_FILE_RETRIES})` : "") +
        (summary.problems.length ? ` -- ${summary.problems.join("; ")}` : ""));
  } catch (e) {
    // A failed pass loses nothing: the next DIRTY scans the whole project
    // again, and anything not recorded as written is simply tried again.
    state.lastError = e.message;
    log(`sync failed (${reason}):`, e.message);
  } finally {
    running = false;
    if (rerun) { const r = rerun; rerun = null; request(r); }
  }
}

function status() {
  return { ...state, pending: !!timer, running };
}

const notTrackedText = (reason) => NOT_TRACKED[reason] || null;

module.exports = { init, request, requestNow, afterImport, status, notTrackedText };
