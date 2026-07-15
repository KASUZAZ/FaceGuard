# FaceGuard 2.1

FaceGuard ialah sistem kamera keselamatan ESP32-CAM yang menggunakan aplikasi
Android, Supabase dan rangkaian Wi-Fi tempatan. Versi ini tidak memerlukan PIR:
kamera membandingkan imej untuk mengesan gerakan.

## Fungsi semasa

- Kamera telefon boleh mengimbas QR Wi-Fi router/hotspot dan mengisi SSID serta
  kata laluan secara automatik.
- Setup ESP32 melalui QR dalam aplikasi; SSID dan kata laluan tidak perlu
  dimasukkan dalam kod Arduino.
- Live MJPEG terus daripada ESP32-CAM apabila telefon berada pada Wi-Fi sama.
- Gambar automatik apabila gerakan dikesan dan butang snapshot manual.
- Realtime activity, notifikasi tempatan, lihat dan padam gambar.
- Akaun dan perkongsian kamera dengan had maksimum 5 pengguna.
- Semakan versi dan butang muat turun APK baharu.
- Gambar CCTV dalam bucket private; APK berada dalam bucket release awam.

Rakaman video panjang memerlukan kad microSD. Tanpa microSD, firmware 2.0
menyediakan live video dan snapshot automatik/manual sahaja.

## Setup pengguna

1. Pasang APK FaceGuard dan daftar/log masuk akaun.
2. Pastikan ESP32-CAM telah dipasang firmware 2.0 dan hidup dengan bekalan 5V
   yang stabil.
3. Dalam aplikasi tekan **+ Kamera**.
4. Masukkan Wi-Fi 2.4 GHz yang sama dengan telefon dan jana QR.
5. Tunjukkan QR pada jarak kira-kira 15-25 cm daripada lensa.
6. Tunggu kamera muncul sebagai online, kemudian tekan **Mulakan live**.

ESP32-CAM tidak mempunyai skrin. Oleh itu aplikasi yang memaparkan QR, lalu
lensa ESP32-CAM mengimbas QR tersebut.

## Struktur projek

- `app.js`, `index.html`, `styles.css` — aplikasi/PWA.
- `android/` — projek Android Capacitor.
- `FaceGuard_Esp32/FaceGuard_Esp32.ino` — firmware kamera.
- `FaceGuard_Esp32/libraries/ESP32QRCodeReader/` — library QR yang telah
  disesuaikan untuk ESP32 Arduino Core 3.x.
- `supabase/migrations/` — skema, RLS dan had lima pengguna.
- `supabase/functions/faceguard-device/` — API selamat kamera, media dan invite.
- `releases/FaceGuard-Android.apk` — APK Android terkini.

## Build

```powershell
npm install
npm run build
npm run android:sync
```

Kemudian buka folder `android` dalam Android Studio atau jalankan Gradle untuk
menghasilkan APK. Firmware dikompil sebagai `esp32:esp32:esp32cam` dan library
dalam `FaceGuard_Esp32/libraries` mesti disertakan.

## Notifikasi

Notifikasi tempatan berfungsi semasa aplikasi menerima event Realtime. Push
notification ketika aplikasi ditutup memerlukan fail Firebase
`android/app/google-services.json` dan secret Edge Function
`FCM_SERVICE_ACCOUNT_JSON`; kedua-duanya tidak disimpan dalam Git.

## Keselamatan

- Rahsia peranti dan token live dijana pada ESP32 dan disimpan dalam NVS.
- Firmware upload gambar melalui Edge Function, bukan polisi anonymous.
- RLS membenarkan hanya ahli kamera melihat aktiviti.
- Jangan commit `FaceGuard_Esp32/secrets.h`, Firebase service account atau fail
  signing release.
