const test = require("node:test");
const assert = require("node:assert");
const { buildGraph, findShadeIntegration, uuid4, OPS } = require("../proxyflow.js");

test("the graph: trigger -> proxy -> two metadata writes, wired by real node ids", () => {
  let n = 0;
  const g = buildGraph({ integrationId: "shade", linkedProxyId: "f-proxy", linkedHiResId: "f-hires",
                         uuid: () => `id${++n}` });
  const [T, G, P, H] = g.nodes;
  assert.deepStrictEqual(g.nodes.map((x) => [x.node_type, x.operation, x.integration_id]), [
    ["TRIGGER", OPS.trigger, "shade"], ["ACTION", OPS.proxy, "shade"],
    ["ACTION", OPS.metadata, "shade"], ["ACTION", OPS.metadata, "shade"]]);
  assert.deepStrictEqual(g.edges.map((e) => [e.source_node_id, e.target_node_id, e.output_key]),
    [[T.id, G.id, null], [G.id, P.id, null], [P.id, H.id, null]]);
  assert.deepStrictEqual(G.config, { asset: `{{${T.id}.asset}}`, preset: "h264_1080p",
                                     destination_folder: `{{${T.id}.asset.directory}}/proxies` });
  assert.deepStrictEqual(P.config, { asset: `{{${T.id}.asset}}`,
                                     metadata: { "f-proxy": [{ id: `{{${G.id}.asset.id}}`, type: "asset" }] } });
  assert.deepStrictEqual(H.config, { asset: `{{${G.id}.asset}}`,
                                     metadata: { "f-hires": [{ id: `{{${T.id}.asset.id}}`, type: "asset" }] } });

  // Every {{id.…}} reference points at a node in this graph.
  const ids = new Set(g.nodes.map((x) => x.id));
  const refs = JSON.stringify(g.nodes.map((x) => x.config)).match(/\{\{([^.}]+)\./g) || [];
  assert.ok(refs.length >= 6 && refs.every((r) => ids.has(r.slice(2, -1))));
});

test("the catalog: the integration with all three operations, however entries are spelled", () => {
  const catalog = [
    { id: "slack", triggers: [], actions: [{ operation: "send_message" }] },
    { id: "shade", triggers: [{ operation: "manually_triggered" }, "asset_uploaded"],
      actions: [{ id: "generate_proxy" }, { name: "update_asset_metadata" }] }
  ];
  assert.deepStrictEqual(findShadeIntegration(catalog), { id: "shade", missing: [] });
  assert.deepStrictEqual(findShadeIntegration([{ id: "shade", triggers: ["manually_triggered"],
                                                 actions: ["update_asset_metadata"] }]),
                         { id: null, missing: ["generate_proxy"] });
  assert.strictEqual(findShadeIntegration([]).id, null);
});

test("uuid4 is a v4 UUID", () => {
  assert.match(uuid4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
