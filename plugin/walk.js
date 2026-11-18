/*
 * The active project, its clip items, and which of them are on a timeline.
 *
 * Premiere sends no event when an item is added or a timeline changes, so
 * the whole project is walked instead (cheap: 129 items across 5 sequences
 * measured 24ms). Every Premiere call is wrapped: one item that throws must
 * not abandon the rest of the project.
 *
 * No uxp require here, so it loads under plain Node with Premiere faked.
 */

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { return fallback; }
}

/* Every clip item in the project (not sequences), with its id. */
async function clips(ppro, folder, out = [], depth = 0) {
  if (depth > 32) return out;
  for (const item of await safe(() => folder.getItems(), [])) {
    const sub = await safe(() => ppro.FolderItem.cast(item), null);
    if (sub) { await clips(ppro, sub, out, depth + 1); continue; }
    const clip = await safe(() => ppro.ClipProjectItem.cast(item), null);
    if (!clip) continue;
    if (await safe(() => clip.isSequence(), false)) continue;
    const id = await safe(() => item.getId(), null);
    if (!id) continue;
    out.push({ id: String(id), clip, name: item.name });
  }
  return out;
}

/* The active project: { project, guid, name, path, folder }, or null. */
async function activeProject(ppro) {
  const project = await safe(() => ppro.Project.getActiveProject(), null);
  if (!project) return null;
  const guid = String(await safe(() => project.guid, ""));
  const root = await safe(() => project.getRootItem(), null);
  const folder = root ? (await safe(() => ppro.FolderItem.cast(root), null)) || root : null;
  if (!guid || !folder) return null;
  return {
    project, guid, folder,
    name: await safe(() => project.name, ""),
    path: await safe(() => project.path, "")
  };
}

/*
 * Adds to usedIds the project-item id of every clip on any sequence's video
 * or audio tracks. Returns the number of sequences.
 *
 * Only direct timeline use is counted: nested sequences, multicam, Dynamic
 * Link and Motion Graphics templates can all hide a clip.
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

/* Premiere's Project.name includes ".prproj", which is noise in a prompt. */
function projectDisplayName(name) {
  if (typeof name !== "string") return null;
  return name.replace(/\.prproj$/i, "").trim() || null;
}

module.exports = { safe, clips, activeProject, walkSequences, projectDisplayName };
