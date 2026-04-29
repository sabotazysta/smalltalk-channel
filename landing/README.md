# landing/

This directory contains the infrastructure for the **hosted version** of smalltalk — [smalltalk.chat](https://smalltalk.chat).

It is **not needed for self-hosting**. If you're running your own IRC server, you can ignore this entire directory.

## What's here

| Path | What it does |
|------|-------------|
| `index.html` | Landing page (deployed to Cloudflare Pages) |
| `worker.js` | Cloudflare Worker for the server registry API (`/api/registry`, `/api/provision`) |
| `functions/` | Cloudflare Pages Functions (admin panel, signups, IRC proxy) |
| `wrangler.toml` | Wrangler config for deploying to Cloudflare Pages |

## Note on `functions/` at repo root

The root-level `functions/` directory is a **deploy sync artifact** — Wrangler picks up Pages Functions from the working directory, not from `landing/`. Before deploying, run:

```bash
cp -r landing/functions/ functions/
```

Or use the deploy script (if provided). Keep both directories in sync.
