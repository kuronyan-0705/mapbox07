const ROUTE_128_RELATION_ID = 9069158;
const ROUTE_128_COORDINATES = [
  [139.86315, 34.99318],
  [139.83560, 35.01770],
  [139.84510, 35.04440],
  [139.85920, 35.06980],
  [139.89050, 35.08910],
  [139.92520, 35.09810],
  [139.97090, 35.09770],
  [140.01510, 35.08930],
  [140.07030, 35.08060],
  [140.12430, 35.08220],
  [140.18030, 35.09260],
  [140.22950, 35.10640],
  [140.26730, 35.12110],
  [140.29730, 35.13660],
  [140.31520, 35.15120],
  [140.30630, 35.18430],
  [140.30680, 35.21940],
  [140.31770, 35.25850],
  [140.32620, 35.29170],
  [140.33920, 35.32330],
  [140.35940, 35.34860],
  [140.36800, 35.37410],
  [140.36550, 35.40100],
  [140.35990, 35.43720],
  [140.35730, 35.46620],
  [140.36030, 35.48650],
  [140.36620, 35.50920],
  [140.37600, 35.52930],
  [140.36770, 35.55320],
  [140.31980, 35.55960],
  [140.25210, 35.54620],
  [140.20350, 35.56330],
  [140.16880, 35.58520],
  [140.14610, 35.59860],
  [140.12462, 35.61059]
];

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  response.status(200).json(buildRoute128GeoJson());
}

function buildRoute128GeoJson() {
  return {
    type: 'FeatureCollection',
    metadata: {
      source: 'Route 128 cinematic control path with verified official endpoints',
      relationId: ROUTE_128_RELATION_ID,
      extraction: 'Tateyama Hojo intersection to Chiba Hirokoji intersection; no sea-gap stitching',
      licenseNote: 'Use OpenStreetMap extraction only after segment validation is complete.',
      start: 'Tateyama Hojo intersection',
      end: 'Chiba Hirokoji intersection',
      noSeaSection: true,
      pathKm: round(pathLengthKm(ROUTE_128_COORDINATES), 2),
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
          osm_relation_id: ROUTE_128_RELATION_ID,
          role: 'camera-path',
          start: '館山市 北条交差点',
          end: '千葉市中央区 広小路交差点'
        },
        geometry: { type: 'LineString', coordinates: ROUTE_128_COORDINATES }
      }
    ]
  };
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
