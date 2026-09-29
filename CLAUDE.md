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

**Phase: setup.** Repo created 2026-09-29. The Shade schema exists in Adobe
Sandbox (below). No plugin code yet.

The custom-object endpoints have been found in the web app's code (see
"Custom-object API"). Next: confirm them live with an `sk_` key.

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
- **Assets are resolved by drive-relative path.** A clip at
  `/Volumes/<drive>/Footage/a.mp4` is `/Footage/a.mp4` on the drive, looked
  up with `GET /assets/path?path=&drive_id=`. Anything outside a Shade mount
  is not ours and is skipped silently: most projects mix Shade media with
  local media, and that is not an error.
- **Relations are read-merge-write, which can lose an append.** Setting a
  relation value replaces it. Two editors adding the same asset to two
  projects at the same moment can each overwrite the other. Acceptable for
  now, because the next scan of either project re-adds its link, and a
  project is never removed. Don't build locking for it.
- **Only write what changed.** Keep what was last written per project in the
  plugin's data folder and diff against it. A scan is cheap (24ms for 129
  items); a Shade write per asset per `DIRTY` would not be.
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
- `GET /assets/path?path=&drive_id=` → `AssetDTO`. The path is
  drive-relative and starts with `/`.
- Webhooks exist (`asset.updated` etc., via a Svix dashboard) but aren't
  needed: the plugin is the only writer of these fields.
- The official SDK is Python only and hasn't been updated since February
  2025. It doesn't cover custom objects.

## Custom-object API (undocumented)

**Read out of the Shade web app's own JavaScript** (`app.shade.inc`,
`main-*.js`, 2026-09-29), because none of it is in Shade's docs. It's the
same API the app uses, so it's real. But it's unpublished and can change
without notice. Treat every shape here as **seen in the bundle, not yet
confirmed with an `sk_` key**, until the live check below is done.

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
  `metadata_values: [{id: <columnId>, ...}]`, and a relation reads back as
  `[{entity_type, id, name, ...}]`. Convert before writing back.
- **Asset values are written in bulk:**
  `PUT /assets/metadata/values` with
  `{drive_id, asset_ids: [...], metadata_attributes: [{id, value, append}]}`.
  **`append: true` exists.** If it works for relation fields, Shade appends a
  project on its side, and the read-merge-write race described in Decisions
  goes away. The other form,
  `{drive_id, asset_ids_with_metadata_attributes: [{asset_id,
  metadata_attributes: [{id, value}]}]}`, is per asset and has no append.
- The web app sends a Firebase user token, not an `sk_` key. **Whether these
  routes accept an `sk_` key is not yet known.** It's the first thing to test.
- There's no "find record by column value" route in the bundle. Finding a
  Project by GUID means listing the type's records and matching locally.
  Cache the GUID → record ID map in the plugin's data folder.

## Unknowns, to settle before writing code

1. ~~Custom-object REST endpoints.~~ Found; see above. Confirm them live with
   an `sk_` key.
2. **Relation value shape on an asset**, and whether `append: true` works for
   relations. Test against one asset with `PUT /assets/metadata/values`.
3. **Mount → drive ID.** Shade mounts drives over SMB from localhost:
   `//GUEST:@shadefs:<port>/<Name>` on `/Volumes/<Name>` (seen:
   `Alex B Sandbox`). UXP can't run `mount`, so the plugin can't discover
   this itself. Likely answer: the panel lists drives from the API and the
   user confirms which `/Volumes/` folder each one is. Verify first whether
   the mount name always equals the drive's display name. If it does, this
   can be automatic.
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

## Working conventions

- Repo: `github.com/GrammyMoney/Shade-Tracker` (private), branch `main`.
- Plain JS, no build step. Node's `--test` for the pure parts (path mapping,
  collapse, diff); everything else is verified by loading it in Premiere.
- Keep it small. If a feature needs a local service, it belongs in SHINE.
