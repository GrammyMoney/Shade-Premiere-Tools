# Shade Linker -- project context

A Premiere Pro panel (UXP) that does two things for media on mounted Shade
drives: **proxy linking** and **auto-pinning**. Nothing else. Read the whole
file before changing anything: most of it is decisions already made and the
reasons behind them.

**Branch `linker-only` of Shade Premiere Tools (SPT)**, made 2026-11-18 by
cutting SPT down: project tracking (Imported?/Used?/Projects Used In, the
Premiere Projects object), the CLI, Export with version stacks and version
timelines, and Shade comments as markers are all gone. The linking and
pinning code is SPT's, unchanged. SPT itself lives on `main` /
`linker-and-project-pins`; its CLAUDE.md there holds the history of
everything removed.

**Plugin id `com.grammymoney.shadelinker`, name "Shade Linker", panel
`shadeLinkerPanel`, version 0.2.0** (decided 2026-11-18). That id and
panel id are the older Shade-Linker repo's plugin (0.1.0), taken over on
purpose: installing this upgrades it in place, so editors have one Shade
Linker, not two plugins of the same name. Briefly called "SPT Lite"
before the first release; "Lite" was dropped as the wrong message. The
automation keeps the name "Make SPT Proxies": it's the standard shared
with SPT, and renaming it would make a second one on drives that have it.
Shade Linker can be installed beside SPT (different ids), but **don't
enable both**: each would link and pin the same clips and both would ask
about pinning.

## What it does

1. **Proxy linking** (off by default). A Shade clip imported into a project
   gets the other half of its pair attached in Premiere: a hi-res whose
   `Linked Proxy` is set gets that proxy, a proxy whose `Linked Hi Res` is
   set gets its hi-res. Needs the editor's Shade API key.
2. **Auto-pinning** (on by default; one Settings picker: Off / Pin clips on
   import / Pin clips when used in a timeline). New Shade clips are pinned
   in Shade Desktop so they stay local. Opening a project **asks** whether
   to pin its Shade media; closing one **asks** whether to unpin it. Needs
   Shade Desktop running; no API key.
3. **Setup through the API, only when asked.** Switching linking on checks
   the open project's drive for `Linked Proxy`, `Linked Hi Res` (one-way
   relations to assets) and the automation **"Make SPT Proxies"** that fills
   them. Anything missing is listed in a dialog and created only on "Set Up".

There is no local service, no database and no CLI. The plugin talks to
`https://api.shade.inc` and to Shade Desktop's bridge
(`ws://localhost:19876`).

The panel: a status line and lamp, counters (Shade drives mounted, proxies
linked, files pinned, failed), the last clip handled, **get logs**, **pin
project** / **unpin project**, and a Settings tab (auto-pinning picker, proxy
linking checkbox, API key).

## Current state (2026-11-18)

| part | state |
|------|-------|
| linking + pinning code | SPT's, unchanged except the source-comments hook was removed from `link.js`. Linking worked in Premiere under Shade-Linker. |
| timeline pinning (`pinWhen`) | Unit-tested with Premiere faked; *unverified in Premiere*, as is `sp-picker`. |
| setup (fields + automation) | Unit-tested against stubbed REST; *unverified against real Shade* (the automation create). |
| `enable.js` drive lookup | Now from Shade Desktop's mount table (SPT used tracking's resolver). *Unverified in Premiere.* |
| as a plugin | Loads under Node with Premiere stubbed, packages cleanly. **Not yet loaded in Premiere.** |
| `tools/pins-harness.js` | Not re-run on this branch: Shade Desktop wasn't running. |

## Decisions (and why)

- **UXP, never CEP/ExtendScript.** Adobe ends ExtendScript for Premiere in
  September 2026. `require("premierepro")`, promise-based.
- **Two features, each a Settings toggle** (`settings.js`, `settings.json`
  in the data folder): `autoPin` (on) + `pinWhen` (`"import"` |
  `"timeline"`), and `linking` (off, because it needs fields everyone on
  the drive sees). Off means no event does anything for that feature;
  switching one off undoes nothing. Auto-pinning without linking pins new
  clips straight from the mount with no Shade request. Unknown saved keys
  (SPT's `tracking`, `sourceComments`) are dropped on load.
- **Setup never runs silently** (`enable.js` + `setup.js`). Fields every
  user of a drive sees are a person's decision, and Shade can only archive
  a field, never delete one. Switching linking on checks the active
  project's drive; if anything is missing a dialog lists it ("Set Up" /
  "Not Now"). Declined, a conflict, or a 401/403 ("ask a drive owner"): the
  toggle goes back off. A drive met later (another project, or `link.js`
  finding no link fields) gets the same dialog once per drive per session.
  Setup is idempotent, creates only what's absent, never modifies or
  removes, and reports a same-named field of the wrong type as a conflict.
- **Link fields are one-way on purpose**, so neither fills in the other.
  Looked up by name at runtime and re-read every 10 minutes (a panel runs
  for days; a field replaced under it must not keep receiving lookups by a
  stale id).
- **Which drive a file is on comes from Shade Desktop's mount table**
  (`shadefs.mounts()` → `mounts.locate`), never from guessing
  `/Volumes/<drive name>`: names go stale (Adobe Sandbox was renamed
  "Adobo Sandbox" while still mounted as `/Volumes/Adobe Sandbox`).
  A dialog names a drive by its mount folder.
- **Pinning a whole project is asked, never automatic**, because a real
  media pool is terabytes. Unpinning is asked too (below).
- **Only new arrivals are acted on automatically.** A project is seeded the
  first time it is seen this session: everything already in it (or on its
  timelines) is marked seen and left alone. The open prompt is how a whole
  project gets pinned.
- **Nothing is saved between sessions** except `settings.json`. A fresh
  launch re-seeds from what is in the project.
- **The API key is the user's own and stays in `uxp.storage.secureStorage`.**
  It has every permission its owner has, so it never goes in the repo, a log
  line or a plain file. A key saved by SPT doesn't carry over (different
  plugin id): enter it again.

## Proxy linking and project pinning

Added to Shade Premiere Tools 2026-10-14 by folding Shade-Linker in, and
carried here unchanged.

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
  - **Asked, never automatic**, because a real media pool is terabytes.
    The panel's **pin project** asks again on demand.
- **When a new clip is pinned: on import, or when used in a timeline**
  (setting `pinWhen`, `"import"` default | `"timeline"`; added 2026-10-27).
  **One picker in Settings, Off / Pin clips on import / Pin clips when used
  in a timeline**, over the two stored settings `autoPin` + `pinWhen`
  (`main.js` `setPinMode`/`pinModeOf`; Off keeps `pinWhen`). A checkbox
  plus a separate picker read as two unrelated settings. On a timeline: an import pins nothing
  (linking still attaches); the debounced DIRTY walk in `link.js` also
  lists every sequence's clip items (`walk.walkSequences`) and pins media +
  attached proxy for items not on a timeline before, skipping files the pin
  list already has. What is on a timeline when a project is first seen, or
  when `autoPin`/`pinWhen` changes, is left alone (same rule as imports).
  The open prompt then counts **timeline media only** ("Number of assets on
  its timelines"), since unused bin media is what this mode leaves unpinned.
  Direct timeline use only: nested sequences and multicam can
  hide a clip. Unit-tested with Premiere faked (`test/link-timeline.test.js`);
  *unverified in Premiere*, as is `sp-picker` itself.
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
- **Module layout**: `walk.js` (active project, clip items, timeline walk) and
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
- `GET /workspaces/drives/{drive_id}/metadata`: the field schema (system
  and custom). Link fields are found **by name** here, never by hard-coded id.
- `POST /workspaces/drives/{d}/metadata/assets/columns` with `{columns:
  [{column_name, column_type: "relation", relation_config: {target: {kind:
  "asset"}}}]}` creates asset fields (undocumented; read out of Shade's web
  app, confirmed with an `sk_` key). Not retried: setup re-checks first.
- Custom values (`Linked Proxy` etc.) are on `GET /assets/{id}?drive_id=`
  under `custom_metadata`, keyed by field id. `GET /assets/{id}/metadata`
  returns **only system fields**, despite its name.
- `GET /assets/path?path=&drive_id=` → `AssetDTO`. **The path must start
  with the drive's ID**: `/<driveId>/Graphic Design/a.mov`. The
  drive-relative `/Graphic Design/a.mov` that the docs imply returns `404
  Asset not found`. Every `path` Shade returns carries the same prefix.
  **Lookup is case-sensitive** (a lower-cased path 404s), so pass the exact
  spelling on disk, which is what Premiere reports.
- **Shade intermittently returns `503` on writes** (about half, for a
  stretch on 2026-09-29; reads kept working). A failed write left nothing
  behind, so `shade.js` retries idempotent calls; a create is never retried.

## Automations API (documented)

Found 2026-10-26 at `academy.shade.inc/developers/automate/automations.md`
(newer than `docs/shade-endpoints.txt`, which doesn't list it). Same auth
(`Authorization: sk_...`). This is what the Shade MCP's `manage_automations`
wraps; its `get` of "Proxy + Relational Link" returned exactly these shapes.

```
GET    /automations/integrations?workspace_id=&drive_id=   catalog (triggers/actions + schemas)
GET    /automations?drive_id=                              list
POST   /automations  {name, drive_id, description?}        create -> v1 DRAFT
GET    /automations/{id}                                   active/latest version + versions[]
PUT    /automations/{id}  {name, viewport{x,y,zoom}, nodes[], edges[], description?}
                                                           whole-graph replace; saving an ACTIVE
                                                           version makes a new DRAFT
PATCH  /automations/{id}/versions/{v}/status  {status}     DRAFT | ACTIVE | BROKEN
GET    /automations/{id}/versions/{v}
DELETE /automations/{id}                                   -> 204
POST   /automations/{id}/executions  {selection, inputs?}  run now: selection
         {type:"asset", asset_ids:[...]} or {type:"directory", paths:[...]}, 1-1000
GET    /automations/{id}/executions?page=&page_size=
GET    /automations/{id}/executions/form                   inputs_schema or null
```

- **Node:** `{id, node_type: TRIGGER|ACTION|CONDITION, integration_id,
  operation, label, config, position_x, position_y}`. **Edge:** `{id,
  source_node_id, target_node_id, output_key}`. **Node ids are required on
  PUT**, so a client mints its own UUIDs and can write templates like
  `{{<triggerId>.asset.directory}}/proxies` in one save. (The MCP generates
  them itself, which is why building through the MCP needed two saves.)
- **The MCP's `list_integrations` 422** ("workspace_id: Field required") is
  the MCP not passing `workspace_id`; the REST route takes it.
- "Proxy + Relational Link" on Adobe Sandbox, as read 2026-10-26: SHADE
  `manually_triggered` → SHADE `generate_proxy` (`asset`, `preset:
  h264_1080p`, `destination_folder: {{trigger.asset.directory}}/proxies`) →
  SHADE `update_asset_metadata` on the trigger asset (`Linked Proxy` =
  `[{id: {{proxyNode.asset.id}}, type: asset}]`) → the same on the proxy
  asset (`Linked Hi Res` = the trigger asset).
- **Setup creates "Make SPT Proxies"** (decided 2026-10-26 in Shade
  Premiere Tools, name kept so the two plugins share one automation per
  drive; `proxyflow.js` + `setup.setupProxyAutomation`): the layout above, with
  node ids minted by the plugin, the drive's own Linked Proxy / Hi Res ids,
  and the integration id read from the catalog (the one offering
  `manually_triggered`, `generate_proxy`, `update_asset_metadata`; a
  CONFLICT if none does). Create, then PUT, then PATCH the newest version
  ACTIVE; any failure after create deletes it, so a half-made DRAFT never
  holds the name. **The name is the standard:** an automation called exactly
  "Make SPT Proxies" is left alone whatever it does or its status (a WARN if
  not ACTIVE); a similar one under another name ("Proxy + Relational Link")
  doesn't count. **The plugin never runs it**: manual trigger, run from
  Shade. Linking is "ready" only with the fields and the automation, so
  Adobe Sandbox will be asked to add just the automation. Unit-tested
  against stubbed REST; *unverified* against real Shade (which of
  `metadata` object vs JSON string the API wants; the trigger's config).

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
  signal. Debounce 2s so edits can settle (not for cost; a walk is ~24ms),
  then walk everything and diff.
- **`IMPORT_MEDIA_COMPLETE` fires before the new item is queryable.** The
  item appears 100–217ms later. Wait about 400ms before scanning, or the scan
  finds nothing.
- **Don't bind `SequenceEvent.SELECTION_CHANGED`.** It fired 11 times a
  minute and tells us nothing.
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
  `https://api.shade.inc` and `ws://localhost:19876` explicitly.
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

Project tracking, Export, comments as markers, the CLI (all in SPT);
relinking, search (SHINE); unpinning at quit (Premiere gives no chance);
usage hidden inside nested sequences, multicam, Dynamic Link, MOGRTs.

## Repo layout

```
scripts/package-ccx.sh build the installable .ccx into dist/ (bash 3.2)
CLAUDE.md              this file
docs/shade-endpoints.txt   every documented endpoint, extracted from Shade's docs
tools/pins-harness.js  project pinning + import linking under Node: REAL bridge
                       (read-only) and real files on a mount; REST, dialogs and
                       pin/unpin stubbed. Changes nothing.
plugin/                the UXP plugin. Manifest v5, flat, no build step.
  manifest.json        host is an OBJECT; network: https://api.shade.inc, ws://localhost:19876
  main.js              entry: event wiring, API key, panel
  link.js              new clip -> Linked Proxy/Hi Res -> attach -> pin; timeline pinning
  projectpins.js       ask to pin a project on open; ask to unpin on close / button
  enable.js            switching linking on: check the drive, ask, create
  setup.js             Linked Proxy / Linked Hi Res + "Make SPT Proxies", or report
  proxyflow.js         the automation graph. Pure, tested
  settings.js          autoPin, pinWhen, linking; settings.json
  dialog.js            yes/no modal (uxpShowModal), one at a time
  walk.js              active project, clip items, timeline walk
  shadefs.js           this Mac's Shade: mounts, inode+size, pin list, pin/unpin
  bridge.js            Shade Desktop's ws://localhost:19876
  mounts.js            bridge mount table <-> paths. Pure, tested
  pins.js              link/pin rules, pin-list parsing, prompt numbers. Pure, tested
  shade.js             REST client: auth header, retries, the routes used
  platform.js          file I/O and the data folder (UXP; swapped in tests)
  log.js               queued log file, shade-linker.log
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
  `linker-only`. Fixes to linking or pinning made here likely belong on
  SPT's branch too: the files are the same.
- Plain JS, no build step. `cd plugin && npm test` for the pure parts
  (`node --test test/*.test.js`: Node 24 rejects a bare directory);
  `node tools/pins-harness.js` with Shade Desktop running; everything
  Premiere-side is verified by loading it.
- Keep it small. A feature that isn't linking or pinning belongs in SPT.
