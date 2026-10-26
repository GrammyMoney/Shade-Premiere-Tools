/*
 * A whole export.run() with Premiere, Shade and the bridge faked, and
 * project tracking OFF (the default): the file is rendered, found in Shade,
 * stacked onto the previous version and linked on the timeline; only the
 * Exports column on the project record is skipped, and sync is never asked.
 */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const FOLDER = "/Volumes/Test Drive/EXPORTS";
const DRIVE = "drive-1";
const V01 = "Proj_Main Cut_V01.mp4";
const V02 = "Proj_Main Cut_V02.mp4";

/* uxp: the folder picker and the host version, nothing else. */
const uxpStub = {
  host: { version: "26.5.1" },
  storage: { localFileSystem: {
    getFolder: async () => ({ nativePath: FOLDER, getEntries: async () => [{ name: V01 }, { name: "notes.txt" }] }),
    getDataFolder: async () => { throw new Error("no data folder"); }
  } }
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === "uxp" ? uxpStub : origLoad.call(this, req, ...rest);
};

const { setPlatform } = require("../platform.js");
const rendered = new Set();
setPlatform({
  readData: async () => null, writeData: async () => {}, echo() {},
  fileSize: async (p) => (p.endsWith(".epr") ? 1 : rendered.has(p) ? 1000 : null)
});

const settings = require("../settings.js");
const shade = require("../shade.js");
const shadefs = require("../shadefs.js");
const resolve = require("../resolve.js");
const dialog = require("../dialog.js");
const seqlink = require("../seqlink.js");
const snapshot = require("../snapshot.js");
const sync = require("../sync.js");
const exporter = require("../export.js");

const calls = [];
const shadePathOf = (name) => `/${DRIVE}/EXPORTS/${name}`;
const assets = {
  [shadePathOf(V01)]: { id: "a1", name: V01, stack_id: null, stack_number: null, size_bytes: 900 },
  [shadePathOf(V02)]: { id: "a2", name: V02, stack_id: null, stack_number: null, size_bytes: 1000 }
};

Object.assign(shade, {
  assetByPath: async (d, p) => assets[p] || null,
  getAsset: async (d, id) => {
    const a = Object.values(assets).find((x) => x.id === id);
    if (!a) { const e = new Error("gone"); e.status = 404; throw e; }
    return a;
  },
  createStack: async (d, ids) => {
    calls.push(["createStack", ids]);
    ids.forEach((id, i) => Object.assign(Object.values(assets).find((x) => x.id === id), { stack_id: "s1", stack_number: i + 1 }));
    return "s1";
  },
  addToStack: async () => { calls.push(["addToStack"]); return 2; },
  patchRecord: async () => { calls.push(["patchRecord"]); }
});
shadefs.mounts = async () => [{ root: "/Volumes/Test Drive", driveId: DRIVE, rootIno: 1 }];
resolve.resolveFile = async () => ({ status: "found", driveId: DRIVE, asset: {} });
resolve.driveName = () => "Test Drive";
dialog.notify = async (q) => { calls.push(["notify", q.heading, q.lines]); };
dialog.confirm = async () => true;
seqlink.read = async () => null;                                    // never exported before
seqlink.write = async (p, project, seq, link) => { calls.push(["link", seq.guid, link.latest, link.stack, link.version]); };
snapshot.make = async (p, project, seq, o) => { calls.push(["copy", o.name]); return { guid: "copy-1", name: o.name }; };
snapshot.complete = async (p, project, snap, o) => { calls.push(["copyLinked", snap.guid, o.assetId]); };
snapshot.removeShadeMarkers = async () => 0;
snapshot.focusWorking = async () => 0;
sync.schemaFor = async () => { throw new Error("sync must not be used with tracking off"); };
sync.projectRecord = async () => { throw new Error("sync must not be used with tracking off"); };

const sequence = { guid: "seq-main", name: "Main Cut" };
const project = {
  path: "/Volumes/Test Drive/Projects/Proj.prproj", name: "Proj.prproj", guid: "proj-1",
  getActiveSequence: async () => sequence
};
const em = {
  isAMEInstalled: true,
  exportSequence: async (seq, type, out, preset, full) => {
    calls.push(["render", out.split("/").pop(), preset.split("/").pop(), full]);
    rendered.add(out);
    return true;
  }
};
const ppro = {
  Project: { getActiveProject: async () => project },
  EncoderManager: Object.assign({ getManager: () => em, getExportFileExtension: async () => "mp4" },
    { EVENT_RENDER_COMPLETE: "c", EVENT_RENDER_PROGRESS: "p", EVENT_RENDER_ERROR: "e", EVENT_RENDER_CANCEL: "x" }),
  EventManager: { addEventListener() {}, removeEventListener() {} },
  Constants: { ExportType: { IMMEDIATELY: "now" } }
};

test("export with project tracking off still renders, stacks and links", async () => {
  assert.strictEqual(settings.get("tracking"), false);                 // the default
  exporter.init(ppro, { hasKey: async () => true });

  const msg = await exporter.run();

  assert.deepStrictEqual(calls.find((c) => c[0] === "render"),
    ["render", V02, "02 - Match Source - Low bitrate.epr", true]);
  assert.deepStrictEqual(calls.find((c) => c[0] === "createStack"), ["createStack", ["a1", "a2"]]);
  assert.deepStrictEqual(calls.find((c) => c[0] === "link"), ["link", "seq-main", "a2", "s1", 2]);
  assert.deepStrictEqual(calls.find((c) => c[0] === "copy"), ["copy", "Main Cut_V02"]);
  assert.deepStrictEqual(calls.find((c) => c[0] === "copyLinked"), ["copyLinked", "copy-1", "a2"]);
  assert.ok(!calls.some((c) => c[0] === "patchRecord"), "no record write with tracking off");
  assert.ok(!calls.some((c) => c[0] === "notify"), "no error dialog: " + JSON.stringify(calls));
  assert.match(msg, /^Proj_Main Cut_V02\.mp4 is in Shade, stacked on Proj_Main Cut_V01\.mp4/);
  assert.match(msg, /tracking is off/);
});
