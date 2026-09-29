/*
 * Deciding what to write to one asset.
 *
 * Pure: takes what Shade currently holds and what this project says, returns
 * the values to send, or null when Shade is already right. Kept apart from
 * the network code so the rules can be tested on their own -- they are the
 * whole point of the plugin, and every one of them is easy to get subtly
 * wrong. Tested in test/plan.test.js.
 */

/*
 * A relation value as Shade returns it -> the ids it links to.
 *
 * Reads come back as [{entity_type, id, name, ...}]; anything that is not an
 * object with an id is dropped rather than trusted.
 */
function linkedIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const v of value) {
    if (v && typeof v === "object" && typeof v.id === "string") ids.push(v.id);
    else if (typeof v === "string") ids.push(v);
  }
  return ids;
}

/*
 * The rules:
 *
 *  - Imported? becomes true. It is in this project, so it was imported.
 *  - Used? becomes true if it is on a timeline here. It is NEVER set false:
 *    another project may have used it, and even this one may be hiding use
 *    in a nested sequence or multicam. Calling an asset unused when it is
 *    not is the dangerous mistake, so we only ever raise the flag.
 *  - This project is added to Projects Used In, keeping every link already
 *    there. The link is made on import, not on use (decided 2026-09-29).
 *
 * The whole relation list is sent, not just the new link. Shade's
 * `append: true` is silently ignored for relation fields -- measured, it
 * replaced the list -- so merging here is the only way to add without
 * erasing someone else's project.
 *
 * `custom` is the asset's custom_metadata, keyed by field id.
 * `fields` is { imported, used, projects } field ids.
 */
function planAsset(custom, fields, projectRecordId, usedHere) {
  const current = custom || {};
  const out = [];

  if (current[fields.imported] !== true) {
    out.push({ id: fields.imported, value: true });
  }

  if (usedHere && current[fields.used] !== true) {
    out.push({ id: fields.used, value: true });
  }

  const ids = linkedIds(current[fields.projects]);
  if (!ids.includes(projectRecordId)) {
    const merged = ids.concat([projectRecordId]);
    out.push({
      id: fields.projects,
      value: merged.map((id) => ({ id, type: "custom_object" }))
    });
  }

  return out.length ? out : null;
}

/*
 * What we already told Shade about an asset for this project, so an
 * unchanged asset costs no request at all.
 *
 * `used` is recorded because it is the one thing that can change later: an
 * asset imported first and cut in afterwards needs a second write. Once
 * written as used there is nothing left to say about it, ever.
 */
function needsWork(previous, usedHere) {
  if (!previous) return true;
  if (usedHere && !previous.used) return true;
  return false;
}

module.exports = { planAsset, linkedIds, needsWork };
