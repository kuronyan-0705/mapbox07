export default function handler(request, response) {
  response.setHeader("cache-control", "no-store");
  response.status(200).json({
    mapboxToken: process.env.MAPBOX_TOKEN || "",
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ""
  });
}
