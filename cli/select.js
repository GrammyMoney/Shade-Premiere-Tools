/*
 * Which files on a drive are projects, and which copies are one project.
 *
 * Pure; tested in cli/test/select.test.js.
 */

/*
 * Premiere's auto-save copies live on the drive next to the project, and
 * carry the SAME project id as the real one (verified 2026-09-29: the
 * auto-save of "New Tracker" has New Tracker's RootProjectItem uid). Parsing
 * them would rename the record after the auto-save's filename and report
 * clips from an older version, so they are never read.
 */
const AUTO_SAVE = /\/Adobe Premiere Pro Auto-Save\//i;

/*
 * Shade's listing includes its own trash: "/<driveId>/.trash/..." (seen
 * 2026-09-29). A deleted project must not be read -- it would re-create or
 * rename its record.
 */
const TRASH = /\/\.trash\//i;

function isProjectFile(entry) {
  if (!entry || typeof entry.path !== "string") return false;
  if (String(entry.extension || "").toLowerCase() !== "prproj") return false;
  if (AUTO_SAVE.test(entry.path)) return false;
  if (TRASH.test(entry.path)) return false;
  return true;
}

/* "/<driveId>/Projects/a.prproj" -> "/Projects/a.prproj" */
function relPath(driveId, shadePath) {
  const prefix = "/" + driveId;
  return shadePath.startsWith(prefix + "/") ? shadePath.slice(prefix.length) : shadePath;
}

/* "a.prproj" -- what Premiere calls the project (Project.name). */
function baseName(p) {
  return p.split("/").pop();
}

/*
 * Several files can carry one project id -- a Finder duplicate, say. They are
 * one project to Shade (one record, found by id), so they are merged:
 *
 *  - the most recently changed file names the project and is its Project
 *    File, as the one someone is actually working in;
 *  - clips are the union, and a clip is used if it is used in ANY copy.
 *    Over-reporting use is the safe mistake; this never under-reports.
 *
 * `parsed` is [{ entry, project }] where project comes from prproj.parse*.
 */
function mergeByGuid(parsed) {
  const byGuid = new Map();
  for (const p of parsed) {
    const list = byGuid.get(p.project.guid) || [];
    list.push(p);
    byGuid.set(p.project.guid, list);
  }
  const out = [];
  for (const [guid, list] of byGuid) {
    list.sort((a, b) => String(b.entry.updated).localeCompare(String(a.entry.updated)));
    const files = new Map();
    for (const { project } of list) {
      for (const f of project.files) {
        const cur = files.get(f.mediaPath);
        if (!cur) files.set(f.mediaPath, { ...f });
        else {
          cur.used = cur.used || f.used;
          cur.itemCount = Math.max(cur.itemCount, f.itemCount);
        }
      }
    }
    out.push({ guid, primary: list[0].entry, copies: list.length, files: [...files.values()] });
  }
  return out;
}

module.exports = { isProjectFile, relPath, baseName, mergeByGuid, AUTO_SAVE };
