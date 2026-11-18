/*
 * Walking a project: what is in it, and what is actually on a timeline.
 *
 * Lifted from premiere-events, minus everything to do with proxies.
 *
 * Premiere sends no event when an item is added or a timeline's structure
 * changes, so there is nothing to listen to that would let us maintain this
 * incrementally. The whole project gets walked instead. That is affordable --
 * 129 items across 5 sequences measured 24ms -- which is why the debounce
 * before it exists to let edits settle, not to avoid the cost.
 *
 * Every Premiere call is wrapped: on a walk of an arbitrary user project, one
 * item that throws must not abandon the other hundred.
 *
 * No uxp require here, so collapse() can be tested under plain Node.
 */

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { return fallback; }
}

async function cast(Klass, item) {
  try { return (await Klass.cast(item)) || null; } catch (e) { return null; }
}

/*
 * Every clip item in the project: project-item id -> media path.
 *
 * Sequences are project items too and are skipped: a sequence is not an
 * asset.
 */
async function walkBins(ppro, folder, out, depth = 0) {
  // Guards against a pathological or cyclic bin structure. Real projects are
  // nowhere near this deep.
  if (depth > 32) return;
  const items = await safe(() => folder.getItems(), []);
  for (const item of items) {
    const sub = await cast(ppro.FolderItem, item);
    if (sub) { await walkBins(ppro, sub, out, depth + 1); continue; }

    const clip = await cast(ppro.ClipProjectItem, item);
    if (!clip) continue;
    if (await safe(() => clip.isSequence(), false)) continue;

    const id = await safe(() => item.getId(), null);
    if (id === null || id === undefined) continue;
    const mediaPath = await safe(() => clip.getMediaFilePath(), null);
    if (!mediaPath) continue;        // offline or synthetic; nothing to track

    out.set(String(id), { mediaPath, name: item.name });
  }
}

/*
 * The set of project-item ids that appear on any timeline.
 *
 * Only direct timeline use is counted. Nested sequences, multicam, Dynamic
 * Link and Motion Graphics templates can all hide usage; resolving them is
 * out of scope, and "Used?" is never unset, so a miss here costs a late
 * flag rather than a wrong one.
 */
async function walkSequences(ppro, project, usedIds) {
  const clipType =
    (ppro.Constants && ppro.Constants.TrackItemType &&
     ppro.Constants.TrackItemType.CLIP !== undefined)
      ? ppro.Constants.TrackItemType.CLIP
      : 1;  // documented: Empty 0, Clip 1, Transition 2, Preview 3, Feedback 4

  const seqs = await safe(() => project.getSequences(), []);
  for (const seq of seqs) {
    const groups = [
      [() => seq.getVideoTrackCount(), (i) => seq.getVideoTrack(i)],
      [() => seq.getAudioTrackCount(), (i) => seq.getAudioTrack(i)]
    ];
    for (const [countFn, trackFn] of groups) {
      const count = await safe(countFn, 0);
      for (let i = 0; i < count; i++) {
        const track = await safe(() => trackFn(i), null);
        if (!track) continue;
        const items = await safe(() => track.getTrackItems(clipType, false), []);
        for (const ti of items) {
          const pi = await safe(() => ti.getProjectItem(), null);
          if (!pi) continue;
          const id = await safe(() => pi.getId(), null);
          if (id !== null && id !== undefined) usedIds.add(String(id));
        }
      }
    }
  }
  return seqs.length;
}

/*
 * Collapse project items onto media paths.
 *
 * The same file imported twice is two project items sharing one path, and in
 * a real project one copy was on a timeline while the other was not. Per
 * item, one of them looks unused. Per file, it plainly is used -- so usage
 * is OR-ed up before anything is sent.
 */
function collapse(items, usedIds) {
  const byPath = new Map();
  for (const [itemId, info] of items) {
    let entry = byPath.get(info.mediaPath);
    if (!entry) {
      entry = { mediaPath: info.mediaPath, name: info.name, itemCount: 0, used: false };
      byPath.set(info.mediaPath, entry);
    }
    entry.itemCount++;
    if (usedIds.has(itemId)) entry.used = true;
  }
  return [...byPath.values()];
}

async function scanProject(ppro, project) {
  const t0 = Date.now();
  const items = new Map();
  const usedIds = new Set();

  const root = await safe(() => project.getRootItem(), null);
  if (!root) return null;
  const rootFolder = (await cast(ppro.FolderItem, root)) || root;

  await walkBins(ppro, rootFolder, items);
  const sequences = await walkSequences(ppro, project, usedIds);
  const files = collapse(items, usedIds);

  return {
    guid: String(await safe(() => project.guid, "")),
    name: await safe(() => project.name, null),
    path: await safe(() => project.path, null),
    files,
    timing: {
      ms: Date.now() - t0,
      items: items.size,
      files: files.length,
      used: files.filter((f) => f.used).length,
      sequences
    }
  };
}

module.exports = { scanProject, collapse, walkSequences };
