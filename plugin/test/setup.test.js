/*
 * setup.js against a stubbed Shade: what it creates, and what it refuses to
 * adopt. The REST client is replaced function by function; setup.js looks
 * each one up at call time.
 */
const test = require("node:test");
const assert = require("node:assert");
const { setPlatform } = require("../platform.js");
setPlatform({ readData: async () => null, writeData: async () => {}, echo() {} });
const shade = require("../shade.js");
const { setup, TYPE_NAME } = require("../setup.js");

const DRIVE = { id: "d1", name: "Test Drive" };

const SHADE_CATALOG = [{ id: "shade", triggers: [{ operation: "manually_triggered" }],
                         actions: [{ operation: "generate_proxy" }, { operation: "update_asset_metadata" }] }];

/*
 * A fake drive: asset fields, object types, automations, and a record of
 * what was created. `made.calls` lists automation calls in order.
 */
function fakeDrive({ fields = [], types = [], automations = [], catalog = SHADE_CATALOG, failPut = false } = {}) {
  const made = { types: [], columns: [], fields: [], calls: [] };
  Object.assign(shade, {
    listWorkspaces: async () => [{ id: "ws1" }],
    listDrives: async () => [{ id: DRIVE.id }],
    listIntegrations: async (w, d) => { made.calls.push(["catalog", w, d]); return catalog; },
    listAutomations: async () => automations,
    createAutomation: async (d, name) => { made.calls.push(["create", name]); return { id: "auto-1", name }; },
    saveAutomation: async (id, body) => {
      made.calls.push(["save", id, body.nodes.length, body.edges.length]);
      made.graph = body;
      if (failPut) throw new Error("PUT refused");
    },
    getAutomation: async () => ({ id: "auto-1", versions: [{ version: 1 }] }),
    setAutomationStatus: async (id, v, status) => { made.calls.push(["status", id, v, status]); },
    deleteAutomation: async (id) => { made.calls.push(["delete", id]); },
    listFields: async () => fields,
    listObjectTypes: async () => types.map((t) => ({ id: t.id, name: t.name })),
    getObjectType: async (d, id) => types.find((t) => t.id === id),
    createObjectType: async (d, name) => {
      const t = { id: "new-type", name, columns: [] };
      types.push(t); made.types.push(name); return t;
    },
    addObjectColumns: async (d, id, cols) => { made.columns.push(...cols.map((c) => c.column_name)); },
    addAssetFields: async (d, cols) => {
      made.fields.push(...cols);
      for (const c of cols) fields.push({ id: "f-" + c.column_name, name: c.column_name, value_type: c.column_type,
                                          location: "custom", relation_config: c.relation_config });
    }
  });
  return made;
}

const custom = (name, value_type, target) => ({
  id: "f-" + name, name, value_type, location: "custom",
  relation_config: target ? { target } : null
});

test("a fresh drive gets \"Premiere Projects\", never a bare \"Projects\"", async () => {
  const made = fakeDrive();
  const { ready } = await setup(DRIVE, { feature: "tracking" });
  assert.ok(ready);
  assert.deepStrictEqual(made.types, [TYPE_NAME]);
  assert.strictEqual(TYPE_NAME, "Premiere Projects");
  assert.deepStrictEqual(made.columns, ["Project GUID", "Project File", "Exports"]);
  const two = made.fields.find((f) => f.column_name === "Projects Used In");
  assert.strictEqual(two.relation_config.target.database_id, "new-type");
  assert.strictEqual(two.relation_config.inverse.enabled, true);
});

test("a customer's own \"Projects\" object is not adopted", async () => {
  const made = fakeDrive({ types: [{ id: "theirs", name: "Projects", columns: [] }] });
  await setup(DRIVE, { feature: "tracking" });
  assert.deepStrictEqual(made.types, [TYPE_NAME]);
  assert.ok(made.fields.every((f) => !f.relation_config || !f.relation_config.target ||
                                     f.relation_config.target.database_id !== "theirs"));
});

test("Projects Used In pointing at another object is a conflict, and nothing is created", async () => {
  const made = fakeDrive({
    fields: [custom("Projects Used In", "relation", { kind: "custom_object", database_id: "theirs" })],
    types: [{ id: "theirs", name: "Projects", columns: [] }]
  });
  const { ready, lines } = await setup(DRIVE, { feature: "tracking" });
  assert.strictEqual(ready, false);
  assert.ok(lines.some((l) => l.state === "CONFLICT" && /not "Premiere Projects"/.test(l.note)));
  assert.deepStrictEqual(made, { types: [], columns: [], fields: [], calls: [] });
});

test("a drive set up before Exports existed is asked for just that column", async () => {
  const cols = [{ id: "c1", column_name: "Project GUID", column_type: "str" },
                { id: "c2", column_name: "Project File", column_type: "relation",
                  display_metadata: { relation_config: { target: { kind: "asset" } } } }];
  const made = fakeDrive({
    fields: [custom("Imported?", "bool"), custom("Used?", "bool"),
             custom("Project Media", "relation", { kind: "asset" }),
             custom("Projects Used In", "relation", { kind: "custom_object", database_id: "pp" })],
    types: [{ id: "pp", name: TYPE_NAME, columns: cols }]
  });
  const { ready, lines } = await setup(DRIVE, { feature: "tracking", check: true });
  assert.strictEqual(ready, false);
  assert.deepStrictEqual(lines.filter((l) => l.state === "missing").map((l) => l.what),
                         [`column "Exports" on ${TYPE_NAME}`]);
  assert.deepStrictEqual(made, { types: [], columns: [], fields: [], calls: [] });
});

test("check mode reports and creates nothing", async () => {
  const made = fakeDrive();
  const { ready, lines } = await setup(DRIVE, { feature: "tracking", check: true });
  assert.strictEqual(ready, false);
  assert.ok(lines.some((l) => l.state === "missing" && l.what === `object "${TYPE_NAME}"`));
  assert.deepStrictEqual(made, { types: [], columns: [], fields: [], calls: [] });
});

test("linking: lists both link fields and the automation, then creates all three", async () => {
  let made = fakeDrive();
  const checked = await setup(DRIVE, { feature: "linking", check: true });
  assert.deepStrictEqual(checked.lines.map((l) => l.what),
    ['field "Linked Proxy"', 'field "Linked Hi Res"', 'automation "Make SPT Proxies"']);
  assert.deepStrictEqual(made.fields, []);
  assert.deepStrictEqual(made.calls, []);                                  // check mode touches nothing

  made = fakeDrive();
  const { ready } = await setup(DRIVE, { feature: "linking" });
  assert.ok(ready);
  assert.deepStrictEqual(made.fields.map((f) => f.column_name), ["Linked Proxy", "Linked Hi Res"]);
  for (const f of made.fields) {
    assert.deepStrictEqual(f.relation_config, { target: { kind: "asset" } });   // no inverse
  }
  // Fields first, then: catalog, create, save the graph, activate. In that order.
  assert.deepStrictEqual(made.calls, [["catalog", "ws1", DRIVE.id], ["create", "Make SPT Proxies"],
    ["save", "auto-1", 4, 3], ["status", "auto-1", 1, "ACTIVE"]]);
  const meta = made.graph.nodes.slice(2).map((n) => Object.keys(n.config.metadata)[0]);
  assert.deepStrictEqual(meta, ["f-Linked Proxy", "f-Linked Hi Res"]);   // the drive's own field ids
  assert.ok(made.graph.nodes.every((n) => n.integration_id === "shade"));
});

test("linking: an automation with the exact name is left alone, whatever its status", async () => {
  const fields = [custom("Linked Proxy", "relation", { kind: "asset" }), custom("Linked Hi Res", "relation", { kind: "asset" })];
  let made = fakeDrive({ fields: fields.slice(), automations: [{ id: "x", name: "Make SPT Proxies", status: "ACTIVE" }] });
  assert.ok((await setup(DRIVE, { feature: "linking" })).ready);
  assert.deepStrictEqual(made.calls, []);

  made = fakeDrive({ fields: fields.slice(), automations: [{ id: "x", name: "Make SPT Proxies", status: "DRAFT" }] });
  const { lines } = await setup(DRIVE, { feature: "linking" });
  assert.ok(lines.some((l) => l.state === "WARN" && /DRAFT/.test(l.note)));
  assert.deepStrictEqual(made.calls, []);

  // A similar automation under another name doesn't count: ours is still made.
  made = fakeDrive({ fields: fields.slice(), automations: [{ id: "y", name: "Proxy + Relational Link", status: "ACTIVE" }] });
  await setup(DRIVE, { feature: "linking" });
  assert.ok(made.calls.some((c) => c[0] === "create"));
});

test("linking: a failed save deletes the half-made automation", async () => {
  const made = fakeDrive({ failPut: true });
  await assert.rejects(setup(DRIVE, { feature: "linking" }), /PUT refused/);
  assert.deepStrictEqual(made.calls.map((c) => c[0]), ["catalog", "create", "save", "delete"]);
});

test("linking: a catalog without the operations is a conflict, and nothing is created", async () => {
  const made = fakeDrive({ catalog: [{ id: "shade", triggers: ["manually_triggered"], actions: ["update_asset_metadata"] }] });
  const { ready, lines } = await setup(DRIVE, { feature: "linking" });
  assert.strictEqual(ready, false);
  assert.ok(lines.some((l) => l.state === "CONFLICT" && /generate_proxy/.test(l.note)));
  assert.ok(!made.calls.some((c) => c[0] === "create"));
});

test("linking: a drive that has the fields is ready only with the automation; a wrong type is a conflict", async () => {
  const fields = () => [custom("Linked Proxy", "relation", { kind: "asset" }), custom("Linked Hi Res", "relation", { kind: "asset" })];
  fakeDrive({ fields: fields() });
  assert.strictEqual((await setup(DRIVE, { feature: "linking", check: true })).ready, false);
  fakeDrive({ fields: fields(), automations: [{ name: "Make SPT Proxies", status: "ACTIVE" }] });
  assert.ok((await setup(DRIVE, { feature: "linking", check: true })).ready);

  const made = fakeDrive({ fields: [custom("Linked Proxy", "str")] });
  const { ready, lines } = await setup(DRIVE, { feature: "linking" });
  assert.strictEqual(ready, false);
  assert.ok(lines.some((l) => l.state === "CONFLICT" && l.what === 'field "Linked Proxy"'));
  assert.deepStrictEqual(made.fields.map((f) => f.column_name), ["Linked Hi Res"]);
  assert.ok(lines.some((l) => l.state === "CONFLICT" && l.what === 'automation "Make SPT Proxies"'));
  assert.ok(!made.calls.some((c) => c[0] === "create"));
});
