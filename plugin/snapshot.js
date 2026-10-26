/*
 * Version timelines: a copy of a timeline as it was exported.
 *
 * Every Export makes one (decided 2026-10-26), right after the render and
 * before anyone can edit again: "<Timeline>_V03" in a "Shade Versions" bin
 * at the project root, linked to that version's Shade asset (seqlink.js,
 * with snapshotOf = the original's guid). So the cut behind every version
 * stays in the project, Import comments on it brings that version's
 * comments onto the right cut, and exporting it continues the original's
 * stack.
 *
 * Shade comments belong to the version they were left on, and only there
 * (decided 2026-10-26): a copy starts with none. The clone carries every
 * marker of the timeline it was made from, so the "(Shade)" ones are taken
 * off it; the editor's own markers stay.
 *
 * After the copy is made, work carries on in the timeline that was exported:
 * it is opened and made active, and the version timelines of the same
 * original -- the new copy and any older ones -- are closed, so nobody keeps
 * editing a record of a version by mistake (decided 2026-10-26).
 *
 * Premiere side (UXP 25.6+): Sequence.createCloneAction,
 * ProjectItem.createSetNameAction, FolderItem.createBinAction /
 * createMoveItemAction, each an Action run inside lockedAccess +
 * executeTransaction like the rest of the plugin. The clone action does not
 * return the copy, so the copy is the sequence whose guid wasn't there
 * before.
 */

const { log } = require("./log.js");
const seqlink = require("./seqlink.js");
const { isOurs } = require("./markers-plan.js");
const { safe } = require("./walk.js");

const BIN = "Shade Versions";

function transact(project, label, build) {
  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((compound) => build(compound), label);
  });
  if (ok === false) throw new Error(`Premiere refused "${label}"`);
}

async function guids(project) {
  return new Set((await project.getSequences()).map((s) => String(s.guid)));
}

/* The project's root bin, as a FolderItem. */
async function rootOf(ppro, project) {
  const root = await project.getRootItem();
  return (await safe(() => ppro.FolderItem.cast(root), null)) || root;
}

/* The "Shade Versions" bin at the root, made if it isn't there. */
async function versionsBin(ppro, project, root) {
  const find = async () => {
    for (const item of await root.getItems()) {
      if (item.name !== BIN) continue;
      const folder = await safe(() => ppro.FolderItem.cast(item), null);
      if (folder && typeof folder.getItems === "function") return folder;
    }
    return null;
  };
  const found = await find();
  if (found) return found;
  transact(project, "Shade Tracker: add Shade Versions bin", (c) => c.addAction(root.createBinAction(BIN, false)));
  const made = await find();
  if (!made) throw new Error(`couldn't make the "${BIN}" bin`);
  return made;
}

/* Take the Shade comment markers off a timeline. Resolves how many. */
async function removeShadeMarkers(ppro, project, sequence) {
  const markers = await ppro.Markers.getMarkers(sequence);
  const ours = (markers.getMarkers() || []).filter((m) => isOurs({ name: m.getName() }));
  if (!ours.length) return 0;
  transact(project, "Shade Tracker: clear copied comment markers", (c) => {
    for (const m of ours) c.addAction(markers.createRemoveMarkerAction(m));
  });
  return ours.length;
}

/* A sequence of the open project, by guid, or null. */
async function sequenceByGuid(project, guid) {
  if (!guid) return null;
  return (await project.getSequences()).find((s) => String(s.guid) === String(guid)) || null;
}

/* Every version timeline made from `originalGuid`: [{ sequence, link }], oldest first. */
async function versionsOf(ppro, project, originalGuid) {
  const out = [];
  for (const sequence of await project.getSequences()) {
    const link = await seqlink.read(ppro, sequence).catch(() => null);
    if (link && link.snapshotOf === String(originalGuid)) out.push({ sequence, link });
  }
  return out.sort((a, b) => (a.link.version || 0) - (b.link.version || 0));
}

/*
 * Copy `sequence` into the Shade Versions bin as `name`, marked as version
 * `version` of `originalGuid` on `driveId`. Resolves { guid, name }.
 */
async function make(ppro, project, sequence, { name, version, driveId, originalGuid }) {
  const before = await guids(project);
  transact(project, "Shade Tracker: copy timeline", (c) => c.addAction(sequence.createCloneAction()));
  const copy = (await project.getSequences()).find((s) => !before.has(String(s.guid)));
  if (!copy) throw new Error("Premiere made no copy of the timeline");

  const cleared = await removeShadeMarkers(ppro, project, copy).catch((e) => {
    log(`version timeline "${name}": couldn't clear copied comment markers: ${e.message}`);
    return 0;
  });

  const item = await copy.getProjectItem();
  const root = await rootOf(ppro, project);
  const bin = await versionsBin(ppro, project, root);
  transact(project, "Shade Tracker: file version timeline", (c) => {
    c.addAction(item.createSetNameAction(name));
    c.addAction(root.createMoveItemAction(item, bin));
  });

  // The copy carries the original's link; every field is set or cleared.
  await seqlink.write(ppro, project, copy, {
    drive: driveId, latest: "", stack: "", version: version, snapshotOf: originalGuid
  });
  const guid = String(copy.guid);
  log(`version timeline "${name}" made in "${BIN}" (${guid.slice(0, 8)})` +
      (cleared ? `, ${cleared} copied comment marker(s) cleared` : ""));
  return { guid, name };
}

/* Once the version is in Shade: point the version timeline at its asset. */
async function complete(ppro, project, snap, { driveId, assetId, stackId, version, originalGuid }) {
  const seq = await sequenceByGuid(project, snap.guid);
  if (!seq) throw new Error(`version timeline "${snap.name}" is gone`);
  await seqlink.write(ppro, project, seq, {
    drive: driveId, latest: assetId, stack: stackId || "", version, snapshotOf: originalGuid
  });
}

/*
 * After an export: close every open version timeline of `originalGuid`
 * (Project.closeSequence, 26.2+) and bring `working` to the front
 * (openSequence + setActiveSequence, 25.6+). Resolves how many were closed.
 * Closing one that isn't open is harmless.
 */
async function focusWorking(ppro, project, working, originalGuid) {
  let closed = 0;
  if (typeof project.closeSequence === "function") {
    for (const { sequence } of await versionsOf(ppro, project, originalGuid)) {
      if (String(sequence.guid) === String(working.guid)) continue;
      try { if (await project.closeSequence(sequence)) closed++; } catch (e) { /* not open */ }
    }
  } else {
    log("this Premiere can't close timelines from a plugin (needs 26.2); version timelines left open");
  }
  await project.openSequence(working);
  await project.setActiveSequence(working);
  return closed;
}

module.exports = { make, complete, sequenceByGuid, versionsOf, focusWorking, removeShadeMarkers, BIN };
