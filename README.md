# Shade Tracker

A Premiere Pro panel (UXP) that reports which Shade assets each Premiere
project has imported and used, directly into Shade's metadata:

- **Imported?** — the asset is in at least one project
- **Used?** — the asset is on a timeline in at least one project (never unset)
- **Projects Used In** — links to a **Projects** custom-object record per
  Premiere project (linked on import)

No local service: the plugin talks to `api.shade.inc` with your own API key.
Only media on a mounted Shade drive (`/Volumes/<drive name>/...`) is tracked.

## Setup

1. The drive needs these fields (they exist on Adobe Sandbox already):
   asset fields `Imported?` (yes/no), `Used?` (yes/no), `Projects Used In`
   (relation to a custom object), and that custom object needs a
   `Project GUID` text column and optionally a `Project File` relation to
   assets. The panel says exactly what's missing.
2. In the UXP Developer Tool: **Add Plugin** → `plugin/manifest.json` →
   **Load**.
3. In Premiere: **Window → UXP Plugins → Shade Tracker**, paste your API key
   (Shade → Settings → My account → API keys), **save**.

## Development

```
cd plugin && npm test                 # pure logic
node tools/harness.js scan.json       # sync against REAL Shade, no Premiere
```

The harness reads `SHADE_API_KEY` from `.env` (git-ignored) and writes to
real assets. See `CLAUDE.md` for everything else.
