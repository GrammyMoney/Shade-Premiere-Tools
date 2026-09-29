/*
 * The only place that knows whether we are inside Premiere or under Node.
 *
 * The same sync code runs in two hosts: the UXP panel (live, event-driven)
 * and the CLI parser (cli/, on a timer, for editors without the panel).
 * Running the SAME code, rather than a port of it, is what keeps the two
 * from disagreeing -- identity, merge rules and drive matching can only
 * drift if there are two copies of them.
 *
 * Everything host-specific is four functions: read and write a small file
 * in our data folder, say where that folder is, and read a local file's
 * size. The default is UXP; the CLI calls setPlatform() before anything
 * else. `uxp` is required lazily so this file loads under Node.
 */

const uxpPlatform = {
  name: "panel",

  async readData(name) {
    const folder = await require("uxp").storage.localFileSystem.getDataFolder();
    try {
      const entry = await folder.getEntry(name);
      return await entry.read();
    } catch (e) {
      return null;     // no such file yet
    }
  },

  async writeData(name, text) {
    const folder = await require("uxp").storage.localFileSystem.getDataFolder();
    const file = await folder.createFile(name, { overwrite: true });
    await file.write(text);
  },

  async dataPath() {
    return (await require("uxp").storage.localFileSystem.getDataFolder()).nativePath;
  },

  /*
   * Two routes, because which works depends on the UXP version and the
   * manifest's localFileSystem permission. Verified working on 26.5.1 (no
   * size warning on first load); which route won is not recorded.
   */
  async fileSize(path) {
    try {
      const st = await require("fs").lstat(path);
      if (st && typeof st.size === "number") return st.size;
    } catch (e) { /* try the next route */ }
    try {
      const lfs = require("uxp").storage.localFileSystem;
      const entry = await lfs.getEntryWithUrl("file:" + path);
      const md = await entry.getMetadata();
      if (md && typeof md.size === "number") return md.size;
    } catch (e) { /* fall through */ }
    return null;
  },

  /* Extra place for log lines to go. The panel shows them itself. */
  echo(line) {}
};

let current = uxpPlatform;

function setPlatform(impl) { current = Object.assign({}, uxpPlatform, impl); }
function platform() { return current; }

module.exports = { platform, setPlatform };
