const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const ROUTE_128_RELATION_ID = 9069158;

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
    rel(${ROUTE_128_RELATION_ID})->.route;
    .route out body;
    way(r.route);
    out geom;
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
  const relation = osm.elements.find((element) => element.type === 'relation' && element.id === ROUTE_128_RELATION_ID);
  const ways = new Map(
    osm.elements
      .filter((element) => element.type === 'way' && Array.isArray(element.geometry))
      .map((way) => [way.id, way])
  );

  if (!relation) throw new Error('Route relation was not included in the Overpass response');
  if (!ways.size) throw new Error('No route ways were included in the Overpass response');

  const orderedWayCoordinates = relation.members
    .filter((member) => member.type === 'way' && ways.has(member.ref))
    .map((member) => {
      const way = ways.get(member.ref);
      return way.geometry.map((point) => [point.lon, point.lat]);
    });

  const coordinates = stitchWays(orderedWayCoordinates);

  if (coordinates.length < 2) {
    throw new Error('Could not stitch Route 128 ways into a usable LineString');
  }

  return {
    type: 'FeatureCollection',
    metadata: {
      source: 'OpenStreetMap via Overpass API',
      relationId: ROUTE_128_RELATION_ID,
      license: 'ODbL-1.0',
      extractedAt: new Date().toISOString()
    },
    features: [
      {
        type: 'Feature',
        properties: {
          id: 'route128_main',
          name: relation.tags?.name || '国道128号',
          ref: relation.tags?.ref || '128',
          network: relation.tags?.network || 'JP:national',
          osm_relation_id: ROUTE_128_RELATION_ID
        },
        geometry: {
          type: 'LineString',
          coordinates
        }
      }
    ]
  };
}

function stitchWays(ways) {
  const remaining = ways
    .filter((coords) => coords.length >= 2)
    .map((coords) => coords.slice());

  if (!remaining.length) return [];

  let stitched = remaining.shift();

  while (remaining.length) {
    const end = stitched[stitched.length - 1];
    let bestIndex = -1;
    let bestReverse = false;
    let bestDistance = Infinity;

    for (let index = 0; index < remaining.length; index++) {
      const coords = remaining[index];
      const forwardDistance = pointDistance(end, coords[0]);
      const reverseDistance = pointDistance(end, coords[coords.length - 1]);

      if (forwardDistance < bestDistance) {
        bestIndex = index;
        bestReverse = false;
        bestDistance = forwardDistance;
      }
      if (reverseDistance < bestDistance) {
        bestIndex = index;
        bestReverse = true;
        bestDistance = reverseDistance;
      }
    }

    const next = remaining.splice(bestIndex, 1)[0];
    const oriented = bestReverse ? next.reverse() : next;
    stitched = appendCoordinates(stitched, oriented);
  }

  return stitched;
}

function appendCoordinates(base, next) {
  if (!base.length) return next;
  if (!next.length) return base;

  const last = base[base.length - 1];
  const first = next[0];
  const shouldSkipFirst = pointDistance(last, first) < 0.000001;
  return base.concat(shouldSkipFirst ? next.slice(1) : next);
}

function pointDistance(a, b) {
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  const y = b[1] - a[1];
  return Math.sqrt(x * x + y * y);
}
