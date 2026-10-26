/*
 * Export names and version numbers. Pure, tested.
 *
 *   <Project>_<Timeline>_V01.mp4, then V02, V03 ... (V100 after V99)
 *
 * The next number is one past the highest already known for that base name,
 * from the Shade stack and from the folder being exported into, so a version
 * someone deleted is never reused and a gap stays a gap. Names are compared
 * case-insensitively: APFS and Shade's SMB mount both fold case.
 */

/* Characters no file name on macOS or Windows can hold safely. */
const BAD = /[\/\\:*?"<>|\u0000-\u001f]/g;

function sanitize(name) {
  return String(name || "")
    .replace(/\.prproj$/i, "")
    .replace(BAD, "")
    .replace(/\s+/g, " ")
    .trim() || "Untitled";
}

function baseName(project, timeline) {
  return `${sanitize(project)}_${sanitize(timeline)}`;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* The version a file name carries for this base, or null. "x_V03.mp4" -> 3 */
function versionOf(fileName, base) {
  const m = new RegExp(`^${escape(base)}_V(\\d{2,})(\\.[^.]+)?$`, "i").exec(String(fileName || ""));
  return m ? Number(m[1]) : null;
}

/* One past the highest version among `names` for this base; 1 when none. */
function nextVersion(base, names) {
  let top = 0;
  for (const n of names || []) {
    const v = versionOf(n, base);
    if (v !== null && v > top) top = v;
  }
  return top + 1;
}

const formatVersion = (n) => "V" + String(n).padStart(2, "0");

function fileName(base, n, ext) {
  const e = String(ext || "mp4").replace(/^\.*/, "");
  return `${base}_${formatVersion(n)}.${e}`;
}

/* A version timeline's name: "Main Cut_V03". */
function snapshotName(timeline, n) {
  return `${sanitize(timeline)}_${formatVersion(n)}`;
}

/* The timeline a version timeline came from: "Main Cut_V03" -> "Main Cut". */
function stripVersion(name) {
  return String(name || "").replace(/_V\d{2,}$/i, "");
}

/*
 * The record's Exports list after a new version: this timeline's previous
 * latest is swapped for the new one, in place; other timelines' entries are
 * kept. Ids only, deduplicated.
 */
function mergeExports(current, previousId, newId) {
  const out = [];
  let replaced = false;
  for (const id of current || []) {
    // The old latest, or the new one already listed: either way this
    // timeline's slot, filled once with the new id.
    if (id === newId || (previousId && id === previousId)) {
      if (!replaced) out.push(newId);
      replaced = true;
    } else {
      out.push(id);
    }
  }
  if (!replaced) out.push(newId);
  return out;
}

module.exports = { sanitize, baseName, versionOf, nextVersion, formatVersion, fileName, mergeExports,
                   snapshotName, stripVersion };
