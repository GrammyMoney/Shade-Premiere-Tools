/*
 * Run the plugin's real sync code under plain Node, against real Shade,
 * without Premiere.
 *
 *   node tools/harness.js <scan.json> [state-dir]
 *
 * The scan file stands in for what scan.js would produce:
 *   { "guid": "...", "name": "...", "path": "/Volumes/<drive>/x.prproj" | null,
 *     "files": [{ "mediaPath": "/Volumes/<drive>/...", "itemCount": 1, "used": true }] }
 *
 * `uxp` is stubbed: the data folder is state-dir (default: a temp dir), and
 * file sizes come from Node's fs. The key is read from .env at the repo root
 * (SHADE_API_KEY=sk_...), which git ignores.
 *
 * THIS WRITES TO SHADE: it sets fields on real assets and creates Projects
 * records. Use a test GUID and clean up afterwards.
 */
const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const [scanFile, dataArg] = process.argv.slice(2);
if (!scanFile) { console.error("usage: node tools/harness.js <scan.json> [state-dir]"); process.exit(2); }
const DATA = dataArg || fs.mkdtempSync(path.join(os.tmpdir(), "shade-tracker-"));

const file = (p) => ({
  read: async () => fs.readFileSync(p, "utf8"),
  write: async (s) => fs.writeFileSync(p, s),
  getMetadata: async () => ({ size: fs.statSync(p).size })
});
const uxpStub = { storage: { localFileSystem: {
  getDataFolder: async () => ({
    nativePath: DATA,
    getEntry: async (n) => {
      const p = path.join(DATA, n);
      if (!fs.existsSync(p)) throw new Error("not found");
      return file(p);
    },
    createFile: async (n) => file(path.join(DATA, n))
  }),
  getEntryWithUrl: async (u) => file(u.replace(/^file:/, ""))
}}};
const load = Module._load;
Module._load = function (req, ...rest) { return req === "uxp" ? uxpStub : load.call(this, req, ...rest); };

const shade = require(path.join(ROOT, "plugin/shade.js"));
const sync = require(path.join(ROOT, "plugin/sync.js"));

const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^SHADE_API_KEY=(\S+)/m);
if (!env) { console.error("no SHADE_API_KEY in .env"); process.exit(2); }
shade.setKeyProvider(async () => env[1]);

sync.run(JSON.parse(fs.readFileSync(scanFile, "utf8")))
  .then((s) => {
    console.log("summary", JSON.stringify(s));
    console.log("state  ", path.join(DATA, "state.json"));
  })
  .catch((e) => { console.error("FAILED", e.stack); process.exit(1); });
