/*
 * Make a drive ready for proxy linking, or say what it lacks:
 *   Linked Proxy and Linked Hi Res   one-way relations to assets, so
 *                                    neither fills in the other
 *   "Make SPT Proxies"               the automation that fills them
 *                                    (proxyflow.js), created and activated
 *                                    only when no automation has that name
 *
 * Called by the panel: switching linking on checks (check mode), then asks
 * in a dialog before creating anything (enable.js).
 *
 * Idempotent: everything is looked up first and only what is missing is
 * created, so running it again is the health check. It never modifies or
 * removes anything that exists. A field with the right name but the wrong
 * type is reported as a conflict for a person to resolve.
 */

const shade = require("./shade.js");
const proxyflow = require("./proxyflow.js");

const LINK_FIELDS = { proxy: "Linked Proxy", hiRes: "Linked Hi Res" };   // as link.js

const DESCRIBE = {
  [LINK_FIELDS.proxy]: "On a hi-res file: its proxy. SPT Lite attaches it in Premiere on import.",
  [LINK_FIELDS.hiRes]: "On a proxy: its hi-res file. SPT Lite attaches it in Premiere on import."
};

const targetOf = (f) => (f && f.relation_config && f.relation_config.target) || null;

/*
 * Returns { ready, lines } -- one line per item: "ok", "created", "missing"
 * (in check mode), or "CONFLICT"/"WARN" with what to do.
 */
async function setup(drive, { check = false } = {}) {
  const fields = ((await shade.listFields(drive.id)) || [])
    .filter((f) => !f.archived && !f.deleted && f.location === "custom");
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
  if (!(await setupProxyAutomation(drive, check, say, ready))) ready = false;
  return { ready, lines };
}

const AUTOMATION_NOTE = `makes a ${proxyflow.PRESET} proxy in a "proxies" folder next to the clip and links the two; ` +
  "you run it from Shade";

const listOf = (r) => (Array.isArray(r) ? r : (r && (r.items || r.automations || r.data)) || []);

/* The workspace a drive belongs to (the integration catalog is per workspace). */
async function workspaceOf(driveId) {
  for (const w of (await shade.listWorkspaces()) || []) {
    const drives = await shade.listDrives(w.id).catch(() => []);
    if ((drives || []).some((d) => d.id === driveId)) return w.id;
  }
  return null;
}

/* An automation's newest version number, from GET /automations/{id}. */
function versionOf(a) {
  const nums = [a && a.version && a.version.version, a && a.active_version && a.active_version.version]
    .concat(((a && a.versions) || []).map((v) => v && v.version))
    .filter((n) => typeof n === "number");
  return nums.length ? Math.max(...nums) : 1;
}

/*
 * "Make SPT Proxies": left alone if an automation of that exact name exists
 * (whatever it does: the name is the standard), else created, filled and
 * activated. A failure after the create deletes it again, or the reserved
 * name would make every later setup skip a broken half-made automation.
 * Resolves true when the drive has it.
 */
async function setupProxyAutomation(drive, check, say, fieldsReady) {
  const label = `automation "${proxyflow.NAME}"`;
  const existing = listOf(await shade.listAutomations(drive.id)).find((a) => a && a.name === proxyflow.NAME);
  if (existing) {
    if (existing.status && existing.status !== "ACTIVE") {
      say("WARN", label, `exists but is ${existing.status}; activate it in Shade`);
    } else {
      say("ok", label);
    }
    return true;
  }
  if (check) { say("missing", label, AUTOMATION_NOTE); return false; }
  if (!fieldsReady) {
    say("CONFLICT", label, "not created: the link fields above need fixing first");
    return false;
  }

  // Field ids as they are now (they may have just been created).
  const fields = ((await shade.listFields(drive.id)) || []).filter((f) => !f.archived && !f.deleted && f.location === "custom");
  const id = (name) => (fields.find((f) => f.name === name) || {}).id;
  const linkedProxyId = id(LINK_FIELDS.proxy);
  const linkedHiResId = id(LINK_FIELDS.hiRes);
  if (!linkedProxyId || !linkedHiResId) {
    say("CONFLICT", label, "not created: Linked Proxy / Linked Hi Res not found after creating them");
    return false;
  }
  const workspaceId = await workspaceOf(drive.id);
  const catalog = workspaceId ? await shade.listIntegrations(workspaceId, drive.id) : [];
  const integ = proxyflow.findShadeIntegration(listOf(catalog));
  if (!integ.id) {
    say("CONFLICT", label, `not created: Shade's automation catalog lacks ${integ.missing.join(", ")}`);
    return false;
  }

  const made = await shade.createAutomation(drive.id, proxyflow.NAME, proxyflow.DESCRIPTION);
  try {
    const graph = proxyflow.buildGraph({ integrationId: integ.id, linkedProxyId, linkedHiResId });
    await shade.saveAutomation(made.id, { name: proxyflow.NAME, description: proxyflow.DESCRIPTION, ...graph });
    const saved = await shade.getAutomation(made.id);
    await shade.setAutomationStatus(made.id, versionOf(saved), "ACTIVE");
  } catch (e) {
    await shade.deleteAutomation(made.id).catch(() => {});
    throw e;
  }
  say("created", label, `active; ${AUTOMATION_NOTE}`);
  return true;
}

module.exports = { setup, LINK_FIELDS, versionOf };
