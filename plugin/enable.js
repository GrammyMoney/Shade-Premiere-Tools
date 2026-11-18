/*
 * Switching proxy linking on, and the drives it meets later.
 *
 * Linking reads two fields (Linked Proxy, Linked Hi Res) that every user of
 * a drive sees, and relies on the "Make SPT Proxies" automation to fill
 * them. Shade can only archive a field, never delete one. So before linking
 * runs on a drive, the drive is checked (setup.js, check mode), and anything
 * missing is created only after the editor says so in a dialog that lists it.
 *
 *   toggle on   check the ACTIVE project's drive. Not set up and declined,
 *               a conflict, or no right to add fields: the toggle goes back
 *               off and the editor is told why. No project on Shade open:
 *               it stays on, and the drive is checked when one opens.
 *   later       a project opened on another drive, or link.js finding no
 *               link fields: the same check and dialog, once per drive per
 *               session. Declined: that drive is skipped for the session
 *               and the toggle stays on.
 *
 * Nothing is remembered between sessions: a drive set up since is simply
 * found ready, and a declined one is asked about again next launch.
 *
 * Which drive a path is on comes from Shade Desktop's mount table
 * (shadefs.mounts), the same source linking and pinning use.
 */

const { log } = require("./log.js");
const settings = require("./settings.js");
const { setup } = require("./setup.js");
const dialog = require("./dialog.js");
const shadefs = require("./shadefs.js");
const { locate } = require("./mounts.js");
const link = require("./link.js");

const LABEL = "proxy linking";

const ready = new Set();      // drive ids known to be set up
const asked = new Set();      // drive ids asked about this session
let ppro = null;
let hasKey = async () => false;

function init(pproModule, opts = {}) {
  ppro = pproModule;
  hasKey = opts.hasKey || hasKey;
}

/* A drive's name for a dialog: its mount folder, which Shade names after it. */
const driveOf = (mount) => ({ id: mount.driveId, name: mount.root.split("/").pop() || mount.driveId });

/* The drive the active project's .prproj is on, or null. */
async function activeDrive() {
  try {
    const project = await ppro.Project.getActiveProject();
    const path = project && (await project.path);
    if (!path) return null;
    const where = locate(path, await shadefs.mounts());
    return where ? driveOf(where.mount) : null;
  } catch (e) {
    log(`could not tell which drive the project is on: ${e.message}`);
    return null;
  }
}

const label = (l) => `${l.what}${l.note ? " (" + l.note + ")" : ""}`;

/*
 * Make sure a drive has the link fields and automation, asking before creating any.
 * True when it has them (already, or now). `force` asks again even if this
 * session already asked -- the editor just flipped the switch.
 */
async function ensure(drive, { force = false } = {}) {
  const key = drive.id;
  if (ready.has(key)) return true;
  if (asked.has(key) && !force) return false;
  asked.add(key);

  const { ready: ok, lines } = await setup(drive, { check: true });
  if (ok) { ready.add(key); return true; }

  const conflicts = lines.filter((l) => l.state === "CONFLICT");
  if (conflicts.length) {
    log(`"${drive.name}" can't be set up for ${LABEL}: ${conflicts.map(label).join("; ")}`);
    await dialog.notify({
      heading: `"${drive.name}" can't be set up for ${LABEL}`,
      lines: conflicts.map((l) => `${l.what} ${l.note}.`)
    });
    return false;
  }

  const todo = lines.filter((l) => l.state === "missing");
  const yes = await dialog.confirm({
    heading: `Set up "${drive.name}" for ${LABEL}?`,
    lines: ["This adds to the drive, for everyone who uses it:"]
      .concat(todo.map((l) => "•  " + label(l)))
      .concat([todo.some((l) => /^field|^column|^object/.test(l.what))
        ? "Shade can archive fields later, but not delete them."
        : "Nothing is run: the automation waits for someone to trigger it in Shade."]),
    yes: "Set Up",
    no: "Not Now"
  });
  if (!yes) {
    log(`"${drive.name}": ${LABEL} setup declined`);
    return false;
  }

  try {
    const done = await setup(drive);
    log(`set up "${drive.name}" for ${LABEL}: ` +
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
        ? "Ask a drive owner to turn on proxy linking in their Shade Linker panel."
        : e.message]
    });
    return false;
  }
  link.forget();
  ready.add(key);
  return true;
}

/*
 * The Settings toggle was switched on. Returns a line for the panel. Turns
 * the setting back off when the drive could not be made ready.
 */
async function switchOn() {
  if (!(await hasKey())) {
    await settings.set("linking", false);
    return `add your Shade API key before turning on ${LABEL}`;
  }
  const drive = await activeDrive();
  if (drive) {
    let ok = false;
    try {
      ok = await ensure(drive, { force: true });
    } catch (e) {
      log(`checking "${drive.name}" failed: ${e.message}`);
    }
    if (!ok) {
      await settings.set("linking", false);
      return `${LABEL} is off: "${drive.name}" isn't set up for it`;
    }
  }
  link.seed(ppro);
  return drive ? `${LABEL} is on for "${drive.name}"`
               : `${LABEL} is on; a drive is checked when a project on Shade opens`;
}

/* A project opened: check its drive, if linking is on. */
async function onProjectOpened() {
  if (!settings.get("linking")) return;
  const drive = await activeDrive();
  if (!drive) return;
  await ensure(drive).catch((e) => { log(`checking "${drive.name}": ${e.message}`); return false; });
}

/* link.js met a drive without the link fields. */
async function onNeedsSetup(driveId) {
  if (!settings.get("linking")) return;
  try {
    const mount = (await shadefs.mounts()).find((m) => m.driveId === driveId);
    await ensure(mount ? driveOf(mount) : { id: driveId, name: driveId.slice(0, 8) });
  } catch (e) {
    log(`checking drive ${driveId.slice(0, 8)}: ${e.message}`);
  }
}

module.exports = { init, switchOn, onProjectOpened, onNeedsSetup, LABEL };
