#!/usr/bin/env node
/*
 * Iterate on the "Make SPT Proxies" automation against REAL Shade, REST only
 * (no MCP), through the plugin's own setup code (its linking part: the
 * `feature` option is what Shade Premiere Tools' setup needs, and Shade
 * Linker's ignores).
 *
 *   node tools/proxyflow-lab.js inspect            raw fields + automations on the drive,
 *                                                  and the working reference automation
 *   node tools/proxyflow-lab.js reset [--automation-only]
 *                                                  delete "Make SPT Proxies", and (unless
 *                                                  --automation-only) the link fields
 *   node tools/proxyflow-lab.js setup              plugin/setup.js: fields first, then the
 *                                                  automation (exactly what the panel does)
 *   node tools/proxyflow-lab.js diff               ours vs the reference, node by node, raw
 *   node tools/proxyflow-lab.js run <assetId>      trigger ours on one clip, poll its execution
 *
 * Options: --drive <id> (default Politik Party), --ref <automationId> (default
 * "Proxy + Relational Link" on Adobe Sandbox, which works).
 *
 * The key is read from SHADE_API_KEY, or from .env at the repo root
 * (git-ignored). It is never printed: the request log redacts it.
 *
 * Every request and response is appended to tools/proxyflow-lab.log, so a
 * cycle can be read back afterwards without re-running it.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PLUGIN = path.join(ROOT, "plugin");
const LOG = path.join(__dirname, "proxyflow-lab.log");

const POLITIK_PARTY = "04f0590d-4209-4fd8-ab49-53932a87b359";
const REFERENCE = "2dcffe4d-d9ed-40b6-b5c3-357484d3487d";   // "Proxy + Relational Link", Adobe Sandbox

/* ------------------------------------------------------------- arguments */

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const DRIVE = opt("drive", POLITIK_PARTY);
const REF = opt("ref", REFERENCE);
const AUTOMATION_ONLY = argv.includes("--automation-only") && !!argv.splice(argv.indexOf("--automation-only"), 1);
const [command, ...rest] = argv;

/* -------------------------------------------------------------- the key */

function readKey() {
  if (process.env.SHADE_API_KEY) return process.env.SHADE_API_KEY.trim();
  try {
    const m = /^SHADE_API_KEY=(.+)$/m.exec(fs.readFileSync(path.join(ROOT, ".env"), "utf8"));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch (e) { /* no .env */ }
  return null;
}
const KEY = readKey();
if (!KEY || !/^sk_\S+$/.test(KEY)) {
  console.error("No Shade key: put SHADE_API_KEY=sk_... in .env at the repo root (git-ignored).");
  process.exit(2);
}

/* --------------------------------------------- request log (key redacted) */

const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  const t0 = Date.now();
  const res = await realFetch(url, init);
  const text = await res.clone().text();
  const entry = [
    `### ${new Date().toISOString()} ${init.method || "GET"} ${url}  -> ${res.status} (${Date.now() - t0}ms)`,
    init.body ? "body: " + init.body : null,
    "resp: " + text.slice(0, 20000)
  ].filter(Boolean).join("\n").split(KEY).join("sk_REDACTED");
  fs.appendFileSync(LOG, entry + "\n\n");
  return res;
};

/* ------------------------------------------------- the plugin, under Node */

const { setPlatform } = require(path.join(PLUGIN, "platform.js"));
setPlatform({ name: "lab", readData: async () => null, writeData: async () => {},
              dataPath: async () => __dirname, echo() {} });
const shade = require(path.join(PLUGIN, "shade.js"));
shade.setKeyProvider(async () => KEY);
const { setup, LINK_FIELDS } = require(path.join(PLUGIN, "setup.js"));
const proxyflow = require(path.join(PLUGIN, "proxyflow.js"));

const listOf = (r) => (Array.isArray(r) ? r : (r && (r.items || r.automations || r.data)) || []);
const show = (label, v) => console.log(`\n== ${label}\n` + JSON.stringify(v, null, 2));
const linkFields = async () => ((await shade.listFields(DRIVE)) || [])
  .filter((f) => Object.values(LINK_FIELDS).includes(f.name));
const ours = async () => listOf(await shade.listAutomations(DRIVE)).filter((a) => a.name === proxyflow.NAME);

/* ------------------------------------------------------------- commands */

async function inspect() {
  show("link fields (raw, archived included)", await linkFields());
  const autos = listOf(await shade.listAutomations(DRIVE));
  show("automations on the drive", autos.map((a) => ({ id: a.id, name: a.name, status: a.status })));
  for (const a of autos.filter((x) => x.name === proxyflow.NAME)) show(`ours ${a.id} (raw)`, await shade.getAutomation(a.id));
  show(`reference ${REF} (raw)`, await shade.getAutomation(REF));
}

/*
 * Field removal has no documented route, and the MCP can't do it. This
 * tries the column route Shade's web app uses: DELETE, then PATCH archive.
 * Whatever Shade answers is printed and logged.
 */
async function reset() {
  for (const a of await ours()) {
    await shade.deleteAutomation(a.id);
    console.log(`deleted automation ${a.id}`);
  }
  if (AUTOMATION_ONLY) return;
  for (const f of await linkFields()) {
    if (f.archived || f.deleted) { console.log(`field "${f.name}" ${f.id}: already archived/deleted`); continue; }
    const route = `/workspaces/drives/${DRIVE}/metadata/assets/columns/${f.id}`;
    try {
      await shade.request("DELETE", route, { retry: false });
      console.log(`field "${f.name}" ${f.id}: DELETE ok`);
      continue;
    } catch (e) {
      console.log(`field "${f.name}" ${f.id}: DELETE refused (${e.message})`);
    }
    try {
      await shade.request("PATCH", route, { body: { archive: true } });
      console.log(`field "${f.name}" ${f.id}: PATCH archive ok`);
    } catch (e) {
      console.log(`field "${f.name}" ${f.id}: PATCH archive refused (${e.message})`);
    }
  }
  show("link fields after reset", await linkFields());
}

async function runSetup() {
  const drive = { id: DRIVE, name: DRIVE.slice(0, 8) };
  show("check (before)", await setup(drive, { feature: "linking", check: true }));
  show("setup", await setup(drive, { feature: "linking" }));
  show("check (after)", await setup(drive, { feature: "linking", check: true }));
  for (const a of await ours()) show(`ours ${a.id} (raw)`, await shade.getAutomation(a.id));
}

/* The graph's shape, minus what differs by design (ids, field ids, positions). */
function normalise(auto) {
  const v = (auto && (auto.version || auto.active_version)) || auto || {};
  const nodes = v.nodes || auto.nodes || [];
  const ids = new Map(nodes.map((n, i) => [n.id, `N${i}`]));
  const swap = (s) => typeof s === "string" ? s.replace(/[0-9a-f-]{36}/g, (m) => ids.get(m) || "<field>") : s;
  const deep = (x) => Array.isArray(x) ? x.map(deep)
    : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [swap(k), deep(y)]))
    : swap(x);
  return {
    nodes: nodes.map((n) => ({ position: [n.position_x, n.position_y], node_type: n.node_type, operation: n.operation, integration_id: n.integration_id,
                               config: deep(n.config), configType: typeof n.config,
                               metadataType: n.config && typeof n.config.metadata })),
    edges: (v.edges || auto.edges || []).map((e) => ({ s: ids.get(e.source_node_id), t: ids.get(e.target_node_id),
                                                       output_key: e.output_key })),
    status: v.status || auto.status
  };
}

async function diff() {
  const mine = (await ours())[0];
  if (!mine) throw new Error(`no "${proxyflow.NAME}" on the drive: run setup first`);
  const a = normalise(await shade.getAutomation(mine.id));
  const b = normalise(await shade.getAutomation(REF));
  const out = [];
  const walk = (x, y, p) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (x && y && typeof x === "object" && typeof y === "object") {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${p}.${k}`);
    } else out.push(`${p}\n    ours: ${JSON.stringify(x)}\n    ref:  ${JSON.stringify(y)}`);
  };
  walk(a, b, "graph");
  console.log(out.length ? out.join("\n") : "no differences beyond ids");
}

async function run(assetId) {
  if (!assetId) throw new Error("usage: run <assetId>");
  const mine = (await ours())[0];
  if (!mine) throw new Error(`no "${proxyflow.NAME}" on the drive: run setup first`);
  const started = await shade.request("POST", `/automations/${mine.id}/executions`,
    { body: { selection: { type: "asset", asset_ids: [assetId] } }, retry: false });
  show("started", started);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    const page = await shade.request("GET", `/automations/${mine.id}/executions`, { query: { page: 1, page_size: 5 } });
    const latest = listOf(page)[0];
    console.log(`${new Date().toTimeString().slice(0, 8)} ${latest ? latest.status : "no execution yet"}`);
    if (latest && !/pending|running|queued|in_progress/i.test(String(latest.status))) {
      show("execution", latest);
      return;
    }
  }
  console.log("still running after 10 minutes; check again with: run is not idempotent, use inspect");
}

const COMMANDS = { inspect, reset, setup: runSetup, diff, run: () => run(rest[0]) };
if (!COMMANDS[command]) {
  console.error("usage: node tools/proxyflow-lab.js inspect|reset|setup|diff|run <assetId> [--drive id] [--ref id]");
  process.exit(2);
}
fs.appendFileSync(LOG, `\n######## ${new Date().toISOString()} ${command} ${rest.join(" ")} (drive ${DRIVE})\n\n`);
COMMANDS[command]().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
