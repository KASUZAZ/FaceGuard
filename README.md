# FaceGuard

FaceGuard ialah aplikasi pemantauan kamera ESP32-CAM. Kamera mengesan perubahan imej tanpa sensor tambahan, memuat naik gambar ke Supabase, dan aplikasi memaparkan aktiviti secara masa nyata.

## Komponen projek

- Aplikasi web PWA: Vite + Supabase Realtime
- Firmware: `FaceGuard_Esp32/FaceGuard_Esp32.ino`
- Peranti: ESP32-CAM sahaja

## Jalankan aplikasi web

```bash
npm install
npm run dev
```

## Bina aplikasi web

```bash
npm run build
```

## Sediakan ESP32-CAM

1. Salin `FaceGuard_Esp32/secrets.example.h` sebagai `FaceGuard_Esp32/secrets.h`.
2. Isi nama Wi-Fi, kata laluan Wi-Fi, URL Supabase dan publishable key.
3. Buka `FaceGuard_Esp32.ino` dalam Arduino IDE dan pilih papan **AI Thinker ESP32-CAM**.
4. Compile dan upload firmware.

`secrets.h` sengaja tidak dimasukkan ke GitHub.
