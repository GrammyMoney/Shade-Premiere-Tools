/*
 * The Shade REST client.
 *
 * Everything the plugin says to Shade goes through request(). Two things
 * about Shade shape it:
 *
 *  - Auth is `Authorization: sk_...` with no "Bearer". The key is the whole
 *    header value.
 *  - Shade returned 503 on roughly half of all writes for a stretch on
 *    2026-09-29, while reads kept working. Each failed write left nothing
 *    behind, so retrying an idempotent call is safe. A create is not
 *    idempotent, so callers pass { retry: false } and check for the thing
 *    they were creating before trying again -- a slow success must not turn
 *    into a duplicate.
 */

const BASE = "https://api.shade.inc";
const RETRYABLE = new Set([429, 502, 503, 504]);
const ATTEMPTS = 4;

let getKey = async () => null;

class ShadeError extends Error {
  constructor(status, detail, method, path) {
    super(`${method} ${path} -> ${status}${detail ? ": " + detail : ""}`);
    this.status = status;
    this.detail = detail;
  }
}

function setKeyProvider(fn) { getKey = fn; }

function qs(query) {
  if (!query) return "";
  const parts = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
  }
  return parts.length ? "?" + parts.join("&") : "";
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function request(method, path, { query, body, retry = true } = {}) {
  const key = await getKey();
  if (!key) throw new ShadeError(0, "no API key set", method, path);

  const url = BASE + path + qs(query);
  const init = {
    method,
    headers: { Authorization: key, Accept: "application/json" }
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const attempts = retry ? ATTEMPTS : 1;
  let last = null;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(500 * Math.pow(2, i - 1));   // 0.5s, 1s, 2s
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      // A network failure. Treated like a 503: nothing arrived, so nothing
      // was changed, so trying again is safe for the calls that allow it.
      last = new ShadeError(0, e.message || "network error", method, path);
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (res.ok) return data;

    const detail = data && typeof data === "object" ? (data.detail || data.message) : String(text).slice(0, 200);
    last = new ShadeError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail), method, path);
    if (!RETRYABLE.has(res.status)) throw last;
  }
  throw last;
}

/* ---------------------------------------------------------------- drives */

const listWorkspaces = () => request("GET", "/workspaces");
const listDrives = (workspaceId) => request("GET", `/workspaces/${workspaceId}/drives`);

/* ---------------------------------------------------------------- assets */

/*
 * An asset by its Shade path, including custom_metadata. Null if there is no
 * such asset -- which is normal for a file Shade has not indexed yet.
 */
async function assetByPath(driveId, path) {
  try {
    return await request("GET", "/assets/path", { query: { drive_id: driveId, path } });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/*
 * Custom values live on GET /assets/{id}, under custom_metadata. Note that
 * GET /assets/{id}/metadata returns only system fields despite its name.
 */
const getAsset = (driveId, assetId) =>
  request("GET", `/assets/${assetId}`, { query: { drive_id: driveId } });

/* -------------------------------------------------------------- schema */

const listFields = (driveId) => request("GET", `/workspaces/drives/${driveId}/metadata`);

/*
 * Creating fields. Used only by setup, after the editor agrees. Not
 * retried: a create that times out may have landed, and setup re-checks
 * what exists before trying again.
 */
const addAssetFields = (driveId, columns) =>
  request("POST", `/workspaces/drives/${driveId}/metadata/assets/columns`,
    { body: { columns }, retry: false });

/* --------------------------------------------------------- automations */

/*
 * Shade's documented automations API (academy.shade.inc/developers/
 * automate/automations). Used only by proxy-linking setup, to create
 * "Make SPT Proxies" (proxyflow.js). The plugin never runs an automation.
 * Create is not idempotent, so it is not retried; setup lists first.
 */
const listAutomations = (driveId) => request("GET", "/automations", { query: { drive_id: driveId } });
const getAutomation = (id) => request("GET", `/automations/${id}`);
const createAutomation = (driveId, name, description) =>
  request("POST", "/automations", { body: { drive_id: driveId, name, description }, retry: false });
/* Whole-graph replace: { name, description?, viewport, nodes, edges }. */
const saveAutomation = (id, body) => request("PUT", `/automations/${id}`, { body });
const setAutomationStatus = (id, version, status) =>
  request("PATCH", `/automations/${id}/versions/${version}/status`, { body: { status } });
const deleteAutomation = (id) => request("DELETE", `/automations/${id}`, { retry: false });
const listIntegrations = (workspaceId, driveId) =>
  request("GET", "/automations/integrations", { query: { workspace_id: workspaceId, drive_id: driveId } });

module.exports = {
  ShadeError, setKeyProvider, request,
  listWorkspaces, listDrives,
  assetByPath, getAsset,
  listFields, addAssetFields,
  listAutomations, getAutomation, createAutomation, saveAutomation, setAutomationStatus,
  deleteAutomation, listIntegrations
};
