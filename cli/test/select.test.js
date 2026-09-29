const test = require("node:test");
const assert = require("node:assert");
const { isProjectFile, relPath, baseName, mergeByGuid } = require("../select.js");

const D = "72454409-8db3-4aba-86f4-53d3d5948b5a";

test("prproj files count, case-insensitively", () => {
  assert.ok(isProjectFile({ path: `/${D}/Projects/a.prproj`, extension: "prproj" }));
  assert.ok(isProjectFile({ path: `/${D}/Projects/A.PRPROJ`, extension: "PRPROJ" }));
  assert.ok(!isProjectFile({ path: `/${D}/a.png`, extension: "png" }));
});

test("auto-saves never count: they share the real project's id", () => {
  assert.ok(!isProjectFile({
    path: `/${D}/Projects/Adobe Premiere Pro Auto-Save/New Tracker--760c-2026-09-29_10-03-29.prproj`,
    extension: "prproj"
  }));
});

test("relPath strips the drive id prefix", () => {
  assert.strictEqual(relPath(D, `/${D}/Projects/a b.prproj`), "/Projects/a b.prproj");
});

test("baseName is what Premiere calls the project", () => {
  assert.strictEqual(baseName("/Projects/New Tracker.prproj"), "New Tracker.prproj");
});

test("copies with one id merge: newest names it, use is OR-ed", () => {
  const merged = mergeByGuid([
    { entry: { path: "/old.prproj", updated: "2026-09-29T10:00:00Z" },
      project: { guid: "g", files: [{ mediaPath: "/Volumes/D/a.mov", itemCount: 1, used: true }] } },
    { entry: { path: "/new.prproj", updated: "2026-09-29T11:00:00Z" },
      project: { guid: "g", files: [
        { mediaPath: "/Volumes/D/a.mov", itemCount: 2, used: false },
        { mediaPath: "/Volumes/D/b.mov", itemCount: 1, used: false }] } },
    { entry: { path: "/other.prproj", updated: "2026-09-29T09:00:00Z" },
      project: { guid: "h", files: [] } }
  ]);
  assert.strictEqual(merged.length, 2);
  const g = merged.find((m) => m.guid === "g");
  assert.strictEqual(g.primary.path, "/new.prproj");
  assert.strictEqual(g.copies, 2);
  const a = g.files.find((f) => f.mediaPath.endsWith("a.mov"));
  assert.strictEqual(a.used, true);
  assert.strictEqual(a.itemCount, 2);
  assert.strictEqual(g.files.length, 2);
});
