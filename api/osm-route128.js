const OSM_FULL_URL = 'https://api.openstreetmap.org/api/0.6/relation/9069158/full.json';
const OVERPASS_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];
const ROUTE_128_RELATION_ID = 9069158;
const CHIBA_START = [140.12462, 35.61059];
const TATEYAMA_END = [139.86315, 34.99318];
const MAX_RELATION_GAP_KM = 0.35;
const MAX_PLAYBACK_CHAIN_GAP_KM = 18;
const MIN_CHAIN_KM = 1;
const PARALLEL_DUPLICATE_KM = 1.15;

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');

  try {
    const geojson = await fetchOrderedRelationRoute128();
    response.status(200).json(geojson);
  } catch (error) {
    response.status(502).json({
      error: 'OpenStreetMapから国道128号リレーションを抽出できませんでした',
      detail: error.message
    });
  }
}

async function fetchOrderedRelationRoute128() {
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
    const response = await fetch(OSM_FULL_URL, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });

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
    const overpassResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ data: query }),
      signal: controller.signal
    });

    if (!overpassResponse.ok) throw new Error(`HTTP ${overpassResponse.status}`);
    return await overpassResponse.json();
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

  const orderedWays = relation.members
    .filter((member) => member.type === 'way')
    .map((member, memberIndex) => {
      const way = wayById.get(member.ref);
      if (!way || !isUsableRoadWay(way)) return null;
      const geometry = way.nodes.map((nodeId) => nodeById.get(nodeId)).filter(Boolean);
      if (geometry.length < 2) return null;
      return { member, memberIndex, way: { ...way, geometry } };
    })
    .filter(Boolean);

  return buildGeoJsonFromOrderedWays(relation, orderedWays, sourceUrl, 'OpenStreetMap API relation full JSON');
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

  const orderedWays = relation.members
    .filter((member) => member.type === 'way')
    .map((member, memberIndex) => ({ member, memberIndex, way: wayById.get(member.ref) }))
    .filter((entry) => entry.way && isUsableRoadWay(entry.way))
    .map((entry) => ({
      ...entry,
      way: { ...entry.way, geometry: entry.way.geometry.map((point) => [point.lon, point.lat]) }
    }));

  return buildGeoJsonFromOrderedWays(relation, orderedWays, sourceUrl, 'OpenStreetMap Overpass ordered relation members');
}

function buildGeoJsonFromOrderedWays(relation, orderedWays, sourceUrl, sourceLabel) {
  if (!orderedWays.length) throw new Error('relation contains no usable highway ways with geometry');

  const relationChains = buildRelationChains(orderedWays);
  const chains = relationChains
    .map((chain, index) => {
      const coordinates = orientChibaToTateyama(deduplicate(chain.coordinates));
      return {
        index,
        coordinates,
        memberCount: chain.memberCount,
        lengthKm: pathLengthKm(coordinates),
        gaps: chain.gaps,
        startDistanceKm: distanceKm(coordinates[0], CHIBA_START),
        endDistanceKm: distanceKm(coordinates[coordinates.length - 1], TATEYAMA_END)
      };
    })
    .filter((chain) => chain.coordinates.length >= 2 && chain.lengthKm >= MIN_CHAIN_KM);

  if (!chains.length) throw new Error('could not build any continuous Route 128 relation chain');

  const cameraChain = buildPlaybackChain(chains);
  const allSegments = chains.flatMap((chain) => chain.coordinates);

  return {
    type: 'FeatureCollection',
    metadata: {
      source: sourceLabel,
      sourceUrl,
      relationId: ROUTE_128_RELATION_ID,
      relationName: relation.tags?.name || '国道128号',
      extraction: 'OSM relation member way order; exact OSM node geometry; duplicate parallel chains skipped',
      license: 'ODbL-1.0',
      direction: 'Chiba to Tateyama for production playback',
      orderedWayCount: orderedWays.length,
      chainCount: chains.length,
      usedChainCount: cameraChain.usedChainCount,
      skippedParallelChains: cameraChain.skippedParallelChains,
      cameraPathKm: round(pathLengthKm(cameraChain.coordinates), 2),
      rawSegmentKm: round(pathLengthKm(allSegments), 2),
      cameraConnectorGapsKm: cameraChain.connectorGapsKm,
      parallelDuplicateKm: PARALLEL_DUPLICATE_KM,
      maxRelationGapKm: MAX_RELATION_GAP_KM,
      maxPlaybackChainGapKm: MAX_PLAYBACK_CHAIN_GAP_KM,
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
          source: 'ordered-osm-relation-members',
          start: '千葉市中央区 広小路交差点',
          end: '館山市 北条交差点'
        },
        geometry: { type: 'LineString', coordinates: cameraChain.coordinates }
      }
    ]
  };
}

function buildPlaybackChain(chains) {
  const remaining = chains
    .map((chain) => ({ ...chain, coordinates: orientChibaToTateyama(chain.coordinates) }))
    .sort((a, b) => a.startDistanceKm - b.startDistanceKm);
  const firstIndex = remaining.findIndex((chain) => chain.startDistanceKm < 35 || chain.coordinates[0][1] > 35.45);
  const first = remaining.splice(firstIndex >= 0 ? firstIndex : 0, 1)[0];
  let coordinates = first.coordinates.slice();
  const acceptedChains = [first];
  const connectorGapsKm = [];
  let usedChainCount = 1;
  let skippedParallelChains = 0;

  while (remaining.length) {
    const last = coordinates[coordinates.length - 1];
    const candidates = remaining
      .map((chain, index) => {
        const forwardDistance = distanceKm(last, chain.coordinates[0]);
        const reverseDistance = distanceKm(last, chain.coordinates[chain.coordinates.length - 1]);
        return forwardDistance <= reverseDistance
          ? { index, distanceKm: forwardDistance, coordinates: chain.coordinates, chain }
          : { index, distanceKm: reverseDistance, coordinates: chain.coordinates.slice().reverse(), chain };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm);

    const next = candidates.find((candidate) => !isParallelDuplicate(candidate.chain, acceptedChains));
    const duplicate = candidates.find((candidate) => isParallelDuplicate(candidate.chain, acceptedChains));
    if (duplicate && (!next || duplicate.distanceKm <= next.distanceKm + 0.6)) {
      remaining.splice(duplicate.index, 1);
      skippedParallelChains += 1;
      continue;
    }

    if (!next || next.distanceKm > MAX_PLAYBACK_CHAIN_GAP_KM) break;

    connectorGapsKm.push(round(next.distanceKm, 2));
    coordinates = appendCoordinates(coordinates, next.coordinates);
    acceptedChains.push(next.chain);
    remaining.splice(next.index, 1);
    usedChainCount += 1;
  }

  const oriented = orientChibaToTateyama(deduplicate(coordinates));
  return { coordinates: oriented, connectorGapsKm, usedChainCount, skippedParallelChains };
}

function isParallelDuplicate(candidate, acceptedChains) {
  if (candidate.lengthKm > 18) return false;
  const sample = sampleCoordinates(candidate.coordinates, 7);
  const nearCount = sample.filter((coord) => acceptedChains.some((chain) => minDistanceToPathKm(coord, chain.coordinates) < PARALLEL_DUPLICATE_KM)).length;
  return nearCount / sample.length >= 0.72;
}

function sampleCoordinates(coords, count) {
  if (coords.length <= count) return coords;
  const result = [];
  for (let index = 0; index < count; index++) {
    result.push(coords[Math.round(index * (coords.length - 1) / (count - 1))]);
  }
  return result;
}

function minDistanceToPathKm(coord, path) {
  let min = Infinity;
  const stride = Math.max(1, Math.floor(path.length / 80));
  for (let index = 0; index < path.length; index += stride) {
    min = Math.min(min, distanceKm(coord, path[index]));
  }
  return min;
}

function buildRelationChains(orderedEntries) {
  const chains = [];
  let current = null;

  for (const entry of orderedEntries) {
    const coords = entry.way.geometry;
    if (!current) {
      current = { coordinates: coords, memberCount: 1, gaps: [] };
      continue;
    }

    const join = bestEndpointJoin(current.coordinates, coords);
    if (join.distanceKm > MAX_RELATION_GAP_KM) {
      chains.push(current);
      current = { coordinates: coords, memberCount: 1, gaps: [] };
      continue;
    }

    if (join.distanceKm > 0.03) current.gaps.push(round(join.distanceKm, 3));
    current.coordinates = applyJoin(current.coordinates, coords, join.mode);
    current.memberCount += 1;
  }

  if (current) chains.push(current);
  return chains;
}

function isUsableRoadWay(way) {
  const highway = way.tags?.highway;
  return Boolean(highway) && !['footway', 'cycleway', 'path', 'steps', 'pedestrian'].includes(highway);
}

function bestEndpointJoin(a, b) {
  const aStart = a[0];
  const aEnd = a[a.length - 1];
  const bStart = b[0];
  const bEnd = b[b.length - 1];
  const candidates = [
    { mode: 'append', distanceKm: distanceKm(aEnd, bStart) },
    { mode: 'appendReverse', distanceKm: distanceKm(aEnd, bEnd) },
    { mode: 'prepend', distanceKm: distanceKm(aStart, bEnd) },
    { mode: 'prependReverse', distanceKm: distanceKm(aStart, bStart) }
  ];
  return candidates.sort((left, right) => left.distanceKm - right.distanceKm)[0];
}

function applyJoin(base, next, mode) {
  if (mode === 'append') return appendCoordinates(base, next);
  if (mode === 'appendReverse') return appendCoordinates(base, next.slice().reverse());
  if (mode === 'prepend') return appendCoordinates(next, base);
  return appendCoordinates(next.slice().reverse(), base);
}

function appendCoordinates(base, next) {
  const last = base[base.length - 1];
  const first = next[0];
  return distanceKm(last, first) < 0.003 ? base.concat(next.slice(1)) : base.concat(next);
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
