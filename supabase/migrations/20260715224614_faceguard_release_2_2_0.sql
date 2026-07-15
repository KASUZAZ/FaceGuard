insert into public.faceguard_app_releases (
  version_code,
  version_name,
  apk_url,
  release_notes,
  minimum_android,
  published_at
) values (
  7,
  '2.2.0',
  'https://github.com/KASUZAZ/FaceGuard/releases/download/v2.2.0/FaceGuard-Android.apk',
  'Live camera bermula secara automatik, menyambung semula jika rangkaian terputus, menggunakan JPEG fallback jika MJPEG gagal, dan pengesanan gerakan terus berjalan semasa live aktif. Firmware ESP32 2.1.0 diperlukan untuk fungsi penuh.',
  24,
  now()
)
on conflict (version_code) do update set
  version_name = excluded.version_name,
  apk_url = excluded.apk_url,
  release_notes = excluded.release_notes,
  minimum_android = excluded.minimum_android,
  published_at = excluded.published_at;
