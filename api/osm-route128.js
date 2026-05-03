const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const ROUTE_128_RELATION_ID = 9069158;
const CHIBA_BBOX = '34.90,139.75,35.70,140.45';
const MAX_JOIN_KM = 1.8;

export default async function handler(request, response) {
  response.setHeader('cache-control', 's-maxage=86400, stale-while-revalidate=604800');

  try {
    const geojson = await fetchRoute128FromOverpass();
    response.status(200).json(geojson);
  } catch (error) {
    response.status(502).json({
      error: 'Failed to extract Route 128 from OpenStreetMap Overpass API',
      detail: error.message
    });
  }
}

async function fetchRoute128FromOverpass() {
  const query = `
    [out:json][timeout:60];
    (
      way["highway"]["ref"~"(^|;| )128($|;| )"](${CHIBA_BBOX});
      way["highway"]["nat_ref"~"(^|;| )128($|;| )"](${CHIBA_BBOX});
      rel(${ROUTE_128_RELATION_ID});
      way(r)["highway"];
    );
    out tags geom;
  `;

  const overpassResponse = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ data: query })
  });

  if (!overpassResponse.ok) {
    throw new Error(`Overpass responded ${overpassResponse.status}`);
  }

  const osm = await overpassResponse.json();
  const wayCoordinates = osm.elements
    .filter((element) => element.type === 'way' && Array.isArray(element.geometry) && element.geometry.length >= 2)
    .filter((way) => isRoute128Way(way))
    .map((way) => way.geometry.map((point) => [point.lon, point.lat]));

  if (!wayCoordinates.length) throw new Error('No Route 128 ways were included in the Overpass response');

  const components = buildConnectedComponents(wayCoordinates);
  const best = components
    .filter((coords) => coords.length >= 2)
    .sort((a, b) => pathLengthKm(b) - pathLengthKm(a))[0];

  if (!best || best.length < 2) throw new Error('Could not build a continuous Route 128 component');

  const coordinates = orientNorthToSouth(deduplicate(best));

  return {
    type: 'FeatureCollection',
    metadata: {
      source: 'OpenStreetMap via Overpass API',
      relationId: ROUTE_128_RELATION_ID,
      extraction: 'highway ways tagged ref/nat_ref=128, longest connected component, no long sea-gap joins',
      license: 'ODbL-1.0',
      maxJoinKm: MAX_JOIN_KM,
      extractedAt: new Date().toISOString()
    },
    features: [
      {
        type: 'Feature',
        properties: {
          id: 'route128_main',
          name: '国道128号',
          ref: '128',
          network: 'JP:national',
          osm_relation_id: ROUTE_128_RELATION_ID
        },
        geometry: { type: 'LineString', coordinates }
      }
    ]
  };
}

function isRoute128Way(way) {
  const tags = way.tags || {};
  const ref = `${tags.ref || ''};${tags.nat_ref || ''};${tags.name || ''}`;
  return /(^|[^0-9])128([^0-9]|$)/.test(ref) || /国道128号/.test(ref);
}

function buildConnectedComponents(ways) {
  const remaining = ways.map((coords) => coords.slice());
  const components = [];

  while (remaining.length) {
    let component = remaining.shift();
    let changed = true;

    while (changed) {
      changed = false;
      for (let index = remaining.length - 1; index >= 0; index--) {
        const candidate = remaining[index];
        const join = bestEndpointJoin(component, candidate);
        if (join.distanceKm <= MAX_JOIN_KM) {
          component = applyJoin(component, candidate, join.mode);
          remaining.splice(index, 1);
          changed = true;
        }
      }
    }

    components.push(component);
  }

  return components;
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
  if (!base.length) return next;
  if (!next.length) return base;

  const last = base[base.length - 1];
  const first = next[0];
  const shouldSkipFirst = distanceKm(last, first) < 0.003;
  return base.concat(shouldSkipFirst ? next.slice(1) : next);
}

function orientNorthToSouth(coords) {
  const first = coords[0];
  const last = coords[coords.length - 1];
  return first[1] >= last[1] ? coords : coords.slice().reverse();
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

function toRadians(value) {
  return value * Math.PI / 180;
}
