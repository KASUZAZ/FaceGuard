# FaceGuard menggunakan ESP32-CAM sahaja

Versi ini tidak menggunakan PIR, microwave, buzzer atau push button. Kamera
OV2640 membandingkan kecerahan daripada frame JPEG bersaiz kecil dan mencetuskan
snapshot apabila perubahan imej melepasi threshold.

## Perkakasan

1. ESP32-CAM AI-Thinker dengan kamera OV2640.
2. ESP32-CAM-MB dan kabel USB untuk kuasa serta upload kod.
3. Bekalan USB 5V yang stabil. microSD tidak diperlukan untuk versi snapshot.

## Cara upload

1. Letakkan fail `.ino` sebagai sketch utama bersama fail lain dalam folder ini.
2. Pilih board `AI Thinker ESP32-CAM` dalam Arduino IDE.
3. Aktifkan PSRAM jika pilihan tersebut tersedia.
4. Upload kod, buka Serial Monitor pada 115200 baud, kemudian tekan RST sekali
   selepas proses upload jika papan tidak reboot secara automatik.

## Pelarasan pengesanan

- `PIXEL_DIFFERENCE_THRESHOLD`: beza kecerahan bagi satu piksel. Naikkan jika
  perubahan cahaya kecil sering mencetuskan event.
- `MOTION_PERCENT_THRESHOLD`: peratus sampel yang perlu berubah. Naikkan jika
  terlalu sensitif, turunkan jika gerakan tidak dikesan.
- `REQUIRED_CONSECUTIVE_FRAMES`: bilangan frame berturut-turut untuk mengesahkan
  gerakan.
- `EVENT_COOLDOWN_MS`: masa minimum antara dua event Supabase.

Mulakan dengan nilai lalai. Pastikan kamera dipasang kukuh kerana gegaran kamera
akan dianggap sebagai gerakan.
