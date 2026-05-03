export default function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  const envConfig = readJsonConfig(process.env.MAPBOX_TOKEN) || {};
  response.status(200).json({
    mapboxToken: cleanToken(envConfig.mapboxToken || process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN || ''),
    supabaseUrl: cleanText(envConfig.supabaseUrl || process.env.SUPABASE_URL || ''),
    supabaseAnonKey: cleanText(envConfig.supabaseAnonKey || process.env.SUPABASE_ANON_KEY || '')
  });
}

function readJsonConfig(value) {
  const text = cleanText(value);
  if (!text.startsWith('{')) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function cleanToken(value) {
  const text = cleanText(value).replace(/^['"]|['"]$/g, '');
  const match = text.match(/pk\.[A-Za-z0-9._-]+/);
  return match ? match[0] : text;
}

function cleanText(value) {
  return String(value || '').replace(/\\n/g, '').replace(/[\r\n\t]/g, '').trim();
}
