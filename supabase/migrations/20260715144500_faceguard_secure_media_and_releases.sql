insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'faceguard-releases',
  'faceguard-releases',
  true,
  26214400,
  array['application/vnd.android.package-archive']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

update public.aktiviti_log
set storage_path = nullif(split_part(image_url, '/faceguard-storage/', 2), '')
where storage_path is null
  and image_url like '%/faceguard-storage/%';

update storage.buckets
set public = false
where id = 'faceguard-storage';

drop policy if exists "Enable insert for ESP32CAM" on public.aktiviti_log;
drop policy if exists "FaceGuard app read activity" on public.aktiviti_log;
drop policy if exists "FaceGuard ESP32 uploads" on storage.objects;

drop policy if exists "FaceGuard temporary release upload" on storage.objects;
create policy "FaceGuard temporary release upload"
on storage.objects for insert to anon
with check (bucket_id = 'faceguard-releases');
