# Shade Premiere Tools — project context

A Premiere Pro panel that reports which Shade assets each Premiere project
has imported and used, written straight into Shade's own metadata. Read the
whole file before changing anything: most of it is decisions already made and
the reasons behind them.

This is a deliberately smaller sibling of `premiere-events` (SHINE), in the
same GitHub account. The Premiere-side tracking is lifted from there, and so
are the gotchas below -- every one of them cost a test cycle to learn.

## What it does

1. An editor brings a clip from a mounted Shade drive into Premiere, by any
   route: drag from Finder, the Shade app, Media Browser, or opening a project
   that already contains it.
2. The plugin notices, works out which Shade asset that file is, and writes
   to Shade:
   - **Imported?** = true when the asset is in the project.
   - **Used?** = true when it is on a timeline.
   - **Projects Used In** gains a link to this project's record.
3. Each Premiere project is a record in the **Projects** custom object, so a
   project can be looked at on its own, not only as text on an asset.

There is **no local service, no database and no launcher.** The plugin talks
to `https://api.shade.inc` directly, and Shade is the only store.

**Since 0.2.0 (2026-10-14) it also links proxies and pins media**, through
Shade Desktop's local bridge (`ws://localhost:19876`). See "Proxy linking
and project pinning" below. That work came from **Shade-Linker**, which
this replaces; don't run both.

**A second way in, for editors without the panel: `cli/`.** (Added
2026-09-29.) A Node CLI that finds `.prproj` files on a Shade drive through
the API, parses them, and runs **the panel's own sync code** on the result,
on a timer (a LaunchAgent). The panel tracks the live project, in real time;
the CLI tracks the last save, every N minutes. That's the only difference,
and see "Panel and CLI" for why they can't disagree.

## Current state

**Phase: plugin written, not yet loaded in Premiere.** (2026-09-29)

| part | state |
|------|-------|
| Shade schema | Created in Adobe Sandbox (below). Projects table empty. |
| `plugin/` | Written. 17 unit tests on the pure parts (`paths`, `plan`, `collapse`). |
| sync against real Shade | **Verified end to end** with `tools/harness.js`: volume proven, record created, fields and links written, second project appended not replaced, repeat pass writes nothing, rename renames, Project File links. All test data deleted afterwards. |
| `cli/` | **Working** against Adobe Sandbox. 14 tests (parser, selection). Not yet installed as a LaunchAgent. |
| inside Premiere | **Working** (first load 2026-09-29, UDT, Premiere 26.5.1). Three projects, three clips from Adobe Sandbox; Shade matched the plugin's state exactly. |
| linking + pinning (0.2.0) | Linking ported from Shade-Linker (worked in Premiere there). `tools/pins-harness.js` passes against the real bridge and real files on Adobe Sandbox. **Not yet loaded in Premiere**: the dialogs, `ProjectEvent.CLOSED` and its payload are unverified. |

**Verified inside Premiere on first load:** the key panel (`<input
type="password">`, `secureStorage` round trip), `fetch` to api.shade.inc,
all four global events plus per-project `DIRTY`, the scan (1–3ms), proving
the volume from a real clip, **reading local file sizes** (no
`cannot read local file sizes` warning), creating records, appending links
across three projects, and zero-write repeat passes.

**Fixed after first load:**
- **400ms after `IMPORT_MEDIA_COMPLETE` was too early for an import.** It
  found 0 files, and the clip was picked up 10s later by an unrelated event.
  An import now also gets a follow-up pass 2.5s later.
- **Project File was never linked.** Shade indexed the `.prproj` 3s and 18s
  *after* the pass that looked for it, and nothing triggered another pass.
  Now a project whose `.prproj` is on a Shade drive but not indexed yet
  retries every 20s, up to 6 times.
- **Record names included `.prproj`.** `Project.name` includes the
  extension. It's now stripped, and existing records are renamed on their
  next pass (verified against the real "New Tracker" record).

**Answered: Save As gives the copy a new `Project.guid`.** "Tracker Test"
had two records because it was saved locally, then Save As'd onto the Shade
drive. Both GUIDs were real and distinct, so `Project.guid` stays the
identity key. The fix is the rule below: a local project is never tracked.
The stray record for the local original was deleted by hand.

## The Shade model

In the **Adobe Sandbox** drive for now
(`72454409-8db3-4aba-86f4-53d3d5948b5a`, workspace *acme. Films*).

| Where | Name | Type | ID | Notes |
|---|---|---|---|---|
| asset field | `Imported?` | bool | `be782155-a89f-4101-9e42-24dc2884d739` | the asset is in a project's bins |
| asset field | `Used?` | bool | `dded2336-ad10-4b63-bdcc-88d5c460b913` | the asset is on a timeline |
| asset field | `Projects Used In` | **two-way** relation → Premiere Projects | `50d1d996-9929-4149-922f-a7e50038d543` | appended to, never replaced; mirrored as `Assets`. Created 2026-10-20 by the panel's setup dialog |
| object | `Premiere Projects` | custom object | `ca7c8bbd-a45a-496c-9efe-4bb03a6ad5c3` | one record per Premiere project. Created 2026-10-20 through the MCP |
| Premiere Projects column | `Project GUID` | str | `04b09d24-e3e6-48e4-a054-7635dff65936` | `Project.guid`: the identity key |
| Premiere Projects column | `Project File` | relation → asset | `4a1a616a-7092-48b4-948f-0e5e8cfd6856` | the `.prproj`, which lives on the drive |
| Premiere Projects column | `Assets` | paired to `Projects Used In` | `61d440fe-2644-4932-98fd-617678b24647` | **maintained by Shade**, never written by us |
| Premiere Projects column | `Exports` | relation → asset | `84a687e0-3d93-4053-ba7d-fc0757ac3960` | newest export of each timeline; older versions are in its Shade stack. Written by Export only |
| asset field | `Project Media` | relation → asset | `857a7a3e-ef1a-45bc-be0a-4ea8a91023d5` | on a `.prproj`: the Shade media in it. Optional. |

Created 2026-09-29 through the Shade MCP and REST.

**Reset 2026-10-20:** the old `Projects` object (`d31ed47a…`, 10 records)
was deleted by hand, which also removed `Projects Used In`; every record
and link went with it. `Premiere Projects` was created empty through the
MCP. The MCP can't create a two-way relation, so `Projects Used In` was
created by the panel's setup dialog, the first real run of it: Project
tracking switched on with "Measuring Tape" open, one item created, then the
record, then 6 clips linked. Verified in Shade the same night. Imported?, Used?, Project Media and the
Linked Proxy / Hi Res fields were untouched.

**`Projects Used In` was re-created as a two-way relation** the same day, so
that Projects gets an `Assets` column Shade keeps mirrored itself: no writes
from us, it can't drift, and links added by hand appear too. A relation can
only be made two-way when it's created, so the migration was: back up every
value (9 assets, 11 links), rename the old field `Projects Used In (old)`
(`2239d488…`), create the new one with `inverse: {enabled: true, name:
"Assets"}`, copy every value, verify 9/9 against the backup, then archive the
old field. The code finds fields by name, so nothing in it changed. It's all
repeatable on another drive the same way. **Look fields up by name at
runtime; don't hard-code these IDs.** They're specific to this drive, and
another drive will have its own. The plugin should create any that are
missing (or say which are missing) rather than assume they exist.

**Shade intermittently returned `503` on writes that day.** Roughly half
failed, reads never did. A 503 left nothing behind: every failed create was
confirmed absent before retrying. So the plugin must retry 503s, and on a
create it must re-check for existence before retrying, or a slow success
turns into a duplicate.

The pattern is proven on this drive already: assets there have a **Client**
relation field pointing at a **Clients** custom object. Relations are **one
directional**: `get_type` on Clients showed no reverse column. So a project
has no list of its assets stored on it. Its assets are the ones whose
`Projects Used In` point at it. That is on purpose: one write per change, and
nothing that can disagree with itself.

## Decisions (and why)

- **UXP, never CEP/ExtendScript.** Adobe ends ExtendScript for Premiere in
  September 2026. `require("premierepro")`, promise-based. Ignore any
  tutorial using `app.project.rootItem` or `evalScript`.
- **Two booleans, mapped to two different facts.** `Imported?` means the
  asset is in the project's bins. `Used?` means a track item on some sequence
  references it. (Decided 2026-09-29.)
- **A project is linked when the asset is imported, not when it is used.**
  (Decided 2026-09-29.) `Projects Used In` means "projects that contain this
  asset", despite its name. Reading an asset:
  - `Imported?` checked, `Used?` unchecked: in at least one project, on no
    timeline.
  - Both checked: imported, and on a timeline in at least one project.

  `Used?` is per asset, not per project. Which of the linked projects
  actually used it is not recorded. That's accepted for now; per-project
  usage would need a second relation field.
- **Only projects saved on a Shade drive are tracked.** (Decided
  2026-09-29.) A project whose `.prproj` is on the local disk, or not saved
  yet, gets no record, and its clips aren't marked at all. A local project
  isn't shared, so it isn't ours to report. It was also producing a second
  record every time an editor started locally and then Save As'd onto the
  drive.
  - The `.prproj` needn't be indexed yet (Shade takes 3–18s). A proven
    volume is enough. On an unproven volume, the project file or any clip on
    that same volume can prove it.
  - A volume that can't be proven is retried like a missing project file
    (the same retry as anything else Shade hasn't caught up with). The panel shows "not tracking" with the
    reason, and the lamp stays green, because this is correct behaviour,
    not a fault.
  - Moving a project onto Shade later makes it tracked from its next pass,
    under its new GUID. Nothing carries over from the local copy, and
    nothing needs to.
- **Every save gives a `.prproj` a new asset in Shade.** (Measured
  2026-09-29: Arbor Hills Sizzle's asset was re-created at the moment of a
  save, and the record's Project File link to the old one vanished.)
  Premiere saves by writing a new file and renaming it over the old one, and
  Shade sees a new file. Consequences:
  - **Project File** breaks on every save. Shade clears the link to the
    deleted asset, and the next pass re-links it. Self-healing, no action.
  - **Anything written onto the `.prproj` is wiped by a save**, and that
    includes Project Media. So Project Media is checked on **every** pass,
    not just when an asset changes, and rewritten in full when missing.
  - The CLI repairs this naturally (a save makes the file "changed"). The
    panel repairs it on the next edit, or through the retry.
    There is no save event in UXP.
- **Project Media lists the Shade assets this session has seen in the
  project on that drive**, merged into whatever is there. So it over-reports, like everything else. It's written only if
  the drive has the field.
- **Never unset.** Neither boolean is cleared, and no project is removed from
  `Projects Used In`, when a clip is deleted from a bin or timeline. Wrongly
  calling an asset unused is the dangerous mistake for anything archival, and
  nested sequences, multicam, Dynamic Link and MOGRTs can all hide real use.
  Over-reporting is the accepted cost. (Carried over from SHINE.)
- **A project is identified by `Project.guid`, never its name or path.** A
  rename or a Save As must not produce a second Projects record. Name and
  file are refreshed on every write; the GUID is how the record is found.
- **Project files are assumed to live on the Shade drive.** (Decided
  2026-09-29.) So `Project File` is a relation to the real `.prproj` asset,
  not a text path. A freshly saved project may not be indexed by Shade yet,
  so a missing `.prproj` asset is *normal* and must not fail the write. Leave
  the column empty and fill it on a later pass.
- **Assets are resolved by path.** A clip at
  `/Volumes/<drive>/Footage/a.mp4` is `/<driveId>/Footage/a.mp4` to Shade,
  looked up with `GET /assets/path?path=&drive_id=`. Anything outside a Shade mount
  is not ours and is skipped silently: most projects mix Shade media with
  local media, and that is not an error.
- **Recognising a Shade drive: prove it with a file, then trust the whole
  volume.** (Decided 2026-09-29.) UXP can't run `mount`, so the plugin can't
  see that a volume is `smbfs` from host `shadefs`. Instead:
  1. For a clip at `/Volumes/<X>/<rest>`, the candidates are every drive the
     key can see whose name is exactly `<X>`. Shade mounts a drive under its
     display name: `Adobe Sandbox` → `/Volumes/Adobe Sandbox`.
  2. For each candidate, `GET /assets/path` with `/<driveId><rest>`. It's a
     match only if the asset exists **and** its `size_bytes` equals the local
     file's size.
  3. On the first match, record `/Volumes/<X>` → `driveId` and resolve every
     other path under it directly, with no more probing.

  Why each part:
  - **Names aren't unique.** 47 drives were visible to one key, and two were
    both called `Joe Test`. A name gives candidates; the file decides.
  - **The size check** stops a same-named file on a same-named drive from
    claiming the volume. Measured: 44,219,305 bytes locally and in Shade.
  - **A 404 proves nothing on its own.** The file may simply not be indexed
    yet. So a volume with no match stays *unknown* and is probed again for
    the next clip. It is never cached as "not Shade".
  - **A mounted drive the key can't see never matches.** Seen: `Alex B
    Sandbox` was mounted, but belongs to a workspace this account can't see.
    Correct result, because we couldn't write to it anyway.
  - Anything outside `/Volumes/` (e.g. `/Users/...`) is local, and skipped
    without asking Shade.

  **Since 2026-10-20 the panel asks Shade Desktop's mount table first**
  (`resolve.setMountSource`, fed by `shadefs.mounts()`), and only falls back
  to the name + size proof when the bridge isn't there (always, for the
  CLI). Names went stale for real: Adobe Sandbox was renamed "Adobo Sandbox"
  in Shade while still mounted as `/Volumes/Adobe Sandbox`, so no name
  matched, every project waited forever, and linking (which already used the
  mount table) worked. `projectHome` also used to swallow lookup errors;
  they're now reported in the "not tracking" line.

  Filesystem markers were considered and rejected. A Shade mount's root
  shows `.trash/`, a zero-byte `.fseventsd` *file* and
  epoch-dated (1969) `.VolumeIcon.icns`. All distinctive, none documented,
  and any Shade release could change them. Drives also have
  `settings.mount_path_macos` (and `_linux`, `_windows`), but they're `null`
  on Adobe Sandbox, so they can't be relied on.
- **Relations are read-merge-write, which can lose an append.** Setting a
  relation value replaces it. Two editors adding the same asset to two
  projects at the same moment can each overwrite the other. Acceptable for
  now, because the next scan of either project re-adds its link, and a
  project is never removed. Don't build locking for it.
- **Only write what changed.** Keep what was last written per project in the
  plugin's data folder and diff against it. A scan is cheap (24ms for 129
  items); a Shade write per asset per `DIRTY` would not be.
- **The project's record comes first.** (Decided 2026-10-20.) As soon as
  a project is known to be on a Shade drive, its record on that drive is
  found or created, before any asset is written and even while the project
  has no Shade media yet. Its own drive is always synced first.
- **But always visit the project's record.** A pass where no asset changed
  must still check the Projects record on every drive the project has
  touched. Otherwise a rename, or a `.prproj` that has just been indexed,
  waits for some unrelated asset to change. That shipped once and was caught
  by the harness: a renamed project kept its old record name.
- **Sync never creates fields; `plugin/setup.js` does, when a person asks.**
  (Added 2026-09-29.) Adding columns to someone's drive is a person's
  decision, and a mistyped name in sync code would quietly create a second
  set. Sync reports a drive without the fields in `summary.needsSetup` (not
  as an error), and setup is the one place that creates. It's reached two
  ways:
  - **In the panel, when a feature is switched on** (since 2026-10-20;
    it replaced an inline two-click "set up drive" box). `enable.js` checks
    the active project's drive; if fields are missing, a dialog lists them
    and asks ("Create Fields" / "Not Now"). Not silent, because it adds
    fields every user of the drive will see, and Shade can only archive a
    field, never delete one. Declined, a conflict, or a 401/403 ("ask a
    drive owner"): the toggle goes back off. A drive met later (another
    project, sync's `needsSetup`, link.js finding no link fields) gets the
    same dialog once per drive per session.
  - **`spt setup --drive X`** from the CLI.

  Setup itself is idempotent, creates only what's absent, never
  modifies or removes, reports a same-named field of the wrong type as a
  conflict. `--check` makes it the health check (exit 1 if not ready).
  It exists mainly for one trap: `Projects Used In` must be two-way, and
  Shade only allows that at creation. Setup always creates it two-way; an
  existing one-way field is reported with a pointer to the migration, not
  migrated silently.
- **Three features, each a Settings toggle** (decided 2026-10-20):
  auto-pinning **on** by default, project tracking and proxy linking
  **off**, because those two write fields everyone on a drive sees.
  `settings.js` keeps them in `settings.json` in the data folder: the one
  thing kept between sessions, and a preference for this Mac, not a record
  of what Shade holds. Off means no event does anything for that feature
  (`tracker.run` returns before scanning; link.js skips the lookup or the
  pin). Switching one off undoes nothing. Auto-pinning without linking pins
  new clips straight from the mount with no Shade request, so it works with
  no API key.
- **The object is "Premiere Projects", never "Projects".** (Decided
  2026-10-20.) A customer's drive may have its own "Projects", and setup
  must not adopt it. An existing `Projects Used In` pointing anywhere else
  is a CONFLICT, not adopted. Sync still finds the object through the
  relation, and a customer's "Projects" has no `Project GUID`, so sync
  would refuse it too. Setup is per feature: `--linking` creates `Linked
  Proxy` / `Linked Hi Res` (one-way to assets).
- **Nothing is saved between sessions.** (Decided 2026-09-29, replacing a
  `state.json` of volumes, record ids and what had been written.) All of it
  lives for one Premiere launch or one CLI run. The saved "already written"
  map was a bug source: a link someone removed by hand in Shade was never
  put back, because the file said it was done. Now the first pass of each
  session re-checks every asset once (~1 lookup per Shade clip), re-proves
  each volume with one file, and re-finds records by GUID. The CLI keeps only
  its listing cut-off (`cli.json`), which is about which files to read, not
  about what Shade holds.
- **One retry signal.** A pass sets `summary.retry` whenever Shade hasn't
  caught up: a clip or the `.prproj` on a Shade drive but not indexed yet,
  or a volume not yet proven. The panel then looks again every 20s, up to 6
  times. `resolveFile` returns *why* it found nothing (`local`, `unknown`,
  `missing`, `found`), and only `missing` on a known drive means "wait".
  Before this, a clip just copied onto the drive waited for the next edit.
- **Field ids are re-read every 10 minutes**, not once per session. A panel
  runs for days, and a field replaced under it (as `Projects Used In` was)
  would otherwise keep receiving writes to the archived copy.
- **The Projects object is found through its relation, not by name.**
  `Projects Used In` names its target type, so renaming "Projects" in
  Shade's UI doesn't break anything. The field and column names are the
  contract: `Imported?`, `Used?`, `Projects Used In`, `Project GUID`,
  `Project File`.
- **Only the drive the project is saved on is tracked.** (Decided
  2026-10-20, replacing "a record on each drive".) Shade clips from any
  other drive get no record, no field writes and no setup prompt there;
  `sync` counts them in `summary.otherDrives` and costs one lookup per
  unproven volume, then nothing. The panel warns once per session ("Clips
  from another drive can't be tracked", `enable.warnOtherDrives`), and every
  sync log line counts them. Custom objects are per drive and relations
  can't cross drives, so a second record would only ever hold part of the
  project. Linking and pinning still handle those clips. Records already
  made on other drives are left alone (never unset).
- **The API key is the user's own and stays in `uxp.storage.secureStorage`.**
  It has every permission its owner has, so it never goes in the repo, a log
  line or a plain file.

## Proxy linking and project pinning

Added 2026-10-14 by folding Shade-Linker in. Plugin only; the CLI does
none of it (it has no mount and no bridge).

- **Import linking** (`link.js`, from Shade-Linker unchanged): a clip that
  arrives after the project was opened gets the other half of its pair
  attached (`Linked Proxy` → `attachProxy(proxy, false)`; `Linked Hi Res` →
  `attachProxy(hiRes, true)`), and both files are pinned. No question asked:
  it's one clip. Everything in Shade-Linker's CLAUDE.md "Decisions" still
  holds.
- **Project pinning** (`projectpins.js`): when a project opens (and at
  startup), the editor is asked once per project per session:
  "Number of assets: x (size) · Already pinned: … · Not pinned: … Would you
  like to pin these?". Nothing is asked when it's all pinned already.
  - **What counts** (decided 2026-10-14): every file the project reads from
    a mounted Shade drive: each clip's media, its attached proxy, and, for
    a clip with no proxy attached, the file its `Linked Proxy` points at.
    Not the Projects record's Assets column (that includes other editors'
    media).
  - **Asked, never automatic**, because a real media pool is terabytes.
    The panel's **pin project** asks again on demand.
- **Unpinning** (decided 2026-10-14): **there is no event before Premiere
  quits and nothing can delay a quit** (no app-quit event in the Premiere
  UXP docs; panel `destroy()` is synchronous). So:
  - `ProjectEvent.CLOSED` (25.6+, payload `id`, `name`, `path`) asks
    "Would you like to unpin the project 'x'?". Works when a project is
    closed with Premiere still open. At quit it's tried, and lost if the
    plugin is torn down first.
  - The panel's **unpin project** does the same for the active project.
  - By CLOSED the project can't be walked, so what's unpinned is what this
    session saw of it: the files counted for the pin prompt plus anything
    pinned on import. `id` is assumed to be the guid; `path` is the fallback.
  - Only files pinned **by themselves** can be unpinned. A file inside a
    pinned folder stays pinned with its folder (logged, not asked about).
  - A file shared with another project is unpinned too. Accepted for now.
- **Dialogs** (`dialog.js`): a `<dialog>` built on demand, `uxpShowModal`,
  `<sp-button>`s, one at a time. Esc or the title-bar close is "no". The
  plugin runs with no panel open, so whether a modal shows from a
  never-opened panel's document is **unverified**; if it can't show, the
  error is logged and the panel buttons still work.
- **Module layout**: `walk.js` (active project, clip items) and
  `shadefs.js` (mounts, inode+size, pin list, pin/unpin) are shared by
  `link.js` and `projectpins.js`, which keeps the requires one-way.
  `shadefs.pin`/`unpin` call through to `bridge.js` at call time, so a
  harness stub of `bridge.pin` takes effect. (They once held a copy of the
  function, and the harness really pinned 1.7 GB.)

### Bridge facts added 2026-10-14

Probed live against Shade Desktop with Adobe Sandbox, UMBRAL INTERNAL and
Design mounted:
- `pin list` → text, one `"<remote_uri>:<path inside the drive>"` per line,
  no leading slash. **Folders appear too** (`…:Shade Logos`), meaning
  everything under them is pinned. `pins.parsePinList` / `isPinned`.
- `pin stats` → a size table, with `?` for files it can't name. Not used.
- `pin remove <ino>…` works (code 0), the same shape as `pin add`.
  Verified by removing four test pins. `pin remove` with no inode answers
  `Please specify at least one ino`.
- Inodes from Node's `fs.stat` on the SMB mount match what pin/unpin act
  on (the four pins above were removed by Node-read inodes).

## Export, version stacks and comments

Added 2026-10-26. Plugin only.

**First real run, 2026-10-26** ("DJI Test", timeline
`2024_04_PANAMA_DAY5_DB_13`, folder `/EXPORTS` on Adobe Sandbox), verified
in the log, in Shade and in the project's auto-save:
- V01: rendered in 58 s (2m52s, 3840×2160, 23.976, 395 MB ≈ 18 Mb/s), in
  Shade 26 s later. V02: rendered in 23 s (1m09s, 156 MB), in Shade 19 s
  later, stacked as #2 on V01 (#1).
- **The higher stack_number is the current version:** `/EXPORTS` lists only
  V02, with V01 under it. So no `stack/move` is needed, and none is made.
- The record's Exports showed V02 only (V01 swapped out). The sequence's
  XMP held `ShadeTrackerExport{Version 2, Drive, Stack, Latest = V02}`.
- Import comments: 4 comments on V01 → 4 markers at exactly their times
  (3.667, 48.726, 86.909, 125.511 s; the last with its 12.11 s range),
  named "Alex Bagheri (Shade)", purple. The second transaction's colour
  took.
- Not yet seen: the rendering panel's behaviour during an export, Finish
  Linking after a timeout, the source-comments dialog, `sp-picker`.

- **Export** (`export.js`, the purple button): active timeline → whole
  sequence → Adobe's own `02 - Match Source - Low bitrate.epr` (H.264, source
  size and rate), found in Premiere's install under
  `MediaIO/systempresets/4E49434B_48323634/` (medium bitrate as fallback; no
  `.epr` shipped). `exportSequence(seq, IMMEDIATELY, out, preset, true)`,
  render events listened on the EncoderManager *instance*, and the promise +
  a non-empty file as the fallback when no complete event comes. These are
  the calls Shade's own Premiere plugin (`07be20ad`, read from its source
  map) uses; its preset and folder choices are not copied.
- **Saved to the project's Shade drive only** (decided 2026-10-26): the
  folder picker must land on the drive the .prproj is on, else a dialog and
  pick again. Shade Desktop uploads it; the plugin polls `GET /assets/path`
  (3 s → 10 s, up to 20 min) until the asset exists at the local size. Out of
  time is not a failure: the next Export on that timeline offers "Finish
  Linking" instead of rendering again.
- **Names:** `<Project>_<Timeline>_V01.mp4`, then the next number past the
  highest found in the stored link and the target folder (`versions.js`,
  pure). Gaps stay gaps; V100 follows V99.
- **Stacks:** onto the previous version: `POST /assets/{new}/stack?
  target_asset_id=<prev>` when it's already in a stack, else `POST
  /assets/stack {asset_ids:[prev,new]}` (that's how V01+V02 was made).
  Shade shows the highest stack_number as current, which is where a new
  version lands. A refused stack doesn't fail the export.
- **The timeline ↔ stack link lives in the .prproj** (decided 2026-10-26,
  so nothing extra is added to Shade): private project metadata on the
  sequence's project item, `ShadeTrackerExport{Drive,Latest,Stack,Version}`
  (`seqlink.js`), written with `createSetProjectMetadataAction` in
  `lockedAccess` + `executeTransaction`. It's saved with the editor's next
  save. Without it (an older project), the newest version file in the
  folder is the one stacked onto.
- **Version timelines** (`snapshot.js`, decided 2026-10-26): every Export,
  right after the render, copies the timeline as rendered into a root bin
  **Shade Versions** as `<Timeline>_V03` (`Sequence.createCloneAction` in a
  transaction; the copy is the sequence whose guid is new, then
  `createSetNameAction` + `createMoveItemAction`). Its XMP gets drive,
  version and `ShadeTrackerSnapshotOf` = the original's guid at once (the
  copied link fields are cleared), and `latest`/`stack` = that version's
  asset once Shade has it.
  **Where comments go** (decided 2026-10-26, revised after testing the
  same day): Import comments, pressed on any timeline of the line, fills
  the **working timeline with its newest version's comments** and **each
  version timeline with its own version's** (`snapshot.versionsOf`). A new
  copy has its "(Shade)" markers removed right after cloning, and **Export
  then clears the "(Shade)" markers from the working timeline**
  (`snapshot.removeShadeMarkers`, one transaction), so it only ever shows
  the current version's notes. Only the plugin's "(Shade)" markers are ever
  removed; the editor's own stay (asked 2026-10-26: "Shade comment markers
  only"). The frozen copy keeps everything else as a record.
  **After an export, work carries on in the timeline just exported**
  (decided 2026-10-26): `snapshot.focusWorking` closes every version
  timeline of the same original (`Project.closeSequence`, 26.2+; the new
  copy and older ones) and brings the exported timeline forward
  (`openSequence` + `setActiveSequence`). The exported timeline *is* the
  up-to-date working copy, so it isn't swapped for a new sequence: that
  would break anything nesting it.

  **Verified in Premiere, 2026-10-26** ("Testing 1234", timeline
  `Como_GAT_Campbell_Video_446_001`, `/EXPORTS`): the clone action works in
  a transaction; copies landed in Shade Versions as `…_V02`, `…_V03`, each
  with its 2 copied "(Shade)" markers cleared; closeSequence closed 1, then
  2 version timelines and the working timeline came back active; stack
  V01→V02→V03 with V03 current; Exports = V03; Import comments put V03's 1
  comment on the working timeline and the V03 copy and left V01/V02's
  already-imported ones alone. Renders of the 11 s timeline took ~1 s;
  Shade had each file 10-12 s later.
  **Bug found and fixed:** the first export ran with the `…_V01` *version
  timeline* active, and Export cleared V01's own comment markers and made
  it the active timeline. Now the working timeline is always the original
  (`targetOf().holder`): its markers are cleared and it's brought forward;
  a version timeline's markers are never cleared. With the original
  deleted, nothing is cleared.
  **Exporting a version timeline continues the original's stack**: named for
  the original, its link and Exports slot updated, plus a new copy. With the
  original deleted: the copy's own link (same stack), its name minus
  `_Vxx`, and no original to update. A copy that fails is logged and named
  in the panel line; it never fails the export. *Unverified:* the clone
  action itself (no working example found, only forum posts).
- **Exports column** on Premiere Projects: one-way relation to assets, one
  entry per timeline (its newest version; `versions.mergeExports` swaps it
  in place). Created by tracking setup; skipped, with a note, when tracking
  is off. **That is the only part of Export that needs tracking**: render,
  wait, stack, the timeline link and version timelines all run with it off
  (`test/export.test.js` runs a whole export that way, Premiere and Shade
  faked, and fails if sync is touched).
- **Import comments** (`comments.js`): each version's comments → markers on
  that version's timeline only (see Version timelines). Unresolved, top-level, timed comments only;
  replies folded into the text; name `<author> (Shade)`; purple, set in a
  second transaction (Shade's plugin does the same). No offset: an export
  covers the whole sequence from 0. Re-import adds nothing: same text within
  half a frame is already there (`markers-plan.js`, pure). The first run
  (before this rule) put V01's 4 comments on the original timeline itself;
  those markers predate it and were left for the editor to delete.
- **Source comments** on import: after linking and pinning, the new Shade
  clips' comments → clip markers (Source Monitor). Setting `sourceComments`
  `ask` (default) | `always` | `never`; the dialog's "Do this every time"
  sets the last two, and Settings has a picker. *Unverified:* clip-marker
  time on media with a non-zero start timecode, and `sp-picker` in UXP.

## Panel and CLI

They don't coordinate, and don't need to. Harmony comes from running **the
same code** (`plugin/sync.js`, `plan.js`, `resolve.js`) against the same
Shade:

- **Same identity.** A `.prproj` stores the project id as
  `<RootProjectItem ObjectUID="...">`, which is exactly what UXP returns as
  `Project.guid`. Verified on both real projects. Either writer finds the
  other's record.
- **Same rules, and they only ever add.** Flags are only raised, links only
  merged. So whichever arrives second finds Shade already right and writes
  nothing. Measured: the CLI's first pass over the two panel-tracked projects
  read both, found both records, and wrote **0 assets**.
- **Same "Shade projects only" rule.** The CLI only ever sees `.prproj`
  files listed from a Shade drive.
- **No shared local state.** Neither keeps anything between sessions
  except the CLI's listing cut-off. Both check Shade before writing.
- **The one real race** is the relation read-merge-write (see Decisions): the
  panel and the CLI writing the same asset in the same instant can drop a
  link. The next pass by either restores it.

Why share code rather than write a server-side port: two copies of the merge
rules, the identity key or the drive matching would eventually disagree, and
that disagreement is exactly the duplicate or erased link this is meant to
prevent. `plugin/platform.js` is the seam: file I/O, the data folder and file
sizes are the only host-specific things, and the CLI swaps them for Node's.

### How the CLI finds and reads projects

- **Listing:** `POST /search/files` with `recursive`, `sort: "-updated"`,
  `return_only_attrs`, paged 200 at a time. Newest change first, so a pass
  stops at the first file older than the last run's newest change (less a
  10-minute overlap, since Shade sets `updated` when it indexes). Measured:
  first pass 1.9s, second pass 83ms with nothing to read.
- **Search is semantic.** A query for `prproj` returned PNGs and JPGs too. So
  the CLI lists and filters on `extension`, never trusts a query.
- **Shade's trash is skipped.** The listing includes `/<driveId>/.trash/`,
  and a deleted `.prproj` there would re-create or rename its record.
- **Auto-saves are skipped.** `Adobe Premiere Pro Auto-Save/*.prproj` carries
  the **same project id** as the real project (verified). Parsing it would
  rename the record after the auto-save and report an older version's clips.
- **Several files with one id** (a Finder duplicate) are merged: the newest
  names the project and is its Project File, and clip usage is OR-ed.
- **Reading:** `GET /assets/{id}/download?origin_type=SOURCE` returns a signed
  URL; the bytes are identical to the file on the mount. So the CLI needs **no
  mount**. Without one, drive matching skips the size check (path only), as
  designed.
- **Media paths** in a project are the editor's absolute paths
  (`/Volumes/<drive>/...`). The drive a `.prproj` was listed from is
  recorded as `/Volumes/<drive name>`, so its own media resolves without a
  probe. **Windows editors' paths (`X:\...`) are not resolved yet**; they
  count as "not on Shade".
- **The cut-off only advances when a pass fully succeeds**, so a project that
  failed to download or sync is retried rather than left behind.

### The .prproj format (26.5.1)

Mapped from real files; the details are in the header of `cli/prproj.js`.
Gzipped XML. Top-level objects at one tab of indent, `ObjectID` (local
number) or `ObjectUID` (uuid), referenced by `ObjectRef` / `ObjectURef`.

- clip: `ClipProjectItem → MasterClip → VideoClip|AudioClip → *MediaSource →
  Media → ActualMediaFilePath`
- sequence: the same chain ending in a `*SequenceSource`, which is skipped
- proxy: a `Media` with `<IsProxy>true</IsProxy>`, which is skipped. SHINE
  attaches these, so a project can hold two `Media` per clip.
- on a timeline: `*ClipTrackItem → SubClip → MasterClip`
- **`<InUse>` is useless:** false on every clip, including clips plainly on a
  timeline.

Verified: both real projects parse to exactly what the panel recorded, in
1–3ms each.

## Shade API facts

Full endpoint list extracted from their docs: `docs/shade-endpoints.txt`.
Source docs: `https://academy.shade.inc/llms.txt`. Append `.md` to any docs
URL for markdown. `?ask=<question>` on a docs URL queries their search.

- Base `https://api.shade.inc`. It also answers under `/v1/...`, which is
  what Shade's own MCP client uses.
- **`Authorization: sk_...`: no `Bearer`.** The key is the whole header value.
- The filesystem API (`https://fs.shade.inc/{drive_id}/...`) uses a
  **different** token: `GET /workspaces/drives/{id}/shade-fs-token` returns a
  JWT valid for about 5 minutes, sent as `Bearer <jwt>`. Check `exp` before
  every use. We shouldn't need this API at all.
- Asset metadata:
  - `GET  /assets/{id}/metadata?drive_id=`
  - `PUT  /assets/{id}/metadata/{attribute_id}/value`
  - `PUT  /assets/metadata/values` (bulk)
  - `GET  /workspaces/drives/{drive_id}/metadata` (schema, including system
    fields)
- `GET /assets/path?path=&drive_id=` → `AssetDTO`. **The path must start
  with the drive's ID**: `/<driveId>/Graphic Design/a.mov`. The
  drive-relative `/Graphic Design/a.mov` that the docs imply returns `404
  Asset not found`. Every `path` Shade returns carries the same prefix.
  **Lookup is case-sensitive** (a lower-cased path 404s), so pass the exact
  spelling on disk, which is what Premiere reports.
- Webhooks exist (`asset.updated` etc., via a Svix dashboard) but aren't
  needed: the plugin is the only writer of these fields.
- The official SDK is Python only and hasn't been updated since February
  2025. It doesn't cover custom objects.

## Custom-object API (undocumented)

**Read out of the Shade web app's own JavaScript** (`app.shade.inc`,
`main-*.js`, 2026-09-29), because none of it is in Shade's docs. **Then
confirmed live with an `sk_` key the same day**: list type, list records,
create a record, write a relation, delete a record. It's unpublished, so it
can change without notice. If a call starts failing, re-read the bundle
before assuming our code is wrong.

```
GET    /workspaces/drives/{drive}/custom-object-types                  list types
GET    /workspaces/drives/{drive}/custom-object-types/{type}            one type + columns
PATCH  /workspaces/drives/{drive}/custom-object-types/{type}            edit type
GET    /workspaces/drives/{drive}/custom-object-types/{type}/records    list records
POST   /workspaces/drives/{drive}/custom-object-types/{type}/records    create
         body {name, metadata: {<columnId>: <tagged value>}}
GET    /workspaces/drives/{drive}/custom-object-types/{type}/records/{id}
PATCH  /workspaces/drives/{drive}/custom-object-types/{type}/records/{id}
         body {name} or {metadata: {...}}
DELETE /workspaces/drives/{drive}/custom-object-types/{type}/records/{id}   -> 204
GET    /workspaces/drives/{drive}/custom-object-types/records/{id}      by id alone
GET    /workspaces/drives/{drive}/relation-targets?object_type=custom_object
         &target_database_id=&query=&limit=                             picker search
       /workspaces/drives/{drive}/metadata/custom-objects/{type}/columns[/{col}]
       /workspaces/drives/{drive}/metadata/assets/columns[/{col}]
```

- **Record metadata is keyed by column ID and every value is tagged:**
  `{kind: "scalar", value: ...}` or
  `{kind: "relation", values: [{id, type}]}`, where `type` is `asset`,
  `custom_object`, `individual` or `user`.
- **Reads come back differently from writes.** A record carries
  `metadata_values: [...]`. A scalar reads back as
  `{kind: "scalar", id, value}`. A relation reads back as
  **`{kind: "reference", id, values: [{entity_type, id, name, ...}]}`**:
  `reference` on the way out, `relation` on the way in. Convert before
  writing back.
- **`sk_` keys work on every custom-object route**, even though the web app
  itself authenticates with a Firebase user token.
- **Create returns `201` with the full record**, including `id` and the
  stored `metadata_values`. That's all the plugin needs to cache.
- **Asset values are written with `PUT /assets/metadata/values`.** A relation
  value there is a plain array: `[{id, type: "custom_object"}]`, with no
  `kind` wrapper. Two body forms both work:
  - `{drive_id, asset_ids: [...], metadata_attributes: [{id, value}]}`: the
    same values for many assets.
  - `{drive_id, asset_ids_with_metadata_attributes: [{asset_id,
    metadata_attributes: [{id, value}]}]}`: different values per asset. This
    is the one the plugin wants, because each asset's link list differs.

  Both answer `[{asset_id, updated_metadata_attribute_ids}]`.
- **`append: true` is silently ignored for relation fields. It REPLACES.**
  Measured 2026-09-29: an asset linked to one project, written with
  `append: true` and a second project, came back linked to the second only.
  The call returned 200 and listed the field as updated. So the only way to
  add a project is **read the asset, merge, write the whole list**. That's
  the race described in Decisions, and it's real, not theoretical.
- **Asset custom values are on `GET /assets/{id}?drive_id=`, under
  `custom_metadata`**, keyed by field ID. `GET /assets/{id}/metadata` returns
  **only system fields** (codec, duration, …), not custom ones. It looks
  like the right endpoint and isn't.
- **Deleting a record removes it from every asset's relation automatically.**
  No dangling references, and no cleanup pass needed.
- Relation columns carry `paired_to` and `relation_config.inverse` (both
  `null` on ours). That suggests Shade can pair a relation with a reverse
  column on the other side, e.g. an automatic "Assets" column on Projects.
  Unexplored; worth a look before building any "assets in this project"
  view by hand.
- **Two-way relations exist ("Two way reference" in the UI), but only at
  creation.** A relation column created with
  `relation_config: {target, inverse: {enabled: true, name: "<column on the other side>"}}`
  gets a paired column on its target that mirrors it (`paired_to` set on
  both). **It can't be turned on later:** PATCH on an asset column rejects
  `relation_target`/`inverse` with 422 `extra_forbidden`. Create is
  `POST /workspaces/drives/{d}/metadata/assets/columns` with
  `{columns: [{column_name, column_type: "relation", relation_config}]}`.
- There's no "find record by column value" route. Finding a Project by GUID
  means listing the type's records and matching locally. Cache the GUID →
  record ID map in the plugin's data folder.

## Unknowns, to settle before writing code

1. ~~Custom-object REST endpoints.~~ Found, and confirmed live with an `sk_`
   key.
2. ~~Relation value shape on an asset / does `append` work?~~ `[{id, type}]`,
   and no, it replaces. See "Custom-object API".
3. ~~Mount → drive ID.~~ **Solved 2026-09-29 by asking Shade about the
   files themselves.** See "Recognising a Shade drive" in Decisions.
4. ~~Does `Projects Used In` link on import, or only on use?~~ **Decided
   2026-09-29: on import.** See Decisions.

## Gotchas already paid for (from premiere-events)

Measured on Premiere 26.5.1 / macOS / arm64 unless stated.

- **`ProjectEvent.DIRTY` only fires on a listener bound to a specific
  `Project`.** Registered globally it never fires, with no error. Bind with
  `EventManager.addEventListener(project, ...)` and **re-bind when the active
  project changes**. Compare the active project's GUID after every scan, so
  a missed `OPENED` can't strand the binding.
- **Event constants live under `ppro.Constants`, and they're dotted
  strings.** `ppro.Constants.ProjectEvent.DIRTY` is `"ProjectEvent.Dirty"`.
  Any string is accepted, so a wrong name registers cleanly and never fires.
  If a constant is missing, say so and bind nothing; never guess the name.
- **`addGlobalEventListener(name, handler, inCapturePhase)`: the third
  argument isn't optional.**
- **No event for "item added" or "timeline changed".** `DIRTY` is the only
  signal. Debounce 2–5s so edits can settle (not for cost; a walk is ~24ms),
  then walk everything and diff.
- **`IMPORT_MEDIA_COMPLETE` fires before the new item is queryable.** The
  item appears 100–217ms later. Wait about 400ms before scanning, or the scan
  finds nothing.
- **Don't bind `SequenceEvent.SELECTION_CHANGED`.** It fired 11 times a
  minute and tells us nothing. `SequenceEvent.ACTIVATED` fires globally and is
  useful.
- **`setInterval`/`setTimeout` are throttled hard when Premiere is idle:** up
  to 29 minutes for a nominal 10s. So the debounce may be late, and Shade will
  be eventually right, not promptly right. Never poll.
- **One file can be several project items.** The same file imported twice is
  two items, and in a real project one was used while the other wasn't. OR
  the status up to the file before writing.
- **Filenames collide.** Camera cards repeat `C0023.MP4` in every folder.
  Never key on a basename.
- **Case folding.** APFS is case-insensitive, and Premiere may report a
  different spelling of the path than Shade stores. Normalise before
  comparing, and never compare paths with `===`.
- **The plugin runs at Premiere launch with no panel open,** and keeps
  running after the panel closes (10+ hours measured). The panel is a status
  window only. **Panel `create`/`show`/`hide`/`destroy` hooks say nothing
  about visibility**, so build no state on them.
- **Manifest: `host` must be an object, not an array.** UDT accepts the
  array; an installed plugin silently doesn't load. When an installed plugin
  isn't there, check the log first:
  `~/Library/Logs/Adobe/Adobe Premiere Pro 2026/UXPLogs_<date>.log`.
- **Manifest v5 on purpose.** A cold-start network permission bug was filed
  against v6.
- **Network permissions list domains, and UXP refuses IP literals.** List
  `https://api.shade.inc` explicitly.
- **UXP files have no append mode.** Every write is a read-modify-write, and
  concurrent ones corrupt the file. Serialise them through a promise chain
  (`log.js` in SHINE does this).
- **No clipboard and no shell in UXP.** `getFileForSaving` works, and is how
  to hand the user a file.
- **UXP's CSS support is a silent subset.** No `box-shadow`. `<button>`
  ignores your styling (style a `<div>`). `body` doesn't fill the panel (set
  height and background on `html` too). Unverified, so avoid: `gap`, CSS
  variables, `grid`, SVG, transitions.
- **Dev-loaded (UDT) plugins vanish on a Premiere restart.** Testing "loads
  at launch" needs an installed plugin.
- **Installing without a `.ccx`** needs two steps: copy the folder to
  `~/Library/Application Support/Adobe/UXP/Plugins/External/<id>_<version>/`
  **and** add an entry to `.../UXP/PluginsInfo/v1/premierepro.json` with
  `path: "$localPlugins/External/<folder>"`.

## Verified UXP API surface (Premiere 25.6+)

`Project.getActiveProject()`, `.guid`, `.name`, `.path`, `.getRootItem()`,
`.getSequences()`; `FolderItem.cast()`, `.getItems()`;
`ClipProjectItem.cast()`, `.getMediaFilePath()`, `.isSequence()`;
`ProjectItem.getId()`, `.name`; `Sequence.guid`, `.getVideoTrackCount()`,
`.getVideoTrack(i)`, `.getAudioTrackCount()`, `.getAudioTrack(i)`;
`Track.getTrackItems(Constants.TrackItemType.CLIP, false)`;
`TrackItem.getProjectItem()`; `EventManager.addEventListener`,
`.addGlobalEventListener`.

## Out of scope

- Relinking, a launcher, search. SHINE has these. (Proxies came in with
  0.2.0, from Shade-Linker; see above.)
- Unsetting `Imported?`/`Used?` when an asset leaves a project.
- Usage hidden inside nested sequences, multicam, Dynamic Link, MOGRTs.
- More than one Shade workspace at once.

## Repo layout

```
scripts/package-ccx.sh build the installable .ccx into dist/ (bash 3.2)
CLAUDE.md              this file
docs/shade-endpoints.txt   every documented endpoint, extracted from Shade's docs
tools/pins-harness.js  project pinning + import linking under Node: REAL bridge
                       (read-only) and real files on a mount; REST, dialogs and
                       pin/unpin stubbed. Changes nothing.
tools/harness.js       runs the plugin's sync under Node against REAL Shade,
                       with uxp stubbed. Writes to real assets: use a test
                       GUID, clean up afterwards.
.env                   SHADE_API_KEY=sk_... for the harness. Git-ignored.
cli/                   the parser, for editors without the panel. Node >= 20, no deps.
  spt.js     setup / run / key / install / uninstall / status
  prproj.js            .prproj -> { guid, files }. Pure, tested.
  select.js            which files are projects; merging same-id copies. Pure, tested.
  test/                node --test
plugin/                the UXP plugin. Manifest v5, flat, no build step.
  platform.js          the seam: UXP by default, swapped for Node by the CLI
  manifest.json        host is an OBJECT; network: https://api.shade.inc, ws://localhost:19876
  main.js              entry: event wiring, API key, panel
  tracker.js           debounce -> scan -> sync
  scan.js              project walk; collapse() is pure and tested
  sync.js              projectHome -> resolveFiles -> syncDrive; session memory
  plan.js              what to write to one asset. Pure, tested. The rules.
  resolve.js           media path -> Shade asset; proving a volume is a drive
  paths.js             /Volumes/<X>/<rest> <-> /<driveId><rest>. Pure, tested.
  setup.js             create what a drive lacks, or report it; per feature. Panel + CLI.
  settings.js          which features run (Settings tab); settings.json
  enable.js            switching a feature on: check the drive, ask, create
  link.js              new clip -> Linked Proxy/Hi Res -> attach -> pin (from Shade-Linker)
  export.js            Export: render, wait for Shade, stack, link, Exports column
  comments.js          Shade comments -> sequence markers (button) / clip markers (on import)
  versions.js          export names, Vxx numbering, Exports merge. Pure, tested
  markers-plan.js      which comments become markers; duplicates. Pure, tested
  seqlink.js           timeline <-> export stack, in the sequence's XMP. XML part tested
  snapshot.js          version timelines: copy at export into "Shade Versions", link to the version
                       (test/export.test.js: a whole export, faked, with tracking off)
  projectpins.js       ask to pin a project on open; ask to unpin on close / button
  dialog.js            yes/no modal (uxpShowModal), one at a time
  shadefs.js           this Mac's Shade: mounts, inode+size, pin list, pin/unpin
  bridge.js            Shade Desktop's ws://localhost:19876 (from Shade-Linker)
  walk.js              active project and its clip items, for link/projectpins
  mounts.js            bridge mount table <-> paths. Pure, tested (Linker's paths.js)
  pins.js              link/pin rules, pin-list parsing, prompt numbers. Pure, tested
  shade.js             REST client: auth header, retries, every route used
  log.js               queued log file (from premiere-events)
  test/                node --test
```

## Packaging

`scripts/package-ccx.sh` builds `dist/<id>_premierepro.ccx`: a plain zip of
`manifest.json`, `index.html` and the plugin's root `*.js`, nothing else
(no tests, no package.json). That is exactly the shape of a UDT-packaged
`.ccx` (checked against premiere-events' spike `.ccx`: files at the root, no
signature, no META-INF). Before zipping it checks what only the installed
path enforces, and has been shown to fail on both:
- `host` must be an object (the array form loads in UDT and is silently
  rejected when installed)
- every `require("./x.js")` and the page's `<script src>` must be shipped

Not yet verified by installing: whether `localFileSystem: "fullAccess"`
makes Creative Cloud ask for consent at install, and whether the API key
saved by a dev copy carries over (secure storage may be per install; expect
to re-enter it). The installed copy's data folder is under
`PluginsStorage/PPRO/26/External/...`, not `Developer/`.

## Working conventions

- Repo: `github.com/GrammyMoney/Shade-Premiere-Tools` (private), branch
  `main`.
- **Renamed from "Shade Tracker" on 2026-10-26**, everywhere: repo (GitHub
  redirects the old URL), plugin and panel name "Shade Premiere Tools",
  panel title "SPT", plugin id `com.grammymoney.shadepremieretools` (was
  `…shadetracker`), panel id `sptPanel`, CLI `cli/spt.js` / `spt`, its
  LaunchAgent `com.grammymoney.spt.cli` and data folder "Shade Premiere Tools
  CLI", log `shade-premiere-tools.log`, undo labels "SPT: …".
  **Deliberately not renamed:** the `ShadeTrackerExport*` /
  `ShadeTrackerSnapshotOf` fields stored in projects' XMP (renaming them
  would orphan every existing export link), and field descriptions already
  written into Shade (setup never edits what exists). The id change makes
  Premiere see a new plugin: remove the old one in UDT / Creative Cloud,
  re-enter the API key and re-tick Settings. The CLI still reads a key saved
  under the old Keychain name "Shade Tracker".
- Plain JS, no build step. `cd plugin && npm test` for the pure parts
  (`node --test test/*.test.js`: Node 24 rejects a bare directory);
  `tools/harness.js` for sync against real Shade; everything Premiere-side is
  verified by loading it.
- Keep it small. If a feature needs a local service, it belongs in SHINE.
