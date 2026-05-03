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
const MIN_CHAIN_KM = 2;

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
        gaps: chain.gaps
      };
    })
    .filter((chain) => chain.coordinates.length >= 2 && chain.lengthKm >= MIN_CHAIN_KM)
    .sort((a, b) => scoreChain(b) - scoreChain(a));

  if (!chains.length) throw new Error('could not build any continuous Route 128 relation chain');

  const cameraChain = chains[0];

  return {
    type: 'FeatureCollection',
    metadata: {
      source: sourceLabel,
      sourceUrl,
      relationId: ROUTE_128_RELATION_ID,
      relationName: relation.tags?.name || '国道128号',
      extraction: 'OSM relation member way order; exact OSM node geometry; no hand drawn coordinates',
      license: 'ODbL-1.0',
      direction: 'Chiba to Tateyama for production playback',
      orderedWayCount: orderedWays.length,
      chainCount: chains.length,
      cameraPathKm: round(cameraChain.lengthKm, 2),
      cameraMemberCount: cameraChain.memberCount,
      maxAllowedGapKm: MAX_RELATION_GAP_KM,
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

function scoreChain(chain) {
  const first = chain.coordinates[0];
  const last = chain.coordinates[chain.coordinates.length - 1];
  const endpointScore = 220 - distanceKm(first, CHIBA_START) - distanceKm(last, TATEYAMA_END);
  return chain.lengthKm + endpointScore * 0.35 + chain.memberCount * 0.03;
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
