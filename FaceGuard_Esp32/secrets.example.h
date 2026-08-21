#pragma once

// Salin fail ini sebagai secrets.h, kemudian isi maklumat sebenar anda.
// Jangan commit secrets.h ke GitHub.
#define WIFI_SSID "NAMA_WIFI_ANDA"
#define WIFI_PASSWORD "KATA_LALUAN_WIFI_ANDA"

// URL awam inference server tanpa slash di hujung.
#define INFERENCE_SERVER_URL "https://faceguard-server.example.com"

// Mesti sama dengan FACEGUARD_DEVICE_TOKEN pada inference server.
#define INFERENCE_DEVICE_TOKEN "ganti-dengan-token-panjang-rawak"

// Gunakan ID yang sama dalam Tetapan aplikasi. Kosongkan untuk ID automatik.
#define INFERENCE_DEVICE_ID "kamera-hadapan"

// Kata laluan AP sementara semasa pairing. Tukar untuk setiap pemasangan.
#define PROVISIONING_AP_PASSWORD "FaceGuard2026!"
