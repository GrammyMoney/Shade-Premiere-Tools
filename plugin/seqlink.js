/*
 * Which Shade export stack a timeline belongs to, kept inside the .prproj.
 *
 * Stored on the sequence's project item as private project metadata (XMP),
 * the way Shade's own Premiere plugin keeps its link: nothing extra in Shade,
 * it travels with the project file, and renaming the timeline doesn't break
 * it. (Decided 2026-10-26.) Fields, all strings:
 *
 *   ShadeTrackerExportDrive    drive id
 *   ShadeTrackerExportLatest   asset id of the newest version
 *   ShadeTrackerExportStack    stack id, once there are two versions
 *   ShadeTrackerExportVersion  "3"
 *   ShadeTrackerSnapshotOf     on a version timeline (a copy made at export,
 *                              in the Shade Versions bin): the guid of the
 *                              timeline it was copied from
 *
 * The XML helpers are pure and tested; read/write need Premiere.
 */

const NS = "premierePrivateProjectMetaData";
const FIELDS = { drive: "ShadeTrackerExportDrive", latest: "ShadeTrackerExportLatest",
                 stack: "ShadeTrackerExportStack", version: "ShadeTrackerExportVersion",
                 snapshotOf: "ShadeTrackerSnapshotOf" };
const ALL = Object.values(FIELDS);

const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const unesc = (v) => v.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">")
  .replace(/&lt;/g, "<").replace(/&amp;/g, "&");
const tag = (f) => new RegExp(`<${NS}:${f}>([^<]*)</${NS}:${f}>`);

function getField(xml, field) {
  const m = tag(field).exec(String(xml || ""));
  return m ? unesc(m[1]) : null;
}

/* Set or add a field. Returns null when the XML has nowhere to put it. */
function setField(xml, field, value) {
  const el = `<${NS}:${field}>${esc(value)}</${NS}:${field}>`;
  const s = String(xml || "");
  if (tag(field).test(s)) return s.replace(tag(field), el);
  const at = s.lastIndexOf("</rdf:Description>");
  if (at === -1) return null;
  return `${s.slice(0, at)}   ${el}\n${s.slice(at)}`;
}

/*
 * xml -> { drive, latest, stack, version, snapshotOf }; missing or empty
 * fields are null. Null when there's no drive: never exported. A version
 * timeline whose asset Shade hasn't indexed yet has no `latest` until the
 * export finishes.
 */
function parseLink(xml) {
  const out = {};
  for (const [k, f] of Object.entries(FIELDS)) out[k] = getField(xml, f) || null;
  out.version = out.version ? Number(out.version) || null : null;
  return out.drive ? out : null;
}

/* ------------------------------------------------------------- Premiere */

async function itemOf(sequence) {
  return sequence && typeof sequence.getProjectItem === "function" ? sequence.getProjectItem() : null;
}

async function read(ppro, sequence) {
  const item = await itemOf(sequence);
  if (!item) return null;
  return parseLink(await ppro.Metadata.getProjectMetadata(item));
}

/*
 * Throws when Premiere won't take it; the export itself is already done.
 * A field given as "" is cleared; one left out is kept.
 */
async function write(ppro, project, sequence, link) {
  const item = await itemOf(sequence);
  if (!item) throw new Error("this timeline has no project item to store the link on");
  for (const f of ALL) {
    // Registering a field that exists already throws; that is fine.
    try { await ppro.Metadata.addPropertyToProjectMetadataSchema(f, f, 2); } catch (e) { /* exists */ }
  }
  let xml = await ppro.Metadata.getProjectMetadata(item);
  for (const [k, f] of Object.entries(FIELDS)) {
    if (link[k] === null || link[k] === undefined) continue;
    xml = setField(xml, f, String(link[k]));
    if (xml === null) throw new Error("the timeline's metadata has no place for the link");
  }
  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((compound) => {
      compound.addAction(ppro.Metadata.createSetProjectMetadataAction(item, xml, ALL));
    }, "SPT: link export");
  });
  if (ok === false) throw new Error("Premiere did not store the export link");
}

module.exports = { FIELDS, getField, setField, parseLink, read, write };
