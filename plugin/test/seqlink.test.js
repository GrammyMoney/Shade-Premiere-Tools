const test = require("node:test");
const assert = require("node:assert");
const { setField, getField, parseLink, FIELDS } = require("../seqlink.js");

const XMP = `<x:xmpmeta><rdf:RDF><rdf:Description rdf:about=""
  xmlns:premierePrivateProjectMetaData="http://ns.adobe.com/premierePrivateProjectMetaData/1.0/">
  <premierePrivateProjectMetaData:Column.Intrinsic.Name>Main Cut</premierePrivateProjectMetaData:Column.Intrinsic.Name>
</rdf:Description></rdf:RDF></x:xmpmeta>`;

test("fields are added, replaced and read back, escaped", () => {
  let xml = setField(XMP, FIELDS.latest, "a1");
  xml = setField(xml, FIELDS.drive, "d<&>1");
  xml = setField(xml, FIELDS.latest, "a2");
  assert.strictEqual(getField(xml, FIELDS.latest), "a2");
  assert.strictEqual(getField(xml, FIELDS.drive), "d<&>1");
  assert.strictEqual((xml.match(/ShadeTrackerExportLatest>/g) || []).length, 2);   // one element
  assert.match(xml, /Column\.Intrinsic\.Name>Main Cut/);                          // the rest untouched
});

test("a link needs a drive; empty fields read as missing", () => {
  assert.strictEqual(parseLink(XMP), null);
  let xml = setField(XMP, FIELDS.drive, "d1");
  xml = setField(xml, FIELDS.latest, "a3");
  xml = setField(xml, FIELDS.version, "3");
  assert.deepStrictEqual(parseLink(xml), { drive: "d1", latest: "a3", stack: null, version: 3, snapshotOf: null });

  // A version timeline before its asset is in Shade: copied fields cleared.
  xml = setField(xml, FIELDS.latest, "");
  xml = setField(xml, FIELDS.snapshotOf, "seq-1");
  assert.deepStrictEqual(parseLink(xml), { drive: "d1", latest: null, stack: null, version: 3, snapshotOf: "seq-1" });
});

test("XML with no Description to add to is refused, not mangled", () => {
  assert.strictEqual(setField("<x/>", FIELDS.drive, "d1"), null);
});
