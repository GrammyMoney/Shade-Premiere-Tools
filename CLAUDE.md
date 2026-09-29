# Shade Tracker — project context

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

## Current state

**Phase: plugin written, not yet loaded in Premiere.** (2026-09-29)

| part | state |
|------|-------|
| Shade schema | Created in Adobe Sandbox (below). Projects table empty. |
| `plugin/` | Written. 17 unit tests on the pure parts (`paths`, `plan`, `collapse`). |
| sync against real Shade | **Verified end to end** with `tools/harness.js`: volume proven, record created, fields and links written, second project appended not replaced, repeat pass writes nothing, rename renames, Project File links. All test data deleted afterwards. |
| inside Premiere | **Working** (first load 2026-09-29, UDT, Premiere 26.5.1). Three projects, three clips from Adobe Sandbox; Shade matched the plugin's state exactly. |

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

**Open question:** "Tracker Test.prproj" has two records with two different
GUIDs, the second created at 14:57:31, 4s after the file on disk was
modified. If that was a new project or a Save As under the same name, it's
correct. If Premiere changes `Project.guid` on a routine save or reopen, the
identity key is broken and needs rethinking. Find out which.

## The Shade model

In the **Adobe Sandbox** drive for now
(`72454409-8db3-4aba-86f4-53d3d5948b5a`, workspace *acme. Films*).

| Where | Name | Type | ID | Notes |
|---|---|---|---|---|
| asset field | `Imported?` | bool | `be782155-a89f-4101-9e42-24dc2884d739` | the asset is in a project's bins |
| asset field | `Used?` | bool | `dded2336-ad10-4b63-bdcc-88d5c460b913` | the asset is on a timeline |
| asset field | `Projects Used In` | relation → Projects | `2239d488-117c-4e3e-b24c-cff21a592a66` | appended to, never replaced |
| object | `Projects` | custom object | `d31ed47a-f6b7-4796-bbd4-5db193c9123e` | one record per Premiere project |
| Projects column | `Project GUID` | str | `11968d4d-a1f1-44dc-ab7d-95e3defbea30` | `Project.guid`: the identity key |
| Projects column | `Project File` | relation → asset | `8550ba00-0017-4736-9522-9f92ee6f3aaa` | the `.prproj`, which lives on the drive |

Created 2026-09-29 through the Shade MCP. **Look fields up by name at
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
- **But always visit the project's record.** A pass where no asset changed
  must still check the Projects record on every drive the project has
  touched. Otherwise a rename, or a `.prproj` that has just been indexed,
  waits for some unrelated asset to change. That shipped once and was caught
  by the harness: a renamed project kept its old record name.
- **Missing fields are reported, not created.** Adding columns to someone's
  drive is a person's decision, and a mistyped name in code would quietly
  create a second set. The panel names exactly which field is missing.
- **The Projects object is found through its relation, not by name.**
  `Projects Used In` names its target type, so renaming "Projects" in
  Shade's UI doesn't break anything. The field and column names are the
  contract: `Imported?`, `Used?`, `Projects Used In`, `Project GUID`,
  `Project File`.
- **A project spanning two Shade drives gets a record on each.** Custom
  objects are per drive, and an asset can only link to its own drive's
  records.
- **The API key is the user's own and stays in `uxp.storage.secureStorage`.**
  It has every permission its owner has, so it never goes in the repo, a log
  line or a plain file.

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

- Proxies, relinking, a launcher, search. SHINE has all of these.
- Unsetting `Imported?`/`Used?` when an asset leaves a project.
- Usage hidden inside nested sequences, multicam, Dynamic Link, MOGRTs.
- More than one Shade workspace at once.

## Repo layout

```
CLAUDE.md              this file
docs/shade-endpoints.txt   every documented endpoint, extracted from Shade's docs
tools/harness.js       runs the plugin's sync under Node against REAL Shade,
                       with uxp stubbed. Writes to real assets: use a test
                       GUID, clean up afterwards.
.env                   SHADE_API_KEY=sk_... for the harness. Git-ignored.
plugin/                the UXP plugin. Manifest v5, flat, no build step.
  manifest.json        host is an OBJECT; network: https://api.shade.inc
  main.js              entry: event wiring, API key, panel
  tracker.js           debounce -> scan -> sync
  scan.js              project walk; collapse() is pure and tested
  sync.js              schema lookup, Projects record, asset writes
  plan.js              what to write to one asset. Pure, tested. The rules.
  resolve.js           media path -> Shade asset; proving a volume is a drive
  paths.js             /Volumes/<X>/<rest> <-> /<driveId><rest>. Pure, tested.
  shade.js             REST client: auth header, retries, every route used
  store.js             state.json in the data folder: volumes, records, writes
  log.js               queued log file (from premiere-events)
  test/                node --test
```

## Working conventions

- Repo: `github.com/GrammyMoney/Shade-Tracker` (private), branch `main`.
- Plain JS, no build step. `cd plugin && npm test` for the pure parts;
  `tools/harness.js` for sync against real Shade; everything Premiere-side is
  verified by loading it.
- Keep it small. If a feature needs a local service, it belongs in SHINE.
