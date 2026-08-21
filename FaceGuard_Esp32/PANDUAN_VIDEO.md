# CCTV 25 FPS dan bukti kejadian

ESP32-CAM menghantar JPEG CIF (400x296) melalui satu sambungan HTTP berterusan
dengan sasaran 25 FPS. Inference server merelay setiap frame ke aplikasi, tetapi
AI memproses frame terkini sahaja mengikut nilai `inference_fps` dalam Supabase.

Live stream tidak disimpan bingkai demi bingkai. Apabila fall detection
disahkan, server:

1. menghasilkan snapshot beranotasi;
2. memuat naik fail ke bucket private `faceguard-storage` dengan laluan
   `<device-id>/falls/...`;
3. memasukkan event `orang_jatuh` ke `aktiviti_log`; dan
4. menghantar alert melalui Supabase Realtime kepada pemilik peranti.

Semua tetapan kamera dibuat dalam halaman Tetapan aplikasi selepas log masuk.
Viewer token kekal pada telefon, manakala nama, lokasi, URL server, Device ID,
target FPS, FPS AI dan tempoh pengesahan disimpan di Supabase.

Untuk operasi stabil, gunakan bekalan 5V yang baik, PSRAM, Wi-Fi 2.4 GHz yang
kuat dan inference server HTTPS/WSS yang sentiasa hidup.
