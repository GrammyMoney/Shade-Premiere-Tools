/*
 * Export: the active timeline -> a light MP4 on the project's Shade drive ->
 * the next version in that timeline's Shade stack -> the project's record.
 *
 *   1. preconditions   project on a Shade drive, a timeline, the key, AME
 *   2. folder          picked by the editor; must be on the project's drive
 *   3. name            <Project>_<Timeline>_V03.mp4 (versions.js)
 *   4. render          exportSequence, whole sequence, Adobe's own
 *                      "Match Source - Low bitrate" H.264 preset
 *   5. wait            Shade Desktop uploads it; poll until Shade has it
 *   6. stack           onto the previous version (or start the stack)
 *   7. link            the timeline remembers its stack (seqlink.js)
 *   8. Exports         the project's Premiere Projects record lists it
 *
 * Right after 4, the timeline is copied as it was rendered into the "Shade
 * Versions" bin as "<Timeline>_V03" (snapshot.js), and in 7 that copy is
 * linked to V03 itself. Exporting such a version timeline continues its
 * original's stack. A copy that can't be made never fails the export.
 * Then the exported timeline is brought back to the front and the version
 * timelines are closed, so work continues on the latest cut.
 *
 * Saving to the mount, not uploading, is deliberate (decided 2026-10-26):
 * the file is where the editor chose, Shade Desktop already uploads
 * reliably, and nothing large passes through UXP. A wait that runs out is
 * not a failure: the file is there, and the next Export on that timeline
 * offers to finish linking it instead of rendering again.
 *
 * Premiere-side calls follow what Shade's own Premiere plugin does and is
 * known to work there: IMMEDIATELY, render events on the EncoderManager
 * instance, and the promise as a fallback when no completion event comes.
 */

const { log } = require("./log.js");
const shade = require("./shade.js");
const shadefs = require("./shadefs.js");
const resolve = require("./resolve.js");
const settings = require("./settings.js");
const dialog = require("./dialog.js");
const seqlink = require("./seqlink.js");
const snapshot = require("./snapshot.js");
const sync = require("./sync.js");
const { platform } = require("./platform.js");
const { locate, shadePath } = require("./mounts.js");
const { projectDisplayName } = require("./paths.js");
const { baseName, nextVersion, versionOf, fileName, formatVersion, mergeExports,
        snapshotName, stripVersion } = require("./versions.js");

/* The highest-numbered file for this base among `names`, or null. */
function highest(base, names) {
  let top = null;
  for (const n of names) {
    const v = versionOf(n, base);
    if (v !== null && (!top || v > top.v)) top = { v, name: n };
  }
  return top && top.name;
}

const PRESETS = ["02 - Match Source - Low bitrate.epr", "01 - Match Source - Medium bitrate.epr",
                 "00 - Match Source - Medium bitrate.epr"];
const H264 = "4E49434B_48323634";        // Adobe's folder for H.264 system presets
const WAIT_MS = 20 * 60 * 1000;
const RENDER_TIMEOUT_MS = 3 * 60 * 60 * 1000;

let ppro = null;
let hasKey = async () => false;
let busy = false;
const pending = new Map();      // sequence guid -> a rendered file not yet in its stack
const state = { text: "", progress: null, at: 0 };

function init(pproModule, opts = {}) {
  ppro = pproModule;
  hasKey = opts.hasKey || hasKey;
}

function say(text, progress = null) {
  state.text = text;
  state.progress = progress;
  state.at = Date.now();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sepOf = (p) => (p.includes("\\") && !p.includes("/") ? "\\" : "/");
const join = (dir, name) => dir.replace(/[\\/]+$/, "") + sepOf(dir) + name;

/* --------------------------------------------------------------- pieces */

/*
 * Whose stack an export of the active timeline continues. Normally its own.
 * For a version timeline, its original's: named for it, linked from it, and
 * its link updated. With the original deleted, the version timeline's own
 * link (same stack) and its name minus "_Vxx", and no original to update.
 * { holder, name, guid, link }
 */
async function targetOf(ctx, link) {
  if (!link || !link.snapshotOf) {
    return { holder: ctx.sequence, name: ctx.sequenceName, guid: ctx.sequenceGuid, link };
  }
  const original = await snapshot.sequenceByGuid(ctx.project, link.snapshotOf);
  if (original) {
    return { holder: original, name: String(await original.name), guid: link.snapshotOf,
             link: await seqlink.read(ppro, original).catch(() => null) };
  }
  log(`"${ctx.sequenceName}" is a version timeline whose original is gone; continuing its stack`);
  return { holder: null, name: stripVersion(ctx.sequenceName), guid: link.snapshotOf, link };
}

/* The project, its timeline, and the mounted Shade drive it is saved on. */
async function context() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("Open a project first.");
  const path = await project.path;
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("Open the timeline you want to export.");

  const r = path ? await resolve.resolveFile(path).catch(() => ({})) : {};
  const mounts = await shadefs.mounts().catch(() => []);
  const mount = r.driveId && mounts.find((m) => m.driveId === r.driveId);
  if (!mount) {
    throw new Error("Save this project on a mounted Shade drive to export to Shade.");
  }
  return {
    project, sequence, mount,
    driveId: mount.driveId,
    driveName: resolve.driveName(mount.driveId),
    projectName: projectDisplayName(await project.name) || "Untitled",
    projectPath: path,
    projectGuid: String(await project.guid),
    sequenceName: String(await sequence.name),
    sequenceGuid: String(await sequence.guid)
  };
}

/* Ask for a folder until it is on the project's drive, or the editor gives up. */
async function chooseFolder(ctx) {
  const lfs = require("uxp").storage.localFileSystem;
  for (let tries = 0; tries < 3; tries++) {
    const folder = await lfs.getFolder();
    if (!folder) return null;                                  // cancelled
    if (locate(join(folder.nativePath, "x"), [ctx.mount])) return folder;
    await dialog.notify({
      heading: `Exports must be saved on "${ctx.driveName}"`,
      lines: [`That folder isn't on "${ctx.driveName}", the drive this project is saved on.`,
              "Pick a folder on that drive."]
    });
  }
  return null;
}

/* Adobe's own Match Source H.264 preset, from the running Premiere's install. */
async function findPreset() {
  const major = parseInt(String((require("uxp").host || {}).version || ""), 10);
  const year = major >= 20 && major < 100 ? 2000 + major : 2026;
  let win = false;
  try { win = require("os").platform() === "win32"; } catch (e) { /* macOS */ }
  const dirs = [];
  for (const y of [year, year + 1, year - 1]) {
    dirs.push(win
      ? `C:\\Program Files\\Adobe\\Adobe Premiere Pro ${y}\\MediaIO\\systempresets\\${H264}\\`
      : `/Applications/Adobe Premiere Pro ${y}/Adobe Premiere Pro ${y}.app/Contents/MediaIO/systempresets/${H264}/`);
  }
  for (const name of PRESETS) {
    for (const dir of dirs) {
      if ((await platform().fileSize(dir + name)) !== null) return dir + name;
    }
  }
  throw new Error("Couldn't find Premiere's \"Match Source\" H.264 export preset.");
}

/* Render the whole sequence. Resolves when the file is complete. */
function render(sequence, outPath, preset) {
  const em = ppro.EncoderManager.getManager();
  const E = ppro.EncoderManager;
  return new Promise((resolveP, rejectP) => {
    const listeners = [];
    let settled = false;
    let timer = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [name, fn] of listeners) {
        try { ppro.EventManager.removeEventListener(em, name, fn); } catch (e) { /* gone */ }
      }
      if (err) rejectP(err); else resolveP();
    };
    const on = (name, fn) => {
      if (!name) return;
      try { ppro.EventManager.addEventListener(em, name, fn); listeners.push([name, fn]); }
      catch (e) { log(`could not listen for ${name}: ${e.message}`); }
    };
    // Progress arrives as 0-1 or 0-100 depending on the build.
    on(E.EVENT_RENDER_PROGRESS, (ev) => {
      let p = Number(ev && (ev.progress !== undefined ? ev.progress : ev.value)) || 0;
      if (p > 1) p /= 100;
      say(`Rendering… ${Math.round(p * 100)}%`, p);
    });
    on(E.EVENT_RENDER_COMPLETE, () => finish());
    on(E.EVENT_RENDER_ERROR, (ev) => finish(new Error((ev && (ev.message || ev.error)) || "the export failed")));
    on(E.EVENT_RENDER_CANCEL, () => finish(new Error("the export was cancelled")));
    timer = setTimeout(() => finish(new Error("the export took too long")), RENDER_TIMEOUT_MS);

    em.exportSequence(sequence, ppro.Constants.ExportType.IMMEDIATELY, outPath, preset, true).then(async (ok) => {
      if (!ok) return finish(new Error("Premiere refused the export"));
      // No completion event on some builds: a finished file is proof enough.
      if (await platform().fileSize(outPath)) finish();
    }, (e) => finish(e));
  });
}

/* Poll until Shade has the file at its full size, or give up. */
async function waitForShade(driveId, path, size, label) {
  const started = Date.now();
  let delay = 3000;
  while (Date.now() - started < WAIT_MS) {
    const a = await shade.assetByPath(driveId, path).catch(() => null);
    if (a && (size === null || a.size_bytes === size)) return a;
    say(`Uploading to Shade… (${label}, ${Math.round((Date.now() - started) / 1000)}s)`);
    await sleep(delay);
    delay = Math.min(10000, delay + 1000);
  }
  return null;
}

async function assetOrNull(driveId, id) {
  if (!id) return null;
  try { return await shade.getAsset(driveId, id); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

/* Put the new version on top of the previous one. Returns the fresh asset. */
async function stack(driveId, asset, prev) {
  if (!prev) return asset;
  if (asset.stack_id && asset.stack_id === prev.stack_id) return asset;   // a retry, already done
  if (prev.stack_id) await shade.addToStack(driveId, asset.id, prev.id);
  else await shade.createStack(driveId, [prev.id, asset.id]);
  const after = await shade.getAsset(driveId, asset.id);
  const before = await assetOrNull(driveId, prev.id);
  // Which end of a stack Shade shows as current is to be confirmed on a real
  // run; the numbers are logged so it can be.
  log(`stacked ${after.name} (#${after.stack_number}) with ${prev.name} (#${before ? before.stack_number : "?"})`);
  return after;
}

/* The Exports column on the project's Premiere Projects record. */
async function listOnRecord(ctx, prevId, newId) {
  if (!settings.get("tracking")) return "project tracking is off, so Exports wasn't updated";
  const schema = await sync.schemaFor(ctx.driveId).catch(() => null);
  if (!schema || !schema.exportsColumn) return `"${ctx.driveName}" has no Exports column yet`;
  const record = await sync.projectRecord(ctx.driveId, schema,
    { guid: ctx.projectGuid, name: ctx.projectName, path: ctx.projectPath });
  const ids = mergeExports(sync.relationIdsOf(record, schema.exportsColumn), prevId, newId);
  await shade.patchRecord(ctx.driveId, schema.typeId, record.id, {
    metadata: { [schema.exportsColumn]: { kind: "relation", values: ids.map((id) => ({ id, type: "asset" })) } }
  });
  return null;
}

/* ---------------------------------------------------------------- run */

/* The Export button. Resolves a line for the panel; dialogs say the rest. */
async function run() {
  if (busy) return "an export is already running";
  busy = true;
  try {
    if (!(await hasKey())) throw new Error("Add your Shade API key in Settings first.");
    const em = ppro.EncoderManager && ppro.EncoderManager.getManager();
    if (!em) throw new Error("This Premiere can't export from a plugin (needs 25.6 or later).");
    if (em.isAMEInstalled === false) throw new Error("Export needs Adobe Media Encoder installed.");

    say("Preparing…");
    const ctx = await context();
    const target = await targetOf(ctx, await seqlink.read(ppro, ctx.sequence).catch(() => null));
    const link = target.link;
    let prev = link && link.drive === ctx.driveId ? await assetOrNull(ctx.driveId, link.latest) : null;

    const waiting = pending.get(ctx.sequenceGuid);
    if (waiting && (await platform().fileSize(waiting.outPath)) !== null) {
      const again = await dialog.confirm({
        heading: `Finish linking ${waiting.label}?`,
        lines: [`${waiting.name} was exported, but Shade hadn't picked it up yet.`,
                "Link it now instead of exporting again?"],
        yes: "Finish Linking", no: "Export Again"
      });
      if (again) return await finish(ctx, waiting, waiting.prev);
      pending.delete(ctx.sequenceGuid);
    }

    const folder = await chooseFolder(ctx);
    if (!folder) { say(""); return "export cancelled"; }

    const base = baseName(ctx.projectName, target.name);
    const names = (await folder.getEntries().catch(() => [])).map((e) => e.name);
    if (prev) names.push(prev.name);
    if (link && link.version) names.push(fileName(base, link.version, "mp4"));
    const n = nextVersion(base, names);
    if (!prev) {
      // No link stored (a project from before this, or a copy): the newest
      // version already in the folder is the one to stack onto.
      const top = highest(base, names);
      const at = top && locate(join(folder.nativePath, top), [ctx.mount]);
      prev = at ? await shade.assetByPath(ctx.driveId, shadePath(ctx.driveId, at.rest)).catch(() => null) : null;
      if (prev) log(`no stored link for "${target.name}"; stacking onto ${prev.name} found in the folder`);
    }

    const preset = await findPreset();
    const ext = await ppro.EncoderManager.getExportFileExtension(ctx.sequence, preset).catch(() => "mp4");
    const name = fileName(base, n, ext || "mp4");
    const outPath = join(folder.nativePath, name);
    const where = locate(outPath, [ctx.mount]);
    const job = { outPath, name, n, label: formatVersion(n), shadePath: shadePath(ctx.driveId, where.rest),
                  target, prev, snap: null, snapNote: null };

    log(`export "${ctx.sequenceName}" -> ${outPath} (${preset.split(/[\\/]/).pop()})`);
    say(`Rendering ${job.label}…`, 0);
    const t0 = Date.now();
    await render(ctx.sequence, outPath, preset);
    log(`rendered ${name} in ${Math.round((Date.now() - t0) / 1000)}s`);

    // Before anything else can change it: the timeline as it was rendered.
    try {
      job.snap = await snapshot.make(ppro, ctx.project, ctx.sequence, {
        name: snapshotName(target.name, n), version: n, driveId: ctx.driveId, originalGuid: target.guid
      });
    } catch (e) {
      job.snapNote = `version timeline not made: ${e.message}`;
      log(`${name}: ${job.snapNote}`);
    }
    // The working timeline is the original: the one just exported, or, when
    // a version timeline was exported, the timeline it was copied from. A
    // version timeline is a record and keeps its own comments (found in
    // testing: exporting from "…_V01" cleared V01's markers). With the
    // original deleted there is no working timeline to clear.
    const working = target.holder;
    const workingName = working === ctx.sequence ? ctx.sequenceName : target.name;
    if (working) {
      // A new version starts with no comments: clear the Shade comment
      // markers (the editor's own stay), so Import comments can bring in
      // this version's. The copy above was made first.
      await snapshot.removeShadeMarkers(ppro, ctx.project, working)
        .then((n) => { if (n) log(`cleared ${n} Shade comment marker(s) from "${workingName}" for ${job.label}`); })
        .catch((e) => log(`couldn't clear comment markers from "${workingName}": ${e.message}`));
    }
    // Carry on in the working timeline; put the version records away.
    await snapshot.focusWorking(ppro, ctx.project, working || ctx.sequence, target.guid)
      .then((closed) => { if (closed) log(`closed ${closed} version timeline(s); "${working ? workingName : ctx.sequenceName}" is active`); })
      .catch((e) => log(`couldn't bring the working timeline back to the front: ${e.message}`));

    pending.set(ctx.sequenceGuid, job);
    return await finish(ctx, job, prev);
  } catch (e) {
    say(`Export failed: ${e.message}`);
    log("export failed:", e.message);
    await dialog.notify({ heading: "Export didn't finish", lines: [e.message] }).catch(() => {});
    return `export failed: ${e.message}`;
  } finally {
    busy = false;
  }
}

/* Steps 5-8 for a rendered file. Safe to run again for the same file. */
async function finish(ctx, job, prev) {
  const size = await platform().fileSize(job.outPath);
  const t0 = Date.now();
  const asset = await waitForShade(ctx.driveId, job.shadePath, size, job.label);
  if (!asset) {
    say(`${job.label} saved. Shade hasn't picked it up yet: press Export again to finish linking.`);
    log(`${job.name}: not in Shade after ${Math.round(WAIT_MS / 60000)} min; left pending`);
    return `${job.label} saved; not in Shade yet`;
  }
  log(`${job.name} in Shade after ${Math.round((Date.now() - t0) / 1000)}s`);

  say(`Adding ${job.label} to its stack…`);
  // A refused stack (say, the previous version is in another folder) must not
  // turn a good export into a failure: the file is in Shade either way.
  let stackNote = null;
  const stacked = await stack(ctx.driveId, asset, prev).catch((e) => {
    stackNote = `not stacked: ${e.message}`;
    log(`${job.name}: ${stackNote}`);
    return asset;
  });
  const prevId = prev ? prev.id : null;       // its Exports slot is replaced either way
  if (stackNote) prev = null;
  if (job.target.holder) {
    await seqlink.write(ppro, ctx.project, job.target.holder, {
      drive: ctx.driveId, latest: stacked.id, stack: stacked.stack_id || null, version: job.n
    }).catch((e) => log(`couldn't store the export link on the timeline: ${e.message}`));
  }
  if (job.snap) {
    await snapshot.complete(ppro, ctx.project, job.snap, {
      driveId: ctx.driveId, assetId: stacked.id, stackId: stacked.stack_id, version: job.n,
      originalGuid: job.target.guid
    }).catch((e) => {
      job.snapNote = `version timeline not linked: ${e.message}`;
      log(`${job.name}: ${job.snapNote}`);
    });
  }
  const skipped = await listOnRecord(ctx, prevId, stacked.id)
    .catch((e) => `couldn't update Exports: ${e.message}`);
  pending.delete(ctx.sequenceGuid);

  const notes = [stackNote, skipped, job.snapNote].filter(Boolean).join("; ");
  const msg = `${job.name} is in Shade` + (prev ? `, stacked on ${prev.name}` : "") + (notes ? ` (${notes})` : "");
  log(msg);
  say(`${job.label} exported and in Shade` + (job.snap ? `; version timeline "${job.snap.name}".` : "."));
  return msg;
}

const status = () => ({ ...state, busy });

module.exports = { init, run, status };
