#!/usr/bin/env node
/*
 * Shade Tracker CLI -- the same tracking as the Premiere panel, for editors
 * who don't have it, by reading saved .prproj files on a timer.
 *
 *   node cli/shade-tracker.js setup --drive "Adobe Sandbox" make a drive ready
 *   node cli/shade-tracker.js run --drive "Adobe Sandbox"   one pass
 *   node cli/shade-tracker.js key                           store the API key
 *   node cli/shade-tracker.js install --drive "..." [--every 15]
 *   node cli/shade-tracker.js uninstall
 *   node cli/shade-tracker.js status
 *
 * Harmony with the panel is not a protocol between them; it falls out of
 * both running the SAME sync code (plugin/sync.js) against the same Shade:
 *
 *   - Same identity. A project is found by the id in its .prproj
 *     (RootProjectItem uid), which is exactly what the panel reads as
 *     Project.guid. One project, one record, whoever gets there first.
 *   - Same rules, and they only ever add: Imported?/Used? are only raised,
 *     links are merged, never replaced. So the second writer to arrive finds
 *     Shade already right and writes nothing -- a project the panel tracks
 *     live costs the CLI a few reads and no writes.
 *   - Same "Shade projects only" rule: only .prproj files that live on a
 *     Shade drive are ever looked at.
 *
 * What the CLI cannot see: anything not yet saved. The panel tracks the live
 * project; the CLI tracks the last save. That is the whole difference.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(os.homedir(), "Library", "Application Support", "Shade Tracker CLI");
const KEYCHAIN = { service: "Shade Tracker", account: "shade-api-key" };
const AGENT_LABEL = "com.grammymoney.shadetracker.cli";
const AGENT_PLIST = path.join(os.homedir(), "Library", "LaunchAgents", AGENT_LABEL + ".plist");
const CLI_STATE = "cli.json";
const LOCK = "run.lock";

// How far back past the last run's newest change to look again. Shade's
// "updated" is set when it indexes a file, and indexing is not instant, so
// an exact cut-off could skip a file indexed just as the last run listed.
const OVERLAP_MS = 10 * 60 * 1000;
const PAGE = 200;

/* ----------------------------------------------------- the Node platform */

fs.mkdirSync(DATA_DIR, { recursive: true });

const { setPlatform } = require(path.join(ROOT, "plugin/platform.js"));
setPlatform({
  name: "cli",
  async readData(name) {
    try { return fs.readFileSync(path.join(DATA_DIR, name), "utf8"); } catch (e) { return null; }
  },
  async writeData(name, text) {
    const p = path.join(DATA_DIR, name);
    fs.writeFileSync(p + ".tmp", text);
    fs.renameSync(p + ".tmp", p);           // never leave a half-written file
  },
  async dataPath() { return DATA_DIR; },
  async fileSize(p) {
    try { return fs.statSync(p).size; } catch (e) { return null; }   // not mounted here
  },
  echo(line) { if (process.stdout.isTTY) console.log(line); }
});

const { log, flush } = require(path.join(ROOT, "plugin/log.js"));
const shade = require(path.join(ROOT, "plugin/shade.js"));
const resolve = require(path.join(ROOT, "plugin/resolve.js"));
const sync = require(path.join(ROOT, "plugin/sync.js"));
const { mountRootFor } = require(path.join(ROOT, "plugin/paths.js"));
const { parseBytes } = require("./prproj.js");
const { setup } = require(path.join(ROOT, "plugin/setup.js"));
const { isProjectFile, relPath, baseName, mergeByGuid } = require("./select.js");

/* --------------------------------------------------------------- the key */

/*
 * From SHADE_API_KEY, else the login Keychain. Never a plain file: the key
 * carries every permission its owner has.
 */
function getKey() {
  if (process.env.SHADE_API_KEY) return process.env.SHADE_API_KEY.trim();
  try {
    return execFileSync("security",
      ["find-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account, "-w"],
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch (e) {
    return null;
  }
}

/*
 * `security` prompts for the value itself when -w is last, so the key never
 * appears in a command line, a shell history, or this process.
 */
function cmdKey() {
  console.log("Paste your Shade API key (sk_...) when asked. It goes into your login Keychain.");
  const r = spawnSync("security",
    ["add-generic-password", "-U", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account, "-w"],
    { stdio: "inherit" });
  if (r.status !== 0) throw new Error("security exited with " + r.status);
  const key = getKey();
  if (!key || !/^sk_\S+$/.test(key)) throw new Error("that does not look like a Shade key (sk_...)");
  console.log("Saved.");
}

/* ------------------------------------------------------------ the drives */

async function findDrives(wanted) {
  const all = [];
  for (const w of (await shade.listWorkspaces()) || []) {
    for (const d of (await shade.listDrives(w.id)) || []) all.push({ id: d.id, name: d.name, workspace: w.name });
  }
  return wanted.map((want) => {
    const hits = all.filter((d) => d.id === want || d.name === want);
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new Error(`no drive "${want}" visible to this key`);
    throw new Error(`"${want}" names ${hits.length} drives; use an id:\n` +
      hits.map((d) => `  ${d.id}  ${d.name}  (${d.workspace})`).join("\n"));
  });
}

/* ---------------------------------------------------------------- run */

async function readCliState() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, CLI_STATE), "utf8")); }
  catch (e) { return { drives: {} }; }
}
function writeCliState(st) {
  const p = path.join(DATA_DIR, CLI_STATE);
  fs.writeFileSync(p + ".tmp", JSON.stringify(st, null, 1));
  fs.renameSync(p + ".tmp", p);
}

/*
 * Every .prproj on the drive changed since the last run, newest first.
 * Listing stops at the first file older than the last run's newest change
 * (less an overlap), so after the first run a pass lists a page or two, not
 * the whole drive.
 */
async function changedProjects(drive, since) {
  const cutoff = since ? Date.parse(since) - OVERLAP_MS : null;
  const found = [];
  let newest = null;
  for (let page = 0; ; page++) {
    const items = (await shade.listFilesPage(drive.id, { page, limit: PAGE })) || [];
    for (const e of items) {
      if (!newest) newest = e.updated;
      if (cutoff !== null && Date.parse(e.updated) < cutoff) return { found, newest };
      if (isProjectFile(e)) found.push(e);
    }
    if (items.length < PAGE) return { found, newest };
  }
}

async function download(drive, entry) {
  const url = await shade.downloadUrl(drive.id, entry.id);
  const res = await fetch(typeof url === "string" ? url : url.url);
  if (!res.ok) throw new Error(`download ${baseName(entry.path)} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function runDrive(drive, cliState, { full }) {
  const ds = cliState.drives[drive.id] || (cliState.drives[drive.id] = { highWater: null, seen: {} });
  const { found, newest } = await changedProjects(drive, full ? null : ds.highWater);
  const changed = found.filter((e) => full || ds.seen[e.id] !== e.updated);

  // The .prproj files themselves prove the drive: they were listed from it.
  // Media paths in a project are the editor's /Volumes/<drive name>/..., so
  // that is the volume every path on this drive will be written under.
  const root = mountRootFor(drive.name);
  resolve.rememberVolume(root, drive.id, drive.name);

  const parsed = [];
  let failed = 0;
  for (const entry of changed) {
    try {
      parsed.push({ entry, project: parseBytes(await download(drive, entry)) });
    } catch (e) {
      failed++;
      log(`could not read ${relPath(drive.id, entry.path)}: ${e.message}`);
    }
  }

  let written = 0;
  for (const group of mergeByGuid(parsed)) {
    const rel = relPath(drive.id, group.primary.path);
    const scan = {
      guid: group.guid,
      name: baseName(rel),
      path: root + rel,
      files: group.files
    };
    try {
      const s = await sync.run(scan);
      written += s.written;
      log(`${drive.name}${rel}: ${scan.files.length} files, ${s.onShade} on Shade, ` +
          `${s.written} written` + sync.describeChanges(s) + (group.copies > 1 ? `, ${group.copies} copies merged` : "") +
          (s.status !== "tracked" ? `, not tracked (${s.status})` : "") +
          (s.retry ? ", Shade not caught up yet" : "") +
          (s.needsSetup.length ? ", drive not set up: run shade-tracker setup" : "") +
          (Object.keys(s.otherDrives).length
            ? `, ${Object.values(s.otherDrives).reduce((a, n) => a + n, 0)} on another drive (not tracked)` : "") +
          (s.problems.length ? ` -- ${s.problems.join("; ")}` : ""));
      for (const p of parsed) if (p.project.guid === group.guid) ds.seen[p.entry.id] = p.entry.updated;
    } catch (e) {
      failed++;
      log(`${drive.name}${rel}: sync failed: ${e.message}`);
    }
  }

  // Only move the cut-off forward when everything went through. Otherwise a
  // project that failed now would fall behind it and never be looked at
  // again until a --full run.
  if (!failed && newest) ds.highWater = newest;
  return { listed: found.length, changed: changed.length, written, failed };
}

function takeLock() {
  const p = path.join(DATA_DIR, LOCK);
  try {
    const pid = Number(fs.readFileSync(p, "utf8"));
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return false; } catch (e) { /* stale lock */ }
    }
  } catch (e) { /* no lock */ }
  fs.writeFileSync(p, String(process.pid));
  return true;
}
function dropLock() { try { fs.unlinkSync(path.join(DATA_DIR, LOCK)); } catch (e) { /* fine */ } }

async function cmdRun(args) {
  const drives = args.drive;
  if (!drives.length) throw new Error('say which drive(s): run --drive "Drive Name"');
  const key = getKey();
  if (!key) throw new Error("no API key: run `shade-tracker key` first, or set SHADE_API_KEY");
  shade.setKeyProvider(async () => key);

  if (!takeLock()) { log("another run is still going; skipping this one"); return; }
  try {
    const cliState = await readCliState();
    for (const drive of await findDrives(drives)) {
      const t0 = Date.now();
      const r = await runDrive(drive, cliState, { full: args.full });
      writeCliState(cliState);
      log(`pass on "${drive.name}": ${r.listed} project file(s) listed, ${r.changed} changed, ` +
          `${r.written} asset(s) written, ${r.failed} failed, ${Date.now() - t0}ms`);
    }
  } finally {
    dropLock();
  }
}

/* --------------------------------------------------------------- setup */

async function cmdSetup(args) {
  if (args.drive.length !== 1) throw new Error('setup takes one drive: setup --drive "Drive Name"');
  const key = getKey();
  if (!key) throw new Error("no API key: run `shade-tracker key` first, or set SHADE_API_KEY");
  shade.setKeyProvider(async () => key);

  const [drive] = await findDrives(args.drive);
  const feature = args.linking ? "linking" : "tracking";
  console.log(`${args.check ? "Checking" : "Setting up"} "${drive.name}" (${drive.id}) for ${feature}\n`);
  const { ready, lines } = await setup(drive, { check: args.check, feature });
  const width = Math.max(...lines.map((l) => l.state.length));
  for (const l of lines) console.log(`  ${l.state.padEnd(width)}  ${l.what}${l.note ? " -- " + l.note : ""}`);
  console.log(ready ? "\nReady." : `\nNot ready.${args.check ? " Run without --check to create what is missing." : ""}`);
  if (!ready) process.exitCode = 1;
}

/* ------------------------------------------------------------- launchd */

function xml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function cmdInstall(args) {
  if (!args.drive.length) throw new Error('say which drive(s): install --drive "Drive Name"');
  if (!getKey()) throw new Error("no API key in the Keychain: run `shade-tracker key` first");
  const minutes = Math.max(1, Number(args.every || 15));
  const argv = [process.execPath, path.join(__dirname, "shade-tracker.js"), "run"];
  for (const d of args.drive) argv.push("--drive", d);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>StartInterval</key><integer>${minutes * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${xml(path.join(DATA_DIR, "launchd-stderr.log"))}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(AGENT_PLIST), { recursive: true });
  fs.writeFileSync(AGENT_PLIST, plist);
  const uid = String(process.getuid());
  spawnSync("launchctl", ["bootout", `gui/${uid}/${AGENT_LABEL}`], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, AGENT_PLIST], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("launchctl bootstrap failed");
  console.log(`Installed: every ${minutes} min on ${args.drive.join(", ")}.`);
  console.log(`Log: ${path.join(DATA_DIR, "shade-tracker.log")}`);
}

function cmdUninstall() {
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${AGENT_LABEL}`], { stdio: "ignore" });
  try { fs.unlinkSync(AGENT_PLIST); console.log("Uninstalled."); }
  catch (e) { console.log("Was not installed."); }
  console.log(`Left in place: ${DATA_DIR} (state and log; safe to delete).`);
}

async function cmdStatus() {
  console.log("key:      " + (getKey() ? "set" : "NOT SET (run `key`)"));
  console.log("agent:    " + (fs.existsSync(AGENT_PLIST) ? AGENT_PLIST : "not installed"));
  const st = await readCliState();
  for (const [id, d] of Object.entries(st.drives)) {
    console.log(`drive ${id}: last change seen ${d.highWater || "never"}, ` +
                `${Object.keys(d.seen).length} project file(s) read`);
  }
  const logFile = path.join(DATA_DIR, "shade-tracker.log");
  if (fs.existsSync(logFile)) {
    console.log("\nlast log lines:");
    console.log(fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-8).join("\n"));
  }
}

/* ---------------------------------------------------------------- main */

function parseArgs(argv) {
  const out = { _: [], drive: [], full: false, check: false, linking: false, every: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--drive") out.drive.push(argv[++i]);
    else if (a === "--every") out.every = argv[++i];
    else if (a === "--full") out.full = true;
    else if (a === "--check") out.check = true;
    else if (a === "--linking") out.linking = true;
    else out._.push(a);
  }
  return out;
}

const USAGE = `usage: shade-tracker <command>
  setup --drive NAME|ID [--check]             create the fields tracking needs (or report)
  setup --drive NAME|ID --linking [--check]   the same for proxy linking (Linked Proxy/Hi Res)
  run --drive NAME|ID [--drive ...] [--full]   one pass over the drive(s)
  key                                         store your API key in the Keychain
  install --drive NAME|ID [--every MIN]       run automatically (default 15 min)
  uninstall                                   stop running automatically
  status                                      what it has done`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === "setup") await cmdSetup(args);
  else if (cmd === "run") await cmdRun(args);
  else if (cmd === "key") cmdKey();
  else if (cmd === "install") cmdInstall(args);
  else if (cmd === "uninstall") cmdUninstall();
  else if (cmd === "status") await cmdStatus();
  else { console.log(USAGE); process.exitCode = cmd ? 2 : 0; }
}

main()
  .catch((e) => { log("error: " + e.message); console.error(e.message); process.exitCode = 1; })
  .finally(() => flush());
