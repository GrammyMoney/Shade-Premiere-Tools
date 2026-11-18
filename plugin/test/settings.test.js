const test = require("node:test");
const assert = require("node:assert");
const { setPlatform } = require("../platform.js");
const settings = require("../settings.js");

test("defaults: auto-pinning on import, linking off", () => {
  assert.deepStrictEqual(settings.parse(null), { autoPin: true, pinWhen: "import", linking: false });
});

test("saved values win; junk and unknown keys are ignored", () => {
  // "tracking" and "sourceComments" are Shade Premiere Tools settings: dropped here.
  assert.deepStrictEqual(settings.parse('{"tracking": true, "linking": true, "autoPin": "yes", "extra": 1, "sourceComments": "always"}'),
                         { autoPin: true, pinWhen: "import", linking: true });
  assert.strictEqual(settings.parse('{"pinWhen": "timeline"}').pinWhen, "timeline");
  assert.strictEqual(settings.parse('{"pinWhen": "export"}').pinWhen, "import");
  assert.deepStrictEqual(settings.parse("not json"), settings.DEFAULTS);
});

test("set saves, notifies, and survives a reload", async () => {
  const files = {};
  setPlatform({ readData: async (n) => files[n] || null, writeData: async (n, t) => { files[n] = t; },
                echo() {} });
  await settings.load();
  const seen = [];
  settings.onChange((k, v) => seen.push([k, v]));
  await settings.set("linking", true);
  await settings.set("linking", true);          // no change: no write, no event
  assert.deepStrictEqual(seen, [["linking", true]]);
  await settings.load();
  assert.strictEqual(settings.get("linking"), true);
  await assert.rejects(settings.set("nope", true));
  await assert.rejects(settings.set("tracking", true));
  await settings.set("pinWhen", "timeline");
  assert.strictEqual(settings.get("pinWhen"), "timeline");
  await assert.rejects(settings.set("pinWhen", "never"));
});
