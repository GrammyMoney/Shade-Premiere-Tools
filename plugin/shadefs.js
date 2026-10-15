/*
 * Shade on this machine: what is mounted where, a file's inode, and pins.
 *
 * Everything goes through Shade Desktop's bridge (bridge.js), because UXP
 * has no shell to run the shadefs CLI. The mount table comes from the daemon
 * that made the mounts, so no drive is guessed from its volume name.
 */

const { log } = require("./log.js");
const bridge = require("./bridge.js");
const { mountFrom } = require("./mounts.js");
const { parsePinList } = require("./pins.js");

let warnedNoIno = false;

/* Every mounted Shade drive: [{ root, driveId, driveNumber, rootIno }]. */
async function mounts() {
  const [states, drives] = await Promise.all([bridge.mountStates(), bridge.allDrives().catch(() => [])]);
  return states.map((s) => mountFrom(s, drives)).filter(Boolean);
}

/*
 * A file's shadefs inode and size. On Shade's SMB mount, a stat's inode IS
 * the daemon's inode (measured in premiere-events), and a stat does not
 * download the file.
 *
 * UXP's fs.lstat is documented as "Node's Stats, but some properties may be
 * missing", so a missing inode is logged once rather than assumed away.
 * Linking and pinning worked in Premiere 26.5.1 (Shade-Linker, 2026-10-07),
 * so it has been there so far.
 */
async function statOf(path) {
  let st;
  try {
    st = await require("fs").lstat(path);
  } catch (e) {
    throw new Error(`cannot stat ${path}: ${e.message}`);
  }
  const num = (v) => (typeof v === "bigint" ? Number(v) : v);
  const ino = st && num(st.ino);
  if (typeof ino !== "number" && !warnedNoIno) {
    warnedNoIno = true;
    log(`UXP fs.lstat has no inode here (keys: ${Object.keys(st || {}).join(", ")}); cannot pin`);
  }
  const size = st && num(st.size);
  return { ino: typeof ino === "number" ? ino : null, size: typeof size === "number" ? size : null };
}

/* What is pinned now, as [{ driveId, path }] (see pins.parsePinList). */
async function pinned() {
  return parsePinList(await bridge.pinList());
}

/* Pin or unpin by inode (see bridge.js). Resolves { code, data }. */
const pin = (inos) => bridge.pin(inos);
const unpin = (inos) => bridge.unpin(inos);

module.exports = { mounts, statOf, pinned, pin, unpin };
