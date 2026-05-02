create table if not exists public.scenes (
  id text primary key,
  sort_order integer not null unique,
  title text not null,
  lng_lat jsonb not null,
  zoom numeric not null,
  pitch numeric not null default 0,
  bearing numeric not null default 0,
  duration integer not null default 10000,
  overlay_image text,
  overlay_coords jsonb,
  highlight_route_id text
);

alter table public.scenes enable row level security;

drop policy if exists "Public scenes are readable" on public.scenes;
create policy "Public scenes are readable"
on public.scenes
for select
to anon
using (true);

insert into public.scenes (
  id,
  sort_order,
  title,
  lng_lat,
  zoom,
  pitch,
  bearing,
  duration,
  overlay_image,
  overlay_coords,
  highlight_route_id
) values
  (
    'route128-opening',
    10,
    '国道128号線：海岸線に残る記憶',
    '[140.34, 35.33]'::jsonb,
    11.5,
    55,
    18,
    9000,
    null,
    null,
    'route128_main'
  ),
  (
    'ichinomiya-castle',
    20,
    '一宮城跡：消えた要塞',
    '[140.36, 35.37]'::jsonb,
    17,
    60,
    45,
    10000,
    'https://upload.wikimedia.org/wikipedia/commons/5/59/Old_map_of_Japan.jpg',
    '[[140.3538,35.3748],[140.3678,35.3748],[140.3678,35.3657],[140.3538,35.3657]]'::jsonb,
    'route128_main'
  ),
  (
    'katsuura-coast',
    30,
    '勝浦海岸：港町の境界線',
    '[140.315, 35.151]'::jsonb,
    14.2,
    62,
    -28,
    11000,
    null,
    null,
    'route128_main'
  )
on conflict (id) do update set
  sort_order = excluded.sort_order,
  title = excluded.title,
  lng_lat = excluded.lng_lat,
  zoom = excluded.zoom,
  pitch = excluded.pitch,
  bearing = excluded.bearing,
  duration = excluded.duration,
  overlay_image = excluded.overlay_image,
  overlay_coords = excluded.overlay_coords,
  highlight_route_id = excluded.highlight_route_id;
