const OSM_FULL_URL = 'https://api.openstreetmap.org/api/0.6/relation/9069158/full.json';
const OVERPASS_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];
const ROUTE_128_RELATION_ID = 9069158;
const CHIBA_START = [140.12462, 35.61059];
const TATEYAMA_END = [139.86315, 34.99318];

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');

  try {
    const geojson = await fetchRoute128();
    response.status(200).json(geojson);
  } catch (error) {
    response.status(502).json({
      error: 'OpenStreetMapから国道128号リレーションを抽出できませんでした',
      detail: error.message
    });
  }
}

async function fetchRoute128() {
  const errors = [];

  try {
    const osm = await fetchOsmFullJson();
    return buildRouteFromOsmFullJson(osm, OSM_FULL_URL);
  } catch (error) {
    errors.push(`${OSM_FULL_URL}: ${error.message}`);
  }

  const query = `
    [out:json][timeout:90];
    rel(${ROUTE_128_RELATION_ID});
    out body;
    way(r);
    out tags geom;
  `;

  for (const url of OVERPASS_URLS) {
    try {
      const osm = await fetchOverpassJson(url, query);
      return buildRouteFromOverpassJson(osm, url);
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }

  throw new Error(errors.join(' | '));
}

async function fetchOsmFullJson() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(OSM_FULL_URL, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOverpassJson(url, query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ data: query }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildRouteFromOsmFullJson(osm, sourceUrl) {
  const elements = osm.elements || [];
  const relation = elements.find((element) => element.type === 'relation' && element.id === ROUTE_128_RELATION_ID);
  if (!relation || !Array.isArray(relation.members)) throw new Error(`relation ${ROUTE_128_RELATION_ID} missing`);

  const nodeById = new Map(
    elements
      .filter((element) => element.type === 'node' && typeof element.lon === 'number' && typeof element.lat === 'number')
      .map((node) => [node.id, [node.lon, node.lat]])
  );
  const wayById = new Map(
    elements
      .filter((element) => element.type === 'way' && Array.isArray(element.nodes) && element.nodes.length >= 2)
      .map((way) => [way.id, way])
  );
  const ways = relation.members
    .filter((member) => member.type === 'way')
    .map((member) => wayById.get(member.ref))
    .filter((way) => way && isUsableRoadWay(way))
    .map((way) => way.nodes.map((nodeId) => nodeById.get(nodeId)).filter(Boolean))
    .filter((coords) => coords.length >= 2);

  return buildGeoJson(relation, ways, sourceUrl, 'OpenStreetMap API relation full JSON, graph shortest path');
}

function buildRouteFromOverpassJson(osm, sourceUrl) {
  const elements = osm.elements || [];
  const relation = elements.find((element) => element.type === 'relation' && element.id === ROUTE_128_RELATION_ID);
  if (!relation || !Array.isArray(relation.members)) throw new Error(`relation ${ROUTE_128_RELATION_ID} missing`);

  const wayById = new Map(
    elements
      .filter((element) => element.type === 'way' && Array.isArray(element.geometry) && element.geometry.length >= 2)
      .map((way) => [way.id, way])
  );
  const ways = relation.members
    .filter((member) => member.type === 'way')
    .map((member) => wayById.get(member.ref))
    .filter((way) => way && isUsableRoadWay(way))
    .map((way) => way.geometry.map((point) => [point.lon, point.lat]))
    .filter((coords) => coords.length >= 2);

  return buildGeoJson(relation, ways, sourceUrl, 'OpenStreetMap Overpass relation, graph shortest path');
}

function buildGeoJson(relation, ways, sourceUrl, sourceLabel) {
  if (!ways.length) throw new Error('relation contains no usable highway ways with geometry');

  const graph = buildGraph(ways);
  const startKey = nearestGraphNode(graph, CHIBA_START);
  const endKey = nearestGraphNode(graph, TATEYAMA_END);
  const pathKeys = shortestPath(graph, startKey, endKey);
  if (pathKeys.length < 2) throw new Error('could not build one connected Route 128 graph path');

  let coordinates = pathKeys.map((key) => graph.coords.get(key));
  coordinates = orientChibaToTateyama(deduplicate(coordinates));

  return {
    type: 'FeatureCollection',
    metadata: {
      source: sourceLabel,
      sourceUrl,
      relationId: ROUTE_128_RELATION_ID,
      relationName: relation.tags?.name || '国道128号',
      extraction: 'Single Dijkstra path through OSM relation way/node graph. Branches and parallel alternatives are not drawn.',
      license: 'ODbL-1.0',
      direction: 'Chiba to Tateyama for production playback',
      inputWayCount: ways.length,
      graphNodeCount: graph.coords.size,
      graphEdgeCount: graph.edgeCount,
      startSnapKm: round(distanceKm(graph.coords.get(startKey), CHIBA_START), 2),
      endSnapKm: round(distanceKm(graph.coords.get(endKey), TATEYAMA_END), 2),
      cameraPathKm: round(pathLengthKm(coordinates), 2),
      extractedAt: new Date().toISOString()
    },
    features: [
      {
        type: 'Feature',
        properties: {
          id: 'route128_main',
          role: 'camera-path',
          name: relation.tags?.name || '国道128号',
          ref: relation.tags?.ref || '128',
          network: relation.tags?.network || 'JP:national',
          osm_relation_id: ROUTE_128_RELATION_ID,
          source: 'single-osm-relation-graph-path',
          start: '千葉市中央区 広小路交差点',
          end: '館山市 北条交差点'
        },
        geometry: { type: 'LineString', coordinates }
      }
    ]
  };
}

function buildGraph(ways) {
  const coords = new Map();
  const adjacency = new Map();
  let edgeCount = 0;

  for (const way of ways) {
    const clean = deduplicate(way);
    for (let index = 0; index < clean.length - 1; index++) {
      const a = clean[index];
      const b = clean[index + 1];
      const aKey = coordKey(a);
      const bKey = coordKey(b);
      const weight = distanceKm(a, b);
      coords.set(aKey, a);
      coords.set(bKey, b);
      addEdge(adjacency, aKey, bKey, weight);
      addEdge(adjacency, bKey, aKey, weight);
      edgeCount += 1;
    }
  }

  return { coords, adjacency, edgeCount };
}

function addEdge(adjacency, from, to, weight) {
  if (!adjacency.has(from)) adjacency.set(from, []);
  adjacency.get(from).push({ to, weight });
}

function nearestGraphNode(graph, target) {
  let bestKey = null;
  let bestDistance = Infinity;
  for (const [key, coord] of graph.coords) {
    const distance = distanceKm(coord, target);
    if (distance < bestDistance) {
      bestKey = key;
      bestDistance = distance;
    }
  }
  return bestKey;
}

function shortestPath(graph, startKey, endKey) {
  const distances = new Map([[startKey, 0]]);
  const previous = new Map();
  const visited = new Set();
  const queue = [{ key: startKey, distance: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.distance - b.distance);
    const current = queue.shift();
    if (visited.has(current.key)) continue;
    visited.add(current.key);
    if (current.key === endKey) break;

    for (const edge of graph.adjacency.get(current.key) || []) {
      const nextDistance = current.distance + edge.weight;
      if (nextDistance < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, nextDistance);
        previous.set(edge.to, current.key);
        queue.push({ key: edge.to, distance: nextDistance });
      }
    }
  }

  if (!previous.has(endKey) && startKey !== endKey) return [];
  const path = [endKey];
  while (path[0] !== startKey) path.unshift(previous.get(path[0]));
  return path;
}

function isUsableRoadWay(way) {
  const highway = way.tags?.highway;
  return Boolean(highway) && !['footway', 'cycleway', 'path', 'steps', 'pedestrian', 'service'].includes(highway);
}

function coordKey(coord) {
  return `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;
}

function orientChibaToTateyama(coords) {
  const first = coords[0];
  const last = coords[coords.length - 1];
  const normal = distanceKm(first, CHIBA_START) + distanceKm(last, TATEYAMA_END);
  const reversed = distanceKm(last, CHIBA_START) + distanceKm(first, TATEYAMA_END);
  return normal <= reversed ? coords : coords.slice().reverse();
}

function deduplicate(coords) {
  const result = [];
  for (const coord of coords) {
    const last = result[result.length - 1];
    if (!last || distanceKm(last, coord) > 0.003) result.push(coord);
  }
  return result;
}

function pathLengthKm(coords) {
  let total = 0;
  for (let index = 0; index < coords.length - 1; index++) total += distanceKm(coords[index], coords[index + 1]);
  return total;
}

function distanceKm(a, b) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(b[1] - a[1]);
  const dLon = toRadians(b[0] - a[0]);
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toRadians(value) {
  return value * Math.PI / 180;
}
