/*
 * Switching tracking or linking on, and the drives they meet later.
 *
 * Both write fields every user of a drive sees, and Shade can only archive a
 * field, never delete one. So before either runs on a drive, the drive is
 * checked (setup.js, check mode), and anything missing is created only after
 * the editor says so in a dialog that lists it. (Decided 2026-10-20; this
 * replaced the panel's inline "set up drive" box.)
 *
 *   toggle on   check the ACTIVE project's drive. Not set up and declined,
 *               a conflict, or no right to add fields: the toggle goes back
 *               off and the editor is told why. No project on Shade open:
 *               it stays on, and the drive is checked when one opens.
 *   later       a project opened on another drive, sync's needsSetup, or
 *               link.js finding no link fields: the same check and dialog,
 *               once per drive per session. Declined: that drive is skipped
 *               for the session and the toggle stays on.
 *
 * Nothing is remembered between sessions: a drive set up since is simply
 * found ready, and a declined one is asked about again next launch.
 *
 * Tracking covers only the drive a project is saved on (decided
 * 2026-10-20). Shade clips from other drives are left untracked, and the
 * editor is told so once per session (warnOtherDrives), not on every pass.
 */

const { log } = require("./log.js");
const settings = require("./settings.js");
const { setup } = require("./setup.js");
const resolve = require("./resolve.js");
const { splitVolume } = require("./paths.js");
const dialog = require("./dialog.js");
const sync = require("./sync.js");
const link = require("./link.js");
const tracker = require("./tracker.js");

const LABEL = { tracking: "project tracking", linking: "proxy linking" };

let warnedOtherDrives = false;
const ready = new Set();      // "<feature>:<driveId>" known to have its fields
const asked = new Set();      // "<feature>:<driveId>" asked about this session
let ppro = null;
let hasKey = async () => false;

function init(pproModule, opts = {}) {
  ppro = pproModule;
  hasKey = opts.hasKey || hasKey;
}

/* The drive the active project's .prproj is on, or null. */
async function activeDrive() {
  try {
    const project = await ppro.Project.getActiveProject();
    const path = project && (await project.path);
    if (!path) return null;
    const r = await resolve.resolveFile(path);
    return r.driveId ? { id: r.driveId, name: resolve.driveName(r.driveId) } : null;
  } catch (e) {
    log(`could not tell which drive the project is on: ${e.message}`);
    return null;
  }
}

const label = (l) => `${l.what}${l.note ? " (" + l.note + ")" : ""}`;

/*
 * Make sure a drive has a feature's fields, asking before creating any.
 * True when it has them (already, or now). `force` asks again even if this
 * session already asked -- the editor just flipped the switch.
 */
async function ensure(feature, drive, { force = false } = {}) {
  const key = feature + ":" + drive.id;
  if (ready.has(key)) return true;
  if (asked.has(key) && !force) return false;
  asked.add(key);

  const { ready: ok, lines } = await setup(drive, { feature, check: true });
  if (ok) { ready.add(key); return true; }

  const conflicts = lines.filter((l) => l.state === "CONFLICT");
  if (conflicts.length) {
    log(`"${drive.name}" can't be set up for ${LABEL[feature]}: ${conflicts.map(label).join("; ")}`);
    await dialog.notify({
      heading: `"${drive.name}" can't be set up for ${LABEL[feature]}`,
      lines: conflicts.map((l) => `${l.what} ${l.note}.`)
    });
    return false;
  }

  const todo = lines.filter((l) => l.state === "missing");
  const yes = await dialog.confirm({
    heading: `Set up "${drive.name}" for ${LABEL[feature]}?`,
    lines: ["This adds to the drive, for everyone who uses it:"]
      .concat(todo.map((l) => "•  " + label(l)))
      .concat([todo.some((l) => /^field|^column|^object/.test(l.what))
        ? "Shade can archive fields later, but not delete them."
        : "Nothing is run: the automation waits for someone to trigger it in Shade."]),
    yes: "Set Up",
    no: "Not Now"
  });
  if (!yes) {
    log(`"${drive.name}": ${LABEL[feature]} setup declined`);
    return false;
  }

  try {
    const done = await setup(drive, { feature });
    log(`set up "${drive.name}" for ${LABEL[feature]}: ` +
        `${done.lines.filter((l) => l.state === "created").length} item(s) created` + (done.ready ? "" : ", NOT ready"));
    if (!done.ready) return false;
  } catch (e) {
    // Adding fields needs rights on the drive an editor may not have. Say
    // who can fix it rather than showing a status code.
    const denied = e.status === 401 || e.status === 403;
    log(`setting up "${drive.name}" failed: ${e.message}`);
    await dialog.notify({
      heading: denied ? `You can't add fields to "${drive.name}"` : `Setting up "${drive.name}" failed`,
      lines: [denied
        ? "Ask a drive owner to turn this on in their Shade Premiere Tools panel, or to run spt setup."
        : e.message]
    });
    return false;
  }
  if (feature === "tracking") sync.forget(); else link.forget();
  ready.add(key);
  return true;
}

/*
 * The Settings toggle was switched on. Returns a line for the panel. Turns
 * the setting back off when the drive could not be made ready.
 */
async function switchOn(feature) {
  if (!(await hasKey())) {
    await settings.set(feature, false);
    return `add your Shade API key before turning on ${LABEL[feature]}`;
  }
  const drive = await activeDrive();
  if (drive) {
    let ok = false;
    try {
      ok = await ensure(feature, drive, { force: true });
    } catch (e) {
      log(`checking "${drive.name}" failed: ${e.message}`);
    }
    if (!ok) {
      await settings.set(feature, false);
      return `${LABEL[feature]} is off: "${drive.name}" isn't set up for it`;
    }
  }
  start(feature);
  return drive ? `${LABEL[feature]} is on for "${drive.name}"`
               : `${LABEL[feature]} is on; a drive is checked when a project on Shade opens`;
}

function start(feature) {
  if (feature === "tracking") tracker.requestNow("enabled");
  else link.seed(ppro);
}

/* A project opened: check its drive for every feature that is on. */
async function onProjectOpened() {
  const features = ["tracking", "linking"].filter((f) => settings.get(f));
  if (!features.length) return;
  const drive = await activeDrive();
  if (!drive) return;
  for (const f of features) {
    if (await ensure(f, drive).catch((e) => { log(`checking "${drive.name}": ${e.message}`); return false; })) {
      if (f === "tracking") tracker.requestNow("setup");
    }
  }
}

/* sync or link.js met a drive without the feature's fields. */
function onNeedsSetup(feature, driveId) {
  if (!settings.get(feature)) return;
  const drive = { id: driveId, name: resolve.driveName(driveId) };
  ensure(feature, drive)
    .then((ok) => { if (ok && feature === "tracking") tracker.requestNow("setup"); })
    .catch((e) => log(`checking "${drive.name}": ${e.message}`));
}

/*
 * A tracking pass found Shade clips on drives other than the project's.
 * Warn once per session; every sync line in the log still counts them.
 */
function warnOtherDrives(others, scan) {
  const files = Object.values(others).reduce((a, n) => a + n, 0);
  const drives = Object.keys(others).map((id) => `"${resolve.driveName(id)}"`).join(", ");
  const project = (scan.name || "this project").replace(/\.prproj$/i, "");
  if (warnedOtherDrives) return;
  warnedOtherDrives = true;
  log(`"${project}": ${files} clip(s) on ${drives} not tracked (other drive); warned`);

  const v = splitVolume(scan.path || "");
  const homeId = v && resolve.driveForVolume(v.root);
  const home = homeId ? `"${resolve.driveName(homeId)}"` : "the drive it is saved on";
  dialog.notify({
    heading: "Clips from another drive can't be tracked",
    lines: [
      `${files} clip${files === 1 ? "" : "s"} in "${project}" ${files === 1 ? "is" : "are"} on ${drives}.`,
      `Project tracking only covers media on ${home}, the drive this project is saved on.`,
      "Proxy linking and pinning are not affected."
    ]
  }).catch((e) => log(`could not show the other-drive warning: ${e.message}`));
}

module.exports = { init, switchOn, onProjectOpened, onNeedsSetup, warnOtherDrives, LABEL };
