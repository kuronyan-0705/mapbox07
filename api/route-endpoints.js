const VERIFIED_ENDPOINTS = {
  '128': {
    termini: [
      { label: '千葉市中央区 広小路交差点付近', lngLat: [140.12462, 35.61059], source: 'verified project preset', confidence: 'high' },
      { label: '館山市方面 終点付近', lngLat: [139.86315, 34.99318], source: 'verified project preset', confidence: 'medium' }
    ],
    bounds: [139.72, 34.86, 140.62, 35.72]
  },
  '134': {
    termini: [
      { label: '横須賀市 三春町二丁目交差点付近', lngLat: [139.686972, 35.266611], source: 'verified route endpoint', confidence: 'high' },
      { label: '中郡大磯町 大磯駅入口交差点付近', lngLat: [139.316528, 35.311083], source: 'verified route endpoint', confidence: 'high' }
    ],
    bounds: [139.25, 35.12, 139.78, 35.38]
  }
};

export default async function handler(request, response) {
  response.setHeader('cache-control', 's-maxage=86400, stale-while-revalidate=604800');
  const url = new URL(request.url, 'https://local.vercel');
  const routeNumber = cleanRouteNumber(url.searchParams.get('routeNumber'));
  if (!routeNumber) {
    response.status(400).json({ error: 'routeNumber is required' });
    return;
  }

  try {
    const verified = VERIFIED_ENDPOINTS[routeNumber];
    if (verified) {
      response.status(200).json(routeResponse({
        routeNumber,
        relationId: null,
        relationLabel: `国道${routeNumber}号`,
        termini: verified.termini,
        bounds: verified.bounds,
        sourceStatus: { verified: true, wikidataError: null, osmEndpointError: null }
      }));
      return;
    }

    const wikidata = await lookupWikidataRoute(routeNumber);
    const osm = wikidata.relationId ? await inferOsmEndpointCandidates(wikidata.relationId).catch((error) => ({ error: error.message, termini: [] })) : { termini: [] };
    const termini = mergeCandidates(osm.termini, wikidata.termini);
    const bounds = boundsFromCandidates(termini);

    response.status(200).json(routeResponse({
      routeNumber,
      relationId: wikidata.relationId || null,
      relationLabel: wikidata.label || `国道${routeNumber}号`,
      termini,
      bounds,
      sourceStatus: { verified: false, wikidataError: null, osmEndpointError: osm.error || null }
    }));
  } catch (error) {
    response.status(502).json({ error: `国道${routeNumber}号の起終点候補を取得できませんでした`, detail: error.message });
  }
}

function routeResponse({ routeNumber, relationId, relationLabel, termini, bounds, sourceStatus }) {
  const cleanTermini = labelCandidates(mergeCandidates(termini, []), routeNumber);
  const first = cleanTermini[0];
  const second = cleanTermini[1];
  return {
    routeNumber,
    relationId,
    relationLabel,
    start: cleanTermini,
    end: second ? [second, first, ...cleanTermini.slice(2)] : cleanTermini,
    bounds: bounds || boundsFromCandidates(cleanTermini),
    sourceStatus
  };
}

async function lookupWikidataRoute(routeNumber) {
  const ids = await searchRouteEntities(routeNumber);
  if (!ids.length) throw new Error('Wikidata item not found');
  const routeEntities = await fetchEntities(ids.slice(0, 12), 'claims|labels|descriptions');
  const route = chooseRouteEntity(Object.values(routeEntities.entities || {}), routeNumber);
  if (!route) throw new Error('Wikidata route entity has no useful data');

  const relationId = readFirstNumericClaim(route, 'P402');
  const terminusIds = readEntityClaims(route, 'P559');
  const endpointEntities = terminusIds.length ? await fetchEntities(terminusIds.slice(0, 8), 'claims|labels|descriptions') : { entities: {} };
  const termini = Object.values(endpointEntities.entities || {})
    .map((entity) => candidateFromEntity(entity, 'Wikidata terminus'))
    .filter(Boolean);

  return { relationId, label: labelOf(route), termini };
}

async function inferOsmEndpointCandidates(relationId) {
  const osm = await fetchOsmJson(`https://api.openstreetmap.org/api/0.6/relation/${relationId}/full.json`);
  const elements = osm.elements || [];
  const relation = elements.find((element) => element.type === 'relation' && element.id === relationId);
  if (!relation?.members?.length) throw new Error(`relation ${relationId} missing`);

  const nodeById = new Map(elements
    .filter((element) => element.type === 'node' && typeof element.lon === 'number' && typeof element.lat === 'number')
    .map((node) => [node.id, [node.lon, node.lat]]));
  const wayById = new Map(elements
    .filter((element) => element.type === 'way' && Array.isArray(element.nodes) && element.nodes.length >= 2 && isUsableRoadWay(element))
    .map((way) => [way.id, way]));

  const graph = buildGraph(relation.members
    .filter((member) => member.type === 'way')
    .map((member) => wayById.get(member.ref))
    .filter(Boolean)
    .map((way) => way.nodes.map((nodeId) => nodeById.get(nodeId)).filter(Boolean))
    .filter((coords) => coords.length >= 2));

  if (graph.coords.size < 2) throw new Error('OSM relation has too few usable route nodes');
  const endpointKeys = [...graph.coords.keys()].filter((key) => (graph.adjacency.get(key) || []).length <= 1);
  const candidates = endpointKeys.length >= 2 ? endpointKeys : [...graph.coords.keys()];
  const aKey = farthestKeyFrom(graph, candidates[0], candidates);
  const bKey = farthestKeyFrom(graph, aKey, candidates);
  const raw = [graph.coords.get(aKey), graph.coords.get(bKey)].filter(Boolean);

  const termini = [];
  for (let index = 0; index < raw.length; index += 1) {
    const lngLat = raw[index];
    const label = await reverseGeocode(lngLat).catch(() => `推定端点${index + 1}`);
    termini.push({ label, lngLat: roundCoord(lngLat), source: 'OSM route graph endpoint', confidence: 'medium' });
  }
  return { termini };
}

async function reverseGeocode([lng, lat]) {
  const data = await fetchOsmJson('https://nominatim.openstreetmap.org/reverse?' + new URLSearchParams({
    format: 'jsonv2',
    lat: String(lat),
    lon: String(lng),
    zoom: '16',
    addressdetails: '1',
    'accept-language': 'ja'
  }));
  const address = data.address || {};
  const state = address.state || address.province;
  const city = address.city || address.town || address.village || address.municipality || address.county;
  const district = address.city_district || address.suburb || address.quarter || address.neighbourhood || address.hamlet;
  const road = address.road;
  const name = data.name && data.name !== road ? data.name : null;
  const parts = [state, city, district, name, road].filter(Boolean);
  const compact = dedupeStrings(parts).slice(0, 4);
  if (compact.length >= 2) return `${compact.join(' ')} 付近`;
  const displayParts = String(data.display_name || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (displayParts.length) return `${displayParts.slice(0, 4).reverse().join(' ')} 付近`;
  return '地名未取得';
}

async function searchRouteEntities(routeNumber) {
  const searches = [
    { language: 'ja', text: `国道${routeNumber}号` },
    { language: 'en', text: `Japan National Route ${routeNumber}` },
    { language: 'en', text: `National Route ${routeNumber} Japan` }
  ];
  const ids = [];
  for (const search of searches) {
    const data = await fetchWikidataJson('https://www.wikidata.org/w/api.php?' + new URLSearchParams({
      action: 'wbsearchentities',
      format: 'json',
      language: search.language,
      uselang: search.language,
      type: 'item',
      limit: '10',
      search: search.text
    }));
    for (const item of data.search || []) {
      if (item.id && !ids.includes(item.id)) ids.push(item.id);
    }
  }
  return ids;
}

async function fetchEntities(ids, props) {
  return fetchWikidataJson('https://www.wikidata.org/w/api.php?' + new URLSearchParams({
    action: 'wbgetentities',
    format: 'json',
    ids: ids.join('|'),
    props,
    languages: 'ja|en'
  }));
}

function chooseRouteEntity(entities, routeNumber) {
  const scored = entities.map((entity) => {
    const labelJa = entity.labels?.ja?.value || '';
    const labelEn = entity.labels?.en?.value || '';
    const descriptionJa = entity.descriptions?.ja?.value || '';
    const descriptionEn = entity.descriptions?.en?.value || '';
    const text = `${labelJa} ${labelEn} ${descriptionJa} ${descriptionEn}`.toLowerCase();
    let score = 0;
    if (labelJa.includes(`国道${routeNumber}号`)) score += 100;
    if (labelEn.toLowerCase().includes(`national route ${routeNumber}`)) score += 90;
    if (readFirstNumericClaim(entity, 'P402')) score += 40;
    if (readEntityClaims(entity, 'P559').length) score += 30;
    if (text.includes('japan')) score += 20;
    if (text.includes('国道')) score += 20;
    return { entity, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].entity : null;
}

function candidateFromEntity(entity, source) {
  const lngLat = readCoordinateClaim(entity, 'P625');
  if (!lngLat) return null;
  return { label: labelOf(entity), lngLat, source, confidence: 'medium' };
}

function readFirstNumericClaim(entity, property) {
  const value = (entity.claims?.[property] || [])[0]?.mainsnak?.datavalue?.value;
  const number = Number(String(value || '').replace(/[^0-9]/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function readEntityClaims(entity, property) {
  return (entity.claims?.[property] || [])
    .map((claim) => claim.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
}

function readCoordinateClaim(entity, property) {
  const value = (entity.claims?.[property] || [])[0]?.mainsnak?.datavalue?.value;
  if (!value || typeof value.longitude !== 'number' || typeof value.latitude !== 'number') return null;
  return [round(value.longitude, 6), round(value.latitude, 6)];
}

async function fetchWikidataJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'mapbox07-route-director/1.0' }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOsmJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'mapbox07-route-director/1.0' }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildGraph(ways) {
  const coords = new Map();
  const adjacency = new Map();
  for (const way of ways) {
    const clean = deduplicate(way);
    for (let index = 0; index < clean.length - 1; index += 1) {
      const a = clean[index];
      const b = clean[index + 1];
      const weight = distanceKm(a, b);
      if (weight <= 0 || weight > 3.5) continue;
      const aKey = coordKey(a);
      const bKey = coordKey(b);
      coords.set(aKey, a);
      coords.set(bKey, b);
      addEdge(adjacency, aKey, bKey, weight);
      addEdge(adjacency, bKey, aKey, weight);
    }
  }
  return { coords, adjacency };
}

function addEdge(adjacency, from, to, weight) {
  if (!adjacency.has(from)) adjacency.set(from, []);
  const existing = adjacency.get(from).find((edge) => edge.to === to);
  if (existing) existing.weight = Math.min(existing.weight, weight);
  else adjacency.get(from).push({ to, weight });
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

function isUsableRoadWay(way) {
  const highway = way.tags?.highway;
  return Boolean(highway) && !['footway', 'cycleway', 'path', 'steps', 'pedestrian', 'service', 'track'].includes(highway);
}

function mergeCandidates(primary = [], secondary = []) {
  const seen = new Set();
  const result = [];
  for (const candidate of [...primary, ...secondary]) {
    if (!candidate?.lngLat) continue;
    const key = candidate.lngLat.map((value) => Number(value).toFixed(5)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function labelCandidates(candidates, routeNumber) {
  return candidates.map((candidate, index) => {
    const letter = String.fromCharCode(65 + index);
    const label = isVagueLabel(candidate.label, routeNumber) ? `推定端点${letter}（地名取得不足）` : candidate.label;
    return { ...candidate, label: `候補${letter}: ${label}` };
  });
}

function isVagueLabel(label, routeNumber) {
  const text = String(label || '').trim();
  if (!text) return true;
  return text === `国道${routeNumber}号` || text === `国道${routeNumber}号 周辺` || text === `Route ${routeNumber}` || text.length <= 4;
}

function dedupeStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = String(value).trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundsFromCandidates(candidates) {
  const points = candidates.map((candidate) => candidate.lngLat).filter(Boolean);
  if (points.length < 2) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of points) {
    west = Math.min(west, lng);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    north = Math.max(north, lat);
  }
  const pad = 0.08;
  return [round(west - pad, 5), round(south - pad, 5), round(east + pad, 5), round(north + pad, 5)];
}

function labelOf(entity) {
  return entity.labels?.ja?.value || entity.labels?.en?.value || entity.id || '名称未取得';
}

function cleanRouteNumber(value) {
  return String(value || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 32);
}

function coordKey(coord) {
  return `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;
}

function deduplicate(coords) {
  const result = [];
  for (const coord of coords) {
    const last = result[result.length - 1];
    if (!last || distanceKm(last, coord) > 0.003) result.push(coord);
  }
  return result;
}

function roundCoord(coord) {
  return [round(coord[0], 6), round(coord[1], 6)];
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
