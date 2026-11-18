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
const { setup } = require("../setup.js");

const DRIVE = { id: "d1", name: "Test Drive" };

const SHADE_CATALOG = [{ id: "shade", triggers: [{ operation: "manually_triggered" }],
                         actions: [{ operation: "generate_proxy" }, { operation: "update_asset_metadata" }] }];

/*
 * A fake drive: asset fields, automations, and a record of
 * what was created. `made.calls` lists automation calls in order.
 */
function fakeDrive({ fields = [], automations = [], catalog = SHADE_CATALOG, failPut = false } = {}) {
  const made = { fields: [], calls: [] };
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

test("lists both link fields and the automation, then creates all three", async () => {
  let made = fakeDrive();
  const checked = await setup(DRIVE, { check: true });
  assert.deepStrictEqual(checked.lines.map((l) => l.what),
    ['field "Linked Proxy"', 'field "Linked Hi Res"', 'automation "Make SPT Proxies"']);
  assert.deepStrictEqual(made.fields, []);
  assert.deepStrictEqual(made.calls, []);                                  // check mode touches nothing

  made = fakeDrive();
  const { ready } = await setup(DRIVE);
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

test("an automation with the exact name is left alone, whatever its status", async () => {
  const fields = [custom("Linked Proxy", "relation", { kind: "asset" }), custom("Linked Hi Res", "relation", { kind: "asset" })];
  let made = fakeDrive({ fields: fields.slice(), automations: [{ id: "x", name: "Make SPT Proxies", status: "ACTIVE" }] });
  assert.ok((await setup(DRIVE)).ready);
  assert.deepStrictEqual(made.calls, []);

  made = fakeDrive({ fields: fields.slice(), automations: [{ id: "x", name: "Make SPT Proxies", status: "DRAFT" }] });
  const { lines } = await setup(DRIVE);
  assert.ok(lines.some((l) => l.state === "WARN" && /DRAFT/.test(l.note)));
  assert.deepStrictEqual(made.calls, []);

  // A similar automation under another name doesn't count: ours is still made.
  made = fakeDrive({ fields: fields.slice(), automations: [{ id: "y", name: "Proxy + Relational Link", status: "ACTIVE" }] });
  await setup(DRIVE);
  assert.ok(made.calls.some((c) => c[0] === "create"));
});

test("a failed save deletes the half-made automation", async () => {
  const made = fakeDrive({ failPut: true });
  await assert.rejects(setup(DRIVE), /PUT refused/);
  assert.deepStrictEqual(made.calls.map((c) => c[0]), ["catalog", "create", "save", "delete"]);
});

test("a catalog without the operations is a conflict, and nothing is created", async () => {
  const made = fakeDrive({ catalog: [{ id: "shade", triggers: ["manually_triggered"], actions: ["update_asset_metadata"] }] });
  const { ready, lines } = await setup(DRIVE);
  assert.strictEqual(ready, false);
  assert.ok(lines.some((l) => l.state === "CONFLICT" && /generate_proxy/.test(l.note)));
  assert.ok(!made.calls.some((c) => c[0] === "create"));
});

test("a drive that has the fields is ready only with the automation; a wrong type is a conflict", async () => {
  const fields = () => [custom("Linked Proxy", "relation", { kind: "asset" }), custom("Linked Hi Res", "relation", { kind: "asset" })];
  fakeDrive({ fields: fields() });
  assert.strictEqual((await setup(DRIVE, { check: true })).ready, false);
  fakeDrive({ fields: fields(), automations: [{ name: "Make SPT Proxies", status: "ACTIVE" }] });
  assert.ok((await setup(DRIVE, { check: true })).ready);

  const made = fakeDrive({ fields: [custom("Linked Proxy", "str")] });
  const { ready, lines } = await setup(DRIVE);
  assert.strictEqual(ready, false);
  assert.ok(lines.some((l) => l.state === "CONFLICT" && l.what === 'field "Linked Proxy"'));
  assert.deepStrictEqual(made.fields.map((f) => f.column_name), ["Linked Hi Res"]);
  assert.ok(lines.some((l) => l.state === "CONFLICT" && l.what === 'automation "Make SPT Proxies"'));
  assert.ok(!made.calls.some((c) => c[0] === "create"));
});
