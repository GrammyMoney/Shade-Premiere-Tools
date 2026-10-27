/*
 * Make a drive ready for Shade Premiere Tools, or say what it lacks.
 *
 * Per feature, because each Settings toggle needs its own fields:
 *   tracking  Imported?, Used?, Project Media, Projects Used In, and the
 *             "Premiere Projects" object with Project GUID / Project File
 *   linking   Linked Proxy and Linked Hi Res: one-way relations to assets
 *
 * Shared by the panel (switching a feature on checks, then asks in a
 * dialog before creating: enable.js) and the CLI:
 *   spt setup --drive "X" [--linking]          create what is missing
 *   spt setup --drive "X" [--linking] --check  report only; exit 1 if not ready
 *
 * The object is "Premiere Projects", never a bare "Projects" (decided
 * 2026-10-20): a customer's drive may well have its own "Projects", and
 * setup must not adopt it. For the same reason an existing "Projects Used
 * In" that points anywhere but "Premiere Projects" is a conflict, not ours.
 *
 * Idempotent: everything is looked up first and only what is missing is
 * created, so running it again is the health check. It never modifies or
 * removes anything that exists. A field with the right name but the wrong
 * type is reported as a conflict for a person to resolve.
 *
 * The one thing that is easy to get wrong by hand, and why this exists:
 * "Projects Used In" must be a TWO-WAY relation, so that Projects gets an
 * "Assets" column Shade keeps mirrored. Shade only allows that when the
 * field is created -- it cannot be switched on later. An existing one-way
 * field is reported with the migration to do (see CLAUDE.md), not migrated
 * silently.
 */

const shade = require("./shade.js");
const { FIELD, COLUMN } = require("./sync.js");

const TYPE_NAME = "Premiere Projects";
const INVERSE_NAME = "Assets";
const LINK_FIELDS = { proxy: "Linked Proxy", hiRes: "Linked Hi Res" };   // as link.js

const DESCRIBE = {
  [LINK_FIELDS.proxy]: "On a hi-res file: its proxy. Shade Premiere Tools attaches it in Premiere on import.",
  [LINK_FIELDS.hiRes]: "On a proxy: its hi-res file. Shade Premiere Tools attaches it in Premiere on import.",
  type: "Premiere Pro projects, one record per project. Maintained by Shade Premiere Tools; matched on Project GUID, not name.",
  [COLUMN.guid]: "Premiere's project id. The identity key; survives renames.",
  [COLUMN.file]: "The .prproj on this drive.",
  [COLUMN.exports]: "The newest export of each timeline in this project (V01, V02...: the older versions are in its Shade stack). Written by Export in Shade Premiere Tools.",
  [FIELD.imported]: "In at least one Premiere project. Set by Shade Premiere Tools; never unset.",
  [FIELD.used]: "On a timeline in at least one Premiere project. Set by Shade Premiere Tools; never unset.",
  [FIELD.projects]: "Premiere projects this asset is in (linked on import). Two-way: mirrored as Assets on Projects.",
  [FIELD.projectMedia]: "On a .prproj: the Shade media in that project. Written by Shade Premiere Tools after each save."
};

const targetOf = (f) => (f && f.relation_config && f.relation_config.target) || null;
const columnTarget = (c) =>
  (c && c.display_metadata && c.display_metadata.relation_config &&
   c.display_metadata.relation_config.target) || null;

/*
 * Returns { ready, lines } -- one line per item: "ok", "created", "missing"
 * (in --check), or "CONFLICT"/"WARN" with what to do.
 */
async function setup(drive, { check = false, feature = "tracking" } = {}) {
  const fields = ((await shade.listFields(drive.id)) || [])
    .filter((f) => !f.archived && !f.deleted && f.location === "custom");
  if (feature === "linking") return setupLinking(drive, fields, check);
  if (feature !== "tracking") throw new Error(`no feature "${feature}"`);
  return setupTracking(drive, fields, check);
}

/* Linked Proxy / Linked Hi Res: one-way on purpose, so neither fills in the other. */
async function setupLinking(drive, fields, check) {
  const lines = [];
  const say = (state, what, note) => lines.push({ state, what, note });
  let ready = true;
  const toCreate = [];
  for (const name of Object.values(LINK_FIELDS)) {
    const f = fields.find((x) => x.name === name);
    const label = `field "${name}"`;
    if (!f) { toCreate.push({ column_name: name, column_type: "relation", description: DESCRIBE[name],
                              relation_config: { target: { kind: "asset" } } }); continue; }
    const t = targetOf(f);
    if (f.value_type !== "relation" || !t || t.kind !== "asset") {
      say("CONFLICT", label, `is ${f.value_type}${t ? " to " + t.kind : ""}, needs a relation to assets`);
      ready = false;
    } else {
      say("ok", label);
    }
  }
  if (toCreate.length) {
    if (check) { toCreate.forEach((w) => say("missing", `field "${w.column_name}"`, "relation to assets")); ready = false; }
    else {
      await shade.addAssetFields(drive.id, toCreate);
      toCreate.forEach((w) => say("created", `field "${w.column_name}"`, "relation to assets"));
    }
  }
  return { ready, lines };
}

async function setupTracking(drive, fields, check) {
  const lines = [];
  const say = (state, what, note) => lines.push({ state, what, note });
  let ready = true;
  const field = (name) => fields.find((f) => f.name === name);

  /* ---- the object: whatever "Projects Used In" points at, provided it is
   *      "Premiere Projects"; else a type of that name; else a new one. A
   *      bare "Projects" is never adopted -- it may be the customer's. */
  const projectsField = field(FIELD.projects);
  let type = null;
  if (projectsField) {
    const t = targetOf(projectsField);
    if (!t || t.kind !== "custom_object") {
      say("CONFLICT", `field "${FIELD.projects}"`, "exists but does not point at a custom object; rename or remove it, then re-run");
      return { ready: false, lines };
    }
    type = await shade.getObjectType(drive.id, t.database_id);
    if (type.name !== TYPE_NAME) {
      say("CONFLICT", `field "${FIELD.projects}"`,
          `already exists and points at "${type.name}", not "${TYPE_NAME}". If "${type.name}" is Shade ` +
          `Tracker's, rename it to "${TYPE_NAME}" in Shade; if not, rename the field, then re-run`);
      return { ready: false, lines };
    }
    say("ok", `object "${type.name}"`, `the target of "${FIELD.projects}"`);
  } else {
    const types = (await shade.listObjectTypes(drive.id)) || [];
    const found = types.find((t) => t.name === TYPE_NAME);
    if (found) {
      type = await shade.getObjectType(drive.id, found.id);
      say("ok", `object "${TYPE_NAME}"`);
    } else if (check) {
      say("missing", `object "${TYPE_NAME}"`); ready = false;
    } else {
      type = await shade.createObjectType(drive.id, TYPE_NAME, DESCRIBE.type);
      say("created", `object "${TYPE_NAME}"`);
    }
  }

  /* ---- its columns */
  if (type) {
    const wanted = [
      { column_name: COLUMN.guid, column_type: "str", description: DESCRIBE[COLUMN.guid] },
      { column_name: COLUMN.file, column_type: "relation", description: DESCRIBE[COLUMN.file],
        relation_config: { target: { kind: "asset" } } },
      { column_name: COLUMN.exports, column_type: "relation", description: DESCRIBE[COLUMN.exports],
        relation_config: { target: { kind: "asset" } } }
    ];
    const toAdd = [];
    for (const w of wanted) {
      const c = (type.columns || []).find((x) => x.column_name === w.column_name && !x.archive);
      const label = `column "${w.column_name}" on ${type.name}`;
      if (!c) { toAdd.push(w); continue; }
      const t = columnTarget(c);
      if (c.column_type !== w.column_type || (w.relation_config && (!t || t.kind !== "asset"))) {
        say("CONFLICT", label, `is ${c.column_type}, needs ${w.column_type}${w.relation_config ? " to assets" : ""}`);
        ready = false;
      } else {
        say("ok", label);
      }
    }
    if (toAdd.length) {
      if (check) { toAdd.forEach((w) => say("missing", `column "${w.column_name}" on ${type.name}`)); ready = false; }
      else {
        await shade.addObjectColumns(drive.id, type.id, toAdd);
        toAdd.forEach((w) => say("created", `column "${w.column_name}" on ${type.name}`));
      }
    }
  }

  /* ---- asset fields */
  const wantedFields = [
    { column_name: FIELD.imported, column_type: "bool", description: DESCRIBE[FIELD.imported] },
    { column_name: FIELD.used, column_type: "bool", description: DESCRIBE[FIELD.used] },
    { column_name: FIELD.projectMedia, column_type: "relation", description: DESCRIBE[FIELD.projectMedia],
      relation_config: { target: { kind: "asset" } } }
  ];
  if (!projectsField && type) {
    wantedFields.push({
      column_name: FIELD.projects, column_type: "relation", description: DESCRIBE[FIELD.projects],
      relation_config: {
        target: { kind: "custom_object", database_id: type.id },
        inverse: { enabled: true, name: INVERSE_NAME }
      }
    });
  } else if (!projectsField) {
    say("missing", `field "${FIELD.projects}"`, `two-way, to ${TYPE_NAME}`); ready = false;
  }

  const toCreate = [];
  for (const w of wantedFields) {
    const f = field(w.column_name);
    const label = `field "${w.column_name}"`;
    if (!f) { toCreate.push(w); continue; }
    const t = targetOf(f);
    if (f.value_type !== w.column_type || (w.relation_config && (!t || t.kind !== "asset"))) {
      say("CONFLICT", label, `is ${f.value_type}, needs ${w.column_type}${w.relation_config ? " to assets" : ""}`);
      ready = false;
    } else {
      say("ok", label);
    }
  }
  if (toCreate.length) {
    if (check) {
      toCreate.forEach((w) => say("missing", `field "${w.column_name}"`, w.relation_config && w.relation_config.inverse ? "two-way" : ""));
      ready = false;
    } else {
      await shade.addAssetFields(drive.id, toCreate);
      toCreate.forEach((w) => say("created", `field "${w.column_name}"`,
        w.relation_config && w.relation_config.inverse ? `two-way, mirrored as "${INVERSE_NAME}" on ${type.name}` : ""));
    }
  }

  /* ---- an existing Projects Used In must be two-way */
  if (projectsField && type) {
    const fresh = await shade.getObjectType(drive.id, type.id);
    const mirror = (fresh.columns || []).find((c) => c.paired_to && c.paired_to.column_id === projectsField.id);
    if (mirror) {
      say("ok", `field "${FIELD.projects}"`, `two-way, mirrored as "${mirror.column_name}" on ${type.name}`);
    } else {
      say("WARN", `field "${FIELD.projects}"`,
        `is one-way, so ${type.name} has no "${INVERSE_NAME}" column. Tracking works; ` +
        `to get the column, re-create it two-way (the migration is in CLAUDE.md)`);
    }
  }

  return { ready, lines };
}

module.exports = { setup, TYPE_NAME, LINK_FIELDS };
