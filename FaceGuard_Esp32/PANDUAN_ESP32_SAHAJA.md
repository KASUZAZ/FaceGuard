# Panduan ESP32-CAM FaceGuard 2.1

## Barang diperlukan

1. ESP32-CAM AI Thinker dengan kamera OV2640.
2. ESP32-CAM-MB atau USB-to-serial untuk upload firmware.
3. Bekalan 5V yang stabil.
4. Telefon Android dengan aplikasi FaceGuard.
5. Wi-Fi 2.4 GHz. ESP32-CAM tidak menyokong Wi-Fi 5 GHz.

PIR, buzzer dan breadboard tidak digunakan dalam versi ini. Kad microSD hanya
diperlukan jika mahu menambah rakaman video panjang kemudian.

## Firmware automatik 2.1

Firmware 2.1 menghidupkan Live secara automatik daripada aplikasi, terus
mengesan gerakan semasa Live sedang ditonton, dan menyimpan gambar gerakan ke
Supabase tanpa perlu menekan **Ambil gambar**. Firmware ini perlu diflash ke
ESP32-CAM sebelum ciri automatik boleh digunakan. Semasa belum disetup, Serial
Monitor 115200 akan memaparkan:

```text
Belum ada Wi-Fi. Tunjukkan QR setup daripada aplikasi.
Mod QR aktif. Pegang skrin 15-25 cm daripada lensa.
```

## Cara pairing

1. Hidupkan ESP32-CAM.
2. Buka FaceGuard dan log masuk.
3. Tekan **+ Kamera**.
4. Masukkan SSID dan kata laluan Wi-Fi 2.4 GHz.
5. Tekan **Jana QR setup**.
6. Naikkan kecerahan telefon dan halakan QR terus kepada lensa pada jarak
   15-25 cm.
7. Apabila QR berjaya, ESP32 restart, sambung Wi-Fi dan kamera muncul dalam app.
8. Telefon mesti kekal pada Wi-Fi sama untuk melihat live stream.

Jika Wi-Fi tersalah, restart papan ketika rangkaian lama tidak dapat dicapai;
firmware akan kembali ke mod QR supaya QR baharu boleh diimbas.

## Compile semula

Arduino CLI perlu diberi folder library projek:

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32cam `
  --libraries .\FaceGuard_Esp32\libraries .\FaceGuard_Esp32
```

Isi hanya URL Supabase dan publishable key dalam `secrets.h`. Nama dan kata
laluan Wi-Fi tidak lagi disimpan dalam fail tersebut.

## Apa yang boleh digunakan tanpa sensor/microSD

- live video bergerak yang auto-connect dan auto-reconnect dalam aplikasi;
- fallback bingkai JPEG jika telefon tidak serasi dengan MJPEG;
- pengesanan perubahan imej yang terus berjalan ketika Live aktif;
- gambar alert automatik;
- snapshot manual;
- notifikasi Realtime dan pemadaman gambar.

Rakaman video panjang tidak boleh disimpan secara stabil tanpa kad microSD.

## Jika Live masih tidak keluar

1. Pastikan telefon dan ESP32-CAM berada pada router serta subnet yang sama,
   bukan rangkaian `Guest` yang mengasingkan peranti.
2. Matikan `AP isolation`, `client isolation` atau `wireless isolation` pada
   router jika pilihan itu aktif.
3. Pastikan Serial Monitor memaparkan `API kamera aktif pada port 80` dan
   `Live MJPEG aktif pada port 81`.
4. Dalam aplikasi, nilai **Rangkaian** mesti menunjukkan alamat IP kamera dan
   status kamera mesti Online.
5. Bekalkan ESP32-CAM dengan 5V yang stabil; bekalan lemah lazimnya menyebabkan
   kamera restart ketika stream bermula.
