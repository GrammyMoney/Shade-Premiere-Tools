/*
 * snapshot.versionsOf with a faked Premiere: which timelines are version
 * timelines of which original, in version order. (Import comments uses it
 * to send each version's comments to its own timeline and nowhere else.)
 */
const test = require("node:test");
const assert = require("node:assert");
const { setPlatform } = require("../platform.js");
setPlatform({ readData: async () => null, writeData: async () => {}, echo() {} });
const { setField, FIELDS } = require("../seqlink.js");
const snapshot = require("../snapshot.js");

const XMP = `<x:xmpmeta><rdf:RDF><rdf:Description rdf:about=""></rdf:Description></rdf:RDF></x:xmpmeta>`;

function seq(guid, fields) {
  let xml = XMP;
  for (const [k, v] of Object.entries(fields)) xml = setField(xml, FIELDS[k], v);
  return { guid, name: guid, getProjectItem: async () => ({ xml }) };
}

const ppro = { Metadata: { getProjectMetadata: async (item) => item.xml } };

test("version timelines of a timeline, oldest first; others ignored", async () => {
  const project = { getSequences: async () => [
    seq("main", { drive: "d", latest: "a4", version: "4" }),          // the original itself
    seq("v4", { drive: "d", latest: "a4", version: "4", snapshotOf: "main" }),
    seq("v3", { drive: "d", latest: "a3", version: "3", snapshotOf: "main" }),
    seq("other-v1", { drive: "d", latest: "b1", version: "1", snapshotOf: "teaser" }),
    seq("plain", {})                                                  // never exported
  ] };
  const found = await snapshot.versionsOf(ppro, project, "main");
  assert.deepStrictEqual(found.map((v) => [v.sequence.guid, v.link.latest]), [["v3", "a3"], ["v4", "a4"]]);
  assert.deepStrictEqual(await snapshot.versionsOf(ppro, project, "nobody"), []);
});

test("after an export: version timelines closed, the working one opened and active", async () => {
  const calls = [];
  const working = seq("v3", { drive: "d", latest: "a3", version: "3", snapshotOf: "main" });  // exported from a copy
  const all = [seq("main", { drive: "d", latest: "a5", version: "5" }), working,
               seq("v4", { drive: "d", latest: "a4", version: "4", snapshotOf: "main" }),
               seq("v5", { drive: "d", version: "5", snapshotOf: "main" }),
               seq("teaser-v1", { drive: "d", latest: "b1", version: "1", snapshotOf: "teaser" })];
  const project = {
    getSequences: async () => all,
    closeSequence: async (s) => { calls.push("close " + s.guid); return s.guid !== "v4"; },   // v4 wasn't open
    openSequence: async (s) => { calls.push("open " + s.guid); return true; },
    setActiveSequence: async (s) => { calls.push("active " + s.guid); return true; }
  };
  const closed = await snapshot.focusWorking(ppro, project, working, "main");
  assert.deepStrictEqual(calls, ["close v4", "close v5", "open v3", "active v3"]);   // never the working one
  assert.strictEqual(closed, 1);
});

test("without closeSequence (before 26.2) the working timeline is still brought forward", async () => {
  const calls = [];
  const working = seq("main", { drive: "d", latest: "a5", version: "5" });
  const project = {
    getSequences: async () => [working, seq("v5", { drive: "d", version: "5", snapshotOf: "main" })],
    openSequence: async (s) => { calls.push("open " + s.guid); return true; },
    setActiveSequence: async (s) => { calls.push("active " + s.guid); return true; }
  };
  assert.strictEqual(await snapshot.focusWorking(ppro, project, working, "main"), 0);
  assert.deepStrictEqual(calls, ["open main", "active main"]);
});

test("clearing comment markers takes only the plugin's \"(Shade)\" ones, in one transaction", async () => {
  const removed = [];
  let transactions = 0;
  const mk = (name) => ({ getName: () => name });
  const list = [mk("Kirsten (Shade)"), mk("Music hit"), mk("Alex Bagheri (Shade)"), mk("Shade notes")];
  const fake = { Markers: { getMarkers: async () => ({
    getMarkers: () => list,
    createRemoveMarkerAction: (m) => ({ remove: m.getName() })
  }) } };
  const project = {
    lockedAccess: (fn) => fn(),
    executeTransaction: (build) => { transactions++; build({ addAction: (a) => removed.push(a.remove) }); return true; }
  };
  assert.strictEqual(await snapshot.removeShadeMarkers(fake, project, {}), 2);
  assert.deepStrictEqual(removed, ["Kirsten (Shade)", "Alex Bagheri (Shade)"]);
  assert.strictEqual(transactions, 1);

  list.length = 0;
  list.push(mk("Music hit"));
  assert.strictEqual(await snapshot.removeShadeMarkers(fake, project, {}), 0);
  assert.strictEqual(transactions, 1);                                   // nothing to do, no transaction
});
