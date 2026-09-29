/*
 * A synthetic project built with the same object graph as a real
 * Premiere 26.5.1 .prproj (see the header of prproj.js), so the parser is
 * tested without committing anyone's real project file.
 */
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const { parseXml, parseBytes } = require("../prproj.js");

function clip(n, path, { proxy = null } = {}) {
  // ClipProjectItem -> MasterClip -> VideoClip -> VideoMediaSource -> Media
  return `
\t<ClipProjectItem ObjectUID="cpi-${n}" ClassID="x" Version="1">
\t\t<ProjectItem Version="1"><Name>clip ${n}</Name></ProjectItem>
\t\t<MasterClip ObjectURef="mc-${n}"/>
\t</ClipProjectItem>
\t<MasterClip ObjectUID="mc-${n}" ClassID="x" Version="12">
\t\t<Clips Version="1">
\t\t\t<Clip Index="0" ObjectRef="${n}01"/>
\t\t</Clips>
\t</MasterClip>
\t<VideoClip ObjectID="${n}01" ClassID="x" Version="11">
\t\t<Clip Version="18"><Source ObjectRef="${n}02"/><InUse>false</InUse></Clip>
\t</VideoClip>
\t<VideoMediaSource ObjectID="${n}02" ClassID="x" Version="2">
\t\t<MediaSource Version="4"><Media ObjectURef="media-${n}"/></MediaSource>
\t</VideoMediaSource>
\t<Media ObjectUID="media-${n}" ClassID="x" Version="30">
\t\t<ActualMediaFilePath>${path}</ActualMediaFilePath>
\t\t<FilePath>${path}</FilePath>
\t</Media>` + (proxy ? `
\t<Media ObjectUID="proxy-${n}" ClassID="x" Version="30">
\t\t<IsProxy>true</IsProxy>
\t\t<ActualMediaFilePath>${proxy}</ActualMediaFilePath>
\t</Media>` : "");
}

function sequence(n, usesMasterClip) {
  // A sequence is a ClipProjectItem too, whose source is a SequenceSource;
  // its track item points at a SubClip, which names the master clip used.
  return `
\t<ClipProjectItem ObjectUID="cpi-seq${n}" ClassID="x" Version="1">
\t\t<MasterClip ObjectURef="mc-seq${n}"/>
\t</ClipProjectItem>
\t<MasterClip ObjectUID="mc-seq${n}" ClassID="x" Version="12">
\t\t<Clips Version="1"><Clip Index="0" ObjectRef="9${n}01"/></Clips>
\t</MasterClip>
\t<VideoClip ObjectID="9${n}01" ClassID="x" Version="11">
\t\t<Clip Version="18"><Source ObjectRef="9${n}02"/></Clip>
\t</VideoClip>
\t<VideoSequenceSource ObjectID="9${n}02" ClassID="x" Version="2">
\t</VideoSequenceSource>
\t<Sequence ObjectUID="seq-${n}" ClassID="x" Version="1">
\t</Sequence>
\t<VideoClipTrackItem ObjectID="9${n}03" ClassID="x" Version="8">
\t\t<ClipTrackItem Version="8"><SubClip ObjectRef="9${n}04"/></ClipTrackItem>
\t</VideoClipTrackItem>
\t<SubClip ObjectID="9${n}04" ClassID="x" Version="6">
\t\t<MasterClip ObjectURef="${usesMasterClip}"/>
\t</SubClip>`;
}

function project(items, body) {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<PremiereData Version="3">
\t<RootProjectItem ObjectUID="the-project-guid" ClassID="x" Version="1">
\t\t<ProjectItemContainer Version="1">
\t\t\t<Items Version="1">
${items.map((uid, i) => `\t\t\t\t<Item Index="${i}" ObjectURef="${uid}"/>`).join("\n")}
\t\t\t</Items>
\t\t</ProjectItemContainer>
\t</RootProjectItem>${body}
</PremiereData>`;
}

test("reads the project id from the root item", () => {
  const p = parseXml(project([], ""));
  assert.strictEqual(p.guid, "the-project-guid");
});

test("clips in bins are imported; a clip on a timeline is used", () => {
  const xml = project(["cpi-1", "cpi-2", "cpi-seq1"],
    clip(1, "/Volumes/D/a.mov") + clip(2, "/Volumes/D/b.mov") + sequence(1, "mc-1"));
  const p = parseXml(xml);
  assert.deepStrictEqual(p.files.map((f) => [f.mediaPath, f.used]).sort(), [
    ["/Volumes/D/a.mov", true],
    ["/Volumes/D/b.mov", false]
  ]);
  assert.strictEqual(p.sequences, 1);
});

test("a sequence is not an asset", () => {
  const p = parseXml(project(["cpi-seq1"], sequence(1, "mc-none")));
  assert.deepStrictEqual(p.files, []);
});

test("proxies are never assets", () => {
  const xml = project(["cpi-1"], clip(1, "/Volumes/D/a.mov", { proxy: "/Users/x/proxy/a.mp4" }));
  assert.deepStrictEqual(parseXml(xml).files.map((f) => f.mediaPath), ["/Volumes/D/a.mov"]);
});

test("clips inside nested bins are found", () => {
  const bin = `
\t<BinProjectItem ObjectUID="bin-1" ClassID="x" Version="1">
\t\t<ProjectItemContainer Version="1"><Items Version="1">
\t\t\t<Item Index="0" ObjectURef="cpi-1"/>
\t\t</Items></ProjectItemContainer>
\t</BinProjectItem>`;
  const p = parseXml(project(["bin-1"], bin + clip(1, "/Volumes/D/deep.mov")));
  assert.deepStrictEqual(p.files.map((f) => f.mediaPath), ["/Volumes/D/deep.mov"]);
});

test("the same file imported twice is one file, used if either copy is", () => {
  const twice = clip(1, "/Volumes/D/a.wav") + clip(2, "/Volumes/D/a.wav");
  const p = parseXml(project(["cpi-1", "cpi-2", "cpi-seq1"], twice + sequence(1, "mc-2")));
  assert.strictEqual(p.files.length, 1);
  assert.strictEqual(p.files[0].itemCount, 2);
  assert.strictEqual(p.files[0].used, true);
});

test("XML entities in paths are decoded", () => {
  const p = parseXml(project(["cpi-1"], clip(1, "/Volumes/D/Tom &amp; Jerry&#39;s.mov")));
  assert.strictEqual(p.files[0].mediaPath, "/Volumes/D/Tom & Jerry's.mov");
});

test("gzipped bytes parse the same as the XML", () => {
  const xml = project(["cpi-1"], clip(1, "/Volumes/D/a.mov"));
  assert.deepStrictEqual(parseBytes(zlib.gzipSync(Buffer.from(xml))), parseXml(xml));
});

test("a file that is not a project says so", () => {
  assert.throws(() => parseXml("<nope/>"), /not a Premiere project/);
});
