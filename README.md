# FaceGuard

FaceGuard ialah aplikasi CCTV ESP32-CAM dengan fall detection pada inference
server. ESP32-CAM menghantar stream JPEG QQVGA melalui WebSocket dengan sasaran 25 FPS,
server merelay video tanpa menunggu AI, dan aplikasi menerima paparan serta
alert secara masa nyata.

## Komponen projek

- Aplikasi web PWA: Vite + Supabase Realtime + WebSocket CCTV
- Firmware: `FaceGuard_Esp32/FaceGuard_Esp32.ino`
- Inference server: FastAPI + Ultralytics YOLO Pose
- Peranti: ESP32-CAM sahaja; model AI berjalan pada server
- Cloud: projek Supabase `FaceGuard` (`nscqzfkuanfgxzfwukty`)

## Jalankan aplikasi web

```bash
npm install
npm run dev
```

## Bina aplikasi web

```bash
npm run build
```

## Bina APK Android

```bash
npm run android:sync
cd android
./gradlew assembleRelease
```

APK yang telah diuji disimpan sebagai `releases/FaceGuard-Android.apk`. Halaman
`/download.html` menyediakan butang muat turun melalui Chrome.

Versi semasa ialah **2.1.3**. Pada pembukaan pertama, daftar/log masuk dalam
halaman Tetapan, kemudian simpan nama kamera, lokasi, URL server, Device ID,
25 FPS CCTV, FPS AI dan tempoh pengesahan jatuh. Tetapan peranti serta aktiviti
disimpan dengan RLS; media kejadian menggunakan signed URL daripada bucket
private `faceguard-storage`.

Versi 2.1.2 menambah pairing terus dalam APK Android dan menggunakan sesi
Supabase pengguna secara automatik untuk paparan CCTV. Selepas firmware pertama
diflash, sambung telefon ke Wi-Fi yang bermula dengan `FACEGUARD-`, buka Tetapan aplikasi, isi Wi-Fi
2.4 GHz dan tekan **Sambungkan ESP32**. Tetapan disimpan dalam ESP32 dan ia akan
auto-connect setiap kali menerima kuasa tanpa laptop.

Versi 2.1.3 menyegerakkan jam ESP32-CAM sebelum sambungan WSS supaya sijil TLS
Render dapat disahkan selepas peranti boot. Aplikasi kini turut membezakan server
aktif daripada ESP32-CAM luar talian, jadi skrin kamera memaparkan punca yang
boleh diambil tindakan dan bukan sekadar `Menunggu CCTV`.

## Sediakan ESP32-CAM

1. Salin `FaceGuard_Esp32/secrets.example.h` sebagai `FaceGuard_Esp32/secrets.h`.
2. Isi token peranti dan kata laluan AP pairing; Wi-Fi serta URL server boleh
   dihantar daripada APK Android.
3. Buka `FaceGuard_Esp32.ino` dalam Arduino IDE dan pilih papan **AI Thinker ESP32-CAM**.
4. Pasang library Arduino **ArduinoWebsockets by Gil Maimon** versi 0.5.4.
5. Compile dan upload firmware.

`secrets.h` sengaja tidak dimasukkan ke GitHub.

## Jalankan inference server

Lihat `inference_server/README.md`. Server perlu mempunyai URL HTTPS awam dan
menyokong WebSocket. Selepas server hidup, buka Tetapan aplikasi dan masukkan
URL server dan Device ID yang sama. Paparan viewer menggunakan sesi akaun
Supabase secara automatik.

Fall detection prototaip memerlukan urutan pose berdiri, bertukar mendatar dan
kekal mendatar. Nilai confirmation/cooldown boleh dilaras melalui environment
server.

## Supabase

Skema yang telah digunakan pada projek cloud berada di
`supabase/20260819_faceguard_latest.sql`. Ia menyediakan jadual `devices` dan
`aktiviti_log`, RLS mengikut `auth.uid()`, Supabase Realtime dan polisi Storage
private. Live 25 FPS tidak disimpan bingkai demi bingkai; hanya status terkini,
tetapan, event, snapshot dan klip bukti disimpan.

`inference_server/.env` mengandungi kunci server dan token lokal serta telah
dikecualikan melalui `.gitignore`. Gunakan secret manager apabila deploy.
