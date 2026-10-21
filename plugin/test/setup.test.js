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

/* A fake drive: asset fields, object types, and a record of what was created. */
function fakeDrive({ fields = [], types = [] } = {}) {
  const made = { types: [], columns: [], fields: [] };
  Object.assign(shade, {
    listFields: async () => fields,
    listObjectTypes: async () => types.map((t) => ({ id: t.id, name: t.name })),
    getObjectType: async (d, id) => types.find((t) => t.id === id),
    createObjectType: async (d, name) => {
      const t = { id: "new-type", name, columns: [] };
      types.push(t); made.types.push(name); return t;
    },
    addObjectColumns: async (d, id, cols) => { made.columns.push(...cols.map((c) => c.column_name)); },
    addAssetFields: async (d, cols) => { made.fields.push(...cols); }
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
  assert.deepStrictEqual(made, { types: [], columns: [], fields: [] });
});

test("check mode reports and creates nothing", async () => {
  const made = fakeDrive();
  const { ready, lines } = await setup(DRIVE, { feature: "tracking", check: true });
  assert.strictEqual(ready, false);
  assert.ok(lines.some((l) => l.state === "missing" && l.what === `object "${TYPE_NAME}"`));
  assert.deepStrictEqual(made, { types: [], columns: [], fields: [] });
});

test("linking: lists both link fields, creates them one-way to assets", async () => {
  let made = fakeDrive();
  const checked = await setup(DRIVE, { feature: "linking", check: true });
  assert.deepStrictEqual(checked.lines.map((l) => l.what), ['field "Linked Proxy"', 'field "Linked Hi Res"']);
  assert.deepStrictEqual(made.fields, []);

  made = fakeDrive();
  const { ready } = await setup(DRIVE, { feature: "linking" });
  assert.ok(ready);
  assert.deepStrictEqual(made.fields.map((f) => f.column_name), ["Linked Proxy", "Linked Hi Res"]);
  for (const f of made.fields) {
    assert.deepStrictEqual(f.relation_config, { target: { kind: "asset" } });   // no inverse
  }
});

test("linking: a drive that has them is ready; a wrong type is a conflict", async () => {
  fakeDrive({ fields: [custom("Linked Proxy", "relation", { kind: "asset" }),
                       custom("Linked Hi Res", "relation", { kind: "asset" })] });
  assert.ok((await setup(DRIVE, { feature: "linking", check: true })).ready);

  const made = fakeDrive({ fields: [custom("Linked Proxy", "str")] });
  const { ready, lines } = await setup(DRIVE, { feature: "linking" });
  assert.strictEqual(ready, false);
  assert.ok(lines.some((l) => l.state === "CONFLICT" && l.what === 'field "Linked Proxy"'));
  assert.deepStrictEqual(made.fields.map((f) => f.column_name), ["Linked Hi Res"]);
});
