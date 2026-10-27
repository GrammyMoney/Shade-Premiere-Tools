/*
 * Where a file lives, as far as Shade is concerned. Pure string work, so it
 * can be tested without Premiere or Shade.
 *
 * Three spellings of one file:
 *
 *   local   /Volumes/Adobe Sandbox/2025 Media/a.MP4        what Premiere reports
 *   rest    /2025 Media/a.MP4                              inside the drive
 *   shade   /72454409-.../2025 Media/a.MP4                 what the REST API wants
 *
 * The mount root comes from Shade itself (status:mount over the desktop
 * bridge), never from guessing /Volumes/<drive name>. Shade Premiere Tools had to
 * guess, because a panel cannot run `mount`, and it found a drive mounted
 * under a name that no longer matched the drive's display name. Asking the
 * daemon that made the mount removes the guess.
 */

/* Strip trailing slashes; "/" stays "/". */
function trimSlash(p) {
  const out = String(p).replace(/\/+$/, "");
  return out || "/";
}

/*
 * One mounted drive, from a MountState the bridge returned. Null for the
 * empty placeholder the daemon reports when nothing is mounted
 * (drive_number 0, mount_path "").
 *
 * The drive's id is the last segment of its remote URI
 * (https://fs.shade.inc/<driveId>). The bridge fills remote_uri in from its
 * own drive table; `drives` is the same table, passed in for when it did not.
 */
function mountFrom(state, drives) {
  if (!state || !state.drive_number || !state.mount_path) return null;
  let uri = state.remote_uri;
  if (!uri && Array.isArray(drives)) {
    const d = drives.find((x) => x && x.drive_number === state.drive_number);
    uri = d && d.remote_uri;
  }
  const driveId = driveIdFromUri(uri);
  if (!driveId) return null;
  return {
    root: trimSlash(state.mount_path),
    driveId,
    driveNumber: state.drive_number,
    rootIno: typeof state.root_ino === "number" ? state.root_ino : null
  };
}

function driveIdFromUri(uri) {
  if (typeof uri !== "string") return null;
  const m = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(uri);
  return m ? m[1].toLowerCase() : null;
}

/*
 * Which mounted drive a local path is on, if any.
 *
 * The root is compared case-insensitively (APFS and SMB both fold case, so
 * Premiere may report a different spelling of the volume than the daemon),
 * and only at a segment boundary: "/Volumes/Shade 2" is not inside
 * "/Volumes/Shade". The rest keeps its exact spelling, because Shade's path
 * lookup is case-sensitive (measured in Shade Premiere Tools: a lower-cased path 404s).
 */
function locate(localPath, mounts) {
  if (typeof localPath !== "string" || !Array.isArray(mounts)) return null;
  let best = null;
  for (const m of mounts) {
    const root = m.root;
    if (localPath.length <= root.length) continue;
    if (localPath.slice(0, root.length).toLowerCase() !== root.toLowerCase()) continue;
    if (localPath[root.length] !== "/") continue;
    // Longest root wins, in case one mount sits inside another's folder.
    if (!best || root.length > best.mount.root.length) {
      best = { mount: m, rest: localPath.slice(root.length) };
    }
  }
  return best;
}

/* The path GET /assets/path wants: it must start with the drive id. */
function shadePath(driveId, rest) {
  return "/" + driveId + rest;
}

/*
 * A Shade asset path back to a local one on a given mount. Null when the
 * asset is not on that drive -- a relation can, in principle, point anywhere.
 */
function localPath(assetPath, mount) {
  if (typeof assetPath !== "string" || !mount) return null;
  const prefix = "/" + mount.driveId + "/";
  if (assetPath.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
  return mount.root + assetPath.slice(prefix.length - 1);
}

module.exports = { mountFrom, driveIdFromUri, locate, shadePath, localPath, trimSlash };
