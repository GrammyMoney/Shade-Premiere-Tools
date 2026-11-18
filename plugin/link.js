/*
 * What happens when a Shade clip lands in a project.
 *
 *   new clip item ─► on a Shade mount? ─► GET /assets/path ─► Linked Proxy? (hi-res)
 *                                                              Linked Hi Res? (proxy)
 *                                                              │
 *                       pin both files ◄──────── attachProxy ◄─┘
 *
 * "New" means an item this session has not seen in this project. A project
 * is seeded the first time we see it -- everything already in it is marked
 * seen and left alone -- so opening last month's project does not pin its
 * entire media pool. Only what arrives afterwards is acted on.
 *
 * Two triggers find new items, and both run the same walk through one queue:
 *
 *   IMPORT_MEDIA_COMPLETE  the fast path. The event fires BEFORE the item is
 *                          queryable (100-217ms later, measured in SHINE), so
 *                          poll briefly instead of waiting a fixed delay.
 *   DIRTY, debounced       the backstop, for any route the import event does
 *                          not cover. Cheap: a walk is single-digit ms.
 *
 * Nothing is saved between sessions, on purpose: a fresh launch re-seeds
 * from what is in the project.
 *
 * Two settings share this walk (settings.js): "linking" does the lookup and
 * attach, "autoPin" the pinning. With linking off, a new clip is pinned
 * straight from the mount, with no Shade request; with both off, nothing.
 *
 * "pinWhen" says when a new clip is pinned (added 2026-10-27):
 *   import    as it lands in the project (above)
 *   timeline  when it is first put on a timeline. There is no event for
 *             that, so the debounced DIRTY walk also lists every sequence's
 *             clips and pins the items not on a timeline before. As with
 *             imports, what is already on a timeline when a project is first
 *             seen (or when either setting changes) is left alone: the open
 *             prompt is how a whole project gets pinned.
 *
 * Came over from Shade-Linker. Pinning a whole project, with the editor's
 * say-so, is projectpins.js; this file only ever pins what was just imported,
 * and reports it through onPinned so the project's unpin covers it.
 */

const { log } = require("./log.js");
const shade = require("./shade.js");
const shadefs = require("./shadefs.js");
const settings = require("./settings.js");
const { safe, clips, activeProject } = require("./walk.js");
const { walkSequences } = require("./walk.js");
const { locate, shadePath, localPath } = require("./mounts.js");
const { linkedIds, pinnableIno, decide, fieldByName, isPinned } = require("./pins.js");

const FIELD_NAMES = { proxy: "Linked Proxy", hiRes: "Linked Hi Res" };
const FIELD_TTL_MS = 10 * 60 * 1000;   // a panel runs for days; fields get replaced
const POLL_MS = 40;
const POLL_BUDGET_MS = 6000;
const STRAGGLER_MS = 300;              // a multi-file import lands over a few beats
const MISSING_RETRIES = 5;

const seen = new Map();        // project guid -> Set of project item ids
const waiting = new Map();     // item id -> tries left, for files Shade has not indexed yet
const fields = new Map();      // driveId -> { ids: { proxy, hiRes }, at }
const onTimeline = new Map();  // project guid -> Set of item ids already on a timeline
let queue = Promise.resolve();
let onPinned = () => {};     // (project, [{ path, ino, size, mount, rest }])
let onNeedsSetup = () => {}; // (driveId): linking is on, the drive lacks both fields

const stats = {
  linked: 0, pinned: 0, skipped: 0, failed: 0,
  last: null, lastAt: 0, lastError: null, mounts: 0
};

const pinOnImport = () => settings.get("autoPin") && settings.get("pinWhen") === "import";
const pinOnTimeline = () => settings.get("autoPin") && settings.get("pinWhen") === "timeline";

// Switching either one starts the timeline watch afresh: what is on a
// timeline at that moment is left alone, not pinned in one go.
settings.onChange((key) => { if (key === "autoPin" || key === "pinWhen") onTimeline.clear(); });

/* ------------------------------------------------------------ the walk */

/*
 * Items not seen before. The first walk of a project seeds it and returns
 * nothing: what was already there is not ours to act on.
 */
async function fresh(ppro) {
  const p = await activeProject(ppro);
  if (!p) return [];
  const all = await clips(ppro, p.folder);
  let known = seen.get(p.guid);
  if (!known) {
    seen.set(p.guid, new Set(all.map((c) => c.id)));
    log(`watching project ${p.guid.slice(0, 8)}: ${all.length} existing clip(s) left alone`);
    return [];
  }
  const out = all.filter((c) => !known.has(c.id) || waiting.has(c.id));
  for (const c of out) { known.add(c.id); c.project = { guid: p.guid, name: p.name }; }
  return out;
}

/* Serialise every walk, so two triggers never process one item twice. */
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch((e) => {
    stats.lastError = e.message;
    log("pass failed:", e.message);
  });
  return run;
}

/* ------------------------------------------------------------ triggers */

/* A project opened or became active: seed it, so its contents are left alone. */
function seed(ppro) {
  return enqueue(async () => {
    await fresh(ppro);
    if (pinOnTimeline()) await timelineAdditions(ppro);
  });
}

function onImport(ppro) {
  return enqueue(async () => {
    const started = Date.now();
    let found = [];
    while (Date.now() - started < POLL_BUDGET_MS) {
      found = await fresh(ppro);
      if (found.length) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (!found.length) return;
    await new Promise((r) => setTimeout(r, STRAGGLER_MS));
    found = found.concat(await fresh(ppro));
    log(`import: ${found.length} new clip(s) after ${Date.now() - started}ms`);
    await processAll(found);
  });
}

function onDirty(ppro) {
  return enqueue(async () => {
    const found = await fresh(ppro);
    if (found.length) await processAll(found);
    if (pinOnTimeline()) await pinTimeline(ppro);
  });
}

/* ------------------------------------------------------------ timelines */

/*
 * Clip items put on a timeline since the last look, with the project.
 * The first look at a project seeds it and returns none.
 */
async function timelineAdditions(ppro) {
  const p = await activeProject(ppro);
  if (!p) return null;
  const used = new Set();
  await walkSequences(ppro, p.project, used);
  const known = onTimeline.get(p.guid);
  if (!known) {
    onTimeline.set(p.guid, used);
    log(`watching timelines of ${p.guid.slice(0, 8)}: ${used.size} clip(s) already on one left alone`);
    return null;
  }
  const added = [...used].filter((id) => !known.has(id));
  if (!added.length) return null;
  for (const id of added) known.add(id);
  const ids = new Set(added);
  const items = (await clips(ppro, p.folder)).filter((c) => ids.has(c.id));   // sequences drop out here
  for (const c of items) c.project = { guid: p.guid, name: p.name };
  return { p, items, ids };
}

async function pinTimeline(ppro) {
  const found = await timelineAdditions(ppro);
  if (!found || !found.items.length) return;
  let ms;
  try {
    ms = await mounts();
  } catch (e) {
    log("Shade bridge unavailable:", e.message);
    stats.lastError = "Shade is not running";
    // Look at them again next time, when Shade may be back.
    for (const id of found.ids) onTimeline.get(found.p.guid).delete(id);
    return;
  }
  stats.lastError = null;
  const pinnedNow = await shadefs.pinned().catch(() => null);
  for (const item of found.items) {
    try {
      const path = await safe(() => item.clip.getMediaFilePath(), null);
      const where = path && locate(path, ms);
      if (!where) continue;                 // not on a Shade drive: not ours
      const n = await pinFiles(item, path, where.mount, pinnedNow);
      log(`${item.name}: on a timeline, ${n ? `pinned ${n} file(s)` : "already pinned"}`);
    } catch (e) {
      stats.failed++;
      stats.lastError = e.message;
      log(`${item.name}: ${e.message}`);
    }
  }
}

/* ------------------------------------------------------------ the work */

async function mounts() {
  const out = await shadefs.mounts();
  stats.mounts = out.length;
  return out;
}

/* Both link fields' ids on a drive; null for one the drive lacks. */
async function fieldIds(driveId) {
  const hit = fields.get(driveId);
  if (hit && Date.now() - hit.at < FIELD_TTL_MS) return hit.ids;
  const all = (await shade.listFields(driveId)) || [];
  const ids = {};
  for (const [k, name] of Object.entries(FIELD_NAMES)) {
    const f = fieldByName(all, name);
    if (!f) log(`drive ${driveId.slice(0, 8)} has no "${name}" field`);
    ids[k] = f ? f.id : null;
  }
  fields.set(driveId, { ids, at: Date.now() });
  return ids;
}

async function processAll(items) {
  if (!settings.get("linking") && !pinOnImport()) return;
  let ms;
  try {
    ms = await mounts();
  } catch (e) {
    // Shade is not running. Then nothing on its drives is reachable anyway.
    log("Shade bridge unavailable:", e.message);
    stats.lastError = "Shade is not running";
    return;
  }
  stats.lastError = null;
  for (const item of items) {
    try {
      await processOne(item, ms);
    } catch (e) {
      stats.failed++;
      stats.lastError = e.message;
      log(`${item.name}: ${e.message}`);
    }
  }
}

async function processOne(item, ms) {
  const { clip, name } = item;
  const path = await safe(() => clip.getMediaFilePath(), null);
  const where = path && locate(path, ms);
  if (!where) { waiting.delete(item.id); return; }   // not on a Shade drive: not ours
  const { mount, rest } = where;

  // Auto-pinning without linking needs no Shade lookup: the clip, and a
  // proxy someone else attached, are pinned by inode from the mount.
  if (!settings.get("linking")) {
    waiting.delete(item.id);
    await pinOnly(item, path, mount);
    return;
  }

  const asset = await shade.assetByPath(mount.driveId, shadePath(mount.driveId, rest));
  if (!asset) {
    // On the drive but not indexed yet (Shade takes seconds). Look again on
    // the next pass, a few times, then let it go.
    const left = (waiting.has(item.id) ? waiting.get(item.id) : MISSING_RETRIES) - 1;
    if (left > 0) waiting.set(item.id, left); else waiting.delete(item.id);
    log(`${name}: not in Shade yet${left > 0 ? ", will look again" : ", giving up"}`);
    return;
  }
  waiting.delete(item.id);

  const pins = [];
  const addPin = async (p) => {
    if (!pinOnImport()) return;
    const st = await shadefs.statOf(p);
    const where = locate(p, [mount]);
    if (pinnableIno(st.ino, mount.rootIno)) pins.push({ path: p, ino: st.ino, size: st.size, mount, rest: where && where.rest });
    else if (st.ino !== null) log(`${p}: inode ${st.ino} is the drive root's; not pinning`);
  };

  // Link first, so the editor sees the result before anything slow happens.
  const hasProxy = await safe(() => clip.hasProxy(), false);
  const ids = await fieldIds(mount.driveId);
  if (!ids.proxy && !ids.hiRes) onNeedsSetup(mount.driveId);
  const plan = decide({ hasProxy,
                        proxyIds: linkedIds(asset, ids.proxy),
                        hiResIds: linkedIds(asset, ids.hiRes) });

  if (plan.attach) {
    // The other half of the pair: the proxy for a hi-res, or the hi-res for
    // a proxy. Pinned either way -- everything in the project is pinned.
    const what = plan.isHiRes ? "hi-res" : "proxy";
    const other = await getAssetOrNull(mount.driveId, plan.otherId);
    const otherPath = other && localPath(other.path, mount);
    if (!otherPath) {
      log(`${name}: linked ${what} ${plan.otherId.slice(0, 8)} is not on this drive`);
    } else {
      await addPin(otherPath);
      const ok = await safe(() => clip.attachProxy(otherPath, plan.isHiRes), false);
      if (ok) {
        stats.linked++;
        log(`${name}: ${what} linked (${other.name})`);
      } else {
        // attachProxy returns a bare false on a frame-rate or duration
        // mismatch (premiere-events gotcha). Retrying cannot fix the media.
        stats.failed++;
        log(`${name}: Premiere refused the ${what} -- check frame rate and duration match`);
      }
    }
  } else {
    stats.skipped++;
    if (hasProxy) {
      // Whoever attached it, the proxy is what Premiere will read: pin it too.
      const existing = await safe(() => clip.getProxyPath(), null);
      if (existing && locate(existing, [mount])) await addPin(existing);
    }
    log(`${name}: ${plan.reason}`);
  }

  await addPin(path);
  await sendPins(item, pins);
}

/* Auto-pinning alone: the clip and whatever proxy it already has. */
async function pinOnly(item, path, mount) {
  if (!pinOnImport()) return;
  await pinFiles(item, path, mount, null);
}

/*
 * Pin a clip's media and its attached proxy, skipping any file already in
 * `pinnedNow` (the bridge's pin list, or null to skip none). Returns how
 * many were pinned.
 */
async function pinFiles(item, path, mount, pinnedNow) {
  const pins = [];
  for (const p of [path, await safe(() => item.clip.getProxyPath(), null)]) {
    const where = p && locate(p, [mount]);
    if (!where) continue;
    if (pinnedNow && isPinned(pinnedNow, mount.driveId, where.rest)) continue;
    const st = await shadefs.statOf(p);
    if (pinnableIno(st.ino, mount.rootIno)) pins.push({ path: p, ino: st.ino, size: st.size, mount, rest: where.rest });
  }
  await sendPins(item, pins);
  return pins.length;
}

async function sendPins(item, pins) {
  if (pins.length) {
    const r = await shadefs.pin(pins.map((x) => x.ino));
    if (r.code !== 0) throw new Error(`pin failed: ${r.data}`);
    stats.pinned += pins.length;
    if (item.project) onPinned(item.project, pins);
    if (!settings.get("linking")) log(`${item.name}: pinned`);
  }
  stats.last = item.name;
  stats.lastAt = Date.now();
}

/* GET /assets/{id}, or null when the asset is gone. */
async function getAssetOrNull(driveId, assetId) {
  try {
    return await shade.getAsset(driveId, assetId);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

function status() { return Object.assign({}, stats); }

function setOnPinned(fn) { onPinned = fn; }
function setOnNeedsSetup(fn) { onNeedsSetup = fn; }

/* Field ids are re-read after setup creates them. */
function forget() { fields.clear(); }

module.exports = { seed, onImport, onDirty, status, timelineAdditions, fieldIds, getAssetOrNull, setOnPinned,
                   setOnNeedsSetup, forget, FIELD_NAMES };
