const test = require("node:test");
const assert = require("node:assert/strict");
const { linkedIds, pinnableIno, decide, fieldByName } = require("../pins.js");

const PROXY_FIELD = "9f75a4fb-9a69-47dc-abdc-fb12f5f01aa5";

// Trimmed from GET /assets/path on the real CG_034 hi-res, 2026-10-07.
const hiRes = {
  id: "ef4deac3-6afc-4c4b-8de2-0e1d030e9712",
  custom_metadata: {
    "a73b9019-de99-4052-b5f8-490aa059131f": false,
    [PROXY_FIELD]: [{ entity_type: "asset", id: "6975f66b-0403-4bbb-a9ac-5e630173f1d2",
                      name: "2023_07_BERLIN_SUMMIT_DAY 2_CG_034_proxy_h264_1080p.mp4",
                      asset_type: "VIDEO", thumbnail_url: null }],
    "a879869c-d146-4d6e-acc2-fd0bbe4ea46f": [{ entity_type: "custom_object", id: "cf8bfe3d", name: "Berlin Summit" }]
  }
};

test("linked proxy ids from the real read shape", () => {
  assert.deepEqual(linkedIds(hiRes, PROXY_FIELD), ["6975f66b-0403-4bbb-a9ac-5e630173f1d2"]);
});

test("other relation shapes, and non-assets ignored", () => {
  assert.deepEqual(linkedIds({ custom_metadata: { f: ["a", "b"] } }, "f"), ["a", "b"]);
  assert.deepEqual(linkedIds({ custom_metadata: { f: { kind: "reference", values: [{ id: "a" }] } } }, "f"), ["a"]);
  assert.deepEqual(linkedIds(hiRes, "a879869c-d146-4d6e-acc2-fd0bbe4ea46f"), []);
  assert.deepEqual(linkedIds({ custom_metadata: {} }, "f"), []);
  assert.deepEqual(linkedIds({}, "f"), []);
  assert.deepEqual(linkedIds(hiRes, null), []);
});

test("the drive root's inode is never pinned", () => {
  assert.equal(pinnableIno(7, 1), true);
  assert.equal(pinnableIno(1, 1), false);
  assert.equal(pinnableIno(0, 1), false);
  assert.equal(pinnableIno(undefined, 1), false);
  assert.equal(pinnableIno(7, null), true);
});

test("an existing proxy is never replaced", () => {
  assert.equal(decide({ hasProxy: true, proxyIds: ["p"] }).attach, false);
  assert.equal(decide({ hasProxy: true, hiResIds: ["h"] }).attach, false);
  assert.equal(decide({ hasProxy: false, proxyIds: [], hiResIds: [] }).attach, false);
});

test("a hi-res gets its proxy; a proxy gets its hi-res, as hi-res", () => {
  assert.deepEqual(decide({ hasProxy: false, proxyIds: ["p", "q"] }),
                   { attach: true, otherId: "p", isHiRes: false });
  assert.deepEqual(decide({ hasProxy: false, proxyIds: [], hiResIds: ["h"] }),
                   { attach: true, otherId: "h", isHiRes: true });
  // Both set: treated as a hi-res.
  assert.equal(decide({ hasProxy: false, proxyIds: ["p"], hiResIds: ["h"] }).isHiRes, false);
});

test("fields are found by name, skipping archived copies", () => {
  const fields = [
    { id: "old", name: "Linked Proxy", archived: true, location: "custom" },
    { id: "sys", name: "Linked Proxy", location: "system" },
    { id: "new", name: "Linked Proxy", location: "custom" }
  ];
  assert.equal(fieldByName(fields, "Linked Proxy").id, "new");
  assert.equal(fieldByName(fields, "Nope"), null);
});

/* ------------------------------------------------------- project pinning */

const { parsePinList, isPinned, tally, formatBytes } = require("../pins.js");

// Trimmed from `pin list` over the bridge, 2026-10-14.
const PIN_LIST = [
  "https://fs.shade.inc/72454409-8db3-4aba-86f4-53d3d5948b5a:SHINE/thumbs/a4/c8/a4c8.jpg",
  "https://fs.shade.inc/72454409-8db3-4aba-86f4-53d3d5948b5a:Arbor Hills/DJI_20240705192353_0269_D.JPG",
  "https://fs.shade.inc/2dac3f0a-60b1-4ccf-9025-896218fa599e:Shade Logos",
  ""
].join("\n");
const SANDBOX = "72454409-8db3-4aba-86f4-53d3d5948b5a";
const DESIGN = "2dac3f0a-60b1-4ccf-9025-896218fa599e";

test("pin list splits at the drive uri, not the colon in https:", () => {
  const pins = parsePinList(PIN_LIST);
  assert.equal(pins.length, 3);
  assert.deepEqual(pins[1], { driveId: SANDBOX, path: "Arbor Hills/DJI_20240705192353_0269_D.JPG" });
  assert.deepEqual(pins[2], { driveId: DESIGN, path: "Shade Logos" });
});

test("pin list ignores noise and empty output", () => {
  assert.deepEqual(parsePinList(""), []);
  assert.deepEqual(parsePinList(null), []);
  assert.deepEqual(parsePinList("Pinned file    Size\n?   2.17 GiB"), []);
});

test("a file is pinned by itself, or by a folder above it", () => {
  const pins = parsePinList(PIN_LIST);
  assert.equal(isPinned(pins, SANDBOX, "/Arbor Hills/DJI_20240705192353_0269_D.JPG"), "self");
  assert.equal(isPinned(pins, DESIGN, "/Shade Logos/SVG/logo.svg"), "folder");
  assert.equal(isPinned(pins, SANDBOX, "/Arbor Hills/other.JPG"), null);
});

test("a file pinned itself and through a folder is a self pin", () => {
  const pins = parsePinList(PIN_LIST + "\nhttps://fs.shade.inc/" + DESIGN + ":Shade Logos/SVG/logo.svg");
  assert.equal(isPinned(pins, DESIGN, "/Shade Logos/SVG/logo.svg"), "self");
});

test("pinned matching folds case but respects folder boundaries and drives", () => {
  const pins = parsePinList(PIN_LIST);
  assert.equal(isPinned(pins, SANDBOX, "/arbor hills/dji_20240705192353_0269_d.jpg"), "self");
  assert.equal(isPinned(pins, DESIGN, "/Shade Logos 2/a.png"), null);
  assert.equal(isPinned(pins, SANDBOX, "/Shade Logos/a.png"), null);
});

test("tally splits pinned from not pinned, and an unreadable size counts as 0 bytes", () => {
  const t = tally([
    { pinned: true, size: 1000 },
    { pinned: false, size: 250 },
    { pinned: false, size: null }
  ]);
  assert.deepEqual(t, { count: 3, bytes: 1250,
                        pinned: { count: 1, bytes: 1000 },
                        unpinned: { count: 2, bytes: 250 } });
});

test("sizes read like Finder's", () => {
  assert.equal(formatBytes(0), "0 bytes");
  assert.equal(formatBytes(999), "999 bytes");
  assert.equal(formatBytes(1500000), "1.5 MB");
  assert.equal(formatBytes(400e9), "400 GB");
  assert.equal(formatBytes(1.8e12), "1.8 TB");
});
