# main-site

uwuMaps' site: static HTML, CSS and ES modules with no build step, plus Vercel Functions in `api/`.

**Bump `CACHE_VERSION` in `sw.js` on every change to anything it caches.** That is what makes an update
reach anybody.

## The page

| File | What |
| --- | --- |
| `index.html` | The one page. Its pre-paint script sets the theme and the tray before first paint. |
| `style.css` | The theme (`docs/uwuapps-theme.md`), the update bar, the app, then the Edge Tray. |
| `script.js` | The start, and the wiring between the modules below. |
| `sw.js` | Offline: the app and everything it ships, tiles seen before, the font. |
| `js/map.js` | MapLibre, its styles, and answering tile requests through the `uwu://` protocol. |
| `js/buildings.js` | The coloured 3D buildings' layers. |
| `js/transit.js` | Singapore's and Malaysia's public transport, live vehicles and the Layers sheet. |
| `js/packs.js`, `js/pack-read.js` | Downloading offline packs and reading them back from the Cache API. |
| `js/pack-list.js` | The regions there are. The one list. |
| `js/route-core.js`, `js/route-worker.js` | The offline router, and the worker it runs in. |
| `js/route-client.js` | Picks between the offline router and the online server. Walking in Singapore uses our own graph either way, for its void decks. |
| `js/directions.js`, `js/nav.js` | The directions panel, and live navigation. |
| `js/you.js` | You on the map: following you, the compass, your speed, the zoom buttons and the tilt handle. |
| `js/search.js` | Search: saved, public transport, offline packs, then online. |
| `js/places.js` | Saved places, the place card and sync. |
| `js/share.js` | Share links, live ETAs, and opening what somebody shared. |
| `js/nearby.js`, `js/p2p.js` | Sending to a device nearby, by QR code or by code (`docs/STUN-p2p-spec.md`). |
| `js/scanner.js` | Scanning a QR code with the camera. |
| `js/update.js` | The service worker and the update bar (`docs/update-bar-spec.md`). |
| `js/tray.js` | The Edge Tray (`docs/edge-tray-spec.md`). |
| `js/theme.js`, `js/icons.js`, `js/ui.js` | The theme system, SVG icons and small helpers. |
| `data/` | Public transport snapshots, from `tools/vendor-transit.mjs`. |
| `map/` | OpenFreeMap's styles, sprites and fonts, kept here so the map draws offline. |
| `vendor/` | MapLibre, PMTiles, PeerJS (with its public TURN relay removed), a QR code library and jsQR to read them. |

## The API

| Route | What |
| --- | --- |
| `api/mappack.js` | Offline packs from the GitHub release, in 4 MiB pieces. |
| `api/overture.js` | Which Overture release to read online buildings from. |
| `api/my-live.js` | Malaysia's live trains and buses, decoded from data.gov.my's GTFS-realtime feeds. |
| `api/share.js` | Makes, reads and updates share links. |
| `api/share-page.js` | The page behind `/go/`, `/trip/`, `/eta/` and `/list/`, for link previews. |
| `api/share-map.js` | A link's map picture. |
| `api/sync.js` | Saved places sync. |

Environment variables are in `.env.example`, and the SQL they need is in `../migrations/`.

## Where things come from

- Map: [OpenFreeMap](https://openfreemap.org), OpenMapTiles, [OpenStreetMap](https://www.openstreetmap.org/copyright).
- Buildings: [Overture Maps](https://overturemaps.org), under ODbL.
- Singapore rail: [cheeaun/sgraildata](https://github.com/cheeaun/sgraildata), through SG Bus Timings. Bus
  stops are LTA's and door positions SG Bus Timings', both through its public API.
- Malaysia: [data.gov.my](https://developer.data.gov.my/realtime-api/gtfs-realtime).
- Online search: [Photon](https://photon.komoot.io). Online routes: FOSSGIS's OSRM servers at
  routing.openstreetmap.de.
- Which blocks have void decks: HDB Property Information on [data.gov.sg](https://data.gov.sg), under the Singapore
  Open Data Licence.
