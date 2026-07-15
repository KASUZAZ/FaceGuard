drop policy if exists "FaceGuard temporary release upload" on storage.objects;

insert into public.faceguard_app_releases (
  version_code,
  version_name,
  apk_url,
  release_notes,
  minimum_android,
  published_at
) values (
  5,
  '2.1.2',
  'https://rerhdlfuiemsuzygjzqx.supabase.co/storage/v1/object/public/faceguard-releases/FaceGuard-2.1.2.apk',
  'Safe-start Android: buang plugin notifikasi native dan kod Activity tersuai, guna konfigurasi rasmi mixed-content, susun semula manifest, dan kekalkan alert dalam aplikasi.',
  24,
  now()
)
on conflict (version_code) do update set
  version_name = excluded.version_name,
  apk_url = excluded.apk_url,
  release_notes = excluded.release_notes,
  minimum_android = excluded.minimum_android,
  published_at = excluded.published_at;
