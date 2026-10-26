const test = require("node:test");
const assert = require("node:assert");
const { planMarkers, markerText } = require("../markers-plan.js");

const c = (id, timestamp, content, extra = {}) =>
  ({ id, timestamp, content, author: { name: "Kirsten" }, resolved: false, parent_id: null, replies: [], ...extra });

test("timed, unresolved, top-level comments become markers, in time order", () => {
  const { add, skipped } = planMarkers([
    c("2", 12.5, "Trim this", { duration: 2 }),
    c("1", 3, "Love it"),
    c("3", 5, "Done", { resolved: true }),
    c("4", null, "General note"),
    c("5", 7, "reply", { parent_id: "1" })
  ], [], 1 / 24);
  assert.deepStrictEqual(add.map((m) => [m.start, m.text, m.duration]), [[3, "Love it", 0], [12.5, "Trim this", 2]]);
  assert.strictEqual(add[0].name, "Kirsten (Shade)");
  assert.strictEqual(skipped, 2);
});

test("replies are folded into the parent's text", () => {
  const text = markerText(c("1", 1, "Colour is off", {
    replies: [{ content: "Fixed in V04", author: { name: "Alex" } }, { content: "  " }]
  }));
  assert.strictEqual(text, "Colour is off\n↳ Alex: Fixed in V04");
});

test("re-importing adds nothing: same text within half a frame is already there", () => {
  const existing = [{ name: "Kirsten (Shade)", start: 3.01, text: "Love it" },
                    { name: "Editor note", start: 12.5, text: "Trim this" }];     // not ours
  const { add, already } = planMarkers([c("1", 3, "Love it"), c("2", 12.5, "Trim this")], existing, 1 / 24);
  assert.strictEqual(already, 1);
  assert.deepStrictEqual(add.map((m) => m.text), ["Trim this"]);
});

test("outside the half-frame window, or edited text, counts as new", () => {
  const existing = [{ name: "Kirsten (Shade)", start: 3.5, text: "Love it" },
                    { name: "Kirsten (Shade)", start: 12.5, text: "Trim this!!" }];
  const { add } = planMarkers([c("1", 3, "Love it"), c("2", 12.5, "Trim this")], existing, 1 / 24);
  assert.strictEqual(add.length, 2);
});
