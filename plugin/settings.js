/*
 * Which features run: the panel's Settings tab.
 *
 *   autoPin   on   pin prompt on open, unpin prompt on close, pin new imports
 *   tracking  off  Imported?/Used?/Projects Used In and the project record
 *   linking   off  attach a clip's Linked Proxy / Linked Hi Res
 *
 * (Defaults decided 2026-10-20.) Tracking and linking write fields every
 * user of a drive sees, so they are opted into, and switching one on checks
 * the drive for its fields first (enable.js). Pinning only touches this Mac.
 *
 * Saved in the plugin's data folder as settings.json. This is the one thing
 * kept between sessions, and it is a preference for this Mac, not a record
 * of what Shade holds -- the "nothing saved" rule is about the latter.
 */

const { log } = require("./log.js");
const { platform } = require("./platform.js");

const FILE_NAME = "settings.json";
const DEFAULTS = Object.freeze({ autoPin: true, tracking: false, linking: false });

let current = { ...DEFAULTS };
const listeners = [];

/* Saved text -> settings. Unknown keys dropped, bad values defaulted. Pure. */
function parse(text) {
  let saved = {};
  try { saved = JSON.parse(text || "{}") || {}; } catch (e) { saved = {}; }
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (typeof saved[k] === "boolean") out[k] = saved[k];
  return out;
}

async function load() {
  current = parse(await platform().readData(FILE_NAME).catch(() => null));
  log(`settings: auto-pinning ${onOff(current.autoPin)}, project tracking ${onOff(current.tracking)}, ` +
      `proxy linking ${onOff(current.linking)}`);
  return current;
}

const onOff = (v) => (v ? "on" : "off");

function get(key) {
  return key ? current[key] : { ...current };
}

async function set(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`no setting "${key}"`);
  value = !!value;
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  await platform().writeData(FILE_NAME, JSON.stringify(current, null, 2)).catch((e) => {
    log(`could not save settings: ${e.message}`);
  });
  for (const fn of listeners) {
    try { fn(key, value); } catch (e) { /* a listener must not stop the others */ }
  }
}

function onChange(fn) { listeners.push(fn); }

module.exports = { DEFAULTS, parse, load, get, set, onChange };
