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

let ppro = null;
let onProjectSeen = null;
let hasKey = async () => false;
let timer = null;
let running = false;
let rerun = null;

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
    if (onProjectSeen) {
      try { onProjectSeen(scan.guid); } catch (e) { /* never break a run */ }
    }

    const summary = await sync.run(scan);
    state.lastScan = scan.timing;
    state.lastSummary = summary;
    state.lastRunAt = Date.now();
    state.lastError = summary.problems.length ? summary.problems[0] : null;
    state.runs++;

    log(`sync (${reason}) "${scan.name}": ${scan.timing.files} files, ` +
        `${summary.onShade} on Shade, ${summary.written} written, ` +
        `${summary.skipped} not on Shade, walk ${scan.timing.ms}ms` +
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

module.exports = { init, request, requestNow, status };
