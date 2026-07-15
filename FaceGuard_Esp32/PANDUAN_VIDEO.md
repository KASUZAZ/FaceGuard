# Fitur video ESP32-CAM

## Persediaan

1. Format kad microSD sebagai FAT32 dan masukkan ke slot ESP32-CAM.
2. Jalankan `supabase_video_setup.sql` sekali dalam Supabase SQL Editor.
3. Pastikan bucket `faceguard-storage` membenarkan fail `video/x-msvideo` atau
   tidak mempunyai sekatan MIME yang menolak fail AVI.
4. Dalam Arduino IDE pilih board `AI Thinker ESP32-CAM` dan aktifkan PSRAM jika
   menu PSRAM tersedia.
5. Buka ketiga-tiga fail projek dalam folder yang sama dan upload
   `projek_dkm_2.ino`.

## Aliran sistem

1. PIR atau microwave mengesan pergerakan.
2. Kamera mengambil gambar VGA dan upload ke Supabase.
3. Kamera ditukar kepada QVGA dan merakam MJPEG/AVI selama 30 saat pada 8 FPS.
4. Fail AVI ditutup dan upload dari microSD ke folder `videos` dalam Storage.
5. Satu rekod dimasukkan ke `aktiviti_log` bersama `image_url` dan `video_url`.
6. Selepas upload berjaya, salinan video pada microSD dipadam untuk menjimatkan
   ruang. Tukar `DELETE_VIDEO_AFTER_UPLOAD` kepada `false` jika mahu menyimpannya.

## Nota pin

microSD dimulakan dengan `SD_MMC.begin("/sdcard", true)`. Nilai `true`
mengaktifkan mod satu-bit yang hanya menggunakan GPIO 2, 14 dan 15. Oleh itu,
GPIO 12 dan 13 kekal untuk sensor. Jangan tukar kepada mod empat-bit selagi
sensor masih menggunakan GPIO tersebut.

## Jika tidak stabil

- Gunakan bekalan 5V 2A yang stabil.
- Cuba kad microSD Class 10 lain dan pastikan FAT32.
- Turunkan `VIDEO_FPS` daripada 8 kepada 5.
- Pastikan telefon hotspot tidak terputus atau masuk mod penjimatan kuasa.
- Semak Serial Monitor pada 115200 baud untuk mesej kegagalan kamera, SD atau
  HTTP.
