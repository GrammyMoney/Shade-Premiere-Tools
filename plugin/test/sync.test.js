/*
 * sync.run against a stubbed Shade: only the drive the project is saved on
 * is tracked; Shade clips from another drive are counted, never written.
 */
const test = require("node:test");
const assert = require("node:assert");
const { setPlatform } = require("../platform.js");
setPlatform({ readData: async () => null, writeData: async () => {}, echo() {}, fileSize: async () => null });
const shade = require("../shade.js");
const resolve = require("../resolve.js");
const sync = require("../sync.js");

const HOME = "home-drive", OTHER = "other-drive";
resolve.rememberVolume("/Volumes/Home", HOME, "Home");
resolve.rememberVolume("/Volumes/Other", OTHER, "Other");

const calls = { lookups: [], writes: [], created: [], schemaOf: [] };
Object.assign(shade, {
  assetByPath: async (driveId, path) => {
    calls.lookups.push(driveId);
    return { id: "asset:" + path, name: path.split("/").pop(), custom_metadata: {} };
  },
  listFields: async (driveId) => {
    calls.schemaOf.push(driveId);
    return [
      { id: "f-imp", name: "Imported?", value_type: "bool", location: "custom" },
      { id: "f-used", name: "Used?", value_type: "bool", location: "custom" },
      { id: "f-proj", name: "Projects Used In", value_type: "relation", location: "custom",
        relation_config: { target: { kind: "custom_object", database_id: "t" } } }
    ];
  },
  getObjectType: async () => ({ id: "t", name: "Premiere Projects", columns: [
    { id: "c-guid", column_name: "Project GUID", column_type: "str" },
    { id: "c-file", column_name: "Project File", column_type: "relation" }
  ] }),
  listAllRecords: async () => [],
  getRecord: async () => null,
  createRecord: async (driveId, typeId, body) => {
    calls.created.push(driveId);
    return { id: "rec-" + driveId, name: body.name, metadata_values: [] };
  },
  patchRecord: async () => ({}),
  putAssetValues: async (driveId, rows) => { calls.writes.push({ driveId, rows }); return []; }
});

test("clips on another Shade drive are counted, not tracked", async () => {
  const summary = await sync.run({
    guid: "g1", name: "Cut.prproj", path: "/Volumes/Home/Projects/Cut.prproj",
    files: [
      { mediaPath: "/Volumes/Home/Media/a.mp4", used: true },
      { mediaPath: "/Volumes/Other/Media/b.mp4", used: true },
      { mediaPath: "/Volumes/Other/Media/c.mp4", used: false },
      { mediaPath: "/Users/me/Desktop/local.mov", used: false }
    ]
  });

  assert.strictEqual(summary.status, "tracked");
  assert.deepStrictEqual(summary.otherDrives, { [OTHER]: 2 });
  assert.strictEqual(summary.onShade, 1);
  assert.strictEqual(summary.written, 1);
  assert.strictEqual(summary.skipped, 1);                     // the local file
  assert.deepStrictEqual(summary.needsSetup, []);

  // Nothing at all went to the other drive: no lookup, schema, record or write.
  assert.ok(!calls.lookups.includes(OTHER));
  assert.ok(!calls.schemaOf.includes(OTHER));
  assert.deepStrictEqual(calls.created, [HOME]);
  assert.deepStrictEqual(calls.writes.map((w) => w.driveId), [HOME]);
  assert.deepStrictEqual(calls.writes[0].rows.map((r) => r.asset_id), ["asset:/home-drive/Media/a.mp4"]);
});
