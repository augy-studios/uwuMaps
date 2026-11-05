// The offline packs there are: the one list. Read by the app (js/packs.js), by /api/mappack, which
// won't hand out anything not named here, and by .github/workflows/offline-packs.yml, which builds
// one pack per entry. To add a region, add it here.
//
// bounds: west, south, east, north. The pack stops there, whatever the extract holds.
// sources: ways of getting the region's OpenStreetMap data, tried in turn. Files on one line are
// merged. Each needs a .md5 beside it.

const GEO = "https://download.geofabrik.de";
const FR = "https://download.openstreetmap.fr/extracts";
const id = (...names) => names.map((n) => `${FR}/asia/indonesia/${n}.osm.pbf`).join(" ");

export const PACKS = [
  { id: "singapore", name: "Singapore", region: "Asia", bounds: [103.59, 1.15, 104.1, 1.48],
    sources: [`${FR}/asia/singapore.osm.pbf`, `${GEO}/asia/malaysia-singapore-brunei-latest.osm.pbf`] },
  { id: "malaysia", name: "Malaysia, Singapore and Brunei", region: "Asia", bounds: [99.0, 0.7, 119.5, 7.6],
    sources: [`${GEO}/asia/malaysia-singapore-brunei-latest.osm.pbf`, `${FR}/asia/malaysia.osm.pbf ${FR}/asia/singapore.osm.pbf ${FR}/asia/brunei.osm.pbf`] },
  { id: "taiwan", name: "Taiwan", region: "Asia", bounds: [118.1, 21.7, 122.1, 26.5], sources: [`${GEO}/asia/taiwan-latest.osm.pbf`] },
  { id: "hong-kong", name: "Hong Kong", region: "Asia", bounds: [113.8, 22.1, 114.5, 22.6], sources: [`${FR}/asia/china/hong_kong.osm.pbf`] },
  { id: "thailand", name: "Thailand", region: "Asia", bounds: [97.2, 5.5, 105.8, 20.6], sources: [`${GEO}/asia/thailand-latest.osm.pbf`] },
  { id: "south-korea", name: "South Korea", region: "Asia", bounds: [124.5, 33.0, 131.0, 38.7], sources: [`${GEO}/asia/south-korea-latest.osm.pbf`] },
  { id: "japan", name: "Japan", region: "Asia", bounds: [122.9, 24.0, 146.0, 45.6], sources: [`${GEO}/asia/japan-latest.osm.pbf`, `${FR}/asia/japan.osm.pbf`] },
  { id: "java", name: "Java", region: "Asia", bounds: [105.0, -8.9, 116.3, -5.0],
    sources: [`${GEO}/asia/indonesia/java-latest.osm.pbf`, id("banten", "jakarta", "west_java", "central_java", "yogyakarta", "east_java")] },
  { id: "sumatra", name: "Sumatra", region: "Asia", bounds: [94.9, -6.2, 109.3, 6.1],
    sources: [`${GEO}/asia/indonesia/sumatra-latest.osm.pbf`, id("aceh", "north_sumatra", "west_sumatra", "riau", "riau_islands", "jambi", "bengkulu", "south_sumatra", "bangka_belitung_islands", "lampung")] },
  { id: "kalimantan", name: "Kalimantan", region: "Asia", bounds: [108.5, -4.3, 119.1, 4.5],
    sources: [`${GEO}/asia/indonesia/kalimantan-latest.osm.pbf`, id("west_kalimantan", "central_kalimantan", "south_kalimantan", "east_kalimantan", "north_kalimantan")] },
  { id: "sulawesi", name: "Sulawesi", region: "Asia", bounds: [118.7, -7.6, 127.0, 5.6],
    sources: [`${GEO}/asia/indonesia/sulawesi-latest.osm.pbf`, id("north_sulawesi", "gorontalo", "central_sulawesi", "west_sulawesi", "south_sulawesi", "southeast_sulawesi")] },
  { id: "bali-nusa-tenggara", name: "Bali and Nusa Tenggara", region: "Asia", bounds: [114.3, -11.1, 125.3, -7.9],
    sources: [`${GEO}/asia/indonesia/nusa-tenggara-latest.osm.pbf`, id("bali", "west_nusa_tenggara", "east_nusa_tenggara")] },
  { id: "maluku", name: "Maluku", region: "Asia", bounds: [124.2, -8.4, 135.8, 3.0],
    sources: [`${GEO}/asia/indonesia/maluku-latest.osm.pbf`, id("maluku", "north_maluku")] },
  { id: "papua", name: "Papua", region: "Asia", bounds: [129.3, -9.2, 141.1, 1.2],
    sources: [`${GEO}/asia/indonesia/papua-latest.osm.pbf`, id("papua", "west_papua", "southwest_papua", "central_papua", "highland_papua", "south_papua")] },
  { id: "philippines", name: "Philippines", region: "Asia", bounds: [116.8, 4.5, 126.8, 21.2], sources: [`${GEO}/asia/philippines-latest.osm.pbf`, `${FR}/asia/philippines.osm.pbf`] },
  { id: "vietnam", name: "Vietnam", region: "Asia", bounds: [102.0, 8.3, 109.6, 23.5], sources: [`${GEO}/asia/vietnam-latest.osm.pbf`] },
  { id: "greater-london", name: "Greater London", region: "Europe", bounds: [-0.56, 51.25, 0.34, 51.72],
    sources: [`${GEO}/europe/united-kingdom/england/greater-london-latest.osm.pbf`, `${FR}/europe/united_kingdom/england/greater_london.osm.pbf`] },
  { id: "ile-de-france", name: "Paris and Ile-de-France", region: "Europe", bounds: [1.4, 48.1, 3.6, 49.25],
    sources: [`${GEO}/europe/france/ile-de-france-latest.osm.pbf`, `${FR}/europe/france/ile_de_france.osm.pbf`] },
  { id: "netherlands", name: "Netherlands", region: "Europe", bounds: [3.2, 50.7, 7.3, 53.7], sources: [`${GEO}/europe/netherlands-latest.osm.pbf`, `${FR}/europe/netherlands.osm.pbf`] },
  { id: "catalonia", name: "Catalonia", region: "Europe", bounds: [0.15, 40.5, 3.35, 42.9], sources: [`${GEO}/europe/spain/cataluna-latest.osm.pbf`, `${FR}/europe/spain/catalunya.osm.pbf`] },
  { id: "lazio", name: "Rome and Lazio", region: "Europe", bounds: [11.4, 40.7, 14.05, 42.85], sources: [`${FR}/europe/italy/lazio.osm.pbf`, `${GEO}/europe/italy/centro-latest.osm.pbf`] },
  { id: "new-york-state", name: "New York State", region: "North America", bounds: [-79.8, 40.45, -71.8, 45.05],
    sources: [`${GEO}/north-america/us/new-york-latest.osm.pbf`, `${FR}/north-america/us-northeast/new-york.osm.pbf`] },
  { id: "northern-california", name: "Northern California", region: "North America", bounds: [-124.6, 35.7, -117.6, 42.05],
    sources: [`${GEO}/north-america/us/california/norcal-latest.osm.pbf`, `${FR}/north-america/us-west/california.osm.pbf`] },
  { id: "british-columbia", name: "British Columbia", region: "North America", bounds: [-139.1, 48.2, -114.0, 60.05],
    sources: [`${GEO}/north-america/canada/british-columbia-latest.osm.pbf`, `${FR}/north-america/canada/british_columbia.osm.pbf`] },
  { id: "new-south-wales", name: "New South Wales", region: "Oceania", bounds: [140.9, -37.6, 153.7, -28.1],
    sources: [`${FR}/oceania/australia/new_south_wales.osm.pbf`, `${GEO}/australia-oceania/australia-latest.osm.pbf`] },
];

// The parts of a pack, as the workflow names them on the release.
export const ARCHIVES = ["base", "buildings", "route", "search"];
export const PART_SIZE = 4 * 1024 * 1024;
// The size of each release file but the last. A multiple of PART_SIZE, so no piece spans two files.
// Keep in step with `split -b` in the workflow.
export const FILE_SIZE = 1024 * 1024 * 1024;
