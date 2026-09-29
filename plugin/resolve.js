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
 *   3. On the first match, remember /Volumes/<X> -> driveId, and resolve
 *      everything else under it directly.
 *
 * Names are not unique (two drives called "Joe Test" were visible to one
 * key), so a name only nominates; the file decides. And a 404 proves
 * nothing -- the file may just not be indexed yet -- so a volume without a
 * match is never recorded as "not Shade". It is simply asked about again
 * with the next file.
 */

const { log } = require("./log.js");
const shade = require("./shade.js");
const store = require("./store.js");
const { splitVolume, shadePath } = require("./paths.js");

const DRIVE_LIST_TTL_MS = 10 * 60 * 1000;
let drives = null;            // [{ id, name }]
let drivesAt = 0;
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

/*
 * The local file's size, or null if UXP will not tell us.
 *
 * Two routes, because which one works depends on the UXP version and the
 * manifest's localFileSystem permission. Neither is verified inside Premiere
 * yet -- if both fail, matching falls back to path alone and the log says
 * so once.
 */
async function localSize(path) {
  try {
    const fs = require("fs");
    const st = await fs.lstat(path);
    if (st && typeof st.size === "number") return st.size;
  } catch (e) { /* try the next route */ }
  try {
    const lfs = require("uxp").storage.localFileSystem;
    const entry = await lfs.getEntryWithUrl("file:" + path);
    const md = await entry.getMetadata();
    if (md && typeof md.size === "number") return md.size;
  } catch (e) { /* fall through */ }
  if (!sizeWarned) {
    sizeWarned = true;
    log("cannot read local file sizes; matching drives on path alone");
  }
  return null;
}

/*
 * Resolve one media path. Returns { driveId, asset } or null.
 *
 * null covers three different situations that all mean "nothing to write
 * yet": not on a volume at all, on a volume that is not (or not yet proven
 * to be) a Shade drive, and on a Shade drive but not indexed yet.
 */
async function resolveFile(mediaPath) {
  const v = splitVolume(mediaPath);
  if (!v) return null;

  const st = await store.load();
  const known = st.volumes[v.root];
  if (known) {
    const asset = await shade.assetByPath(known.driveId, shadePath(known.driveId, v.rest));
    return asset ? { driveId: known.driveId, asset } : null;
  }

  let candidates = (await allDrives()).filter((d) => d.name === v.name);
  if (!candidates.length) {
    // Maybe a drive created or shared since we last looked.
    candidates = (await allDrives(true)).filter((d) => d.name === v.name);
  }
  if (!candidates.length) return null;

  const size = await localSize(mediaPath);
  for (const d of candidates) {
    const asset = await shade.assetByPath(d.id, shadePath(d.id, v.rest));
    if (!asset) continue;
    if (size !== null && asset.size_bytes !== size) {
      log(`${v.name}: ${v.rest} exists on drive ${d.id.slice(0, 8)} but sizes differ ` +
          `(${asset.size_bytes} vs ${size}); not this drive`);
      continue;
    }
    st.volumes[v.root] = { driveId: d.id, name: d.name };
    await store.save();
    log(`${v.root} is Shade drive "${d.name}" (${d.id.slice(0, 8)}), proven by ${v.rest}`);
    return { driveId: d.id, asset };
  }
  return null;
}

/* Forget the drive list, e.g. after the API key changes. */
function forgetDrives() { drives = null; drivesAt = 0; }

module.exports = { resolveFile, forgetDrives };
