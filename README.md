# Shade Tracker

A Premiere Pro panel (UXP) that reports which Shade assets each Premiere
project has imported and used, directly into Shade's metadata:

- **Imported?** — the asset is in a project
- **Used?** — the asset is on a timeline
- **Projects Used In** — links to a **Projects** custom-object record per
  Premiere project

No local service: the plugin talks to `api.shade.inc` with your own API key.

Status: setup. See `CLAUDE.md` for the design and what's still unknown.
