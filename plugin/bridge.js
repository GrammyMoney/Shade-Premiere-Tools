/*
 * Shade Desktop's local bridge: ws://localhost:19876.
 *
 * Shade.app starts this alongside its filesystem daemon, for Shade's own
 * Premiere panel (it calls it the "CEP Bridge"). Found in Shade 2.3.21's
 * app bundle (dist/background.js) on 2026-10-07 and probed live. It is
 * undocumented, so treat every detail below as measured, not promised:
 *
 *   - Connect, wait for {type:"registered"} (~6-9ms), then send
 *     {type:"rpc", id, method, args}. `[method, ...args]` is handed to the
 *     shadefs daemon as an argv -- the same verbs as the shadefs CLI -- and
 *     the answer comes back as {type:"rpc_response", id, code, data}.
 *     code 0 is success; otherwise `data` is the error text.
 *   - Text output arrives as an array of one-character strings. normalize()
 *     joins it. Structured output (status:mount) arrives already parsed.
 *   - "bridge:getAllDrives" is answered by the bridge itself, from Shade's
 *     drive table: [{drive_number, remote_uri, root_ino, ...}].
 *   - No Origin check, no subprotocol, so UXP's `file://` origin is fine.
 *   - If the daemon is not running, the bridge sends {type:"error"} and
 *     closes with 4001.
 *
 * Why this and not shadefs: UXP has no shell, so the plugin cannot run the
 * CLI the way SHINE's service does. The bridge is the same daemon, reached
 * over a socket UXP is allowed to open. That is what keeps this plugin
 * headless -- no helper process, no LaunchAgent.
 *
 * The socket is opened on demand and kept while it lasts. Nothing polls it:
 * Premiere throttles timers to as much as 29 minutes when idle, and nothing
 * here needs to happen unless an import just did.
 */

const URL = "ws://localhost:19876";
const CONNECT_MS = 3000;
const RPC_MS = 8000;

let ws = null;
let ready = null;          // Promise that resolves once registered
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }

function normalize(data) {
  if (Array.isArray(data) && data.length && data.every((c) => typeof c === "string" && c.length <= 1)) {
    return data.join("");
  }
  return data;
}

function failAll(err) {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
  pending.clear();
}

function drop(err) {
  const sock = ws;
  ws = null;
  ready = null;
  failAll(err);
  try { if (sock) sock.close(); } catch (e) { /* already closed */ }
}

function connect() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      settle(reject, new Error("Shade bridge did not answer -- is Shade running?"));
      drop(new Error("bridge connect timed out"));
    }, CONNECT_MS);

    let sock;
    try {
      sock = new WebSocket(URL);
    } catch (e) {
      // UXP reports a permission failure as a throw here, not an error event.
      settle(reject, new Error("cannot open the Shade bridge: " + (e.message || e)));
      ready = null;
      return;
    }
    ws = sock;

    sock.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (!msg) return;
      if (msg.type === "registered") { settle(resolve, true); return; }
      if (msg.type === "rpc_response") {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve({ code: msg.code, data: normalize(msg.data) });
        return;
      }
      if (msg.type === "error") {
        const err = new Error(msg.error || "Shade bridge error");
        const p = msg.id !== undefined && pending.get(msg.id);
        if (p) { pending.delete(msg.id); clearTimeout(p.timer); p.reject(err); return; }
        // An error with no id is about the connection itself, e.g.
        // "ShadeFS not available - is Shade Desktop running?"
        settle(reject, err);
        drop(err);
      }
      // "event" messages are for subscriptions, which we do not make.
    };

    sock.onclose = () => {
      const err = new Error("Shade bridge closed");
      settle(reject, err);
      if (ws === sock) drop(err);
    };
    // An error is followed by a close, which is where it is handled.
    sock.onerror = () => {};
  });
  return ready;
}

/*
 * One daemon command. Resolves { code, data }; rejects only when the bridge
 * could not be reached or did not answer. A non-zero code is an answer.
 */
async function rpc(method, args = [], timeoutMs = RPC_MS) {
  await connect();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Shade bridge: ${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ type: "rpc", id, method, args: args.map(String) }));
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      drop(e);
      reject(e);
    }
  });
}

/* Every Shade drive on this machine, mounted or not. */
async function allDrives() {
  const r = await rpc("bridge:getAllDrives");
  return r.code === 0 && Array.isArray(r.data) ? r.data : [];
}

/*
 * What is mounted where. Over IPC, status:mount reports every mount (this is
 * what Shade.app itself calls) -- unlike the CLI, which answers for the cwd.
 * With nothing mounted it returns one empty placeholder.
 */
async function mountStates() {
  const r = await rpc("status:mount");
  if (r.code !== 0) throw new Error("status:mount failed: " + r.data);
  return Array.isArray(r.data) ? r.data : [];
}

/*
 * Pin files by inode. shadefs takes inodes only -- `pin add` with a path
 * answers "Please specify at least one ino" (measured). Its own usage text
 * claims `pin <drive> <path>`, which is wrong.
 */
async function pin(inos) {
  if (!inos.length) return { code: 0, data: null };
  return rpc("pin", ["add", ...inos]);
}

/* Unpin files by inode. Same argv shape as pin: `pin remove <ino>...`. */
async function unpin(inos) {
  if (!inos.length) return { code: 0, data: null };
  return rpc("pin", ["remove", ...inos]);
}

/*
 * Everything pinned on this machine, as the text `pin list` prints: one
 * "<remote_uri>:<path inside the drive>" per line, folders included
 * (measured 2026-10-14). pins.parsePinList() reads it.
 */
async function pinList() {
  const r = await rpc("pin", ["list"]);
  if (r.code !== 0) throw new Error("pin list failed: " + r.data);
  return typeof r.data === "string" ? r.data : "";
}

function isOpen() { return !!ws && ws.readyState === 1; }

module.exports = { rpc, allDrives, mountStates, pin, unpin, pinList, normalize, isOpen, URL };
