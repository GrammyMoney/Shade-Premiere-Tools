/*
 * One scan -> the writes Shade needs. Shared by the panel and the CLI.
 *
 * For each file in the project that lives on a Shade drive:
 *   Imported? = true, Used? = true if on a timeline (never set false), and
 *   this project added to Projects Used In (keeping every other link).
 * And on the project's .prproj, Project Media lists those files.
 * The rules themselves are in plan.js; this file is the plumbing:
 *
 *   run(scan)
 *     projectHome()   is this project on Shade at all?
 *     resolveFiles()  which of its files are Shade assets, by drive
 *     syncDrive()     per drive: schema, project record, asset writes,
 *                     Project Media
 *
 * Custom objects are per drive, so a project whose media spans two Shade
 * drives gets a Projects record on each. Each drive's assets can only link
 * to that drive's records.
 *
 * Everything remembered here lasts one session (one Premiere launch, or one
 * CLI run). Nothing is saved: the first pass after a launch re-checks every
 * asset once, which is also what puts back a link someone removed by hand.
 */

const { log } = require("./log.js");
const shade = require("./shade.js");
const { resolveFile, driveForVolume } = require("./resolve.js");
const { planAsset, needsWork, planProjectMedia } = require("./plan.js");
const { splitVolume, projectDisplayName } = require("./paths.js");

const FIELD = { imported: "Imported?", used: "Used?", projects: "Projects Used In",
                projectMedia: "Project Media" };
const COLUMN = { guid: "Project GUID", file: "Project File" };
const WRITE_BATCH = 50;

/*
 * Session memory, keyed "<driveId>:<projectGuid>".
 *   records  -> Projects record id
 *   written  -> Map(mediaPath -> { used, assetId }): what this session has
 *               already told Shade, so an unchanged asset costs no request
 *               on the next DIRTY.
 */
const records = new Map();
const written = new Map();
const keyOf = (driveId, guid) => driveId + ":" + guid;

/* ------------------------------------------------------------- schema */

const schemas = new Map();     // driveId -> { schema, at }

/*
 * Field ids are re-read every 10 minutes, not once per session. A panel runs
 * for days, and fields do get replaced: "Projects Used In" was re-created as
 * a two-way relation on 2026-09-29, and a panel holding the old id would
 * have gone on writing to the archived field.
 */
const SCHEMA_TTL_MS = 10 * 60 * 1000;

class MissingSchema extends Error {}

/*
 * Field ids for a drive, looked up by name. Never hard-coded: ids differ per
 * drive. The Projects object is found by following "Projects Used In" to its
 * target, so renaming the object in Shade's UI does not break us.
 *
 * Missing fields are reported, not created here: `shade-tracker setup`
 * creates them, when a person decides to.
 */
async function schemaFor(driveId) {
  const cached = schemas.get(driveId);
  if (cached && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.schema;

  const fields = (await shade.listFields(driveId)) || [];
  const live = fields.filter((f) => !f.archived && !f.deleted && f.location === "custom");
  const byName = (name) => live.find((f) => f.name === name);
  const targetOf = (f) => (f && f.relation_config && f.relation_config.target) || null;

  const imported = byName(FIELD.imported);
  const used = byName(FIELD.used);
  const projects = byName(FIELD.projects);
  const target = targetOf(projects);
  const missing = [];
  if (!imported || imported.value_type !== "bool") missing.push(`"${FIELD.imported}" (yes/no)`);
  if (!used || used.value_type !== "bool") missing.push(`"${FIELD.used}" (yes/no)`);
  if (!target || target.kind !== "custom_object") {
    missing.push(`"${FIELD.projects}" (relation to a custom object)`);
  }
  if (missing.length) {
    throw new MissingSchema(`drive is missing ${missing.join(", ")}; run shade-tracker setup`);
  }

  const type = await shade.getObjectType(driveId, target.database_id);
  const col = (name) => (type.columns || []).find((c) => c.column_name === name && !c.archive);
  const guid = col(COLUMN.guid);
  const file = col(COLUMN.file);
  if (!guid) {
    throw new MissingSchema(`"${type.name}" has no "${COLUMN.guid}" column; run shade-tracker setup`);
  }

  // Optional: Project Media on the .prproj, as a relation to assets.
  const pm = byName(FIELD.projectMedia);
  const pmTarget = targetOf(pm);

  const schema = {
    fields: { imported: imported.id, used: used.id, projects: projects.id },
    projectMedia: pmTarget && pmTarget.kind === "asset" ? pm.id : null,
    typeId: type.id,
    typeName: type.name,
    guidColumn: guid.id,
    fileColumn: file && file.column_type === "relation" ? file.id : null
  };
  schemas.set(driveId, { schema, at: Date.now() });
  return schema;
}

/* ------------------------------------------------------ project record */

const valueOf = (record, columnId) =>
  (record.metadata_values || []).find((m) => m.id === columnId);

function relationIdsOf(record, columnId) {
  const v = valueOf(record, columnId);
  const list = v && (v.values || v.value);
  return Array.isArray(list) ? list.map((x) => (x && x.id) || x) : [];
}

async function findByGuid(driveId, schema, guid) {
  const all = await shade.listAllRecords(driveId, schema.typeId);
  return all.find((r) => (valueOf(r, schema.guidColumn) || {}).value === guid) || null;
}

/*
 * The Projects record for this project on this drive: found, or created.
 *
 * Identity is Project.guid, never the name, so a rename does not make a
 * second record. (Save As does: it gives the copy a new guid.) The name is
 * refreshed to match on every pass.
 *
 * A create that fails is checked for before retrying: Shade's 503s have so
 * far left nothing behind, but a slow success that we retried would be a
 * duplicate record that every future lookup has to choose between.
 */
async function projectRecord(driveId, schema, scan) {
  const key = keyOf(driveId, scan.guid);
  const name = projectDisplayName(scan.name);

  let record = records.has(key) ? await shade.getRecord(driveId, schema.typeId, records.get(key)) : null;
  if (!record) record = await findByGuid(driveId, schema, scan.guid);

  if (!record) {
    const body = {
      name: name || "Untitled project",
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
  records.set(key, record.id);

  if (name && record.name !== name) {
    await shade.patchRecord(driveId, schema.typeId, record.id, { name });
    log(`renamed project record to "${name}"`);
  }
  return record;
}

/*
 * The .prproj's own asset, linked as the record's "Project File".
 *
 * Returns { asset } when found, { retry: true } when the .prproj is on this
 * drive but not in Shade yet, or {} when it is elsewhere. A relation cannot
 * cross drives, so only a .prproj on this drive is linked.
 *
 * Every save gives the .prproj a NEW asset (measured 2026-09-29): Shade
 * clears the link to the old one, and this puts it back on the next pass.
 */
async function projectFile(driveId, schema, record, scan) {
  if (!scan.path) return {};
  const r = await resolveFile(scan.path).catch(() => ({}));
  if (r.driveId !== driveId) return {};
  if (r.status !== "found") return { retry: true };

  if (schema.fileColumn) {
    const current = relationIdsOf(record, schema.fileColumn);
    if (!(current.length === 1 && current[0] === r.asset.id)) {
      await shade.patchRecord(driveId, schema.typeId, record.id, {
        metadata: { [schema.fileColumn]: { kind: "relation", values: [{ id: r.asset.id, type: "asset" }] } }
      });
      log(`linked project file ${r.asset.name}`);
    }
  }
  return { asset: r.asset };
}

/*
 * List the project's media on its .prproj ("Project Media"), merged into
 * whatever is there. Checked on every pass, not just when an asset changes,
 * because every save gives the .prproj a new asset that starts empty.
 */
async function writeProjectMedia(driveId, schema, prproj, done) {
  if (!schema.projectMedia || !prproj || !done.size) return;
  const ids = [...done.values()].map((w) => w.assetId);
  const value = planProjectMedia((prproj.custom_metadata || {})[schema.projectMedia], ids);
  if (!value) return;
  await shade.putAssetValues(driveId, [{
    asset_id: prproj.id,
    metadata_attributes: [{ id: schema.projectMedia, value }]
  }]);
  log(`listed ${value.length} asset(s) on ${prproj.name}`);
}

/* --------------------------------------------------------------- steps */

/*
 * Is this project one we track? Only if its .prproj is on a Shade drive.
 * (Decided 2026-09-29: Save As gives the copy a new guid, so a project
 * started locally and then saved onto the drive produced two records.)
 *
 *   unsaved  no path yet
 *   local    .prproj not under /Volumes/, or on a volume that is not Shade
 *   waiting  on a volume not yet proven to be Shade; worth a retry
 *   tracked
 *
 * The .prproj itself need not be indexed yet (3-18s after a save,
 * measured): a proven volume is enough, and on an unproven one the project
 * file or any clip on that volume can prove it.
 */
async function projectHome(scan) {
  if (!scan.path) return "unsaved";
  const v = splitVolume(scan.path);
  if (!v) return "local";
  if (driveForVolume(v.root)) return "tracked";

  const witnesses = [scan.path].concat(
    scan.files.map((f) => f.mediaPath).filter((p) => p.startsWith(v.root + "/")).slice(0, 3));
  for (const p of witnesses) {
    const r = await resolveFile(p).catch(() => ({}));
    if (r.driveId) return "tracked";
  }
  return "waiting";
}

/*
 * Which files are Shade assets, grouped by drive. A file this session has
 * already written, and that has not since been put on a timeline, is
 * skipped without a request -- a DIRTY during ordinary editing usually ends
 * here with nothing to do.
 */
async function resolveFiles(scan, summary) {
  const byDrive = new Map();
  const prior = new Map();

  // Drives this project already has a record on are always visited, so a
  // rename or a newly indexed .prproj is picked up without waiting for an
  // asset to change. (Measured: a renamed project kept its old name.)
  for (const [key, done] of written) {
    if (!key.endsWith(":" + scan.guid)) continue;
    byDrive.set(key.slice(0, -(scan.guid.length + 1)), []);
    for (const [p, w] of done) prior.set(p, w);
  }

  for (const f of scan.files) {
    const prev = prior.get(f.mediaPath);
    if (prev) summary.onShade++;
    if (!needsWork(prev, f.used)) continue;

    let r;
    try {
      r = await resolveFile(f.mediaPath);
    } catch (e) {
      summary.problems.push(e.message);
      continue;
    }
    if (r.status === "missing") summary.retry = true;     // on Shade, not indexed yet
    if (r.status !== "found") continue;
    if (!prev) summary.onShade++;
    if (!byDrive.has(r.driveId)) byDrive.set(r.driveId, []);
    byDrive.get(r.driveId).push({ file: f, asset: r.asset });
  }
  return byDrive;
}

/* One drive: schema, record, asset writes, Project Media. */
async function syncDrive(driveId, entries, scan, summary) {
  let schema;
  try {
    schema = await schemaFor(driveId);
  } catch (e) {
    // A drive without the fields is not an error the editor caused, and not
    // one to shout about: the panel offers to set it up.
    if (e instanceof MissingSchema) summary.needsSetup.push(driveId);
    else summary.problems.push(e.message);
    return;
  }

  const record = await projectRecord(driveId, schema, scan);
  const prproj = await projectFile(driveId, schema, record, scan);
  if (prproj.retry) summary.retry = true;

  const key = keyOf(driveId, scan.guid);
  if (!written.has(key)) written.set(key, new Map());
  const done = written.get(key);
  const remember = ({ file, asset }) => done.set(file.mediaPath, { used: !!file.used, assetId: asset.id });

  const updates = [];
  for (const e of entries) {
    const values = planAsset(e.asset.custom_metadata, schema.fields, record.id, e.file.used);
    if (values) updates.push({ entry: e, values });
    else remember(e);                         // Shade already right
  }

  const fieldName = { [schema.fields.imported]: "imported", [schema.fields.used]: "used",
                      [schema.fields.projects]: "linked" };
  for (let i = 0; i < updates.length; i += WRITE_BATCH) {
    const batch = updates.slice(i, i + WRITE_BATCH);
    await shade.putAssetValues(driveId, batch.map((u) =>
      ({ asset_id: u.entry.asset.id, metadata_attributes: u.values })));
    summary.written += batch.length;
    for (const u of batch) {
      remember(u.entry);
      // Say WHICH field each write fixed; otherwise a write on an asset
      // that "should" already be right is impossible to explain afterwards.
      for (const v of u.values) summary.changes[fieldName[v.id]]++;
    }
  }

  await writeProjectMedia(driveId, schema, prproj.asset, done);
}

/* ----------------------------------------------------------------- run */

/*
 * The summary, for the panel and the CLI's log:
 *   status    tracked | unsaved | local | waiting
 *   onShade   files that are Shade assets
 *   written   assets whose values changed this pass
 *   changes   { imported, used, linked }: which fields those writes fixed
 *   retry     Shade has not caught up yet -- a file or the .prproj not
 *             indexed, or a volume not proven. Worth another pass soon.
 *   needsSetup  drive ids whose fields are missing (see setup.js)
 *   problems  messages worth showing
 */
async function run(scan) {
  const summary = { status: "tracked", onShade: 0, written: 0,
                    changes: { imported: 0, used: 0, linked: 0 }, retry: false,
                    needsSetup: [], problems: [] };

  summary.status = await projectHome(scan);
  if (summary.status !== "tracked") {
    summary.retry = summary.status === "waiting";
    return summary;
  }

  const byDrive = await resolveFiles(scan, summary);
  for (const [driveId, entries] of byDrive) await syncDrive(driveId, entries, scan, summary);
  return summary;
}

/* " (imported 2, linked 1)" -- which fields a pass's writes fixed. */
function describeChanges(summary) {
  if (!summary.written) return "";
  const parts = Object.entries(summary.changes).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`);
  return ` (${parts.join(", ")})`;
}

/* A new API key sees different drives, records and schemas. */
function forget() {
  schemas.clear();
  records.clear();
  written.clear();
}

module.exports = { run, forget, describeChanges, FIELD, COLUMN };
