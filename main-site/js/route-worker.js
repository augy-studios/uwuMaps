// Runs the offline router off the main thread, so a long search doesn't stop the map moving.

import { RouteGraph, findRoute } from "./route-core.js";
import { archiveReader, publishedReader } from "./pack-read.js";

const graphs = new Map();
let latest = 0;

async function graphFor(pack) {
  const key = `${pack.published ? "published" : "saved"}/${pack.id}/${pack.build}`;
  if (!graphs.has(key)) graphs.set(key, RouteGraph.open((pack.published ? publishedReader : archiveReader)(pack.id, pack.build, "route")));
  try {
    return await graphs.get(key);
  } catch (err) {
    graphs.delete(key);
    throw err;
  }
}

self.addEventListener("message", async ({ data }) => {
  const { id, pack, from, to, mode } = data;
  latest = id;
  try {
    const graph = await graphFor(pack);
    // A newer request means this one's answer is no longer wanted.
    const route = await findRoute(graph, from, to, mode, { shouldStop: () => latest !== id });
    self.postMessage({ id, route });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
});
