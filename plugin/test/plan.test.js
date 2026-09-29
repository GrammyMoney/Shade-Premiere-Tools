const test = require("node:test");
const assert = require("node:assert");
const { planAsset, linkedIds, needsWork } = require("../plan.js");

const F = { imported: "f-imp", used: "f-used", projects: "f-proj" };
const link = (id, name = "x") => ({ entity_type: "custom_object", id, name, icon: null, color: null });

test("a fresh asset gets imported and linked, not used", () => {
  const out = planAsset({}, F, "p1", false);
  assert.deepStrictEqual(out, [
    { id: "f-imp", value: true },
    { id: "f-proj", value: [{ id: "p1", type: "custom_object" }] }
  ]);
});

test("used on a timeline sets Used? too", () => {
  const out = planAsset({}, F, "p1", true);
  assert.ok(out.find((v) => v.id === "f-used" && v.value === true));
});

test("never unsets Used?, even when this project does not use it", () => {
  const out = planAsset({ "f-imp": true, "f-used": true, "f-proj": [link("p1")] }, F, "p1", false);
  assert.strictEqual(out, null);
});

test("keeps every existing project link: append is emulated, not trusted", () => {
  const out = planAsset({ "f-imp": true, "f-proj": [link("other-a"), link("other-b")] }, F, "p1", false);
  assert.deepStrictEqual(out, [{
    id: "f-proj",
    value: [
      { id: "other-a", type: "custom_object" },
      { id: "other-b", type: "custom_object" },
      { id: "p1", type: "custom_object" }
    ]
  }]);
});

test("already right means no write at all", () => {
  assert.strictEqual(planAsset({ "f-imp": true, "f-proj": [link("p1")] }, F, "p1", false), null);
});

test("only the missing pieces are sent", () => {
  const out = planAsset({ "f-imp": true, "f-proj": [link("p1")] }, F, "p1", true);
  assert.deepStrictEqual(out, [{ id: "f-used", value: true }]);
});

test("linkedIds tolerates junk and bare ids", () => {
  assert.deepStrictEqual(linkedIds(null), []);
  assert.deepStrictEqual(linkedIds([link("a"), "b", null, 3, {}]), ["a", "b"]);
});

test("needsWork: new, newly used, or nothing", () => {
  assert.strictEqual(needsWork(undefined, false), true);
  assert.strictEqual(needsWork({ used: false }, false), false);
  assert.strictEqual(needsWork({ used: false }, true), true);
  assert.strictEqual(needsWork({ used: true }, false), false);
});
