/*
 * Media path -> Shade asset.
 *
 * UXP cannot run `mount`, so the plugin cannot see that a volume is an SMB
 * share from Shade. It proves it with a file instead (decided 2026-09-29):
 *
 *   1. /Volumes/<X>/<rest>: every drive the key can see named exactly <X> is
 *      a candidate. Shade mounts a drive under its display name.
 *   2. For each candidate, look up /<driveId><rest>. It is a match only if
 *      the asset exists AND its size equals the local file's.
 *   3. On the first match, remember /Volumes/<X> -> driveId for the session,
 *      and resolve everything else under it directly.
 *
 * Names are not unique (two drives called "Joe Test" were visible to one
 * key), so a name only nominates; the file decides. And a 404 proves
 * nothing -- the file may just not be indexed yet -- so a volume without a
 * match is never remembered as "not Shade". It is asked about again with the
 * next file.
 *
 * Nothing here is saved between sessions. Re-proving a volume costs one
 * lookup, and a map that outlives a remount or a key change is a map that
 * can be wrong.
 */

const { log } = require("./log.js");
const shade = require("./shade.js");
const { splitVolume, shadePath } = require("./paths.js");
const { platform } = require("./platform.js");

const DRIVE_LIST_TTL_MS = 10 * 60 * 1000;
let drives = null;            // [{ id, name }]
let drivesAt = 0;
const volumes = new Map();    // "/Volumes/X" -> { driveId, name }
let sizeWarned = false;

async function allDrives(force) {
  if (drives && !force && Date.now() - drivesAt < DRIVE_LIST_TTL_MS) return drives;
  const out = [];
  for (const w of (await shade.listWorkspaces()) || []) {
    try {
      for (const d of (await shade.listDrives(w.id)) || []) out.push({ id: d.id, name: d.name });
    } catch (e) {
      // One workspace we cannot list must not hide every other one.
      log(`could not list drives in workspace ${w.name}: ${e.message}`);
    }
  }
  drives = out;
  drivesAt = Date.now();
  return drives;
}

/* The local file's size, or null if this host cannot tell us. */
async function localSize(path) {
  const size = await platform().fileSize(path).catch(() => null);
  if (size === null && !sizeWarned) {
    sizeWarned = true;
    log("cannot read local file sizes; matching drives on path alone");
  }
  return size;
}

/*
 * Resolve one media path. Always returns an object saying which case it is,
 * because the cases need different handling:
 *
 *   { status: "local" }             not under /Volumes/: never ours
 *   { status: "unknown" }           on a volume no Shade drive has claimed
 *   { status: "missing", driveId }  on a Shade drive, but Shade has no such
 *                                   asset yet -- usually not indexed yet, so
 *                                   worth a retry
 *   { status: "found", driveId, asset }
 */
async function resolveFile(mediaPath) {
  const v = splitVolume(mediaPath);
  if (!v) return { status: "local" };

  const known = volumes.get(v.root);
  if (known) {
    const asset = await shade.assetByPath(known.driveId, shadePath(known.driveId, v.rest));
    return asset ? { status: "found", driveId: known.driveId, asset }
                 : { status: "missing", driveId: known.driveId };
  }

  let candidates = (await allDrives()).filter((d) => d.name === v.name);
  if (!candidates.length) {
    // Maybe a drive created or shared since we last looked.
    candidates = (await allDrives(true)).filter((d) => d.name === v.name);
  }
  if (!candidates.length) return { status: "unknown" };

  const size = await localSize(mediaPath);
  for (const d of candidates) {
    const asset = await shade.assetByPath(d.id, shadePath(d.id, v.rest));
    if (!asset) continue;
    if (size !== null && asset.size_bytes !== size) {
      log(`${v.name}: ${v.rest} exists on drive ${d.id.slice(0, 8)} but sizes differ ` +
          `(${asset.size_bytes} vs ${size}); not this drive`);
      continue;
    }
    rememberVolume(v.root, d.id, d.name);
    log(`${v.root} is Shade drive "${d.name}" (${d.id.slice(0, 8)}), proven by ${v.rest}`);
    return { status: "found", driveId: d.id, asset };
  }
  return { status: "unknown" };
}

/* The drive a volume is known to be, if any. */
function driveForVolume(root) {
  const v = volumes.get(root);
  return v ? v.driveId : null;
}

/*
 * Record a volume as a drive without proving it -- for a caller that already
 * knows, like the CLI, which found the .prproj by listing that drive.
 */
function rememberVolume(root, driveId, name) {
  volumes.set(root, { driveId, name });
}

/* Forget everything, e.g. after the API key changes. */
function forget() {
  drives = null;
  drivesAt = 0;
  volumes.clear();
}

module.exports = { resolveFile, driveForVolume, rememberVolume, forget };
