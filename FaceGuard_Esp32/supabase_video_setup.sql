-- Jalankan sekali dalam Supabase SQL Editor sebelum menggunakan kod baharu.
-- Column ini menyimpan URL fail AVI yang di-upload oleh ESP32-CAM.

alter table public.aktiviti_log
  add column if not exists video_url text;
