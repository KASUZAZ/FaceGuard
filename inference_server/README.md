# FaceGuard inference server

Servis ini menerima frame JPEG melalui WebSocket daripada ESP32-CAM, merelay semua
frame CCTV kepada aplikasi melalui WebSocket dan menjalankan YOLO Pose pada
frame terpilih. Apabila urutan
`berdiri -> mendatar -> kekal mendatar` disahkan, snapshot dimuat naik ke
Supabase dan satu rekod `orang_jatuh` dimasukkan ke `aktiviti_log`.

## Jalankan secara lokal

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
copy .env.example .env
uvicorn main:app --host 0.0.0.0 --port 8000
```

Server membaca `inference_server/.env` secara automatik untuk pembangunan lokal.
Pada production, masukkan nilai yang sama melalui secret manager platform dan
jangan commit fail `.env`. Model pose dimuat turun pada startup pertama. Uji
`GET /health` sebelum menghidupkan ESP32-CAM.

Untuk deployment, bina `Dockerfile` pada server/VPS yang menyokong proses
sentiasa hidup dan WebSocket. Serverless function yang tidur
selepas setiap request tidak sesuai untuk aliran CCTV ini.

### Deploy ke Render

Fail `render.yaml` di akar repositori menyediakan Web Service Python di region
Singapore. Sambungkan repositori kepada Render melalui **New > Blueprint**, lalu
isi dua nilai rahsia apabila diminta:

- `FACEGUARD_DEVICE_TOKEN`
- `SUPABASE_SERVICE_ROLE_KEY`

Selepas deploy berjaya, uji `https://<nama-servis>.onrender.com/health` dan
masukkan URL asas `https://<nama-servis>.onrender.com` dalam aplikasi FaceGuard.
Jangan masukkan laluan `/health` dalam ruangan URL inference server.

Blueprint menggunakan pelan percuma untuk ujian. Stream kamera yang sentiasa
aktif biasanya mengelakkan servis idle, tetapi pelan percuma boleh restart,
tertakluk kepada had penggunaan dan tidak sesuai untuk pemantauan keselamatan
production 24/7.

Endpoint peranti semasa ialah `WSS /ws/device/{device_id}`. Endpoint HTTP lama
dikekalkan sebagai fallback diagnostik sahaja.

Jalankan satu Uvicorn worker sahaja kerana senarai viewer dan frame terkini
disimpan dalam memori proses. Deployment berbilang worker memerlukan Redis/NATS
sebagai message broker.

## FPS

- CCTV disasarkan pada 25 FPS dan semua frame direlay tanpa menunggu AI.
- `INFERENCE_FPS=5` bermaksud pose estimation berjalan pada maksimum 5 FPS.
- Frame inference lama dibuang apabila model sibuk; frame CCTV tidak beratur.
- Uji relay lokal dengan `python test_stream.py path/to/frame.jpg`.
- FPS sebenar papan dipaparkan pada Serial Monitor dan dalam aplikasi.

## Keselamatan

- `SUPABASE_SERVICE_ROLE_KEY` hanya berada pada inference server.
- Kunci `sb_secret_...` dihantar melalui header `apikey` sahaja; ia bukan JWT
  dan tidak boleh digunakan sebagai `Authorization: Bearer`.
- Token peranti mesti sama dengan `INFERENCE_DEVICE_TOKEN` dalam firmware.
- Viewer CCTV disahkan menggunakan sesi Supabase dan pemilikan Device ID.
- Gunakan HTTPS/WSS dan hadkan `ALLOWED_ORIGINS` kepada domain aplikasi.
- Heuristik ini ialah prototaip keselamatan, bukan alat perubatan. Uji dengan
  sudut kamera dan keadaan sebenar sebelum digunakan untuk penjagaan manusia.
- Ultralytics dan model YOLO menggunakan AGPL-3.0 secara lalai. Projek
  komersial/proprietari perlu menyemak dan mendapatkan lesen yang sesuai.
