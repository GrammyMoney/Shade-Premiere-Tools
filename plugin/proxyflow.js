/*
 * The "Make SPT Proxies" automation: what proxy-linking setup creates on a
 * drive. Pure, tested; setup.js does the REST.
 *
 *   Manual Trigger -> Generate Proxy (h264_1080p, into "<clip's folder>/proxies")
 *     -> set Linked Proxy on the clip -> set Linked Hi Res on the proxy
 *
 * The same layout as the hand-built "Proxy + Relational Link" on Adobe
 * Sandbox, which works. Decided 2026-10-26: one standard name on every
 * drive; created and activated only when no automation has that exact name
 * (a similar one under another name doesn't count); and the plugin never
 * runs it -- people trigger it from Shade.
 *
 * Node ids are minted here, so the templates ({{<nodeId>.asset}}) can point
 * at each other in a single PUT. The integration id is never guessed: it is
 * read from Shade's catalog (findShadeIntegration).
 */

const NAME = "Make SPT Proxies";
const PRESET = "h264_1080p";
const DESCRIPTION = "Created by Shade Premiere Tools. Run it on video clips: it makes a " +
  `${PRESET} proxy in a "proxies" folder next to each clip and links the two ` +
  "(Linked Proxy on the clip, Linked Hi Res on the proxy), so Premiere attaches the proxy on import.";

const OPS = { trigger: "manually_triggered", proxy: "generate_proxy", metadata: "update_asset_metadata" };

/* A random v4 UUID, with whatever randomness the host has. */
function uuid4() {
  const c = typeof crypto !== "undefined" ? crypto : null;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* An operation's name, however the catalog spells its entries. */
const opName = (x) => (typeof x === "string" ? x : x && (x.operation || x.id || x.key || x.name)) || null;

/*
 * The integration that offers everything the automation needs, from
 * GET /automations/integrations. { id, missing: [] } -- id null when none
 * has all three, with what the best candidate lacks.
 */
function findShadeIntegration(catalog) {
  let best = { id: null, missing: Object.values(OPS) };
  for (const integ of catalog || []) {
    const triggers = (integ.triggers || []).map(opName);
    const actions = (integ.actions || []).map(opName);
    const missing = [];
    if (!triggers.includes(OPS.trigger)) missing.push(OPS.trigger);
    if (!actions.includes(OPS.proxy)) missing.push(OPS.proxy);
    if (!actions.includes(OPS.metadata)) missing.push(OPS.metadata);
    if (!missing.length) return { id: integ.id, missing };
    if (missing.length < best.missing.length) best = { id: null, missing };
  }
  return best;
}

/* The PUT body's graph. Field ids are the drive's own. */
function buildGraph({ integrationId, linkedProxyId, linkedHiResId, uuid = uuid4 }) {
  const [T, G, P, H] = [uuid(), uuid(), uuid(), uuid()];
  // Every node needs its own position. Saved all at (0, 0), Shade ran all
  // four steps but its editor showed only one node (measured 2026-11-18 on
  // Politik Party). The spacing is the hand-built reference's.
  let row = 0;
  const node = (id, node_type, operation, label, config) =>
    ({ id, node_type, integration_id: integrationId, operation, label, config,
       position_x: 250, position_y: 150 + 340 * row++ });
  const nodes = [
    node(T, "TRIGGER", OPS.trigger, "Manual Trigger", {}),
    node(G, "ACTION", OPS.proxy, "Generate Proxy", {
      asset: `{{${T}.asset}}`, preset: PRESET, destination_folder: `{{${T}.asset.directory}}/proxies`
    }),
    node(P, "ACTION", OPS.metadata, "Set Linked Proxy on Hi-Res", {
      asset: `{{${T}.asset}}`, metadata: { [linkedProxyId]: [{ id: `{{${G}.asset.id}}`, type: "asset" }] }
    }),
    node(H, "ACTION", OPS.metadata, "Set Linked Hi Res on Proxy", {
      asset: `{{${G}.asset}}`, metadata: { [linkedHiResId]: [{ id: `{{${T}.asset.id}}`, type: "asset" }] }
    })
  ];
  const edge = (s, t) => ({ id: uuid(), source_node_id: s, target_node_id: t, output_key: null });
  return { nodes, edges: [edge(T, G), edge(G, P), edge(P, H)], viewport: { x: 0, y: 0, zoom: 1 } };
}

module.exports = { NAME, PRESET, DESCRIPTION, OPS, uuid4, findShadeIntegration, buildGraph };
