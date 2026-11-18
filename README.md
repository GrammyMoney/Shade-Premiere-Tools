# Shade Linker

A Premiere Pro panel (UXP) for media on mounted Shade drives. It does two
things, each switched on or off in the panel's **Settings** tab:

| Feature | Default | What it does |
|---|---|---|
| **Auto-pinning** | on | Offers to pin a project's Shade media when you open it (how many files, how much data, what's already pinned), offers to unpin it when you close it, and pins new clips. One picker: **Off**, **Pin clips on import** (default) or **Pin clips when used in a timeline**. On a timeline, the open prompt counts timeline media only. **pin project** / **unpin project** ask on demand. |
| **Proxy linking** | off | A clip whose `Linked Proxy` is set gets that proxy attached on import; a proxy imported alone gets its `Linked Hi Res` attached. Both files are pinned. |

Auto-pinning needs Shade Desktop running. Linking also needs your Shade API
key (Settings tab). Premiere doesn't let plugins act when it quits, so
quitting doesn't ask to unpin.

**Switching linking on checks the open project's drive** for `Linked
Proxy`, `Linked Hi Res` and the **Make SPT Proxies** automation. If any is
missing, a dialog lists exactly what it will add and asks first: the fields
are visible to everyone on the drive, and Shade can archive a field but not
delete it. Say no and linking stays off. Adding fields needs an account
that can; otherwise a drive owner does it once.

The fields are one-way relations to assets. **Make SPT Proxies** is an
active, manually triggered automation: run it in Shade on video clips and
it makes a 1080p proxy in a `proxies` folder next to each clip and links
the two. It's skipped if an automation with that name already exists. The
plugin never runs it.

This is the linking-and-pinning part of **Shade Premiere Tools**, on its
own. It has its own plugin id, so both can be installed, but **enable only
one**: otherwise clips are linked and pinned twice and both panels ask.

Version 0.2.0 replaces the earlier Shade Linker (0.1.0): same plugin id, so
installing it upgrades that one in place.

## Install

Build the installer, then double-click it (Creative Cloud installs it for
Premiere; restart Premiere afterwards):
```
./scripts/package-ccx.sh      # -> dist/com.grammymoney.shadelinker_premierepro.ccx
```
It is not signed or listed on Adobe Exchange, so Creative Cloud may warn
that it is from an unknown developer.

For development, load `plugin/manifest.json` in the UXP Developer Tool
instead. Don't have both at once: they share a plugin id.

## Setup

1. Install the panel (above).
2. In Premiere: **Window → UXP Plugins → Shade Linker**, then **Settings**.
3. For linking: paste your API key (Shade → Settings → My account → API
   keys), **save**, and tick **Proxy linking** with a project on the drive
   open. If the drive needs anything, you're asked first.

## Development

```
cd plugin && npm test                 # pure logic
node tools/pins-harness.js            # pinning + linking against the real bridge (read-only)
```

See `CLAUDE.md` for everything else.
