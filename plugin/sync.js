/*
 * One scan -> the writes Shade needs.
 *
 * For each file in the project that lives on a Shade drive:
 *   Imported? = true, Used? = true if on a timeline (never set false), and
 *   this project added to Projects Used In (keeping every other link).
 * The rules themselves are in plan.js; this file is the plumbing.
 *
 * Custom objects are per drive, so a project whose media spans two Shade
 * drives gets a Projects record on each. That is correct rather than a
 * compromise: each drive's assets can only link to that drive's records.
 */

const { log } = require("./log.js");
const shade = require("./shade.js");
const store = require("./store.js");
const { resolveFile } = require("./resolve.js");
const { planAsset, needsWork } = require("./plan.js");

const FIELD = { imported: "Imported?", used: "Used?", projects: "Projects Used In" };
const COLUMN = { guid: "Project GUID", file: "Project File" };
const WRITE_BATCH = 50;

/* ------------------------------------------------------------- schema */

const schemas = new Map();     // driveId -> schema, for this session

class MissingSchema extends Error {}

/*
 * Field ids for a drive, looked up by name every session.
 *
 * Never hard-coded: ids differ per drive. The Projects object is found by
 * following the "Projects Used In" relation to its target, not by its name,
 * so renaming the object in Shade's UI does not break us.
 *
 * Missing fields are reported, not created. Creating schema on someone's
 * drive is a decision for a person, and a typo'd field name here would
 * otherwise quietly spawn a second set of columns.
 */
async function schemaFor(driveId) {
  if (schemas.has(driveId)) return schemas.get(driveId);

  const fields = (await shade.listFields(driveId)) || [];
  const live = fields.filter((f) => !f.archived && !f.deleted && f.location === "custom");
  const byName = (name) => live.find((f) => f.name === name);

  const missing = [];
  const imported = byName(FIELD.imported);
  const used = byName(FIELD.used);
  const projects = byName(FIELD.projects);
  if (!imported || imported.value_type !== "bool") missing.push(`"${FIELD.imported}" (yes/no)`);
  if (!used || used.value_type !== "bool") missing.push(`"${FIELD.used}" (yes/no)`);
  const target = projects && projects.relation_config && projects.relation_config.target;
  if (!projects || !target || target.kind !== "custom_object") {
    missing.push(`"${FIELD.projects}" (relation to a custom object)`);
  }
  if (missing.length) throw new MissingSchema("drive is missing " + missing.join(", "));

  const type = await shade.getObjectType(driveId, target.database_id);
  const col = (name) => (type.columns || []).find((c) => c.column_name === name && !c.archive);
  const guid = col(COLUMN.guid);
  const file = col(COLUMN.file);
  if (!guid) {
    throw new MissingSchema(`"${type.name}" has no "${COLUMN.guid}" column`);
  }

  const schema = {
    fields: { imported: imported.id, used: used.id, projects: projects.id },
    typeId: type.id,
    typeName: type.name,
    guidColumn: guid.id,
    fileColumn: file && file.column_type === "relation" ? file.id : null
  };
  schemas.set(driveId, schema);
  return schema;
}

/* ------------------------------------------------------ project record */

function scalarOf(record, columnId) {
  const v = (record.metadata_values || []).find((m) => m.id === columnId);
  return v ? v.value : undefined;
}

function relationIdsOf(record, columnId) {
  const v = (record.metadata_values || []).find((m) => m.id === columnId);
  const list = v && (v.values || v.value);
  return Array.isArray(list) ? list.map((x) => (x && x.id) || x) : [];
}

async function findByGuid(driveId, schema, guid) {
  const all = await shade.listAllRecords(driveId, schema.typeId);
  return all.find((r) => scalarOf(r, schema.guidColumn) === guid) || null;
}

/*
 * The Projects record for this project on this drive: found, or created.
 *
 * Identity is Project.guid, never the name, so a rename or a Save As does
 * not make a second record. The name is refreshed to match on every pass.
 *
 * A create that fails is checked for before retrying: Shade's 503s have so
 * far left nothing behind, but a slow success that we retried would be a
 * duplicate record that every future lookup has to choose between.
 */
async function projectRecord(driveId, schema, scan) {
  const st = await store.load();
  const key = driveId + ":" + scan.guid;

  let record = null;
  if (st.projects[key]) {
    record = await shade.getRecord(driveId, schema.typeId, st.projects[key]);
    if (!record) log(`project record for ${scan.name} was deleted in Shade; recreating`);
  }
  if (!record) record = await findByGuid(driveId, schema, scan.guid);

  if (!record) {
    const body = {
      name: scan.name || "Untitled project",
      metadata: { [schema.guidColumn]: { kind: "scalar", value: scan.guid } }
    };
    for (let attempt = 1; !record; attempt++) {
      try {
        record = await shade.createRecord(driveId, schema.typeId, body);
        log(`created ${schema.typeName} record "${body.name}"`);
      } catch (e) {
        if (attempt >= 3) throw e;
        log(`creating project record failed (${e.message}); checking before retrying`);
        record = await findByGuid(driveId, schema, scan.guid);
      }
    }
  }

  if (st.projects[key] !== record.id) {
    st.projects[key] = record.id;
    await store.save();
  }

  if (scan.name && record.name !== scan.name) {
    await shade.patchRecord(driveId, schema.typeId, record.id, { name: scan.name });
    log(`renamed project record to "${scan.name}"`);
  }

  await linkProjectFile(driveId, schema, record, scan);
  return record.id;
}

/*
 * Point "Project File" at the .prproj asset.
 *
 * A project saved a moment ago is usually not indexed by Shade yet, so not
 * finding it is normal and simply retried on a later pass. Only a .prproj on
 * this same drive can be linked -- a relation cannot cross drives.
 */
async function linkProjectFile(driveId, schema, record, scan) {
  if (!schema.fileColumn || !scan.path) return;
  const found = await resolveFile(scan.path).catch(() => null);
  if (!found || found.driveId !== driveId) return;
  const current = relationIdsOf(record, schema.fileColumn);
  if (current.length === 1 && current[0] === found.asset.id) return;
  await shade.patchRecord(driveId, schema.typeId, record.id, {
    metadata: {
      [schema.fileColumn]: { kind: "relation", values: [{ id: found.asset.id, type: "asset" }] }
    }
  });
  log(`linked project file ${found.asset.name}`);
}

/* ---------------------------------------------------------------- run */

/* Everything already written for this project, across every drive. */
function priorWrites(st, guid) {
  const out = {};
  for (const [key, written] of Object.entries(st.written)) {
    if (key.endsWith(":" + guid)) Object.assign(out, written);
  }
  return out;
}

/*
 * Returns a summary for the panel: how many files were on Shade, how many
 * needed a write, and what could not be done yet.
 */
async function run(scan) {
  const st = await store.load();
  // onShade: files resolved to a Shade asset. written: assets whose values
  // changed this pass. skipped: local, unproven, or not indexed yet.
  // pending: on Shade but blocked, e.g. the drive lacks the fields.
  const summary = { onShade: 0, written: 0, pending: 0, skipped: 0, problems: [] };

  // Resolve only what needs work. An asset already written, and not newly
  // used, costs no request at all -- a DIRTY during ordinary editing
  // usually ends here with nothing to do.
  const prior = priorWrites(st, scan.guid);
  const byDrive = new Map();
  for (const f of scan.files) {
    const p = prior[f.mediaPath];
    if (p) summary.onShade++;
    if (p && !needsWork(p, f.used)) continue;

    let found;
    try {
      found = await resolveFile(f.mediaPath);
    } catch (e) {
      summary.problems.push(e.message);
      continue;
    }
    // Local media, a volume not proven to be Shade, or not indexed yet.
    if (!found) { summary.skipped++; continue; }
    if (!p) summary.onShade++;
    if (!byDrive.has(found.driveId)) byDrive.set(found.driveId, []);
    byDrive.get(found.driveId).push({ file: f, asset: found.asset });
  }

  // Drives this project already has a record on get visited even when no
  // asset changed. Otherwise a rename, or a .prproj that has just been
  // indexed, would wait for some unrelated asset to need a write.
  // (Measured: a renamed project kept its old record name.)
  for (const key of Object.keys(st.written)) {
    if (!key.endsWith(":" + scan.guid)) continue;
    const driveId = key.slice(0, key.length - scan.guid.length - 1);
    if (!byDrive.has(driveId)) byDrive.set(driveId, []);
  }

  for (const [driveId, entries] of byDrive) {
    let schema;
    try {
      schema = await schemaFor(driveId);
    } catch (e) {
      summary.problems.push(e.message);
      summary.pending += entries.length;
      continue;
    }

    const recordId = await projectRecord(driveId, schema, scan);
    const key = driveId + ":" + scan.guid;
    const written = st.written[key] || (st.written[key] = {});

    const updates = [];
    const settled = [];
    for (const { file, asset } of entries) {
      const values = planAsset(asset.custom_metadata, schema.fields, recordId, file.used);
      if (values) updates.push({ asset_id: asset.id, metadata_attributes: values, file });
      else settled.push(file);
    }

    for (let i = 0; i < updates.length; i += WRITE_BATCH) {
      const batch = updates.slice(i, i + WRITE_BATCH);
      await shade.putAssetValues(driveId, batch.map(({ asset_id, metadata_attributes }) =>
        ({ asset_id, metadata_attributes })));
      for (const u of batch) settled.push(u.file);
      summary.written += batch.length;
    }

    for (const f of settled) written[f.mediaPath] = { used: !!f.used };
    await store.save();
  }

  return summary;
}

/* A new API key may see different drives with different schemas. */
function forgetSchemas() { schemas.clear(); }

module.exports = { run, forgetSchemas, MissingSchema };
