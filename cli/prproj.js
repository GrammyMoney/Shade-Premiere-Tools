/*
 * Reading a Premiere project file without Premiere.
 *
 * A .prproj is gzipped XML. Pure: takes the XML text, returns the same shape
 * the panel's scan produces ({ guid, files: [{ mediaPath, itemCount, used }] }),
 * so the CLI can hand it to the panel's own sync code unchanged.
 *
 * Mapped from real projects (Premiere 26.5.1, 2026-09-29):
 *
 *   Top-level objects sit at one tab of indent and carry ObjectID (a number,
 *   local to this file) or ObjectUID (a UUID). References are ObjectRef ->
 *   ObjectID and ObjectURef -> ObjectUID.
 *
 *   project id   <RootProjectItem ObjectUID="..."> -- the same value UXP
 *                returns as Project.guid (verified on two projects). This is
 *                what lets the CLI and the panel find the same record.
 *   bins         RootProjectItem / BinProjectItem
 *                  -> ProjectItemContainer/Items/Item ObjectURef
 *   a clip       ClipProjectItem -> MasterClip (URef)
 *                  -> Clips/Clip (Ref) -> VideoClip | AudioClip
 *                  -> Source (Ref) -> VideoMediaSource | AudioMediaSource
 *                  -> Media (URef) -> ActualMediaFilePath / FilePath
 *   a sequence   the same chain, but its Source is a *SequenceSource. Not an
 *                asset; skipped.
 *   a proxy      a Media carrying <IsProxy>true</IsProxy>. SHINE attaches
 *                these; the panel never sees them (getMediaFilePath returns
 *                the full-res file), so neither must we.
 *   on timeline  *ClipTrackItem -> SubClip (Ref) -> MasterClip (URef)
 *
 * Deliberately ignored: <InUse>. It reads false on every clip, including
 * clips that are plainly on a timeline.
 */

const zlib = require("zlib");

/* ------------------------------------------------------------ indexing */

function decode(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

/*
 * Every top-level object, by id and by uid. The file is machine-written and
 * regular -- one tab of indent for each top-level object, its closing tag at
 * the same indent -- so a line-anchored pattern is exact here, and avoids
 * pulling an XML library into a dependency-free tool.
 */
function index(xml) {
  const byId = new Map();
  const byUid = new Map();
  const all = [];
  const re = /^\t<([A-Za-z][\w]*) (Object(?:ID|UID))="([^"]+)"[^>]*?(\/?)>/gm;
  let m;
  while ((m = re.exec(xml))) {
    const [open, cls, kind, key, selfClosing] = m;
    let body = "";
    if (!selfClosing) {
      const close = "\n\t</" + cls + ">";
      const end = xml.indexOf(close, m.index + open.length);
      if (end === -1) continue;
      body = xml.slice(m.index + open.length, end);
      re.lastIndex = end + close.length;
    }
    const obj = { cls, body };
    all.push(obj);
    (kind === "ObjectID" ? byId : byUid).set(key, obj);
  }
  return { byId, byUid, all };
}

const refs = (body, tag, attr) => {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]+)"`, "g");
  let m;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
};
const text = (body, tag) => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body);
  return m ? decode(m[1]) : null;
};

/* -------------------------------------------------------------- walking */

/*
 * The media paths behind one master clip, or null if it is a sequence.
 * A clip usually has a video and an audio half pointing at the same file,
 * hence a Set.
 */
function masterClipMedia(ix, masterUid) {
  const mc = ix.byUid.get(masterUid);
  if (!mc) return new Set();
  const paths = new Set();
  for (const clipRef of refs(mc.body, "Clip", "ObjectRef")) {
    const clip = ix.byId.get(clipRef);
    if (!clip) continue;
    for (const srcRef of refs(clip.body, "Source", "ObjectRef")) {
      const src = ix.byId.get(srcRef);
      if (!src) continue;
      if (/SequenceSource$/.test(src.cls)) return null;      // a sequence, not media
      for (const mediaUid of refs(src.body, "Media", "ObjectURef")) {
        const media = ix.byUid.get(mediaUid);
        if (!media) continue;
        if (text(media.body, "IsProxy") === "true") continue;
        const p = text(media.body, "ActualMediaFilePath") || text(media.body, "FilePath");
        if (p) paths.add(p);
      }
    }
  }
  return paths;
}

/* Every ClipProjectItem's master clip, walking bins from the root. */
function binMasterClips(ix, root) {
  const out = [];
  const seen = new Set();
  const walk = (obj, depth) => {
    if (!obj || depth > 64) return;
    for (const uid of refs(obj.body, "Item", "ObjectURef")) {
      if (seen.has(uid)) continue;
      seen.add(uid);
      const item = ix.byUid.get(uid);
      if (!item) continue;
      if (item.cls === "ClipProjectItem") {
        const mc = refs(item.body, "MasterClip", "ObjectURef")[0];
        if (mc) out.push(mc);
      } else {
        walk(item, depth + 1);      // BinProjectItem, or anything else with Items
      }
    }
  };
  walk(root, 0);
  return out;
}

/* Master clips referenced by any clip on any timeline. */
function timelineMasterClips(ix) {
  const used = new Set();
  for (const obj of ix.all) {
    if (!/ClipTrackItem$/.test(obj.cls)) continue;
    for (const subRef of refs(obj.body, "SubClip", "ObjectRef")) {
      const sub = ix.byId.get(subRef);
      if (!sub) continue;
      for (const mc of refs(sub.body, "MasterClip", "ObjectURef")) used.add(mc);
    }
  }
  return used;
}

/* ---------------------------------------------------------------- parse */

function parseXml(xml) {
  const ix = index(xml);
  const root = ix.all.find((o) => o.cls === "RootProjectItem");
  const guidMatch = /^\t<RootProjectItem ObjectUID="([^"]+)"/m.exec(xml);
  if (!root || !guidMatch) throw new Error("no RootProjectItem: not a Premiere project?");

  const used = timelineMasterClips(ix);
  // A master clip on a timeline counts even if it has since left the bins.
  const masters = new Set(binMasterClips(ix, root).concat([...used]));

  // Collapse onto media paths, OR-ing usage: the same file imported twice is
  // two master clips, and one of them being on a timeline makes the file used.
  const byPath = new Map();
  for (const mc of masters) {
    const paths = masterClipMedia(ix, mc);
    if (!paths) continue;
    for (const p of paths) {
      const f = byPath.get(p) || { mediaPath: p, itemCount: 0, used: false };
      f.itemCount++;
      if (used.has(mc)) f.used = true;
      byPath.set(p, f);
    }
  }

  return {
    guid: guidMatch[1],
    files: [...byPath.values()],
    sequences: ix.all.filter((o) => o.cls === "Sequence").length
  };
}

/* A .prproj's bytes -> parsed project. Accepts gzipped or plain XML. */
function parseBytes(buf) {
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return parseXml((isGzip ? zlib.gunzipSync(buf) : buf).toString("utf8"));
}

module.exports = { parseXml, parseBytes };
