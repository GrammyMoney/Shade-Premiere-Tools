/*
 * Shade comments as Premiere markers.
 *
 *   importTimeline()  the Import comments button: each version's comments
 *                     -> markers on that version's timeline, and only there
 *   onImported(list)  after an import: comments on the Shade clips just
 *                     brought in -> clip markers (Source Monitor), asked
 *                     about first unless the editor said "every time"
 *
 * Where comments go (decided 2026-10-26, revised after testing):
 *   - the working timeline gets its newest version's comments. Export
 *     clears its "(Shade)" markers, so it only ever shows the current
 *     version's notes;
 *   - each version timeline (snapshot.js) gets its own version's comments,
 *     and starts with none (copied ones are removed when it's made).
 * The button fills all of them, from whichever timeline of the line it's
 * pressed on.
 *
 * What becomes a marker, and duplicate detection, are in markers-plan.js.
 * Times need no offset: an export covers its whole sequence from the start,
 * and a clip's comments are timed from the start of its media.
 *
 * Premiere side, as in Shade's own plugin: markers are added inside
 * lockedAccess + executeTransaction, then coloured purple in a second
 * transaction (colouring in the same one as the add did not take there).
 */

const { log } = require("./log.js");
const shade = require("./shade.js");
const settings = require("./settings.js");
const dialog = require("./dialog.js");
const { planMarkers, isOurs } = require("./markers-plan.js");
const { shadePath } = require("./mounts.js");
const seqlink = require("./seqlink.js");
const snapshot = require("./snapshot.js");
const { formatVersion } = require("./versions.js");

const TICKS_PER_SECOND = 254016000000;
const PURPLE = 2;                    // Premiere's marker colour index for purple
const PARALLEL = 4;

let ppro = null;
let hasKey = async () => false;

function init(pproModule, opts = {}) {
  ppro = pproModule;
  hasKey = opts.hasKey || hasKey;
}

/* One frame of a sequence, in seconds, for the duplicate window. */
async function frameSeconds(sequence) {
  try {
    const ticks = Number(await sequence.getTimebase());
    return ticks > 0 ? ticks / TICKS_PER_SECOND : null;
  } catch (e) {
    return null;
  }
}

const secondsOf = (t) => (t && typeof t.seconds === "number" && isFinite(t.seconds) ? t.seconds : 0);

/* The markers already on a sequence or clip, as markers-plan wants them. */
async function existing(owner) {
  const markers = await ppro.Markers.getMarkers(owner);
  return (markers.getMarkers() || []).map((m) => ({
    name: String(m.getName() || ""), start: secondsOf(m.getStart()), text: String(m.getComments() || "")
  }));
}

/* Add planned markers to a sequence or clip, then colour ours purple. */
async function addMarkers(project, owner, planned) {
  if (!planned.length) return 0;
  const T = ppro.TickTime;
  const markers = await ppro.Markers.getMarkers(owner);
  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((compound) => {
      for (const m of planned) {
        compound.addAction(markers.createAddMarkerAction(m.name, ppro.Marker.MARKER_TYPE_COMMENT,
          T.createWithSeconds(m.start), m.duration ? T.createWithSeconds(m.duration) : T.TIME_ZERO, m.text));
      }
    }, "Shade Tracker: add comment markers");
  });
  if (ok === false) throw new Error("Premiere did not add the markers");

  // Colour only the markers just added: ours, at a planned time.
  try {
    const now = (await ppro.Markers.getMarkers(owner)).getMarkers() || [];
    const fresh = now.filter((m) => isOurs({ name: m.getName() }) &&
      planned.some((p) => Math.abs(p.start - secondsOf(m.getStart())) < 0.001 && p.name === m.getName()));
    if (fresh.length && typeof fresh[0].createSetColorByIndexAction === "function") {
      project.lockedAccess(() => {
        project.executeTransaction((compound) => {
          for (const m of fresh) compound.addAction(m.createSetColorByIndexAction(PURPLE));
        }, "Shade Tracker: colour comment markers");
      });
    }
  } catch (e) {
    log(`markers added, but not coloured: ${e.message}`);
  }
  return planned.length;
}

/* --------------------------------------------------- Import comments */

async function importTimeline() {
  if (!(await hasKey())) return "add your Shade API key in Settings first";
  const project = await ppro.Project.getActiveProject();
  const active = project && (await project.getActiveSequence());
  if (!active) return "open a timeline first";
  const link = await seqlink.read(ppro, active).catch(() => null);

  // The whole line: the working timeline (newest version's comments) and
  // every version timeline made from it (each its own version's).
  const originalGuid = link && link.snapshotOf ? link.snapshotOf : String(active.guid);
  const original = link && link.snapshotOf ? await snapshot.sequenceByGuid(project, originalGuid) : active;
  const originalLink = original === active ? link : await seqlink.read(ppro, original).catch(() => null);
  const targets = [];
  if (original && originalLink && originalLink.latest) {
    targets.push({ sequence: original, link: originalLink, working: true });
  }
  targets.push(...await snapshot.versionsOf(ppro, project, originalGuid));
  if (!targets.length) return "this timeline hasn't been exported to Shade yet";

  const parts = [];
  let total = 0;
  for (const { sequence, link: l, working } of targets) {
    const v = l.version ? formatVersion(l.version) : String(sequence.name);
    const label = working ? `working timeline (${v})` : v;
    if (!l.latest) { parts.push(`${label}: not in Shade yet`); continue; }
    try {
      const comments = (await shade.getComments(l.drive, l.latest)) || [];
      const plan = planMarkers(comments, await existing(sequence), await frameSeconds(sequence));
      const added = await addMarkers(project, sequence, plan.add);
      total += added;
      parts.push(`${label}: ${added} added` + (plan.already ? `, ${plan.already} already there` : ""));
    } catch (e) {
      parts.push(`${label}: ${e.status === 404 ? "no longer in Shade" : e.message}`);
    }
  }
  const msg = `comments: ${total} marker${total === 1 ? "" : "s"} added (${parts.join("; ")})`;
  log(msg);
  return msg;
}

/* ---------------------------------------------------- source comments */

async function eachLimited(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/*
 * After an import. `list` is [{ clip, name, mount, rest, asset? }] for the
 * new Shade clips; `asset` is there when linking already looked it up.
 */
async function onImported(list) {
  const mode = settings.get("sourceComments");
  if (mode === "never" || !list.length) return;
  if (!(await hasKey())) return;
  const project = await ppro.Project.getActiveProject();
  if (!project) return;

  const found = await eachLimited(list, PARALLEL, async (it) => {
    try {
      const driveId = it.mount.driveId;
      const asset = it.asset || (await shade.assetByPath(driveId, shadePath(driveId, it.rest)));
      if (!asset) return null;
      const comments = (await shade.getComments(driveId, asset.id)) || [];
      if (!comments.length) return null;
      // Source media: no frame rate to hand, so the default half-frame window.
      const plan = planMarkers(comments, await existing(it.clip), null);
      return plan.add.length ? { it, add: plan.add } : null;
    } catch (e) {
      log(`${it.name}: couldn't read Shade comments: ${e.message}`);
      return null;
    }
  });
  const withComments = found.filter(Boolean);
  if (!withComments.length) return;
  const total = withComments.reduce((a, x) => a + x.add.length, 0);
  const clips = withComments.length;

  if (mode !== "always") {
    const r = await dialog.ask({
      heading: "Add Shade comments to these clips?",
      lines: [`${clips} imported clip${clips === 1 ? " has" : "s have"} Shade comments (${total}).`,
              "Add them as clip markers, shown in the Source Monitor?"],
      yes: "Add Markers", no: "Not Now", checkbox: "Do this every time"
    });
    if (r.checked) await settings.set("sourceComments", r.yes ? "always" : "never");
    if (!r.yes) { log(`source comments declined for ${clips} clip(s)`); return; }
  }

  let added = 0;
  for (const { it, add } of withComments) {
    try { added += await addMarkers(project, it.clip, add); }
    catch (e) { log(`${it.name}: couldn't add comment markers: ${e.message}`); }
  }
  log(`added ${added} comment marker(s) to ${clips} imported clip(s)`);
}

module.exports = { init, importTimeline, onImported };
