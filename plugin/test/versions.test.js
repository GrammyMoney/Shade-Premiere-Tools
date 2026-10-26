const test = require("node:test");
const assert = require("node:assert");
const { sanitize, baseName, versionOf, nextVersion, fileName, mergeExports,
        snapshotName, stripVersion } = require("../versions.js");

test("names: project and timeline, unsafe characters dropped, .prproj stripped", () => {
  assert.strictEqual(baseName("Measuring Tape.prproj", "Main Cut"), "Measuring Tape_Main Cut");
  assert.strictEqual(sanitize('a/b:c*?"<>|d  e'), "abcd e");
  assert.strictEqual(sanitize("   "), "Untitled");
  assert.strictEqual(fileName("A_B", 3, ".mp4"), "A_B_V03.mp4");
  assert.strictEqual(fileName("A_B", 100, "mp4"), "A_B_V100.mp4");
});

test("next version: one past the highest, gaps kept, other timelines ignored", () => {
  const base = "Tape_Main Cut";
  assert.strictEqual(nextVersion(base, []), 1);
  assert.strictEqual(nextVersion(base, ["Tape_Main Cut_V01.mp4", "Tape_Main Cut_V04.mp4"]), 5);
  assert.strictEqual(nextVersion(base, ["tape_main cut_v02.MP4"]), 3);           // case folds
  assert.strictEqual(nextVersion(base, ["Tape_Main Cut_V99.mp4"]), 100);
  assert.strictEqual(nextVersion(base, ["Tape_Teaser_V07.mp4", "Tape_Main Cut 2_V09.mp4",
                                         "Tape_Main Cut_V1.mp4", "notes.txt"]), 1);
  assert.strictEqual(versionOf("Tape_Main Cut_V12", base), 12);
});

test("exports merge: this timeline's entry is swapped in place, others kept", () => {
  assert.deepStrictEqual(mergeExports(["a1", "b1"], "a1", "a2"), ["a2", "b1"]);
  assert.deepStrictEqual(mergeExports(["b1"], null, "a1"), ["b1", "a1"]);
  assert.deepStrictEqual(mergeExports(["b1"], "gone", "a2"), ["b1", "a2"]);
  assert.deepStrictEqual(mergeExports(["a2", "b1"], "a1", "a2"), ["a2", "b1"]);    // no duplicate
});

test("version timelines: named for the timeline, and back again", () => {
  assert.strictEqual(snapshotName("Main Cut", 3), "Main Cut_V03");
  assert.strictEqual(snapshotName("A/B", 100), "AB_V100");
  assert.strictEqual(stripVersion("Main Cut_V03"), "Main Cut");
  assert.strictEqual(stripVersion("Main Cut_V100"), "Main Cut");
  assert.strictEqual(stripVersion("Interview_Vox"), "Interview_Vox");          // not a version
  assert.strictEqual(stripVersion("Take_V1"), "Take_V1");                      // one digit isn't ours
});
