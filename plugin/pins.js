/*
 * The proxy-linking and pinning rules, without any I/O. Tested in
 * test/pins.test.js. Linking came over from Shade-Linker unchanged.
 */

/*
 * The asset ids a relation field points at.
 *
 * GET /assets/path returns custom_metadata keyed by field id, and a relation
 * reads back as an array of { entity_type, id, name, ... } (measured
 * 2026-10-07 on Adobe Sandbox). The other shapes Shade has used for relations
 * -- plain id strings, and { kind: "reference", values: [...] } on records --
 * are accepted too, because a reader that only knows one shape fails silently
 * the day it changes.
 */
function linkedIds(asset, fieldId) {
  if (!asset || !fieldId) return [];
  const cm = asset.custom_metadata;
  if (!cm || typeof cm !== "object") return [];
  let v = cm[fieldId];
  if (v && !Array.isArray(v) && Array.isArray(v.values)) v = v.values;
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x === "string") { out.push(x); continue; }
    if (!x || typeof x.id !== "string") continue;
    if (x.entity_type && x.entity_type !== "asset") continue;
    out.push(x.id);
  }
  return out;
}

/*
 * Can this inode be pinned?
 *
 * The SMB mount reported inode 1 -- the drive's own root_ino -- for a .trash
 * entry (premiere-events, 2026-09-28). Pinning that queues the entire drive
 * while the editor thought they pinned one clip. An inode equal to the root's
 * is refused for anything that is not the root itself, and we never pin a
 * root on purpose.
 */
function pinnableIno(ino, rootIno) {
  if (typeof ino !== "number" || !Number.isFinite(ino) || ino <= 0) return false;
  if (rootIno !== null && rootIno !== undefined && ino === rootIno) return false;
  return true;
}

/*
 * What to do with one clip that just arrived.
 *
 *   hasProxy   Premiere already has a proxy on it (SHINE attached one, the
 *              editor did, or this ran before). Never replaced: an existing
 *              proxy is someone's decision.
 *   proxyIds   from the asset's Linked Proxy field: this is a hi-res
 *   hiResIds   from the asset's Linked Hi Res field: this IS a proxy
 *
 * Either way the answer is one attachProxy call; only the direction differs.
 * For a dragged-in proxy, `isHiRes: true` tells Premiere the attached file is
 * the full-resolution media and the clip's own file is its proxy.
 *
 * Linked Proxy is checked first: an asset with both is a hi-res first. The
 * first link wins. The automation writes one, and if there were several
 * there is nothing here to choose between them with.
 */
function decide({ hasProxy, proxyIds, hiResIds }) {
  if (hasProxy) return { attach: false, reason: "already has a proxy" };
  if (proxyIds && proxyIds.length) return { attach: true, otherId: proxyIds[0], isHiRes: false };
  if (hiResIds && hiResIds.length) return { attach: true, otherId: hiResIds[0], isHiRes: true };
  return { attach: false, reason: "no linked proxy or hi-res" };
}

/* The live field with this name, ignoring archived copies. */
function fieldByName(fields, name) {
  if (!Array.isArray(fields)) return null;
  return fields.find((f) => f && f.name === name && !f.archived && !f.deleted &&
                            (f.location === undefined || f.location === "custom")) || null;
}

/*
 * `pin list` text -> [{ driveId, path }], path relative to the drive root
 * with no leading slash. A line is "<remote_uri>:<path>", and the uri itself
 * contains "https:", so it is split at the uri, not at the first colon.
 * Lines that are not about a Shade drive are dropped.
 */
function parsePinList(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = /^(https?:\/\/[^\s:]+\/([0-9a-f-]{36})):(.*)$/i.exec(line.trim());
    if (m && m[3]) out.push({ driveId: m[2].toLowerCase(), path: m[3].replace(/^\/+|\/+$/g, "") });
  }
  return out;
}

/*
 * How the file at `rest` ("/Footage/a.mov") on this drive is pinned: "self"
 * when the file itself is, "folder" when only a pinned folder above it is,
 * null when it is not pinned. Only a "self" pin can be removed by unpinning
 * the file. Compared case-insensitively: SMB folds case, so Premiere's
 * spelling and the daemon's may differ.
 */
function isPinned(pinned, driveId, rest) {
  const file = String(rest).replace(/^\/+/, "").toLowerCase();
  let how = null;
  for (const p of pinned) {
    if (p.driveId !== driveId) continue;
    const pin = p.path.toLowerCase();
    if (file === pin) return "self";
    if (file.startsWith(pin + "/")) how = "folder";
  }
  return how;
}

/*
 * The numbers the pin prompt shows, from [{ pinned, size }]. A size of null
 * (the file could not be read) counts as 0 bytes, but the file still counts.
 */
function tally(files) {
  const t = { count: 0, bytes: 0, pinned: { count: 0, bytes: 0 }, unpinned: { count: 0, bytes: 0 } };
  for (const f of files) {
    const bytes = typeof f.size === "number" && f.size > 0 ? f.size : 0;
    const side = f.pinned ? t.pinned : t.unpinned;
    t.count++; t.bytes += bytes;
    side.count++; side.bytes += bytes;
  }
  return t;
}

/* Bytes for people: 1.8 TB, 400 GB, 12 MB. Decimal, as Finder shows them. */
function formatBytes(n) {
  const units = ["bytes", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  if (i === 0) return `${n} bytes`;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

module.exports = { linkedIds, pinnableIno, decide, fieldByName, parsePinList, isPinned, tally, formatBytes };
