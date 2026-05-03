const OVERPASS_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];

const DEFAULT_ROUTE = {
  relationId: 9069158,
  routeNumber: '128',
  start: [140.12462, 35.61059],
  end: [139.86315, 34.99318],
  bounds: { west: 139.72, south: 34.86, east: 140.62, north: 35.72 },
  maxGapKm: 18,
  minComponentLengthKm: 0.35
};
const JAPAN_BOUNDS = { west: 122.5, south: 24, east: 154.5, north: 46.5 };

export default async function handler(request, response) {
  response.setHeader('cache-control', 's-maxage=86400, stale-while-revalidate=604800');
  const config = readRouteConfig(request);

  try {
    const geojson = await fetchRoute(config);
    response.status(200).json(geojson);
  } catch (error) {
    response.status(502).json({
      error: `OpenStreetMapから国道${config.routeNumber}号リレーションを抽出できませんでした`,
      detail: error.message
    });
  }
}

function readRouteConfig(request) {
  const url = new URL(request.url, 'https://local.vercel');
  const hasCustom = ['relationId', 'routeNumber', 'start', 'end', 'bounds'].some((key) => url.searchParams.has(key));
  const routeNumber = cleanText(url.searchParams.get('routeNumber')) || DEFAULT_ROUTE.routeNumber;
  const relationId = readOptionalNumber(url.searchParams.get('relationId')) ?? (!hasCustom || routeNumber === DEFAULT_ROUTE.routeNumber ? DEFAULT_ROUTE.relationId : null);
  const start = readLngLatOptional(url.searchParams.get('start')) ?? (!hasCustom || routeNumber === DEFAULT_ROUTE.routeNumber ? DEFAULT_ROUTE.start : null);
  const end = readLngLatOptional(url.searchParams.get('end')) ?? (!hasCustom || routeNumber === DEFAULT_ROUTE.routeNumber ? DEFAULT_ROUTE.end : null);
  const bounds = readBoundsOptional(url.searchParams.get('bounds')) ?? (!hasCustom || routeNumber === DEFAULT_ROUTE.routeNumber ? DEFAULT_ROUTE.bounds : JAPAN_BOUNDS);
  const maxGapKm = readNumber(url.searchParams.get('maxGapKm'), DEFAULT_ROUTE.maxGapKm);
  return { ...DEFAULT_ROUTE, relationId, routeNumber, start, end, bounds, maxGapKm, inferred: { relationId: !relationId, start: !start, end: !end } };
}

async function fetchRoute(config) {
  const errors = [];
  if (!config.relationId) config.relationId = await lookupRelationId(config.routeNumber);
  const osmFullUrl = `https://api.openstreetmap.org/api/0.6/relation/${config.relationId}/full.json`;

  try {
    const osm = await fetchOsmFullJson(osmFullUrl);
    return buildRouteFromOsmFullJson(osm, osmFullUrl, config);
  } catch (error) {
    errors.push(`${osmFullUrl}: ${error.message}`);
  }

  const query = `
    [out:json][timeout:90];
    rel(${config.relationId});
    out body;
    way(r);
    out tags geom;
  `;

  for (const url of OVERPASS_URLS) {
    try {
      const osm = await fetchOverpassJson(url, query);
      return buildRouteFromOverpassJson(osm, url, config);
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

async function lookupRelationId(routeNumber) {
  const ref = String(routeNumber).replace(/[^0-9A-Za-z_-]/g, '');
  const query = `
    [out:json][timeout:45];
    rel["type"="route"]["route"="road"]["network"~"^JP:national"]["ref"="${ref}"];
    out tags;
  `;
  const errors = [];
  for (const url of OVERPASS_URLS) {
    try {
      const osm = await fetchOverpassJson(url, query);
      const relations = (osm.elements || []).filter((element) => element.type === 'relation');
      const exact = relations.find((relation) => relation.tags?.ref === ref && relation.tags?.network?.startsWith('JP:national')) || relations[0];
      if (exact?.id) return exact.id;
      throw new Error(`国道${ref}号のOSMリレーションが見つかりません`);
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }

  try {
    return await lookupRelationIdFromWikidata(ref);
  } catch (error) {
    errors.push(`Wikidata: ${error.message}`);
  }

  throw new Error(errors.join(' | '));
}

async function lookupRelationIdFromWikidata(ref) {
  const sparql = `
    SELECT ?item ?itemLabel ?osm WHERE {
      ?item wdt:P402 ?osm.
      {
        ?item wdt:P1824 "${ref}".
      }
      UNION
      {
        ?item rdfs:label ?routeLabel.
        FILTER(LANG(?routeLabel) IN ("ja", "en"))
        FILTER(CONTAINS(STR(?routeLabel), "国道${ref}号") || CONTAINS(LCASE(STR(?routeLabel)), "national route ${ref}"))
      }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". }
    }
    LIMIT 20
  `;
  const data = await fetchWikidataSparql(sparql);
  const bindings = data.results?.bindings || [];
  const preferred = bindings.find(({ itemLabel }) => {
    const label = itemLabel?.value || '';
    return label.includes(`国道${ref}号`) || label.toLowerCase().includes(`national route ${ref}`);
  }) || bindings[0];
  const relationId = Number(preferred?.osm?.value);
  if (!Number.isFinite(relationId) || relationId <= 0) throw new Error(`国道${ref}号のOSM relation IDを取得できません`);
  return relationId;
}

async function fetchWikidataSparql(sparql) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`https://query.wikidata.org/sparql?${new URLSearchParams({ query: sparql, format: 'json' })}`, {
      headers: { accept: 'application/sparql-results+json', 'user-agent': 'mapbox07-route-director/1.0' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOsmFullJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
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

function buildRouteFromOsmFullJson(osm, sourceUrl, config) {
  const elements = osm.elements || [];
  const relation = elements.find((element) => element.type === 'relation' && element.id === config.relationId);
  if (!relation || !Array.isArray(relation.members)) throw new Error(`relation ${config.relationId} missing`);
  const nodeById = new Map(elements.filter((element) => element.type === 'node' && typeof element.lon === 'number' && typeof element.lat === 'number').map((node) => [node.id, [node.lon, node.lat]]));
  const wayById = new Map(elements.filter((element) => element.type === 'way' && Array.isArray(element.nodes) && element.nodes.length >= 2).map((way) => [way.id, way]));
  const ways = relation.members.filter((member) => member.type === 'way').map((member) => wayById.get(member.ref)).filter((way) => way && isUsableRoadWay(way)).map((way) => way.nodes.map((nodeId) => nodeById.get(nodeId)).filter(Boolean)).filter((coords) => coords.length >= 2 && wayTouchesRouteBounds(coords, config));
  return buildGeoJson(relation, ways, sourceUrl, 'OpenStreetMap API relation full JSON, component graph trunk path', config);
}

function buildRouteFromOverpassJson(osm, sourceUrl, config) {
  const elements = osm.elements || [];
  const relation = elements.find((element) => element.type === 'relation' && element.id === config.relationId);
  if (!relation || !Array.isArray(relation.members)) throw new Error(`relation ${config.relationId} missing`);
  const wayById = new Map(elements.filter((element) => element.type === 'way' && Array.isArray(element.geometry) && element.geometry.length >= 2).map((way) => [way.id, way]));
  const ways = relation.members.filter((member) => member.type === 'way').map((member) => wayById.get(member.ref)).filter((way) => way && isUsableRoadWay(way)).map((way) => way.geometry.map((point) => [point.lon, point.lat])).filter((coords) => coords.length >= 2 && wayTouchesRouteBounds(coords, config));
  return buildGeoJson(relation, ways, sourceUrl, 'OpenStreetMap Overpass relation, component graph trunk path', config);
}

function buildGeoJson(relation, ways, sourceUrl, sourceLabel, config) {
  if (!ways.length) throw new Error('relation contains no usable highway ways with geometry');
  const graph = buildGraph(ways);
  applyInferredStartEnd(graph, config);
  const components = connectedComponents(graph).map((nodeSet) => describeComponent(graph, nodeSet, config)).filter((component) => component.lengthKm >= config.minComponentLengthKm).sort((a, b) => a.startDistanceKm - b.startDistanceKm);
  const assembled = assembleComponentPath(graph, components, config);
  if (assembled.coordinates.length < 2) throw new Error('could not build an ordered route component path');
  const coordinates = orientStartToEnd(deduplicate(assembled.coordinates), config);
  const relationName = relation.tags?.name || `国道${config.routeNumber}号`;

  return {
    type: 'FeatureCollection',
    metadata: {
      source: sourceLabel,
      sourceUrl,
      relationId: config.relationId,
      routeNumber: config.routeNumber,
      relationName,
      inferred: config.inferred,
      start: coordinates[0],
      end: coordinates[coordinates.length - 1],
      bounds: routeBounds(coordinates),
      extraction: 'OSM national route relation. Relation/start/end can be supplied manually; when omitted, the API searches JP:national relations and infers route endpoints from the road graph.',
      license: 'ODbL-1.0',
      direction: 'Configured or inferred start to end for production playback',
      inputWayCount: ways.length,
      graphNodeCount: graph.coords.size,
      graphEdgeCount: graph.edgeCount,
      componentCount: components.length,
      usedComponentCount: assembled.usedComponents,
      connectorGapCount: assembled.connectorGaps.length,
      connectorGapsKm: assembled.connectorGaps.map((gap) => round(gap, 2)),
      startSnapKm: round(distanceKm(coordinates[0], config.start), 2),
      endSnapKm: round(distanceKm(coordinates[coordinates.length - 1], config.end), 2),
      cameraPathKm: round(pathLengthKm(coordinates), 2),
      extractedAt: new Date().toISOString()
    },
    features: [{ type: 'Feature', properties: { id: `route${config.routeNumber}_main`, role: 'camera-path', name: relationName, ref: relation.tags?.ref || config.routeNumber, network: relation.tags?.network || 'JP:national', osm_relation_id: config.relationId, source: 'component-trunk-osm-national-route-graph-path' }, geometry: { type: 'LineString', coordinates } }]
  };
}

function applyInferredStartEnd(graph, config) {
  if (config.start && config.end) return;
  const endpoints = [...graph.coords.keys()].filter((key) => (graph.adjacency.get(key) || []).length <= 1);
  const candidates = endpoints.length >= 2 ? endpoints : [...graph.coords.keys()];
  if (candidates.length < 2) throw new Error('route graph has too few nodes for endpoint inference');
  const a = farthestKeyFrom(graph, candidates[0], candidates);
  const b = farthestKeyFrom(graph, a, candidates);
  if (!config.start) config.start = graph.coords.get(a);
  if (!config.end) config.end = graph.coords.get(b);
}

function farthestKeyFrom(graph, fromKey, keys) {
  const from = graph.coords.get(fromKey);
  let bestKey = fromKey;
  let bestDistance = -Infinity;
  for (const key of keys) {
    const distance = distanceKm(from, graph.coords.get(key));
    if (distance > bestDistance) {
      bestDistance = distance;
      bestKey = key;
    }
  }
  return bestKey;
}

function assembleComponentPath(graph, components, config) {
  const unused = new Set(components.map((component) => component.id));
  const componentById = new Map(components.map((component) => [component.id, component]));
  const coordinates = [];
  const connectorGaps = [];
  let currentPoint = config.start;
  let usedComponents = 0;
  while (unused.size) {
    const next = chooseNextComponent(components, unused, currentPoint, config);
    if (!next) break;
    const gapKm = distanceKm(currentPoint, next.entryCoord);
    if (usedComponents > 0 && gapKm > config.maxGapKm) break;
    const entryKey = nearestNodeInSet(graph, currentPoint, next.nodeSet);
    const exitKey = chooseExitNode(graph, next.nodeSet, config.end);
    let pathKeys = shortestPath(graph, entryKey, exitKey);
    if (pathKeys.length < 2) pathKeys = shortestPath(graph, entryKey, farthestNodeInSet(graph, currentPoint, next.nodeSet));
    if (pathKeys.length < 2) { unused.delete(next.id); continue; }
    appendCoordinates(coordinates, pathKeys.map((key) => graph.coords.get(key)));
    currentPoint = coordinates[coordinates.length - 1];
    usedComponents += 1;
    unused.delete(next.id);
    if (usedComponents > 1) connectorGaps.push(gapKm);
    if (distanceKm(currentPoint, config.end) < 3.5) break;
    const remainingNearCurrent = [...unused].map((id) => componentById.get(id)).filter(Boolean).some((component) => componentDistanceToPoint(graph, component.nodeSet, currentPoint) <= config.maxGapKm);
    if (!remainingNearCurrent) break;
  }
  return { coordinates, connectorGaps, usedComponents };
}

function chooseNextComponent(components, unused, currentPoint, config) { let best = null; let bestScore = Infinity; for (const component of components) { if (!unused.has(component.id)) continue; const entryKey = nearestNodeInSet(component.graph, currentPoint, component.nodeSet); const entryCoord = component.graph.coords.get(entryKey); const gapKm = distanceKm(currentPoint, entryCoord); const progressPenalty = Math.max(0, component.startDistanceKm - distanceKm(currentPoint, config.start) - 10) * 0.2; const endBonus = component.endDistanceKm * 0.08; const score = gapKm + progressPenalty + endBonus; if (score < bestScore) { bestScore = score; best = { ...component, entryKey, entryCoord, score }; } } return best; }
function describeComponent(graph, nodeSet, config) { const id = [...nodeSet][0]; const startKey = nearestNodeInSet(graph, config.start, nodeSet); const endKey = nearestNodeInSet(graph, config.end, nodeSet); return { id, graph, nodeSet, lengthKm: componentLengthKm(graph, nodeSet), startDistanceKm: distanceKm(graph.coords.get(startKey), config.start), endDistanceKm: distanceKm(graph.coords.get(endKey), config.end) }; }
function buildGraph(ways) { const coords = new Map(); const adjacency = new Map(); let edgeCount = 0; for (const way of ways) { const clean = deduplicate(way); for (let index = 0; index < clean.length - 1; index++) { const a = clean[index]; const b = clean[index + 1]; const aKey = coordKey(a); const bKey = coordKey(b); const weight = distanceKm(a, b); if (weight <= 0 || weight > 2.2) continue; coords.set(aKey, a); coords.set(bKey, b); addEdge(adjacency, aKey, bKey, weight); addEdge(adjacency, bKey, aKey, weight); edgeCount += 1; } } return { coords, adjacency, edgeCount }; }
function addEdge(adjacency, from, to, weight) { if (!adjacency.has(from)) adjacency.set(from, []); const existing = adjacency.get(from).find((edge) => edge.to === to); if (existing) existing.weight = Math.min(existing.weight, weight); else adjacency.get(from).push({ to, weight }); }
function connectedComponents(graph) { const components = []; const visited = new Set(); for (const key of graph.coords.keys()) { if (visited.has(key)) continue; const stack = [key]; const nodeSet = new Set(); visited.add(key); while (stack.length) { const current = stack.pop(); nodeSet.add(current); for (const edge of graph.adjacency.get(current) || []) { if (!visited.has(edge.to)) { visited.add(edge.to); stack.push(edge.to); } } } components.push(nodeSet); } return components; }
function nearestNodeInSet(graph, target, nodeSet) { let bestKey = null; let bestDistance = Infinity; for (const key of nodeSet) { const distance = distanceKm(graph.coords.get(key), target); if (distance < bestDistance) { bestKey = key; bestDistance = distance; } } return bestKey; }
function chooseExitNode(graph, nodeSet, target) { return nearestNodeInSet(graph, target, nodeSet); }
function farthestNodeInSet(graph, target, nodeSet) { let bestKey = null; let bestDistance = -Infinity; for (const key of nodeSet) { const distance = distanceKm(graph.coords.get(key), target); if (distance > bestDistance) { bestKey = key; bestDistance = distance; } } return bestKey; }
function componentDistanceToPoint(graph, nodeSet, point) { let bestDistance = Infinity; for (const key of nodeSet) bestDistance = Math.min(bestDistance, distanceKm(graph.coords.get(key), point)); return bestDistance; }
function componentLengthKm(graph, nodeSet) { let total = 0; const seen = new Set(); for (const key of nodeSet) { for (const edge of graph.adjacency.get(key) || []) { const pair = [key, edge.to].sort().join('|'); if (!seen.has(pair)) { seen.add(pair); total += edge.weight; } } } return total; }
function shortestPath(graph, startKey, endKey) { const distances = new Map([[startKey, 0]]); const previous = new Map(); const visited = new Set(); const queue = [{ key: startKey, distance: 0 }]; while (queue.length) { queue.sort((a, b) => a.distance - b.distance); const current = queue.shift(); if (visited.has(current.key)) continue; visited.add(current.key); if (current.key === endKey) break; for (const edge of graph.adjacency.get(current.key) || []) { const nextDistance = current.distance + edge.weight; if (nextDistance < (distances.get(edge.to) ?? Infinity)) { distances.set(edge.to, nextDistance); previous.set(edge.to, current.key); queue.push({ key: edge.to, distance: nextDistance }); } } } if (!previous.has(endKey) && startKey !== endKey) return []; const path = [endKey]; while (path[0] !== startKey) path.unshift(previous.get(path[0])); return path; }
function isUsableRoadWay(way) { const highway = way.tags?.highway; return Boolean(highway) && !['footway', 'cycleway', 'path', 'steps', 'pedestrian', 'service', 'track'].includes(highway); }
function wayTouchesRouteBounds(coords, config) { const { west, south, east, north } = config.bounds || JAPAN_BOUNDS; return coords.some(([lng, lat]) => lng >= west && lng <= east && lat >= south && lat <= north); }
function appendCoordinates(target, segment) { for (const coord of segment) { const last = target[target.length - 1]; if (!last || distanceKm(last, coord) > 0.003) target.push(coord); } }
function coordKey(coord) { return `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`; }
function orientStartToEnd(coords, config) { const first = coords[0]; const last = coords[coords.length - 1]; const normal = distanceKm(first, config.start) + distanceKm(last, config.end); const reversed = distanceKm(last, config.start) + distanceKm(first, config.end); return normal <= reversed ? coords : coords.slice().reverse(); }
function deduplicate(coords) { const result = []; for (const coord of coords) { const last = result[result.length - 1]; if (!last || distanceKm(last, coord) > 0.003) result.push(coord); } return result; }
function pathLengthKm(coords) { let total = 0; for (let index = 0; index < coords.length - 1; index++) total += distanceKm(coords[index], coords[index + 1]); return total; }
function routeBounds(coords) { let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity; for (const [lng, lat] of coords) { west = Math.min(west, lng); south = Math.min(south, lat); east = Math.max(east, lng); north = Math.max(north, lat); } return [round(west, 5), round(south, 5), round(east, 5), round(north, 5)]; }
function readLngLatOptional(value) { if (!String(value || '').trim()) return null; const parts = String(value).split(',').map((item) => Number(item.trim())); return parts.length === 2 && parts.every(Number.isFinite) && !(parts[0] === 0 && parts[1] === 0) ? parts : null; }
function readBoundsOptional(value) { if (!String(value || '').trim()) return null; const parts = String(value).split(',').map((item) => Number(item.trim())); if (parts.length !== 4 || !parts.every(Number.isFinite) || parts.every((part) => part === 0)) return null; return { west: parts[0], south: parts[1], east: parts[2], north: parts[3] }; }
function readOptionalNumber(value) { if (!String(value || '').trim() || String(value).toLowerCase() === 'auto') return null; const number = Number(value); return Number.isFinite(number) && number > 0 ? number : null; }
function readNumber(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }
function cleanText(value) { return String(value || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 32); }
function distanceKm(a, b) { const earthRadiusKm = 6371; const dLat = toRadians(b[1] - a[1]); const dLon = toRadians(b[0] - a[0]); const lat1 = toRadians(a[1]); const lat2 = toRadians(b[1]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2; return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h))); }
function round(value, decimals) { const factor = 10 ** decimals; return Math.round(value * factor) / factor; }
function toRadians(value) { return value * Math.PI / 180; }
