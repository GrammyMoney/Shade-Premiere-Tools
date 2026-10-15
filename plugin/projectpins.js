/*
 * Pinning a whole project, with the editor's say-so.
 *
 * When a project is opened, every file it reads from a mounted Shade drive
 * -- each clip's media, its attached proxy, and the proxy its Linked Proxy
 * field points at -- is counted, and the editor is asked once:
 *
 *   Number of assets: 42 (1.8 TB)
 *   Already pinned: 30 (1.4 TB) · Not pinned: 12 (400 GB)
 *   Would you like to pin these?
 *
 * Asked, not done, because a real project's media pool is terabytes (the
 * reason link.js leaves an opened project's clips alone). Nothing is asked
 * when everything is already pinned, and each project is asked about once
 * per session. The panel's "pin project" asks again on demand.
 *
 * Unpinning: there is no event before Premiere quits, and nothing can delay
 * a quit (Premiere UXP docs; panel destroy() is synchronous). So the
 * question "unpin the project?" is asked when ProjectEvent.CLOSED fires --
 * a project closed while Premiere stays open -- and from the panel's
 * "unpin project". At quit it is tried too, and is lost if Premiere tears
 * the plugin down first.
 *
 * By the time CLOSED fires the project can no longer be walked, so what to
 * unpin is what this session saw of it: the files counted for the pin
 * prompt, plus anything link.js pinned on import. Only files pinned by
 * themselves can be unpinned; a file inside a pinned folder stays pinned
 * with its folder. Nothing is saved between sessions.
 */

const { log } = require("./log.js");
const shade = require("./shade.js");
const shadefs = require("./shadefs.js");
const dialog = require("./dialog.js");
const link = require("./link.js");
const { safe, clips, activeProject } = require("./walk.js");
const { locate, shadePath, localPath } = require("./mounts.js");
const { linkedIds, pinnableIno, isPinned, tally, formatBytes } = require("./pins.js");
const { projectDisplayName } = require("./paths.js");

const LOOKUPS_AT_ONCE = 6;     // Shade REST requests in flight while counting
const OPEN_SETTLE_MS = 1500;   // let Premiere finish opening before walking

/*
 * guid -> { name, path, files: Map(local path -> { path, ino, size, mount, rest }) }
 * What this session knows each project reads from Shade.
 */
const projects = new Map();
const asked = new Set();       // project guids already asked about this session
let busy = false;
const stats = { pinned: 0, unpinned: 0, lastError: null };

/* Run fn over items, at most n at a time. */
async function eachLimited(items, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function remember(project, files) {
  let p = projects.get(project.guid);
  if (!p) {
    p = { name: projectDisplayName(project.name) || "Untitled project", path: project.path || "", files: new Map() };
    projects.set(project.guid, p);
  }
  for (const f of files) {
    if (f.mount && f.rest) p.files.set(f.path, { path: f.path, ino: f.ino, size: f.size, mount: f.mount, rest: f.rest });
  }
}

/*
 * Every Shade file the active project reads, with its inode, size and
 * whether it is pinned. Null when no project is open.
 */
async function gather(ppro) {
  const p = await activeProject(ppro);
  if (!p) return null;
  const ms = await shadefs.mounts();
  const pinnedNow = await shadefs.pinned();

  const files = new Map();     // local path -> { mount, rest }
  const add = (path) => {
    const where = path && locate(path, ms);
    if (where && !files.has(path)) files.set(path, where);
  };

  const withoutProxy = [];
  for (const c of await clips(ppro, p.folder)) {
    const media = await safe(() => c.clip.getMediaFilePath(), null);
    add(media);
    const proxy = (await safe(() => c.clip.hasProxy(), false)) ? await safe(() => c.clip.getProxyPath(), null) : null;
    if (proxy) add(proxy);
    else if (media && locate(media, ms)) withoutProxy.push(media);
  }

  // A clip with no proxy attached may still have one in Shade: its Linked
  // Proxy. Pinning it means the proxy is local before anyone attaches it.
  let lookupError = null;
  await eachLimited(withoutProxy, LOOKUPS_AT_ONCE, async (media) => {
    try {
      const { mount, rest } = locate(media, ms);
      const ids = await link.fieldIds(mount.driveId);
      if (!ids.proxy) return;
      const asset = await shade.assetByPath(mount.driveId, shadePath(mount.driveId, rest));
      const [proxyId] = linkedIds(asset, ids.proxy);
      if (!proxyId) return;
      const proxy = await link.getAssetOrNull(mount.driveId, proxyId);
      add(proxy && localPath(proxy.path, mount));
    } catch (e) {
      lookupError = e.message;
    }
  });
  if (lookupError) log(`some Linked Proxy lookups failed, counting without them: ${lookupError}`);

  const out = [];
  await eachLimited([...files], LOOKUPS_AT_ONCE, async ([path, { mount, rest }]) => {
    const st = await shadefs.statOf(path).catch(() => ({ ino: null, size: null }));
    out.push({ path, ino: st.ino, size: st.size, mount, rest, pinned: isPinned(pinnedNow, mount.driveId, rest) });
  });
  return { guid: p.guid, name: projectDisplayName(p.name) || "Untitled project", path: p.path, files: out };
}

/*
 * Ask whether to pin the active project, and pin it on yes. `always` asks
 * even if this project was asked about already (the panel button).
 * Returns a short message for the panel.
 */
async function offerPin(ppro, { always = false } = {}) {
  if (busy) return "busy";
  busy = true;
  try {
    const g = await gather(ppro);
    if (!g) return "no project open";
    if (!always && asked.has(g.guid)) return "";
    asked.add(g.guid);
    remember(g, g.files);

    const t = tally(g.files);
    if (!t.count) {
      log(`"${g.name}": no media on a mounted Shade drive, nothing to pin`);
      return "no Shade media in this project";
    }
    if (!t.unpinned.count) {
      log(`"${g.name}": all ${t.count} Shade file(s) already pinned`);
      return `all ${t.count} assets already pinned`;
    }

    const yes = await dialog.confirm({
      heading: `Pin the project "${g.name}"?`,
      lines: [
        `Number of assets: ${t.count} (${formatBytes(t.bytes)})`,
        `Already pinned: ${t.pinned.count} (${formatBytes(t.pinned.bytes)})  ·  ` +
          `Not pinned: ${t.unpinned.count} (${formatBytes(t.unpinned.bytes)})`,
        "Would you like to pin these?"
      ]
    });
    if (!yes) {
      log(`"${g.name}": pin declined (${t.unpinned.count} not pinned)`);
      return "not pinned";
    }

    const todo = g.files.filter((f) => !f.pinned && pinnableIno(f.ino, f.mount.rootIno));
    const r = await shadefs.pin(todo.map((f) => f.ino));
    if (r.code !== 0) throw new Error(`pin failed: ${r.data}`);
    stats.pinned += todo.length;
    const skipped = t.unpinned.count - todo.length;
    log(`"${g.name}": pinned ${todo.length} file(s), ${formatBytes(t.unpinned.bytes)}` +
        (skipped ? `; ${skipped} could not be read, not pinned` : ""));
    return `pinned ${todo.length} assets`;
  } catch (e) {
    stats.lastError = e.message;
    log("pin project failed:", e.message);
    throw e;
  } finally {
    busy = false;
  }
}

/*
 * Ask whether to unpin a project's files, and unpin them on yes. `p` is a
 * remembered project (see `projects`). Returns a short message.
 */
async function offerUnpin(guid, p) {
  const pinnedNow = await shadefs.pinned();
  const self = [];
  let inFolders = 0;
  for (const f of p.files.values()) {
    const how = isPinned(pinnedNow, f.mount.driveId, f.rest);
    if (how === "self" && pinnableIno(f.ino, f.mount.rootIno)) self.push(f);
    else if (how === "folder") inFolders++;
  }
  if (inFolders) log(`"${p.name}": ${inFolders} file(s) are pinned through a pinned folder and stay pinned`);
  if (!self.length) return "nothing of this project is pinned";

  const t = tally(self.map((f) => ({ pinned: true, size: f.size })));
  const yes = await dialog.confirm({
    heading: `Would you like to unpin the project "${p.name}"?`,
    lines: [`Pinned assets: ${t.count} (${formatBytes(t.bytes)})`]
  });
  if (!yes) {
    log(`"${p.name}": unpin declined`);
    return "kept pinned";
  }
  const r = await shadefs.unpin(self.map((f) => f.ino));
  if (r.code !== 0) throw new Error(`unpin failed: ${r.data}`);
  stats.unpinned += self.length;
  asked.delete(guid);        // reopening it should ask again
  log(`"${p.name}": unpinned ${self.length} file(s), ${formatBytes(t.bytes)}`);
  return `unpinned ${self.length} assets`;
}

/* The panel's "unpin project": the active project, walked fresh. */
async function unpinActive(ppro) {
  const g = await gather(ppro);
  if (!g) return "no project open";
  remember(g, g.files);
  return offerUnpin(g.guid, projects.get(g.guid));
}

/*
 * ProjectEvent.CLOSED. The payload documents id, name and path (25.6); id is
 * taken to be the project guid, and path is the fallback match.
 */
async function onClosed(event) {
  const e = event || {};
  let guid = e.id && projects.has(String(e.id)) ? String(e.id) : null;
  if (!guid && e.path) {
    for (const [g, p] of projects) if (p.path && p.path === e.path) guid = g;
  }
  if (!guid) {
    log(`project closed (${e.name || e.id || "unknown"}): nothing pinned for it this session`);
    return;
  }
  const p = projects.get(guid);
  projects.delete(guid);
  try {
    await offerUnpin(guid, p);
  } catch (err) {
    stats.lastError = err.message;
    log("unpin on close failed:", err.message);
  }
}

/* A project was opened or became active: ask once it has settled. */
function offerSoon(ppro) {
  setTimeout(() => {
    offerPin(ppro).catch(() => { /* logged in offerPin */ });
  }, OPEN_SETTLE_MS);
}

function status() { return Object.assign({ asking: busy }, stats); }

module.exports = { offerPin, offerSoon, unpinActive, onClosed, remember, status };
