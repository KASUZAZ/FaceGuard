# FaceGuard menggunakan ESP32-CAM sahaja

ESP32-CAM berfungsi sebagai kamera rangkaian. Ia tidak menjalankan model AI.
JPEG CIF (400x296) dihantar melalui satu sambungan HTTP berterusan dengan sasaran 25 FPS.
Server merelay semua frame ke aplikasi dan menjalankan pose estimation pada
frame terpilih.

## Perkakasan

1. ESP32-CAM AI-Thinker dengan kamera OV2640.
2. ESP32-CAM-MB untuk upload firmware.
3. Bekalan USB 5V stabil untuk operasi berterusan.

Laptop hanya diperlukan untuk upload firmware pertama kali. Selepas itu,
ESP32-CAM bermula dan menyambung semula Wi-Fi secara automatik apabila menerima
kuasa.

## Cara upload

1. Salin `secrets.example.h` sebagai `secrets.h`.
2. Isi `INFERENCE_DEVICE_TOKEN`, `INFERENCE_DEVICE_ID` dan kata laluan AP pairing.
3. Pastikan token peranti sama dengan `FACEGUARD_DEVICE_TOKEN` pada server.
4. Pilih board `AI Thinker ESP32-CAM`, aktifkan PSRAM dan upload sketch.
5. Selepas boot, ESP32 membuka Wi-Fi `FACEGUARD-xxxxxx`. Sambung telefon ke
   Wi-Fi itu, buka Tetapan APK FaceGuard dan isi Wi-Fi 2.4 GHz serta URL server.
6. Tekan **Sambungkan ESP32**. ESP32 menyimpan tetapan dalam NVS, restart dan
   auto-connect semula pada setiap kali menerima kuasa.
7. Buka Serial Monitor 115200 baud untuk melihat Device ID, FPS dan respons server.

## Nota operasi

- Gunakan inference server HTTPS yang sentiasa hidup.
- Reverse proxy mesti menyokong request streaming tanpa buffering. Contoh Nginx
  disediakan dalam folder `inference_server`.
- Firmware prototaip menggunakan TLS tanpa semakan sijil. Untuk produksi,
  pasang root CA server dan gantikan `setInsecure()`.
- Serial Monitor memaparkan FPS dan kadar rangkaian setiap dua saat. Sasaran
  25 FPS memerlukan Wi-Fi stabil, PSRAM aktif dan bekalan kuasa yang baik.
- Sudut kamera perlu memperlihatkan keseluruhan badan untuk pose estimation.
