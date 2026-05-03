const OSM_FULL_URL = 'https://api.openstreetmap.org/api/0.6/relation/9069158/full.json';
const OVERPASS_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];
const ROUTE_128_RELATION_ID = 9069158;
const CHIBA_START = [140.12462, 35.61059];
const TATEYAMA_END = [139.86315, 34.99318];
const ROUTE_BOUNDS = { west: 139.72, south: 34.86, east: 140.62, north: 35.72 };
const MAX_COMPONENT_GAP_KM = 18;
const MIN_COMPONENT_LENGTH_KM = 0.35;

export default async function handler(request, response) {
  response.setHeader('cache-control', 's-maxage=86400, stale-while-revalidate=604800');

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
    .filter((coords) => coords.length >= 2 && wayTouchesRouteBounds(coords));

  return buildGeoJson(relation, ways, sourceUrl, 'OpenStreetMap API relation full JSON, component graph trunk path');
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
    .filter((coords) => coords.length >= 2 && wayTouchesRouteBounds(coords));

  return buildGeoJson(relation, ways, sourceUrl, 'OpenStreetMap Overpass relation, component graph trunk path');
}

function buildGeoJson(relation, ways, sourceUrl, sourceLabel) {
  if (!ways.length) throw new Error('relation contains no usable highway ways with geometry');

  const graph = buildGraph(ways);
  const components = connectedComponents(graph)
    .map((nodeSet) => describeComponent(graph, nodeSet))
    .filter((component) => component.lengthKm >= MIN_COMPONENT_LENGTH_KM)
    .sort((a, b) => a.startDistanceKm - b.startDistanceKm);

  const assembled = assembleComponentPath(graph, components);
  if (assembled.coordinates.length < 2) throw new Error('could not build an ordered Route 128 component path');

  const coordinates = orientChibaToTateyama(deduplicate(assembled.coordinates));

  return {
    type: 'FeatureCollection',
    metadata: {
      source: sourceLabel,
      sourceUrl,
      relationId: ROUTE_128_RELATION_ID,
      relationName: relation.tags?.name || '国道128号',
      extraction: 'OSM relation graph split into connected road components. For each component, only one Chiba-to-Tateyama trunk path is selected; duplicate branches and parallel alternatives are excluded.',
      license: 'ODbL-1.0',
      direction: 'Chiba to Tateyama for production playback',
      inputWayCount: ways.length,
      graphNodeCount: graph.coords.size,
      graphEdgeCount: graph.edgeCount,
      componentCount: components.length,
      usedComponentCount: assembled.usedComponents,
      connectorGapCount: assembled.connectorGaps.length,
      connectorGapsKm: assembled.connectorGaps.map((gap) => round(gap, 2)),
      startSnapKm: round(distanceKm(coordinates[0], CHIBA_START), 2),
      endSnapKm: round(distanceKm(coordinates[coordinates.length - 1], TATEYAMA_END), 2),
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
          source: 'component-trunk-osm-relation-graph-path',
          start: '千葉市中央区 広小路交差点',
          end: '館山市 北条交差点'
        },
        geometry: { type: 'LineString', coordinates }
      }
    ]
  };
}

function assembleComponentPath(graph, components) {
  const unused = new Set(components.map((component) => component.id));
  const componentById = new Map(components.map((component) => [component.id, component]));
  const coordinates = [];
  const connectorGaps = [];
  let currentPoint = CHIBA_START;
  let usedComponents = 0;

  while (unused.size) {
    const next = chooseNextComponent(components, unused, currentPoint);
    if (!next) break;

    const gapKm = distanceKm(currentPoint, next.entryCoord);
    if (usedComponents > 0 && gapKm > MAX_COMPONENT_GAP_KM) break;

    const entryKey = nearestNodeInSet(graph, currentPoint, next.nodeSet);
    const exitKey = chooseExitNode(graph, next.nodeSet, TATEYAMA_END);
    let pathKeys = shortestPath(graph, entryKey, exitKey);

    if (pathKeys.length < 2) {
      const fallbackExitKey = farthestNodeInSet(graph, currentPoint, next.nodeSet);
      pathKeys = shortestPath(graph, entryKey, fallbackExitKey);
    }
    if (pathKeys.length < 2) {
      unused.delete(next.id);
      continue;
    }

    const segment = pathKeys.map((key) => graph.coords.get(key));
    appendCoordinates(coordinates, segment);
    currentPoint = coordinates[coordinates.length - 1];
    usedComponents += 1;
    unused.delete(next.id);

    if (usedComponents > 1) connectorGaps.push(gapKm);

    // Chiba -> Tateyama is covered once the selected trunk reaches the endpoint area.
    if (distanceKm(currentPoint, TATEYAMA_END) < 3.5) break;

    const remainingNearCurrent = [...unused]
      .map((id) => componentById.get(id))
      .filter(Boolean)
      .some((component) => componentDistanceToPoint(graph, component.nodeSet, currentPoint) <= MAX_COMPONENT_GAP_KM);
    if (!remainingNearCurrent) break;
  }

  return { coordinates, connectorGaps, usedComponents };
}

function chooseNextComponent(components, unused, currentPoint) {
  let best = null;
  let bestScore = Infinity;

  for (const component of components) {
    if (!unused.has(component.id)) continue;
    const entryKey = nearestNodeInSet(component.graph, currentPoint, component.nodeSet);
    const entryCoord = component.graph.coords.get(entryKey);
    const gapKm = distanceKm(currentPoint, entryCoord);
    const progressPenalty = Math.max(0, component.startDistanceKm - distanceKm(currentPoint, CHIBA_START) - 10) * 0.2;
    const endBonus = component.endDistanceKm * 0.08;
    const score = gapKm + progressPenalty + endBonus;
    if (score < bestScore) {
      bestScore = score;
      best = { ...component, entryKey, entryCoord, score };
    }
  }

  return best;
}

function describeComponent(graph, nodeSet) {
  const id = [...nodeSet][0];
  const startKey = nearestNodeInSet(graph, CHIBA_START, nodeSet);
  const endKey = nearestNodeInSet(graph, TATEYAMA_END, nodeSet);
  return {
    id,
    graph,
    nodeSet,
    lengthKm: componentLengthKm(graph, nodeSet),
    startDistanceKm: distanceKm(graph.coords.get(startKey), CHIBA_START),
    endDistanceKm: distanceKm(graph.coords.get(endKey), TATEYAMA_END)
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
      if (weight <= 0 || weight > 2.2) continue;
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
  const existing = adjacency.get(from).find((edge) => edge.to === to);
  if (existing) existing.weight = Math.min(existing.weight, weight);
  else adjacency.get(from).push({ to, weight });
}

function connectedComponents(graph) {
  const components = [];
  const visited = new Set();

  for (const key of graph.coords.keys()) {
    if (visited.has(key)) continue;
    const stack = [key];
    const nodeSet = new Set();
    visited.add(key);

    while (stack.length) {
      const current = stack.pop();
      nodeSet.add(current);
      for (const edge of graph.adjacency.get(current) || []) {
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          stack.push(edge.to);
        }
      }
    }

    components.push(nodeSet);
  }

  return components;
}

function nearestNodeInSet(graph, target, nodeSet) {
  let bestKey = null;
  let bestDistance = Infinity;
  for (const key of nodeSet) {
    const distance = distanceKm(graph.coords.get(key), target);
    if (distance < bestDistance) {
      bestKey = key;
      bestDistance = distance;
    }
  }
  return bestKey;
}

function chooseExitNode(graph, nodeSet, target) {
  return nearestNodeInSet(graph, target, nodeSet);
}

function farthestNodeInSet(graph, target, nodeSet) {
  let bestKey = null;
  let bestDistance = -Infinity;
  for (const key of nodeSet) {
    const distance = distanceKm(graph.coords.get(key), target);
    if (distance > bestDistance) {
      bestKey = key;
      bestDistance = distance;
    }
  }
  return bestKey;
}

function componentDistanceToPoint(graph, nodeSet, point) {
  let bestDistance = Infinity;
  for (const key of nodeSet) bestDistance = Math.min(bestDistance, distanceKm(graph.coords.get(key), point));
  return bestDistance;
}

function componentLengthKm(graph, nodeSet) {
  let total = 0;
  const seen = new Set();
  for (const key of nodeSet) {
    for (const edge of graph.adjacency.get(key) || []) {
      const pair = [key, edge.to].sort().join('|');
      if (!seen.has(pair)) {
        seen.add(pair);
        total += edge.weight;
      }
    }
  }
  return total;
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
  return Boolean(highway) && !['footway', 'cycleway', 'path', 'steps', 'pedestrian', 'service', 'track'].includes(highway);
}

function wayTouchesRouteBounds(coords) {
  return coords.some(([lng, lat]) => lng >= ROUTE_BOUNDS.west && lng <= ROUTE_BOUNDS.east && lat >= ROUTE_BOUNDS.south && lat <= ROUTE_BOUNDS.north);
}

function appendCoordinates(target, segment) {
  for (const coord of segment) {
    const last = target[target.length - 1];
    if (!last || distanceKm(last, coord) > 0.003) target.push(coord);
  }
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
