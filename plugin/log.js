/*
 * Logging. Lines go to the panel if it happens to be open, and to a file
 * regardless -- the plugin runs for hours with nobody looking at it, and the
 * panel tells you nothing about whether it is even on screen.
 *
 * UXP has no append mode: every write is a read-modify-write of the whole
 * file. Two writes racing truncate it, which is not hypothetical -- it
 * happened in the spike when two events landed 3ms apart. So writes are
 * serialised through a promise chain, and the file is capped so a plugin left
 * running for a week does not grow without bound.
 */

const uxp = require("uxp");

const MEMORY_LINES = 400;
const MAX_FILE_BYTES = 256 * 1024;
const FILE_NAME = "shade-tracker.log";

const lines = [];
let sink = null;          // the panel, when it exists
let writeChain = Promise.resolve();

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function log(...parts) {
  const line = stamp() + "  " + parts.map(fmt).join(" ");
  lines.push(line);
  if (lines.length > MEMORY_LINES) lines.shift();
  try { if (sink) sink(line, lines); } catch (e) { sink = null; }
  queueWrite(line);
  return line;
}

function fmt(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.message;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function queueWrite(line) {
  writeChain = writeChain.then(() => writeLine(line)).catch(() => {});
  return writeChain;
}

async function writeLine(line) {
  try {
    const folder = await uxp.storage.localFileSystem.getDataFolder();
    let existing = "";
    try {
      const prior = await folder.getEntry(FILE_NAME);
      existing = await prior.read();
    } catch (e) {
      // First run; no file yet.
    }
    let next = existing + line + "\n";
    // Keep the tail, not the head: what just happened matters more than what
    // happened on Tuesday.
    if (next.length > MAX_FILE_BYTES) {
      next = next.slice(next.length - Math.floor(MAX_FILE_BYTES * 0.8));
      const nl = next.indexOf("\n");
      if (nl >= 0) next = next.slice(nl + 1);
    }
    const file = await folder.createFile(FILE_NAME, { overwrite: true });
    await file.write(next);
  } catch (e) {
    // Never let logging take the plugin down.
  }
}

function attach(fn) { sink = fn; if (fn) fn(null, lines); }
function recent() { return lines.slice(); }

async function dataFolderPath() {
  try {
    return (await uxp.storage.localFileSystem.getDataFolder()).nativePath;
  } catch (e) {
    return "(unavailable)";
  }
}

module.exports = { log, attach, recent, dataFolderPath, FILE_NAME };
