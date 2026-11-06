# uwuMaps

Explore cities in colourful 3D and find your way on foot, by bike or by car. Live at
[maps.uwuapps.org](https://maps.uwuapps.org).

| Folder | What |
| --- | --- |
| `main-site/` | The PWA and its API routes. Vercel serves this folder. See its [README](main-site/README.md). |
| `android/` | The Android app, native in Flutter, not a WebView. See its [README](android/README.md). |
| `release/` | The Android APKs, and how to publish one. See its [README](release/README.md). |
| `announcement/` | Each release's notes and announcement. |
| `tools/` | Builds offline packs (`tools/packs/`) and refreshes the public transport snapshots (`tools/vendor-transit.mjs`). |
| `migrations/` | SQL to run once each, in order, in the Supabase SQL editor. Never edited after: changes go in a new file. |
| `tests/` | Playwright tests and checks against real Singapore data. |
| `docs/` | The specs the app follows. |
| `.github/workflows/offline-packs.yml` | Builds every region's pack monthly and publishes it to a GitHub release. |

## Setting up

1. Run `migrations/0001_uwumaps_share_links.sql`, then `0002_uwumaps_sync.sql`, in the Supabase SQL
   editor.
2. In Vercel, set the project's root directory to `main-site`, and add the variables in
   `main-site/.env.example`. Add `maps.uwuapps.org` as its domain.
3. Build the packs: Actions, Offline packs, Run workflow. To try it on one region first, enter
   `singapore` under "Regions to build". Packs show as "Not ready yet" in the app until this has run.

Without Supabase the app still works, with long share links and no sync.

## How offline packs work

A pack is four files on the `offline-packs` release, built per region from `main-site/js/pack-list.js`:

| File | Made by | Holds |
| --- | --- | --- |
| `base` | Planetiler's OpenMapTiles profile | The map, drawn by OpenFreeMap's styles |
| `buildings` | `tools/packs/extract-buildings.mjs` | Overture Maps' 3D buildings, reduced to what's drawn |
| `route` | `tools/packs/compile-graph.mjs` | The road graph for walking, cycling and driving |
| `search` | `tools/packs/compile-graph.mjs` | Places and streets |

GitHub's downloads send no CORS headers, so the app fetches pack files through `/api/mappack`, 4 MiB
at a time, into the Cache API. To add a region, add it to `pack-list.js` and run the workflow.

## Refreshing public transport data

Singapore's and Malaysia's stations, lines and stops are snapshots in `main-site/data/`, so those layers
work offline. They rarely change. To refresh them, with an sgbus-timings clone beside this repository:

```sh
node tools/vendor-transit.mjs
```

Then bump `CACHE_VERSION` in `main-site/sw.js`.

## Testing

```sh
cd tests
npm install
npx playwright install chromium
node build-fixture.mjs             # A real Singapore pack, 42 MB. Run once.
npx playwright test --config playwright.config.mjs
node unit/migrations-check.mjs     # The migrations, on a real Postgres
node unit/decode-check.mjs         # The live feed decoder, on made-up and real feeds
node unit/route-check.mjs .fixture/singapore.route
```

The Android app has its own, in `tests/flutter/` and `android/test/`: see [its README](android/README.md#testing).

The tests run the site on `tests/dev-server.mjs`, which stands in for Vercel, Supabase and the GitHub
release, so they need no accounts. They do need the internet for Overture, OpenFreeMap and the like.
