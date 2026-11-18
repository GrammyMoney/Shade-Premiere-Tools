/*
 * "Pin when used in a timeline" (settings pinWhen), with Premiere and the
 * bridge faked: a clip first put on a timeline is
 * pinned (media and attached proxy), what was on a timeline when the
 * project was first seen is left alone, and an already-pinned file is not
 * pinned again.
 */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === "uxp" ? { storage: { localFileSystem: {} } } : origLoad.call(this, req, ...rest);
};

const { setPlatform } = require("../platform.js");
setPlatform({ readData: async () => null, writeData: async () => {}, echo() {} });

const settings = require("../settings.js");
const shadefs = require("../shadefs.js");
const link = require("../link.js");

const ROOT = "/Volumes/Test Drive";
const mount = { root: ROOT, driveId: "drive-1", rootIno: 1 };
const inode = { [`${ROOT}/A.mov`]: 11, [`${ROOT}/B.mov`]: 12, [`${ROOT}/C.mov`]: 13,
                [`${ROOT}/proxies/B.mp4`]: 22 };
let pinnedNow = [];
const pinCalls = [];
Object.assign(shadefs, {
  mounts: async () => [mount],
  pinned: async () => pinnedNow,
  statOf: async (p) => ({ ino: inode[p] || null, size: 100 }),
  pin: async (inos) => { pinCalls.push(inos); return { code: 0, data: "" }; }
});

/* A project: clips in the root bin, one sequence whose track holds `onTimeline`. */
function fakePremiere(clipsByName) {
  const onTimeline = [];
  const items = Object.entries(clipsByName).map(([name, c], i) => ({
    name, id: `item-${i}`, media: c.media, proxy: c.proxy || null
  }));
  const asItem = (it) => ({
    name: it.name,
    getId: () => it.id,
    getMediaFilePath: async () => it.media,
    getProxyPath: async () => it.proxy,
    hasProxy: async () => !!it.proxy,
    isSequence: async () => false
  });
  const track = { getTrackItems: async () => onTimeline.map((it) => ({ getProjectItem: async () => asItem(it) })) };
  const seq = {
    getVideoTrackCount: async () => 1, getVideoTrack: async () => track,
    getAudioTrackCount: async () => 0, getAudioTrack: async () => null
  };
  const root = { getItems: async () => items.map(asItem) };
  const project = { guid: "proj-1", name: "Proj.prproj", path: `${ROOT}/Proj.prproj`,
                    getRootItem: async () => root, getSequences: async () => [seq] };
  const ppro = {
    Constants: { TrackItemType: { CLIP: 1 } },
    Project: { getActiveProject: async () => project },
    FolderItem: { cast: (x) => (x === root ? root : null) },
    ClipProjectItem: { cast: (x) => x }
  };
  const place = (name) => onTimeline.push(items.find((it) => it.name === name));
  return { ppro, place };
}

test("pin on a timeline: placements pin, what was already there is left alone", async () => {
  await settings.set("pinWhen", "timeline");
  const { ppro, place } = fakePremiere({
    "A.mov": { media: `${ROOT}/A.mov` },
    "B.mov": { media: `${ROOT}/B.mov`, proxy: `${ROOT}/proxies/B.mp4` },
    "C.mov": { media: `${ROOT}/C.mov` },
    "local.mov": { media: "/Users/me/local.mov" }
  });

  place("A.mov");                      // already on a timeline when the project is first seen
  await link.seed(ppro);
  await link.onDirty(ppro);
  assert.deepStrictEqual(pinCalls, [], "nothing already on a timeline is pinned");

  place("B.mov");
  place("local.mov");
  await link.onDirty(ppro);
  assert.deepStrictEqual(pinCalls, [[12, 22]], "media and attached proxy; local media skipped");

  pinnedNow = [{ driveId: "drive-1", path: "C.mov" }];
  place("C.mov");
  await link.onDirty(ppro);
  await link.onDirty(ppro);
  assert.deepStrictEqual(pinCalls, [[12, 22]], "an already-pinned file is not pinned again, and nothing twice");
});

test("pin on import: timeline placements pin nothing", async () => {
  pinCalls.length = 0;
  pinnedNow = [];
  await settings.set("pinWhen", "import");
  const { ppro, place } = fakePremiere({ "A.mov": { media: `${ROOT}/A.mov` } });
  await link.onDirty(ppro);
  place("A.mov");
  await link.onDirty(ppro);
  assert.deepStrictEqual(pinCalls, []);
});
