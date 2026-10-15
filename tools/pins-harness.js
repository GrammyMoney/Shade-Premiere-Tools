#!/usr/bin/env node
/*
 * Runs project pinning (plugin/projectpins.js) and import linking
 * (plugin/link.js) under Node, against a fake Premiere project made of REAL
 * files on a mounted Shade drive:
 *
 *   node tools/pins-harness.js
 *
 * Real: Shade Desktop's bridge (mount table and `pin list`, both read-only)
 * and file stats on the mount, so inodes, sizes and "already pinned" are
 * what the plugin would see. Stubbed: Shade REST (a fake Linked Proxy), the
 * dialogs (answered yes, and recorded), and pin/unpin (recorded, never sent).
 * Nothing on the machine or in Shade changes.
 *
 * Needs Shade running with Adobe Sandbox mounted, and
 * "Arbor Hills/DJI_20240705192353_0269_D.JPG" pinned in it (it was on
 * 2026-10-14). Pass other drive-relative paths to use other files:
 *
 *   node tools/pins-harness.js <pinned file> <clip with a Linked Proxy> <its proxy> <clip with a proxy attached> <that proxy>
 */

const fs = require("fs");
const path = require("path");
const Module = require("module");
const assert = require("assert/strict");

const [PINNED, HIRES, LINKED_PROXY, ATTACHED, ATTACHED_PROXY] = process.argv.length > 6 ? process.argv.slice(2, 7) : [
  "Arbor Hills/DJI_20240705192353_0269_D.JPG",
  "2025 Media/2023_07_BERLIN_SUMMIT_DAY 2_CG_034.MP4",
  "2025 Media/proxies/2023_07_BERLIN_SUMMIT_DAY 2_CG_034_proxy_h264_1080p.mp4",
  "2025 Media/2023_07_BERLIN_SUMMIT_DAY 1_CG_024.MP4",
  "2025 Media/proxies/2023_07_BERLIN_SUMMIT_DAY 1_CG_024_proxy_h264_1080p.mp4"
];
const DRIVE = "72454409-8db3-4aba-86f4-53d3d5948b5a";

/* uxp: only log.js needs it. fs: UXP's is promise-based, so hand shadefs.js Node's promise API. */
const uxpStub = { storage: { localFileSystem: { getDataFolder: async () => { throw new Error("no data folder"); } } } };
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === "uxp") return uxpStub;
  if (req === "fs" && parent && /plugin[\\/]shadefs\.js$/.test(parent.filename)) return fs.promises;
  return origLoad.call(this, req, parent, ...rest);
};

const plugin = path.join(__dirname, "../plugin");
const { attach } = require(path.join(plugin, "log.js"));
attach((line) => { if (line) console.log("  log  " + line); });
const shade = require(path.join(plugin, "shade.js"));
const bridge = require(path.join(plugin, "bridge.js"));
const dialog = require(path.join(plugin, "dialog.js"));
const link = require(path.join(plugin, "link.js"));
const projectpins = require(path.join(plugin, "projectpins.js"));

/* ------------------------------------------------------------ stubs */

shade.setKeyProvider(async () => "sk_harness");
shade.listFields = async () => [
  { id: "f-proxy", name: "Linked Proxy", location: "custom" },
  { id: "f-hires", name: "Linked Hi Res", location: "custom" }
];
shade.assetByPath = async (driveId, p) => ({
  id: "asset:" + p,
  custom_metadata: p.endsWith("/" + HIRES) ? { "f-proxy": [{ entity_type: "asset", id: "the-proxy" }] } : {}
});
shade.getAsset = async (driveId, id) => {
  if (id === "the-proxy") return { id, name: path.basename(LINKED_PROXY), path: `/${driveId}/${LINKED_PROXY}` };
  const e = new Error("not found"); e.status = 404; throw e;
};

const questions = [];
let answer = true;
dialog.confirm = async (q) => { questions.push(q); return answer; };

const sent = { pin: [], unpin: [] };
bridge.pin = async (inos) => { sent.pin.push(inos); return { code: 0, data: null }; };
bridge.unpin = async (inos) => { sent.unpin.push(inos); return { code: 0, data: null }; };

/* ------------------------------------------------------------ fake Premiere */

function clipItem(id, mediaPath, proxyPath = null) {
  const c = {
    id, name: path.basename(mediaPath), proxyPath, attached: [],
    getId: () => id,
    getMediaFilePath: async () => mediaPath,
    isSequence: async () => false,
    hasProxy: async () => !!c.proxyPath,
    getProxyPath: async () => c.proxyPath,
    attachProxy: async (p, isHiRes) => { c.attached.push({ p, isHiRes }); c.proxyPath = p; return true; }
  };
  return c;
}

const items = [];
const root = { isFolder: true, getItems: async () => items };
const project = {
  guid: "harness-project-guid", name: "Pins Harness.prproj", path: "/Volumes/Adobe Sandbox/Pins Harness.prproj",
  getRootItem: async () => root
};
const ppro = {
  Project: { getActiveProject: async () => project },
  FolderItem: { cast: async (i) => (i && i.isFolder ? i : null) },
  ClipProjectItem: { cast: async (i) => (i && i.getMediaFilePath ? i : null) }
};

/* ------------------------------------------------------------ run */

async function main() {
  const mounts = await require(path.join(plugin, "shadefs.js")).mounts();
  const m = mounts.find((x) => x.driveId === DRIVE);
  assert.ok(m, "Adobe Sandbox is not mounted (bridge reports: " + mounts.map((x) => x.root).join(", ") + ")");
  console.log(`bridge: ${mounts.length} Shade drive(s) mounted; Adobe Sandbox at ${m.root}`);
  const at = (rel) => m.root + "/" + rel;

  // Refuse to go on unless pin and unpin really reach the stubs: a real pin
  // here would start downloading the test files.
  const shadefs = require(path.join(plugin, "shadefs.js"));
  await shadefs.pin([]);
  await shadefs.unpin([]);
  assert.deepEqual(sent, { pin: [[]], unpin: [[]] }, "pin/unpin are not stubbed; stopping before anything is pinned");
  sent.pin.length = 0;
  sent.unpin.length = 0;

  items.push(
    clipItem("1", at(PINNED)),
    clipItem("2", at(HIRES)),
    clipItem("3", at(ATTACHED), at(ATTACHED_PROXY)),
    clipItem("4", "/Users/editor/Desktop/local.mov")
  );

  console.log("\n1. project opens: one pin question");
  link.seed(ppro);
  console.log("  -> " + await projectpins.offerPin(ppro));
  assert.equal(questions.length, 1);
  const q = questions[0];
  console.log("  dialog: " + q.heading + "\n          " + q.lines.join("\n          "));
  assert.match(q.lines[0], /^Number of assets: 5 \(/);           // 4 Shade media files + 1 linked proxy
  assert.match(q.lines[1], /^Already pinned: 1 \(.*Not pinned: 4 \(/);
  assert.equal(sent.pin.length, 1);
  assert.equal(sent.pin[0].length, 4, "the four not-yet-pinned files are pinned");

  console.log("\n2. the same project again: not asked twice");
  assert.equal(await projectpins.offerPin(ppro), "");
  assert.equal(questions.length, 1);

  console.log("\n3. a clip is imported: linked and pinned without asking");
  items.push(clipItem("5", at("2024_04_PANAMA_DAY11_CG_3.MP4".replace(/^/, "2025 Media/"))));
  await link.onImport(ppro);
  assert.equal(questions.length, 1);
  assert.equal(sent.pin.length, 2);

  console.log("\n4. project closes: one unpin question");
  // pin list is real, and the captured pins were never sent, so only the
  // file that really is pinned counts as pinned here.
  await projectpins.onClosed({ id: project.guid, name: project.name, path: project.path });
  assert.equal(questions.length, 2);
  console.log("  dialog: " + questions[1].heading + "\n          " + questions[1].lines.join("\n          "));
  assert.match(questions[1].heading, /unpin the project "Pins Harness"/);
  assert.equal(sent.unpin.length, 1);
  assert.equal(sent.unpin[0].length, 1);

  console.log("\n5. a declined pin pins nothing");
  answer = false;
  console.log("  -> " + await projectpins.offerPin(ppro, { always: true }));
  assert.equal(sent.pin.length, 2);

  console.log(`\nok: pins sent ${JSON.stringify(sent.pin.map((x) => x.length))}, unpins ${JSON.stringify(sent.unpin.map((x) => x.length))} (captured, not sent)`);
}

main().then(() => process.exit(0), (e) => { console.error("FAILED:", e.message); process.exit(1); });
