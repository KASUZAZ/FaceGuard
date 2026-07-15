#include "esp_camera.h"
#include "img_converters.h"
#include "esp_http_server.h"
#include <ESP32QRCodeReader.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include "secrets.h"

// FaceGuard ESP32-CAM 2.0
// Aliran setup: aplikasi menjana QR -> kamera mengimbas -> Wi-Fi disimpan
// -> kamera didaftarkan ke akaun -> live MJPEG dan alert gerakan tersedia.

const char* FIRMWARE_VERSION = "2.0.0";
const char* DEVICE_FUNCTION_URL =
    SUPABASE_URL "/functions/v1/faceguard-device";

const uint32_t DETECTION_INTERVAL_MS = 700;
const uint32_t EVENT_COOLDOWN_MS = 20000;
const uint32_t HEARTBEAT_INTERVAL_MS = 60000;
const uint32_t WIFI_RETRY_INTERVAL_MS = 10000;
const uint8_t PIXEL_DIFFERENCE_THRESHOLD = 30;
const uint8_t MOTION_PERCENT_THRESHOLD = 15;
const uint8_t REQUIRED_MOTION_FRAMES = 2;
const uint8_t SAMPLE_STEP = 4;
const size_t MOTION_SAMPLE_CAPACITY = 80 * 60;
const size_t RGB_BUFFER_SIZE = 320 * 240 * 3;

Preferences preferences;
SemaphoreHandle_t cameraMutex = nullptr;
httpd_handle_t controlServer = nullptr;
httpd_handle_t streamServer = nullptr;

String wifiSsid;
String wifiPassword;
String setupToken;
String deviceCode;
String deviceSecret;
String streamToken;
bool provisioned = false;
volatile uint8_t activeStreamClients = 0;
volatile bool manualSnapshotRequested = false;

uint8_t* previousFrame = nullptr;
uint8_t* rgbBuffer = nullptr;
size_t previousSampleCount = 0;
bool baselineReady = false;
uint8_t consecutiveMotionFrames = 0;
uint32_t lastDetectionAt = 0;
uint32_t lastEventAt = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t lastWiFiRetryAt = 0;
uint32_t lastProvisionAttemptAt = 0;

const char* STREAM_CONTENT_TYPE =
    "multipart/x-mixed-replace;boundary=faceguardframe";
const char* STREAM_BOUNDARY = "\r\n--faceguardframe\r\n";

String randomHex(size_t byteCount);
String makeDeviceCode();
void loadIdentity();
bool readSetupQr();
bool parseSetupPayload(const String& payload, String& ssid,
                       String& password, String& token);
bool connectWiFi(uint32_t timeoutMs = 25000);
bool initializeCamera();
void startCameraServers();
bool provisionDevice();
bool sendHeartbeat();
bool uploadSnapshot(const String& eventKind);
bool detectMotion();
bool validRequestToken(httpd_req_t* request);

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(false);
  delay(300);
  Serial.println("\nFaceGuard ESP32-CAM 2.0 bermula...");

  preferences.begin("faceguard", false);
  wifiSsid = preferences.getString("wifi_ssid", "");
  wifiPassword = preferences.getString("wifi_pass", "");
  setupToken = preferences.getString("setup_token", "");
  provisioned = preferences.getBool("provisioned", false);
  loadIdentity();

  if (wifiSsid.isEmpty()) {
    Serial.println("Belum ada Wi-Fi. Tunjukkan QR setup daripada aplikasi.");
    if (readSetupQr()) ESP.restart();
    return;
  }

  if (!connectWiFi()) {
    Serial.println("Wi-Fi lama tidak dapat dicapai.");
    Serial.println("Tunjukkan QR baharu pada lensa untuk menukar Wi-Fi.");
    if (readSetupQr()) ESP.restart();
    return;
  }

  if (!initializeCamera()) return;
  startCameraServers();

  if (!provisioned || !setupToken.isEmpty()) {
    provisionDevice();
  } else {
    sendHeartbeat();
  }

  Serial.printf("FaceGuard sedia: http://%s:81/stream\n",
                WiFi.localIP().toString().c_str());
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWiFiRetryAt >= WIFI_RETRY_INTERVAL_MS) {
      lastWiFiRetryAt = millis();
      connectWiFi(8000);
    }
    delay(20);
    return;
  }

  if (!provisioned && millis() - lastProvisionAttemptAt >= 30000) {
    provisionDevice();
  }
  if (millis() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
    sendHeartbeat();
  }

  if (manualSnapshotRequested) {
    manualSnapshotRequested = false;
    uploadSnapshot("manual_snapshot");
  }

  if (activeStreamClients > 0) {
    baselineReady = false;
    consecutiveMotionFrames = 0;
    delay(30);
    return;
  }

  if (millis() - lastDetectionAt >= DETECTION_INTERVAL_MS) {
    lastDetectionAt = millis();
    if (detectMotion()) {
      if (consecutiveMotionFrames < 255) consecutiveMotionFrames++;
    } else {
      consecutiveMotionFrames = 0;
    }

    const bool cooldownDone = lastEventAt == 0 ||
        millis() - lastEventAt >= EVENT_COOLDOWN_MS;
    if (cooldownDone && consecutiveMotionFrames >= REQUIRED_MOTION_FRAMES) {
      consecutiveMotionFrames = 0;
      lastEventAt = millis();
      uploadSnapshot("pergerakan_kamera");
      baselineReady = false;
    }
  }
  delay(10);
}

String randomHex(size_t byteCount) {
  const char* digits = "0123456789abcdef";
  String value;
  value.reserve(byteCount * 2);
  for (size_t index = 0; index < byteCount; ++index) {
    const uint8_t byte = static_cast<uint8_t>(esp_random());
    value += digits[byte >> 4];
    value += digits[byte & 0x0F];
  }
  return value;
}

String makeDeviceCode() {
  const uint64_t chipId = ESP.getEfuseMac();
  char value[13];
  snprintf(value, sizeof(value), "%04X%08X",
           static_cast<uint16_t>(chipId >> 32),
           static_cast<uint32_t>(chipId));
  return String(value);
}

void loadIdentity() {
  deviceCode = makeDeviceCode();
  deviceSecret = preferences.getString("dev_secret", "");
  streamToken = preferences.getString("stream_token", "");
  if (deviceSecret.length() < 32) {
    deviceSecret = randomHex(24);
    preferences.putString("dev_secret", deviceSecret);
  }
  if (streamToken.length() < 32) {
    streamToken = randomHex(24);
    preferences.putString("stream_token", streamToken);
  }
  Serial.printf("Kod kamera: %s\n", deviceCode.c_str());
}

bool parseSetupPayload(const String& payload, String& ssid,
                       String& password, String& token) {
  if (!payload.startsWith("FG1\n")) return false;
  const int tokenEnd = payload.indexOf('\n', 4);
  if (tokenEnd < 5) return false;
  const int ssidEnd = payload.indexOf('\n', tokenEnd + 1);
  if (ssidEnd <= tokenEnd + 1) return false;

  token = payload.substring(4, tokenEnd);
  ssid = payload.substring(tokenEnd + 1, ssidEnd);
  password = payload.substring(ssidEnd + 1);
  if (password.endsWith("\r")) password.remove(password.length() - 1);
  return token.length() >= 20 && !ssid.isEmpty() && ssid.length() <= 32 &&
         password.length() <= 63;
}

bool readSetupQr() {
  ESP32QRCodeReader reader(CAMERA_MODEL_AI_THINKER, FRAMESIZE_QVGA);
  const QRCodeReaderSetupErr result = reader.setup();
  if (result != SETUP_OK) {
    Serial.printf("Mod QR gagal dimulakan (%d). Pastikan PSRAM aktif.\n", result);
    return false;
  }

  reader.setDebug(false);
  reader.beginOnCore(0);
  Serial.println("Mod QR aktif. Pegang skrin 15-25 cm daripada lensa.");
  for (;;) {
    QRCodeData qrData;
    if (!reader.receiveQrCode(&qrData, 500) || !qrData.valid) {
      delay(50);
      continue;
    }

    String payload(reinterpret_cast<const char*>(qrData.payload));
    String newSsid;
    String newPassword;
    String newSetupToken;
    if (!parseSetupPayload(payload, newSsid, newPassword, newSetupToken)) {
      Serial.println("QR dibaca tetapi bukan QR setup FaceGuard.");
      continue;
    }

    preferences.putString("wifi_ssid", newSsid);
    preferences.putString("wifi_pass", newPassword);
    preferences.putString("setup_token", newSetupToken);
    preferences.putBool("provisioned", false);
    Serial.printf("QR berjaya. Wi-Fi '%s' disimpan.\n", newSsid.c_str());
    reader.end();
    delay(250);
    esp_camera_deinit();
    delay(300);
    return true;
  }
}

bool connectWiFi(uint32_t timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  Serial.printf("Menyambung ke Wi-Fi '%s'", wifiSsid.c_str());
  const uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < timeoutMs) {
    delay(400);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) return false;
  Serial.printf("Wi-Fi berjaya. IP: %s\n", WiFi.localIP().toString().c_str());
  return true;
}

bool initializeCamera() {
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
  config.pin_sccb_sda = 26;
  config.pin_sccb_scl = 27;
  config.pin_pwdn = 32;
  config.pin_reset = -1;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_QVGA;
  config.jpeg_quality = 12;
  config.fb_count = psramFound() ? 2 : 1;
  config.grab_mode = psramFound() ? CAMERA_GRAB_LATEST : CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;

  const esp_err_t error = esp_camera_init(&config);
  if (error != ESP_OK) {
    Serial.printf("Camera init gagal: 0x%x\n", error);
    return false;
  }
  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor) {
    sensor->set_framesize(sensor, FRAMESIZE_QVGA);
    sensor->set_quality(sensor, 12);
  }

  cameraMutex = xSemaphoreCreateMutex();
  previousFrame = static_cast<uint8_t*>(ps_malloc(MOTION_SAMPLE_CAPACITY));
  rgbBuffer = static_cast<uint8_t*>(ps_malloc(RGB_BUFFER_SIZE));
  if (!cameraMutex || !previousFrame || !rgbBuffer) {
    Serial.println("Memori PSRAM tidak cukup untuk pengesanan gerakan.");
    return false;
  }
  delay(400);
  return true;
}

bool validRequestToken(httpd_req_t* request) {
  const size_t length = httpd_req_get_url_query_len(request) + 1;
  if (length <= 1 || length > 180) return false;
  char query[180];
  char token[80];
  if (httpd_req_get_url_query_str(request, query, sizeof(query)) != ESP_OK ||
      httpd_query_key_value(query, "token", token, sizeof(token)) != ESP_OK) {
    return false;
  }
  return streamToken.equals(token);
}

void setCors(httpd_req_t* request) {
  httpd_resp_set_hdr(request, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
}

esp_err_t statusHandler(httpd_req_t* request) {
  if (!validRequestToken(request)) return httpd_resp_send_err(request, HTTPD_401_UNAUTHORIZED, "Token tidak sah");
  setCors(request);
  httpd_resp_set_type(request, "application/json");
  String response = "{\"ok\":true,\"device_code\":\"" + deviceCode +
      "\",\"firmware\":\"" + FIRMWARE_VERSION + "\",\"streams\":" +
      String(activeStreamClients) + "}";
  return httpd_resp_sendstr(request, response.c_str());
}

esp_err_t snapshotHandler(httpd_req_t* request) {
  if (!validRequestToken(request)) return httpd_resp_send_err(request, HTTPD_401_UNAUTHORIZED, "Token tidak sah");
  setCors(request);
  manualSnapshotRequested = true;
  httpd_resp_set_status(request, "202 Accepted");
  httpd_resp_set_type(request, "application/json");
  return httpd_resp_sendstr(request, "{\"ok\":true,\"queued\":true}");
}

esp_err_t streamHandler(httpd_req_t* request) {
  if (!validRequestToken(request)) return httpd_resp_send_err(request, HTTPD_401_UNAUTHORIZED, "Token tidak sah");
  setCors(request);
  httpd_resp_set_type(request, STREAM_CONTENT_TYPE);
  activeStreamClients++;
  esp_err_t result = ESP_OK;
  char partHeader[80];

  while (result == ESP_OK && WiFi.status() == WL_CONNECTED) {
    if (xSemaphoreTake(cameraMutex, pdMS_TO_TICKS(1500)) != pdTRUE) continue;
    camera_fb_t* frame = esp_camera_fb_get();
    if (!frame) {
      xSemaphoreGive(cameraMutex);
      delay(20);
      continue;
    }

    result = httpd_resp_send_chunk(request, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
    if (result == ESP_OK) {
      const size_t headerLength = snprintf(
          partHeader, sizeof(partHeader),
          "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n",
          static_cast<unsigned>(frame->len));
      result = httpd_resp_send_chunk(request, partHeader, headerLength);
    }
    if (result == ESP_OK) {
      result = httpd_resp_send_chunk(
          request, reinterpret_cast<const char*>(frame->buf), frame->len);
    }
    esp_camera_fb_return(frame);
    xSemaphoreGive(cameraMutex);
    delay(25);
  }

  if (activeStreamClients > 0) activeStreamClients--;
  return result;
}

void startCameraServers() {
  httpd_config_t controlConfig = HTTPD_DEFAULT_CONFIG();
  controlConfig.server_port = 80;
  controlConfig.ctrl_port = 32768;
  controlConfig.max_uri_handlers = 6;
  if (httpd_start(&controlServer, &controlConfig) == ESP_OK) {
    httpd_uri_t statusUri = { .uri = "/status", .method = HTTP_GET,
      .handler = statusHandler, .user_ctx = nullptr };
    httpd_uri_t snapshotUri = { .uri = "/api/snapshot", .method = HTTP_GET,
      .handler = snapshotHandler, .user_ctx = nullptr };
    httpd_register_uri_handler(controlServer, &statusUri);
    httpd_register_uri_handler(controlServer, &snapshotUri);
  }

  httpd_config_t streamConfig = HTTPD_DEFAULT_CONFIG();
  streamConfig.server_port = 81;
  streamConfig.ctrl_port = 32769;
  streamConfig.stack_size = 8192;
  if (httpd_start(&streamServer, &streamConfig) == ESP_OK) {
    httpd_uri_t streamUri = { .uri = "/stream", .method = HTTP_GET,
      .handler = streamHandler, .user_ctx = nullptr };
    httpd_register_uri_handler(streamServer, &streamUri);
  }
}

int postDeviceAction(const String& action, const String& jsonBody) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(20000);
  if (!http.begin(client, String(DEVICE_FUNCTION_URL) + "?action=" + action)) return -1;
  http.addHeader("apikey", SUPABASE_PUBLISHABLE_KEY);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-FaceGuard-Action", action);
  const int code = http.POST(jsonBody);
  if (code < 200 || code >= 300) {
    Serial.printf("%s gagal (HTTP %d): %s\n", action.c_str(), code,
                  http.getString().c_str());
  }
  http.end();
  return code;
}

bool provisionDevice() {
  lastProvisionAttemptAt = millis();
  if (setupToken.isEmpty()) return false;
  const String body = "{\"setup_token\":\"" + setupToken +
      "\",\"device_code\":\"" + deviceCode +
      "\",\"device_secret\":\"" + deviceSecret +
      "\",\"stream_token\":\"" + streamToken +
      "\",\"local_ip\":\"" + WiFi.localIP().toString() +
      "\",\"firmware_version\":\"" + FIRMWARE_VERSION + "\"}";
  const int code = postDeviceAction("provision", body);
  if (code < 200 || code >= 300) return false;
  provisioned = true;
  setupToken = "";
  preferences.putBool("provisioned", true);
  preferences.remove("setup_token");
  Serial.println("Kamera berjaya dipautkan kepada akaun FaceGuard.");
  return true;
}

bool sendHeartbeat() {
  if (!provisioned) return false;
  lastHeartbeatAt = millis();
  const String body = "{\"device_code\":\"" + deviceCode +
      "\",\"device_secret\":\"" + deviceSecret +
      "\",\"stream_token\":\"" + streamToken +
      "\",\"local_ip\":\"" + WiFi.localIP().toString() +
      "\",\"firmware_version\":\"" + FIRMWARE_VERSION + "\"}";
  const int code = postDeviceAction("heartbeat", body);
  return code >= 200 && code < 300;
}

bool uploadSnapshot(const String& eventKind) {
  if (!provisioned || WiFi.status() != WL_CONNECTED) return false;
  if (xSemaphoreTake(cameraMutex, pdMS_TO_TICKS(2500)) != pdTRUE) return false;
  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame || frame->format != PIXFORMAT_JPEG) {
    if (frame) esp_camera_fb_return(frame);
    xSemaphoreGive(cameraMutex);
    return false;
  }

  uint8_t* imageCopy = static_cast<uint8_t*>(ps_malloc(frame->len));
  const size_t imageLength = frame->len;
  if (imageCopy) memcpy(imageCopy, frame->buf, imageLength);
  esp_camera_fb_return(frame);
  xSemaphoreGive(cameraMutex);
  if (!imageCopy) return false;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(25000);
  const String url = String(DEVICE_FUNCTION_URL) + "?action=upload_event";
  if (!http.begin(client, url)) {
    free(imageCopy);
    return false;
  }
  http.addHeader("apikey", SUPABASE_PUBLISHABLE_KEY);
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-FaceGuard-Action", "upload_event");
  http.addHeader("X-Device-Code", deviceCode);
  http.addHeader("X-Device-Secret", deviceSecret);
  http.addHeader("X-Event-Kind", eventKind);
  const int code = http.POST(imageCopy, imageLength);
  const String response = http.getString();
  http.end();
  free(imageCopy);

  if (code < 200 || code >= 300) {
    Serial.printf("Upload alert gagal (HTTP %d): %s\n", code, response.c_str());
    return false;
  }
  Serial.printf("Aktiviti '%s' berjaya disimpan.\n", eventKind.c_str());
  return true;
}

bool detectMotion() {
  if (!rgbBuffer || !previousFrame) return false;
  if (xSemaphoreTake(cameraMutex, pdMS_TO_TICKS(1200)) != pdTRUE) return false;
  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame) {
    xSemaphoreGive(cameraMutex);
    return false;
  }

  const bool decoded = fmt2rgb888(frame->buf, frame->len, frame->format, rgbBuffer);
  const size_t width = frame->width;
  const size_t height = frame->height;
  esp_camera_fb_return(frame);
  xSemaphoreGive(cameraMutex);
  if (!decoded || width != 320 || height != 240) return false;

  size_t sampleCount = 0;
  size_t changedCount = 0;
  for (size_t y = 0; y < height; y += SAMPLE_STEP) {
    for (size_t x = 0; x < width; x += SAMPLE_STEP) {
      if (sampleCount >= MOTION_SAMPLE_CAPACITY) break;
      const size_t pixel = (y * width + x) * 3;
      const uint8_t current = static_cast<uint8_t>(
          (static_cast<uint16_t>(rgbBuffer[pixel]) + rgbBuffer[pixel + 1] +
           rgbBuffer[pixel + 2]) / 3);
      if (baselineReady && sampleCount < previousSampleCount &&
          abs(static_cast<int>(current) -
              static_cast<int>(previousFrame[sampleCount])) >=
              PIXEL_DIFFERENCE_THRESHOLD) {
        changedCount++;
      }
      previousFrame[sampleCount++] = current;
    }
  }

  const bool comparable = baselineReady && previousSampleCount == sampleCount;
  baselineReady = true;
  previousSampleCount = sampleCount;
  if (!comparable || sampleCount == 0) return false;
  const uint8_t changedPercent = static_cast<uint8_t>(
      changedCount * 100UL / sampleCount);
  if (changedPercent >= MOTION_PERCENT_THRESHOLD) {
    Serial.printf("Perubahan imej: %u%%\n", changedPercent);
    return true;
  }
  return false;
}
