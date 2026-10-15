/*
 * The active project and its clip items, for linking and pinning.
 *
 * scan.js walks the project for tracking and keeps only media paths. Linking
 * and pinning need the ClipProjectItem itself (attachProxy, getProxyPath), so
 * they walk with this instead. Every Premiere call is wrapped: one item that
 * throws must not abandon the rest of the project.
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

module.exports = { safe, clips, activeProject };
