/*
 * Shade comments -> Premiere markers. Pure, tested.
 *
 * Which comments become markers, and what each marker says. Used for both
 * timeline markers (comments on an export) and clip markers (comments on
 * source media); comments.js does the Premiere side.
 *
 *   - top-level comments only; replies are folded into their parent's text
 *   - unresolved only: a resolved note is done with
 *   - only comments with a timestamp (seconds from the start of the media)
 *   - name "<author> (Shade)", so ours are recognisable among the editor's
 *
 * Re-importing must not duplicate. A comment is already there when one of
 * our markers sits within half a frame of its time with the same text. That
 * matches on what the editor sees rather than a hidden id, and a marker the
 * editor has edited is left alone (and its comment not re-added, unless its
 * text was changed back).
 */

const SUFFIX = " (Shade)";

const authorOf = (c) => (c && c.author && (c.author.name || c.author.email)) || "Shade";

function markerName(comment) {
  return authorOf(comment) + SUFFIX;
}

function markerText(comment) {
  const lines = [String(comment.content || "").trim()];
  for (const r of comment.replies || []) {
    const t = String(r.content || "").trim();
    if (t) lines.push(`↳ ${authorOf(r)}: ${t}`);
  }
  return lines.filter(Boolean).join("\n");
}

const isOurs = (m) => typeof (m && m.name) === "string" && m.name.endsWith(SUFFIX);

/*
 * comments: Shade CommentDTOs. existing: [{ name, start (s), text }] already
 * on the timeline or clip. frameSeconds: one frame, for the duplicate window.
 * Returns { add: [{ name, start, duration, text }], already, skipped }.
 */
function planMarkers(comments, existing, frameSeconds) {
  const window = (frameSeconds > 0 ? frameSeconds : 1 / 24) / 2;
  const ours = (existing || []).filter(isOurs);
  const add = [];
  let already = 0;
  let skipped = 0;

  for (const c of comments || []) {
    if (!c || c.parent_id) continue;                         // replies ride on their parent
    if (c.resolved || typeof c.timestamp !== "number" || !isFinite(c.timestamp) || c.timestamp < 0) {
      skipped++;
      continue;
    }
    const m = {
      name: markerName(c),
      start: c.timestamp,
      duration: typeof c.duration === "number" && c.duration > 0 ? c.duration : 0,
      text: markerText(c)
    };
    const same = (x) => Math.abs(x.start - m.start) <= window && String(x.text || "").trim() === m.text;
    if (ours.some(same) || add.some(same)) { already++; continue; }
    add.push(m);
  }
  add.sort((a, b) => a.start - b.start);
  return { add, already, skipped };
}

module.exports = { planMarkers, markerName, markerText, isOurs, SUFFIX };
