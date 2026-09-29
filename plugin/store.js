/*
 * What the plugin remembers between runs, in one JSON file in its data
 * folder.
 *
 * Nothing here is authoritative -- Shade is the only store -- so losing this
 * file costs requests, never data:
 *
 *   volumes   "/Volumes/X" -> { driveId, name }. Learned by proving a file
 *             (see resolve.js). Losing it means re-proving one file per drive.
 *   projects  "<driveId>:<projectGuid>" -> Projects record id. Losing it
 *             means one records listing per project to find it again.
 *   written   "<driveId>:<projectGuid>" -> { "<mediaPath>": { used } }.
 *             What we have already told Shade, so an unchanged asset costs
 *             nothing. Losing it means every asset is re-read once and, if
 *             already right, left alone.
 *
 * UXP files have no append mode and two overlapping writes truncate each
 * other, so saves go through a promise chain, like the log.
 */

const uxp = require("uxp");

const FILE = "state.json";
let state = null;
let chain = Promise.resolve();

function empty() { return { volumes: {}, projects: {}, written: {} }; }

async function load() {
  if (state) return state;
  try {
    const folder = await uxp.storage.localFileSystem.getDataFolder();
    const entry = await folder.getEntry(FILE);
    const parsed = JSON.parse(await entry.read());
    state = Object.assign(empty(), parsed);
  } catch (e) {
    state = empty();       // first run, or an unreadable file: start clean
  }
  return state;
}

function save() {
  const snapshot = JSON.stringify(state);
  chain = chain.then(async () => {
    const folder = await uxp.storage.localFileSystem.getDataFolder();
    const file = await folder.createFile(FILE, { overwrite: true });
    await file.write(snapshot);
  }).catch(() => {});
  return chain;
}

/* Forget everything we learned. For the panel's reset, and for testing. */
async function reset() {
  state = empty();
  await save();
}

module.exports = { load, save, reset };
