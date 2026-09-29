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
 *
 * The custom-object routes are undocumented (read out of Shade's web app)
 * but confirmed working with an sk_ key. See CLAUDE.md, "Custom-object API".
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

/*
 * Write different values to many assets in one call.
 * `updates` is [{ asset_id, metadata_attributes: [{ id, value }] }].
 */
const putAssetValues = (driveId, updates) =>
  request("PUT", "/assets/metadata/values", {
    body: { drive_id: driveId, asset_ids_with_metadata_attributes: updates }
  });

/*
 * One page of every file on a drive, newest change first. Used by the CLI to
 * find .prproj files. The search behind this is semantic -- a query for
 * "prproj" also returns PNGs -- so callers list and filter on extension
 * rather than trust a query. `sort: "-updated"` is what makes an
 * incremental pass possible: stop once past the last run's newest change.
 */
const listFilesPage = (driveId, { page, limit }) =>
  request("POST", "/search/files", {
    body: {
      drive_id: driveId,
      path: "/" + driveId,
      recursive: true,
      sort: "-updated",
      page,
      limit,
      return_only_attrs: ["id", "path", "name", "extension", "updated", "size_bytes"]
    }
  });

/* A short-lived signed URL for a file's bytes. */
const downloadUrl = (driveId, assetId) =>
  request("GET", `/assets/${assetId}/download`, {
    query: { drive_id: driveId, origin_type: "SOURCE" }
  });

/* -------------------------------------------------------------- schema */

const listFields = (driveId) => request("GET", `/workspaces/drives/${driveId}/metadata`);
const getObjectType = (driveId, typeId) =>
  request("GET", `/workspaces/drives/${driveId}/custom-object-types/${typeId}`);

/* ------------------------------------------------------------- records */

const recordsPath = (driveId, typeId) =>
  `/workspaces/drives/${driveId}/custom-object-types/${typeId}/records`;

async function listAllRecords(driveId, typeId) {
  const out = [];
  const limit = 200;
  for (let offset = 0; offset < 100000; offset += limit) {
    const page = await request("GET", recordsPath(driveId, typeId), { query: { limit, offset } });
    const items = (page && page.items) || [];
    out.push(...items);
    if (items.length < limit || out.length >= (page.total || 0)) break;
  }
  return out;
}

async function getRecord(driveId, typeId, recordId) {
  try {
    return await request("GET", `${recordsPath(driveId, typeId)}/${recordId}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/* Not retried here: see the header comment. The caller re-checks first. */
const createRecord = (driveId, typeId, body) =>
  request("POST", recordsPath(driveId, typeId), { body, retry: false });

const patchRecord = (driveId, typeId, recordId, body) =>
  request("PATCH", `${recordsPath(driveId, typeId)}/${recordId}`, { body });

module.exports = {
  ShadeError, setKeyProvider, request,
  listWorkspaces, listDrives,
  assetByPath, getAsset, putAssetValues, listFilesPage, downloadUrl,
  listFields, getObjectType,
  listAllRecords, getRecord, createRecord, patchRecord
};
