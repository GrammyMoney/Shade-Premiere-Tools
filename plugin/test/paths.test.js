const test = require("node:test");
const assert = require("node:assert");
const { splitVolume, shadePath, mountRootFor } = require("../paths.js");

test("splits a path on a mounted volume", () => {
  assert.deepStrictEqual(
    splitVolume("/Volumes/Adobe Sandbox/Graphic Design/a b.mov"),
    { root: "/Volumes/Adobe Sandbox", name: "Adobe Sandbox", rest: "/Graphic Design/a b.mov" });
});

test("a file at the volume root still has a rest", () => {
  assert.strictEqual(splitVolume("/Volumes/X/clip.mov").rest, "/clip.mov");
});

test("local disk paths are not ours", () => {
  assert.strictEqual(splitVolume("/Users/alex/Movies/a.mov"), null);
  assert.strictEqual(splitVolume("/Volumes/Macintosh HD/Users/a.mov"), null);
});

test("a bare volume, or garbage, is not a file", () => {
  assert.strictEqual(splitVolume("/Volumes/X"), null);
  assert.strictEqual(splitVolume("/Volumes/X/"), null);
  assert.strictEqual(splitVolume(null), null);
  assert.strictEqual(splitVolume(""), null);
});

test("case is preserved exactly: Shade's lookup is case-sensitive", () => {
  assert.strictEqual(splitVolume("/Volumes/Drive/Shots/C0023.MP4").rest, "/Shots/C0023.MP4");
});

test("shade paths carry the drive id", () => {
  assert.strictEqual(shadePath("abc", "/Graphic Design/a.mov"), "/abc/Graphic Design/a.mov");
});

test("mount root from drive name", () => {
  assert.strictEqual(mountRootFor("Adobe Sandbox"), "/Volumes/Adobe Sandbox");
});

const { projectDisplayName } = require("../paths.js");
test("project names drop the .prproj extension, and only that", () => {
  assert.strictEqual(projectDisplayName("New Tracker.prproj"), "New Tracker");
  assert.strictEqual(projectDisplayName("Cut v2.PRPROJ"), "Cut v2");
  assert.strictEqual(projectDisplayName("my.prproj.notes"), "my.prproj.notes");
  assert.strictEqual(projectDisplayName(".prproj"), null);
  assert.strictEqual(projectDisplayName(null), null);
});
