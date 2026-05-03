const VERIFIED_ENDPOINTS = {
  '128': {
    start: [{ label: '千葉市中央区 広小路交差点付近', lngLat: [140.12462, 35.61059], source: 'verified project preset', confidence: 'high' }],
    end: [{ label: '館山市方面 終点付近', lngLat: [139.86315, 34.99318], source: 'verified project preset', confidence: 'medium' }],
    bounds: [139.72, 34.86, 140.62, 35.72]
  },
  '134': {
    start: [{ label: '横須賀市 三春町二丁目交差点付近', lngLat: [139.686972, 35.266611], source: 'verified route endpoint', confidence: 'high' }],
    end: [{ label: '中郡大磯町 大磯駅入口交差点付近', lngLat: [139.316528, 35.311083], source: 'verified route endpoint', confidence: 'high' }],
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
    const verified = VERIFIED_ENDPOINTS[routeNumber] || { start: [], end: [], bounds: null };
    const wikidata = await lookupWikidataRoute(routeNumber).catch((error) => ({ error: error.message, relationId: null, start: [], end: [] }));
    const start = mergeCandidates(verified.start, wikidata.start);
    const end = mergeCandidates(verified.end, wikidata.end);
    const bounds = verified.bounds || boundsFromCandidates([...start, ...end]);

    response.status(200).json({
      routeNumber,
      relationId: wikidata.relationId || null,
      relationLabel: wikidata.label || `国道${routeNumber}号`,
      start,
      end,
      bounds,
      sourceStatus: { verified: Boolean(VERIFIED_ENDPOINTS[routeNumber]), wikidataError: wikidata.error || null }
    });
  } catch (error) {
    response.status(502).json({ error: `国道${routeNumber}号の起終点候補を取得できませんでした`, detail: error.message });
  }
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
  const endpoints = Object.values(endpointEntities.entities || {})
    .map((entity) => candidateFromEntity(entity, 'Wikidata terminus'))
    .filter(Boolean);

  const point = readCoordinateClaim(route, 'P625');
  const routePoint = point ? [{ label: `${labelOf(route)} 中心座標`, lngLat: point, source: 'Wikidata route coordinate', confidence: 'low' }] : [];

  return {
    relationId,
    label: labelOf(route),
    start: endpoints.slice(0, 1).concat(routePoint),
    end: endpoints.slice(1, 2)
  };
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

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
