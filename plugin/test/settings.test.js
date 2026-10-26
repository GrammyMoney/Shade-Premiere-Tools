const test = require("node:test");
const assert = require("node:assert");
const { setPlatform } = require("../platform.js");
const settings = require("../settings.js");

test("defaults: auto-pinning on, tracking and linking off", () => {
  assert.deepStrictEqual(settings.parse(null), { autoPin: true, tracking: false, linking: false, sourceComments: "ask" });
});

test("saved values win; junk and unknown keys are ignored", () => {
  assert.deepStrictEqual(settings.parse('{"tracking": true, "autoPin": "yes", "extra": 1, "sourceComments": "always"}'),
                         { autoPin: true, tracking: true, linking: false, sourceComments: "always" });
  assert.strictEqual(settings.parse('{"sourceComments": "sometimes"}').sourceComments, "ask");
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
  await settings.set("sourceComments", "never");
  assert.strictEqual(settings.get("sourceComments"), "never");
  await assert.rejects(settings.set("sourceComments", true));
});
