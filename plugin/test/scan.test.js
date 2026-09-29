const test = require("node:test");
const assert = require("node:assert");
const { collapse } = require("../scan.js");

test("two project items for one file become one file, used if either is", () => {
  const items = new Map([
    ["1", { mediaPath: "/Volumes/D/a.wav", name: "a" }],
    ["2", { mediaPath: "/Volumes/D/a.wav", name: "a copy" }],
    ["3", { mediaPath: "/Volumes/D/b.mov", name: "b" }]
  ]);
  const files = collapse(items, new Set(["2"]));
  assert.strictEqual(files.length, 2);
  const a = files.find((f) => f.mediaPath.endsWith("a.wav"));
  assert.strictEqual(a.itemCount, 2);
  assert.strictEqual(a.used, true);
  assert.strictEqual(files.find((f) => f.mediaPath.endsWith("b.mov")).used, false);
});

test("same basename in different folders stays two files", () => {
  const items = new Map([
    ["1", { mediaPath: "/Volumes/D/shots 2/C0023.MP4", name: "C0023.MP4" }],
    ["2", { mediaPath: "/Volumes/D/shots 3/C0023.MP4", name: "C0023.MP4" }]
  ]);
  assert.strictEqual(collapse(items, new Set()).length, 2);
});
