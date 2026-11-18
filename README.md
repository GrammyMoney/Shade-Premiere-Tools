# Shade Premiere Tools

A Premiere Pro panel (UXP) for media on mounted Shade drives. Three
features, each switched on or off in the panel's **Settings** tab:

| Feature | Default | What it does |
|---|---|---|
| **Auto-pinning** | on | Offers to pin a project's Shade media when you open it (how many files, how much data, what's already pinned), offers to unpin it when you close it, and pins new clips. One picker: **Off**, **Pin clips on import** (default) or **Pin clips when used in a timeline**. On a timeline, the open prompt counts timeline media only. **pin project** / **unpin project** ask on demand. |
| **Project tracking** | off | Writes into Shade's metadata: **Imported?** (in at least one project), **Used?** (on a timeline; never unset), and **Projects Used In**, a link to the project's record in the **Premiere Projects** object. |
| **Proxy linking** | off | A clip whose `Linked Proxy` is set gets that proxy attached on import; a proxy imported alone gets its `Linked Hi Res` attached. |
| **Export** | button | The purple **Export to Shade** button renders the open timeline as a light MP4 (source resolution and frame rate) into a folder you pick on the project's Shade drive, named `<Project>_<Timeline>_V01.mp4`. Each later export becomes the next version in the same Shade stack, and the project's Premiere Projects record lists the newest version of each timeline under **Exports**. Each export also keeps a copy of the timeline as it was, `<Timeline>_V03`, in a **Shade Versions** bin, linked to that version: import comments there for that version's notes on that cut, or export it to continue the same stack. |
| **Comments** | button / ask | **import comments** puts the newest version's Shade comments as purple markers on your working timeline, and each version's on its own `<Timeline>_V03` timeline in Shade Versions; running it again adds only new ones. Export clears the Shade comment markers from the working timeline (yours stay), ready for the new version's. Comments on clips you import can become clip markers too: you're asked, with "Do this every time". |

Auto-pinning needs Shade Desktop running; tracking and linking also need
your Shade API key (Settings tab). Premiere doesn't let plugins act when it
quits, so quitting doesn't ask to unpin.

Project tracking only covers media on the drive the project is saved on.
Shade clips from another drive aren't tracked, and the panel says so once.

**Switching tracking or linking on checks the open project's drive** for
the fields that feature uses. If any are missing, a dialog lists exactly
what it will add and asks first: the fields are visible to everyone on the
drive, and Shade can archive a field but not delete it. Say no and the
feature stays off. Adding fields needs an account that can; otherwise a
drive owner does it once.

This replaces **Shade Linker**. Uninstall it, so clips aren't handled twice.

## Install

Build the installer, then double-click it (Creative Cloud installs it for
Premiere; restart Premiere afterwards):
```
./scripts/package-ccx.sh      # -> dist/com.grammymoney.shadepremieretools_premierepro.ccx
```
The `.ccx` is what you hand to an editor. It is not signed or listed on
Adobe Exchange, so Creative Cloud may warn that it is from an unknown
developer.

For development, load `plugin/manifest.json` in the UXP Developer Tool
instead. Don't have both at once: they share a plugin id.

## Setup

1. Install the panel (above).
2. In Premiere: **Window → UXP Plugins → Shade Premiere Tools**, then **Settings**.
3. For tracking or linking: paste your API key (Shade → Settings → My
   account → API keys), **save**, and tick the feature with a project on
   the drive open. If the drive needs fields, you're asked first.

A drive can also be prepared from Terminal (safe to re-run; `--check` only
reports):
```
node cli/spt.js key
node cli/spt.js setup --drive "Drive Name"             # tracking
node cli/spt.js setup --drive "Drive Name" --linking   # proxy linking
```
Tracking creates the **Premiere Projects** object (`Project GUID`,
`Project File`) and the asset fields `Imported?`, `Used?`, `Project Media`,
and a two-way `Projects Used In` that gives Premiere Projects an **Assets**
column. A drive's own object called "Projects" is never used. Linking
creates `Linked Proxy` and `Linked Hi Res`, one-way relations to assets, and
an active, manually triggered automation **Make SPT Proxies** that fills
them: run it in Shade on video clips and it makes a 1080p proxy in a
`proxies` folder next to each clip and links the two. It's skipped if an
automation with that name already exists. The plugin never runs it.

## Without the panel: the CLI

For editors who don't have the panel, `cli/` reads saved `.prproj` files on a
Shade drive and does the same tracking, on a timer. It uses the panel's own
sync code, so the two never duplicate or undo each other: the panel is live,
the CLI catches up on the last save.

```
node cli/spt.js run --drive "Adobe Sandbox"          # one pass
node cli/spt.js install --drive "Adobe Sandbox"      # every 15 min (--every N)
node cli/spt.js status
node cli/spt.js uninstall
```

Needs Node 20+; no mount required. Uses the key stored by `key` above. Its
log lives in
`~/Library/Application Support/Shade Premiere Tools CLI/`.

## Development

```
cd plugin && npm test                 # pure logic
cd cli && npm test                    # parser
node tools/harness.js scan.json       # sync against REAL Shade, no Premiere
```

The harness reads `SHADE_API_KEY` from `.env` (git-ignored) and writes to
real assets. See `CLAUDE.md` for everything else.
