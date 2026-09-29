/*
 * Where a file lives, as far as Shade is concerned.
 *
 * Shade mounts each drive at /Volumes/<drive display name>, and names its
 * assets /<driveId>/<path inside the drive>. Getting from one to the other
 * is pure string work, kept here so it can be tested without Premiere.
 *
 * Pure: no uxp, no premierepro. Tested in test/paths.test.js.
 */

/*
 * Split a macOS media path into the volume it is on and the rest.
 *
 * Returns null for anything not under /Volumes/ -- a file in /Users/... is on
 * the local disk and cannot be on a Shade drive, so there is no point asking
 * Shade about it. "Macintosh HD" is a symlink to / and is excluded for the
 * same reason.
 *
 * Case is left exactly as given. Shade's path lookup is case-sensitive
 * (measured: a lower-cased path 404s), so the spelling Premiere reports is
 * the only one worth sending.
 */
function splitVolume(mediaPath) {
  if (typeof mediaPath !== "string") return null;
  const m = /^\/Volumes\/([^/]+)(\/.+)$/.exec(mediaPath);
  if (!m) return null;
  const name = m[1];
  if (name === "Macintosh HD") return null;
  return { root: "/Volumes/" + name, name, rest: m[2] };
}

/*
 * The path Shade knows an asset by.
 *
 * GET /assets/path only finds an asset when the path starts with the drive's
 * id -- the drive-relative form the docs imply returns 404. Every path Shade
 * hands back carries the same prefix.
 */
function shadePath(driveId, rest) {
  return "/" + driveId + rest;
}

/* The volume a Shade drive would be mounted at, from its display name. */
function mountRootFor(driveName) {
  return "/Volumes/" + driveName;
}

module.exports = { splitVolume, shadePath, mountRootFor };
