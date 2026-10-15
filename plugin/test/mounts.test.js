const test = require("node:test");
const assert = require("node:assert/strict");
const { mountFrom, driveIdFromUri, locate, shadePath, localPath } = require("../mounts.js");

const D = "72454409-8db3-4aba-86f4-53d3d5948b5a";
const mount = { root: "/Volumes/Adobe Sandbox", driveId: D, driveNumber: 30589885, rootIno: 1 };

test("drive id comes from the remote uri", () => {
  assert.equal(driveIdFromUri(`https://fs.shade.inc/${D}`), D);
  assert.equal(driveIdFromUri(`https://fs.shade.inc/${D}/`), D);
  assert.equal(driveIdFromUri("https://fs.shade.inc/"), null);
  assert.equal(driveIdFromUri(null), null);
});

test("the unmounted placeholder is not a mount", () => {
  // Measured: status:mount with nothing mounted.
  assert.equal(mountFrom({ status: 4, drive_number: 0, root_ino: 0, mount_path: "" }), null);
});

test("a mount state becomes a mount, uri from the state or the drive table", () => {
  const withUri = mountFrom({ drive_number: 30589885, root_ino: 1, mount_path: "/Volumes/Adobe Sandbox/",
                              remote_uri: `https://fs.shade.inc/${D}` });
  assert.deepEqual(withUri, mount);
  const fromTable = mountFrom({ drive_number: 30589885, root_ino: 1, mount_path: "/Volumes/Adobe Sandbox" },
                              [{ drive_number: 30589885, remote_uri: `https://fs.shade.inc/${D}` }]);
  assert.deepEqual(fromTable, mount);
  assert.equal(mountFrom({ drive_number: 5, mount_path: "/Volumes/X" }, []), null);
});

test("locate matches at a segment boundary, case-insensitively on the root only", () => {
  const hit = locate("/Volumes/adobe sandbox/2025 Media/A.MP4", [mount]);
  assert.equal(hit.mount, mount);
  assert.equal(hit.rest, "/2025 Media/A.MP4");
  assert.equal(locate("/Volumes/Adobe Sandbox 2/a.mp4", [mount]), null);
  assert.equal(locate("/Volumes/Adobe Sandbox", [mount]), null);
  assert.equal(locate("/Users/alex/a.mp4", [mount]), null);
});

test("the longest mount root wins", () => {
  const inner = { root: "/Volumes/Adobe Sandbox/nested", driveId: "x" };
  assert.equal(locate("/Volumes/Adobe Sandbox/nested/a.mp4", [mount, inner]).mount, inner);
});

test("shade path and back", () => {
  const sp = shadePath(D, "/2025 Media/a b.MP4");
  assert.equal(sp, `/${D}/2025 Media/a b.MP4`);
  assert.equal(localPath(sp, mount), "/Volumes/Adobe Sandbox/2025 Media/a b.MP4");
  assert.equal(localPath("/other-drive/x.mp4", mount), null);
});
