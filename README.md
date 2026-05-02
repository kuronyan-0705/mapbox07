# Route 128 Topographic Mystery Director

Mapbox GL JSで国道128号線の地誌ミステリー動画を撮るための、オートパイロット型・地図演出システムです。

## Architecture

- Frontend: static HTML, CSS, JavaScript
- Map: Mapbox GL JS `mapbox://styles/mapbox/dark-v11`
- Hosting: Vercel
- Scenario CMS: Supabase `public.scenes`
- CI/CD: GitHub Actions to Vercel Production

## Vercel Environment Variables

Set these variables in the Vercel project.

```txt
MAPBOX_TOKEN
SUPABASE_URL
SUPABASE_ANON_KEY
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are optional. If they are missing, the app falls back to `storyline.json`.

## Supabase Setup

Run `supabase/schema.sql` in the Supabase SQL editor. It creates the `scenes` table, enables RLS, allows public read access for scenes, and seeds the first three scenes.

## GitHub Secrets

For GitHub Actions deployment, set these repository secrets.

```txt
VERCEL_TOKEN
VERCEL_ORG_ID
VERCEL_PROJECT_ID
```

## Controls

- Space: next scene
- R: autoplay from scene 1
- L: toggle current old-map overlay opacity

## Scenario Fields

Each Supabase row maps to one scene.

```json
{
  "id": "ichinomiya-castle",
  "title": "一宮城跡：消えた要塞",
  "lng_lat": [140.36, 35.37],
  "zoom": 17,
  "pitch": 60,
  "bearing": 45,
  "duration": 10000,
  "overlay_image": "https://example.com/old-map.png",
  "overlay_coords": [[140.3538, 35.3748], [140.3678, 35.3748], [140.3678, 35.3657], [140.3538, 35.3657]],
  "highlight_route_id": "route128_main"
}
```
