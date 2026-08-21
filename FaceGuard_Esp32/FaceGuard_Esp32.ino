#include "esp_camera.h"
#include <esp_arduino_version.h>
#include <WiFi.h>
#include <ArduinoWebsockets.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <time.h>
#include "secrets.h"

using namespace websockets;

static const char RENDER_CA_CERT[] PROGMEM = R"CERT(
-----BEGIN CERTIFICATE-----
MIIDejCCAmKgAwIBAgIQf+UwvzMTQ77dghYQST2KGzANBgkqhkiG9w0BAQsFADBX
MQswCQYDVQQGEwJCRTEZMBcGA1UEChMQR2xvYmFsU2lnbiBudi1zYTEQMA4GA1UE
CxMHUm9vdCBDQTEbMBkGA1UEAxMSR2xvYmFsU2lnbiBSb290IENBMB4XDTIzMTEx
NTAzNDMyMVoXDTI4MDEyODAwMDA0MlowRzELMAkGA1UEBhMCVVMxIjAgBgNVBAoT
GUdvb2dsZSBUcnVzdCBTZXJ2aWNlcyBMTEMxFDASBgNVBAMTC0dUUyBSb290IFI0
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE83Rzp2iLYK5DuDXFgTB7S0md+8Fhzube
Rr1r1WEYNa5A3XP3iZEwWus87oV8okB2O6nGuEfYKueSkWpz6bFyOZ8pn6KY019e
WIZlD6GEZQbR3IvJx3PIjGov5cSr0R2Ko4H/MIH8MA4GA1UdDwEB/wQEAwIBhjAd
BgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwDwYDVR0TAQH/BAUwAwEB/zAd
BgNVHQ4EFgQUgEzW63T/STaj1dj8tT7FavCUHYwwHwYDVR0jBBgwFoAUYHtmGkUN
l8qJUC99BM00qP/8/UswNgYIKwYBBQUHAQEEKjAoMCYGCCsGAQUFBzAChhpodHRw
Oi8vaS5wa2kuZ29vZy9nc3IxLmNydDAtBgNVHR8EJjAkMCKgIKAehhxodHRwOi8v
Yy5wa2kuZ29vZy9yL2dzcjEuY3JsMBMGA1UdIAQMMAowCAYGZ4EMAQIBMA0GCSqG
SIb3DQEBCwUAA4IBAQAYQrsPBtYDh5bjP2OBDwmkoWhIDDkic574y04tfzHpn+cJ
odI2D4SseesQ6bDrarZ7C30ddLibZatoKiws3UL9xnELz4ct92vID24FfVbiI1hY
+SW6FoVHkNeWIP0GCbaM4C6uVdF5dTUsMVs/ZbzNnIdCp5Gxmx5ejvEau8otR/Cs
kGN+hr/W5GvT1tMBjgWKZ1i4//emhA1JG1BbPzoLJQvyEotc03lXjTaCzv8mEbep
8RqZ7a2CPsgRbuvTPBwcOMBBmuFeU88+FSBX6+7iP0il8b4Z0QFqIwwMHfs/L6K1
vepuoxtGzi4CZ68zJpiq1UvSqTbFJjtbD4seiMHl
-----END CERTIFICATE-----
)CERT";

// FaceGuard 25 FPS mode: JPEG binary melalui WebSocket selamat.

String wifiSsid = WIFI_SSID;
String wifiPassword = WIFI_PASSWORD;
String inferenceServerUrl = INFERENCE_SERVER_URL;
const String deviceToken = INFERENCE_DEVICE_TOKEN;
String configuredDeviceId = INFERENCE_DEVICE_ID;

#ifndef PROVISIONING_AP_PASSWORD
#define PROVISIONING_AP_PASSWORD "FaceGuard2026!"
#endif

const uint32_t TARGET_FRAME_INTERVAL_US = 40000;  // 25 FPS
const uint32_t WIFI_RETRY_INTERVAL_MS = 5000;
const uint32_t CLOCK_RETRY_INTERVAL_MS = 30000;
const time_t MIN_VALID_EPOCH = 1704067200;  // 2024-01-01 UTC

struct ServerAddress {
  bool valid = false;
  bool secure = true;
  String host;
  uint16_t port = 443;
  String basePath;
};

WebsocketsClient cameraSocket;
WebServer provisioningServer(80);
DNSServer provisioningDns;
Preferences preferences;
ServerAddress serverAddress;
String deviceId;
String provisioningSsid;
bool provisioningMode = false;
bool socketConnected = false;
uint32_t restartAt = 0;

uint32_t lastFrameAtUs = 0;
uint32_t lastWiFiAttemptAt = 0;
uint32_t lastSocketAttemptAt = 0;
uint32_t lastClockAttemptAt = 0;
uint32_t fpsWindowStartedAt = 0;
uint32_t framesInWindow = 0;
uint32_t bytesInWindow = 0;
uint32_t lastSendDurationMs = 0;
uint32_t lastFrameBytes = 0;

bool initialiseCamera();
bool ensureWiFi();
bool ensureClockReady();
bool parseServerUrl(const String& value, ServerAddress& output);
void startCameraSocket();
bool sendCameraFrame();
void stopCameraSocket();
void cameraSocketEvent(WebsocketsEvent event, String data);
void reportFps();
String createDeviceId();
void loadProvisioningConfig();
void startProvisioning();
void handleProvisioning();
bool validDeviceId(const String& value);

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(false);
  delay(300);

  loadProvisioningConfig();
  deviceId = configuredDeviceId.length() >= 3
                 ? configuredDeviceId
                 : createDeviceId();
  serverAddress.valid = parseServerUrl(inferenceServerUrl, serverAddress);
  bool cameraReady = initialiseCamera();
  if (!cameraReady) {
    Serial.println("Camera init gagal. Pairing masih dibuka supaya tetapan boleh disimpan.");
  } else {
    Serial.println("Kamera OV2640 aktif; mod CCTV pantas 25 FPS.");
  }
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);

  if (wifiSsid.isEmpty() || !serverAddress.valid || !ensureWiFi()) {
    Serial.println("Konfigurasi rangkaian belum lengkap; membuka mod pairing.");
    startProvisioning();
    return;
  }
  if (!cameraReady) {
    Serial.println("Semak board, model sensor dan kedudukan kabel kamera.");
    return;
  }

  ensureWiFi();
  if (serverAddress.secure) ensureClockReady();
  startCameraSocket();

  fpsWindowStartedAt = millis();
  Serial.println("FaceGuard WebSocket stream mode sedia.");
  Serial.println("Device ID: " + deviceId);
  Serial.println("Sasaran kamera: 25 FPS QQVGA 160x120");
}

void loop() {
  if (provisioningMode) {
    handleProvisioning();
    return;
  }
  if (!ensureWiFi()) {
    stopCameraSocket();
    delay(20);
    return;
  }
  if (!socketConnected) startCameraSocket();
  if (socketConnected) {
    cameraSocket.poll();
    if (!cameraSocket.available()) socketConnected = false;
  }
  if (!socketConnected) {
    delay(2);
    return;
  }

  uint32_t nowUs = micros();
  if (static_cast<uint32_t>(nowUs - lastFrameAtUs) < TARGET_FRAME_INTERVAL_US) {
    delay(1);
    reportFps();
    return;
  }

  lastFrameAtUs = nowUs;
  if (!sendCameraFrame()) stopCameraSocket();
  reportFps();
}

bool initialiseCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = 5;
  config.pin_d1 = 18;
  config.pin_d2 = 19;
  config.pin_d3 = 21;
  config.pin_d4 = 36;
  config.pin_d5 = 39;
  config.pin_d6 = 34;
  config.pin_d7 = 35;
  config.pin_xclk = 0;
  config.pin_pclk = 22;
  config.pin_vsync = 25;
  config.pin_href = 23;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  config.pin_sccb_sda = 26;
  config.pin_sccb_scl = 27;
#else
  config.pin_sscb_sda = 26;
  config.pin_sscb_scl = 27;
#endif
  config.pin_pwdn = 32;
  config.pin_reset = -1;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_QQVGA;
  config.jpeg_quality = 30;
  config.fb_count = psramFound() ? 2 : 1;
  config.grab_mode = CAMERA_GRAB_LATEST;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;

  esp_err_t cameraError = esp_camera_init(&config);
  if (cameraError != ESP_OK) {
    Serial.printf("Camera error 0x%x\n", cameraError);
    return false;
  }

  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor) {
    sensor->set_framesize(sensor, FRAMESIZE_QQVGA);
    sensor->set_quality(sensor, 30);
    sensor->set_brightness(sensor, 0);
    sensor->set_contrast(sensor, 0);
  }
  return true;
}

bool ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  if (lastWiFiAttemptAt != 0 &&
      millis() - lastWiFiAttemptAt < WIFI_RETRY_INTERVAL_MS) {
    return false;
  }

  lastWiFiAttemptAt = millis();
  WiFi.disconnect();
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  Serial.print("Menyambung WiFi 2.4 GHz");
  uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 12000) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi belum tersedia; cuba semula automatik.");
    return false;
  }
  Serial.println("WiFi connected: " + WiFi.localIP().toString());
  return true;
}

bool ensureClockReady() {
  if (!serverAddress.secure) return true;
  time_t now = time(nullptr);
  if (now >= MIN_VALID_EPOCH) return true;
  if (lastClockAttemptAt != 0 &&
      millis() - lastClockAttemptAt < CLOCK_RETRY_INTERVAL_MS) {
    return false;
  }

  lastClockAttemptAt = millis();
  Serial.print("Menyelaraskan masa untuk TLS");
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
  uint32_t startedAt = millis();
  while (time(nullptr) < MIN_VALID_EPOCH && millis() - startedAt < 15000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  now = time(nullptr);
  if (now < MIN_VALID_EPOCH) {
    Serial.println("Masa belum sah; WSS ditangguhkan dan akan dicuba semula.");
    return false;
  }
  Serial.println("Masa TLS sedia; sijil server boleh disahkan.");
  return true;
}

bool parseServerUrl(const String& value, ServerAddress& output) {
  String url = value;
  url.trim();
  if (url.startsWith("https://")) {
    output.secure = true;
    output.port = 443;
    url.remove(0, 8);
  } else if (url.startsWith("http://")) {
    output.secure = false;
    output.port = 80;
    url.remove(0, 7);
  } else {
    return false;
  }

  int slashAt = url.indexOf('/');
  String authority = slashAt >= 0 ? url.substring(0, slashAt) : url;
  output.basePath = slashAt >= 0 ? url.substring(slashAt) : "";
  while (output.basePath.endsWith("/")) {
    output.basePath.remove(output.basePath.length() - 1);
  }

  int colonAt = authority.lastIndexOf(':');
  if (colonAt > 0) {
    output.host = authority.substring(0, colonAt);
    long parsedPort = authority.substring(colonAt + 1).toInt();
    if (parsedPort <= 0 || parsedPort > 65535) return false;
    output.port = static_cast<uint16_t>(parsedPort);
  } else {
    output.host = authority;
  }
  output.valid = output.host.length() > 0;
  return output.valid;
}

void startCameraSocket() {
  if (socketConnected || !serverAddress.valid) return;
  if (!ensureClockReady()) return;
  if (lastSocketAttemptAt != 0 && millis() - lastSocketAttemptAt < 2000) return;
  lastSocketAttemptAt = millis();

  String path = serverAddress.basePath + "/ws/device/" + deviceId;
  Serial.println("Menyambung WebSocket kamera: " + path);
  static bool configured = false;
  if (!configured) {
    cameraSocket.addHeader("X-Device-Token", deviceToken);
    cameraSocket.addHeader("Sec-WebSocket-Protocol", "faceguard-device");
    cameraSocket.onEvent(cameraSocketEvent);
    if (serverAddress.secure) cameraSocket.setCACert(RENDER_CA_CERT);
    configured = true;
  }
  String url = String(serverAddress.secure ? "wss://" : "ws://") +
               serverAddress.host + ":" + String(serverAddress.port) + path;
  if (!cameraSocket.connect(url)) {
    socketConnected = false;
    Serial.println("WebSocket belum tersedia; cuba semula automatik.");
  }
}

void cameraSocketEvent(WebsocketsEvent event, String data) {
  if (event == WebsocketsEvent::ConnectionOpened) {
    socketConnected = true;
    lastFrameAtUs = micros() - TARGET_FRAME_INTERVAL_US;
    Serial.println("WebSocket kamera connected.");
  } else if (event == WebsocketsEvent::ConnectionClosed) {
    socketConnected = false;
    Serial.println("WebSocket kamera terputus (" + data + "); cuba semula automatik.");
  }
}

bool sendCameraFrame() {
  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame || frame->format != PIXFORMAT_JPEG) {
    if (frame) esp_camera_fb_return(frame);
    Serial.println("Capture JPEG gagal.");
    return false;
  }

  uint32_t sendStartedAt = millis();
  bool ok = cameraSocket.sendBinary(
      reinterpret_cast<const char*>(frame->buf), frame->len);
  lastSendDurationMs = millis() - sendStartedAt;
  lastFrameBytes = frame->len;
  if (ok) {
    framesInWindow++;
    bytesInWindow += frame->len;
  }
  esp_camera_fb_return(frame);
  return ok;
}

void stopCameraSocket() {
  if (socketConnected || cameraSocket.available()) cameraSocket.close();
  socketConnected = false;
}

void reportFps() {
  uint32_t elapsed = millis() - fpsWindowStartedAt;
  if (elapsed < 2000) return;
  float fps = framesInWindow * 1000.0f / elapsed;
  float kbps = bytesInWindow * 8.0f / elapsed;
  Serial.printf("CCTV %.1f FPS | %.0f kbps | JPEG %lu B | send %lu ms | RSSI %d dBm\n",
                fps, kbps, static_cast<unsigned long>(lastFrameBytes),
                static_cast<unsigned long>(lastSendDurationMs), WiFi.RSSI());
  fpsWindowStartedAt = millis();
  framesInWindow = 0;
  bytesInWindow = 0;
}

String createDeviceId() {
  uint64_t chipId = ESP.getEfuseMac();
  char value[24];
  snprintf(value, sizeof(value), "esp32-%04X%08X",
           static_cast<uint16_t>(chipId >> 32),
           static_cast<uint32_t>(chipId));
  return String(value);
}

void loadProvisioningConfig() {
  preferences.begin("faceguard", true);
  wifiSsid = preferences.getString("wifi_ssid", wifiSsid);
  wifiPassword = preferences.getString("wifi_pass", wifiPassword);
  inferenceServerUrl = preferences.getString("server_url", inferenceServerUrl);
  configuredDeviceId = preferences.getString("device_id", configuredDeviceId);
  preferences.end();
}

bool validDeviceId(const String& value) {
  if (value.length() < 3 || value.length() > 64) return false;
  for (size_t index = 0; index < value.length(); index++) {
    char character = value.charAt(index);
    if (!isalnum(character) && character != '_' && character != '-') return false;
  }
  return true;
}

void startProvisioning() {
  stopCameraSocket();
  WiFi.disconnect(false, false);
  delay(100);
  String hardwareId = createDeviceId();
  String suffix = hardwareId.substring(hardwareId.length() > 6 ? hardwareId.length() - 6 : 0);
  provisioningSsid = "FaceGuard-" + suffix;
  provisioningSsid.toUpperCase();
  WiFi.mode(WIFI_AP);
  bool accessPointStarted = WiFi.softAP(provisioningSsid.c_str(), PROVISIONING_AP_PASSWORD);
  provisioningDns.start(53, "*", WiFi.softAPIP());

  provisioningServer.enableCORS(true);
  provisioningServer.on("/", HTTP_GET, []() {
    provisioningServer.send(
        200, "text/plain; charset=utf-8",
        "FaceGuard ESP32-CAM pairing aktif. Kembali ke aplikasi FaceGuard dan tekan Sambungkan ESP32.");
  });
  provisioningServer.on("/status", HTTP_GET, []() {
    String body = "{\"ok\":true,\"device_id\":\"" + deviceId +
                  "\",\"ap\":\"" + provisioningSsid + "\"}";
    provisioningServer.send(200, "application/json", body);
  });
  provisioningServer.on("/configure", HTTP_OPTIONS, []() {
    provisioningServer.send(204);
  });
  provisioningServer.on("/configure", HTTP_POST, []() {
    String nextSsid = provisioningServer.arg("wifi_ssid");
    String nextPassword = provisioningServer.arg("wifi_password");
    String nextServerUrl = provisioningServer.arg("server_url");
    String nextDeviceId = provisioningServer.arg("device_id");
    nextSsid.trim();
    nextServerUrl.trim();
    nextDeviceId.trim();

    bool serverValid = nextServerUrl.startsWith("https://") ||
                       nextServerUrl.startsWith("http://");
    if (nextSsid.isEmpty() || !serverValid || !validDeviceId(nextDeviceId)) {
      provisioningServer.send(400, "application/json",
                              "{\"ok\":false,\"error\":\"Konfigurasi tidak sah\"}");
      return;
    }

    preferences.begin("faceguard", false);
    preferences.putString("wifi_ssid", nextSsid);
    preferences.putString("wifi_pass", nextPassword);
    preferences.putString("server_url", nextServerUrl);
    preferences.putString("device_id", nextDeviceId);
    preferences.end();
    provisioningServer.send(200, "application/json",
                            "{\"ok\":true,\"message\":\"Konfigurasi disimpan\"}");
    restartAt = millis() + 1500;
  });
  provisioningServer.onNotFound([]() {
    provisioningServer.sendHeader("Location", "http://192.168.4.1/", true);
    provisioningServer.send(302, "text/plain", "");
  });
  provisioningServer.begin();
  provisioningMode = true;

  Serial.println("=== PAIRING FACEGUARD ===");
  Serial.println("WiFi sementara: " + provisioningSsid);
  Serial.println(accessPointStarted ? "Access point aktif." : "Access point gagal dimulakan.");
  Serial.println("IP pairing: " + WiFi.softAPIP().toString());
  Serial.println("Buka aplikasi FaceGuard > Tetapan > Pair ESP32.");
  Serial.println("Alamat pairing: http://192.168.4.1");
}

void handleProvisioning() {
  provisioningDns.processNextRequest();
  provisioningServer.handleClient();
  if (restartAt && static_cast<int32_t>(millis() - restartAt) >= 0) {
    delay(100);
    ESP.restart();
  }
  delay(2);
}
