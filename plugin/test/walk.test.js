const test = require("node:test");
const assert = require("node:assert");
const { projectDisplayName } = require("../walk.js");

test("project names drop the .prproj extension, and only that", () => {
  assert.strictEqual(projectDisplayName("New Tracker.prproj"), "New Tracker");
  assert.strictEqual(projectDisplayName("Cut v2.PRPROJ"), "Cut v2");
  assert.strictEqual(projectDisplayName("my.prproj.notes"), "my.prproj.notes");
  assert.strictEqual(projectDisplayName(".prproj"), null);
  assert.strictEqual(projectDisplayName(null), null);
});
