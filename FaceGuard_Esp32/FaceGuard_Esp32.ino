#include "esp_camera.h"
#include "img_converters.h"
#include <esp_arduino_version.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "secrets.h"

// FaceGuard versi ESP32-CAM sahaja.
// Kamera membandingkan frame kecil untuk mengesan perubahan gerakan.

// --- WIFI DAN SUPABASE ---
// Nilai peribadi disimpan dalam secrets.h yang tidak dihantar ke GitHub.
const char* ssid = WIFI_SSID;
const char* password = WIFI_PASSWORD;

const String supabaseUrl = SUPABASE_URL;
const String apiKey = SUPABASE_PUBLISHABLE_KEY;
const String bucketName = "faceguard-storage";
const String tableName = "aktiviti_log";

// --- TETAPAN PENGESANAN ---
const uint32_t DETECTION_INTERVAL_MS = 450;
const uint32_t STARTUP_WARMUP_MS = 7000;
const uint32_t EVENT_COOLDOWN_MS = 20000;
const uint8_t SAMPLE_STEP = 2;
const uint8_t PIXEL_DIFFERENCE_THRESHOLD = 28;
const uint8_t MOTION_PERCENT_THRESHOLD = 14;
const uint8_t REQUIRED_CONSECUTIVE_FRAMES = 2;

// FRAMESIZE_96X96 dengan SAMPLE_STEP=2 menghasilkan 48 x 48 sampel.
const size_t MAX_MOTION_SAMPLES = 48 * 48;
uint8_t previousFrame[MAX_MOTION_SAMPLES];
uint8_t detectionRgb[96 * 96 * 3];
size_t previousSampleCount = 0;
bool baselineReady = false;
uint8_t consecutiveMotionFrames = 0;
uint32_t lastDetectionAt = 0;
uint32_t lastEventAt = 0;
uint32_t cameraReadyAt = 0;

bool connectWiFi();
bool enterDetectionMode();
bool cameraMotionDetected();
void handleCameraMotion();
String captureAndUploadSnapshot();
bool insertActivityLog(const String& imageUrl, const String& eventStatus);
void discardFrames(uint8_t count);

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(false);

  // Mulakan dengan buffer JPEG VGA supaya buffer juga cukup besar ketika
  // resolusi ditukar daripada pengesanan kecil kepada snapshot VGA.
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
  config.frame_size = FRAMESIZE_VGA;
  config.jpeg_quality = 12;
  config.fb_count = 1;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;

  esp_err_t cameraError = esp_camera_init(&config);
  if (cameraError != ESP_OK) {
    Serial.printf("Camera init gagal, error 0x%x\n", cameraError);
    return;
  }

  connectWiFi();
  if (!enterDetectionMode()) {
    Serial.println("Mod pengesanan kamera gagal dimulakan.");
    return;
  }

  cameraReadyAt = millis();
  Serial.println("FaceGuard sedia. Kamera sedang memerhati perubahan imej.");
}

void loop() {
  if (millis() - lastDetectionAt < DETECTION_INTERVAL_MS) {
    delay(10);
    return;
  }
  lastDetectionAt = millis();

  bool motion = cameraMotionDetected();
  if (millis() - cameraReadyAt < STARTUP_WARMUP_MS) {
    consecutiveMotionFrames = 0;
    return;
  }

  if (motion) {
    if (consecutiveMotionFrames < 255) consecutiveMotionFrames++;
  } else {
    consecutiveMotionFrames = 0;
  }

  bool cooldownFinished = lastEventAt == 0 ||
                          millis() - lastEventAt >= EVENT_COOLDOWN_MS;
  if (cooldownFinished &&
      consecutiveMotionFrames >= REQUIRED_CONSECUTIVE_FRAMES) {
    lastEventAt = millis();
    consecutiveMotionFrames = 0;
    handleCameraMotion();
  }
}

bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(ssid, password);
  Serial.print("Menyambung WiFi");
  uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi gagal disambungkan. Kamera akan cuba lagi kemudian.");
    return false;
  }

  Serial.print("WiFi Connected. IP: ");
  Serial.println(WiFi.localIP());
  return true;
}

bool enterDetectionMode() {
  sensor_t* sensor = esp_camera_sensor_get();
  if (!sensor) return false;

  if (sensor->set_pixformat(sensor, PIXFORMAT_JPEG) != 0 ||
      sensor->set_framesize(sensor, FRAMESIZE_96X96) != 0) {
    return false;
  }

  delay(250);
  discardFrames(2);
  baselineReady = false;
  previousSampleCount = 0;
  return true;
}

bool cameraMotionDetected() {
  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame) {
    Serial.println("Frame pengesanan gagal.");
    return false;
  }

  if (frame->format != PIXFORMAT_JPEG || frame->width == 0 ||
      frame->height == 0) {
    esp_camera_fb_return(frame);
    return false;
  }

  if (!fmt2rgb888(frame->buf, frame->len, frame->format, detectionRgb)) {
    esp_camera_fb_return(frame);
    Serial.println("JPEG pengesanan gagal dinyahkod.");
    return false;
  }

  size_t sampleCount = 0;
  size_t changedPixels = 0;
  for (size_t y = 0; y < frame->height; y += SAMPLE_STEP) {
    for (size_t x = 0; x < frame->width; x += SAMPLE_STEP) {
      if (sampleCount >= MAX_MOTION_SAMPLES) break;
      size_t pixelIndex = (y * frame->width + x) * 3;
      uint8_t current = static_cast<uint8_t>(
          (static_cast<uint16_t>(detectionRgb[pixelIndex]) +
           detectionRgb[pixelIndex + 1] + detectionRgb[pixelIndex + 2]) / 3);
      if (baselineReady && sampleCount < previousSampleCount) {
        int difference = abs(static_cast<int>(current) -
                             static_cast<int>(previousFrame[sampleCount]));
        if (difference >= PIXEL_DIFFERENCE_THRESHOLD) changedPixels++;
      }
      previousFrame[sampleCount++] = current;
    }
  }

  esp_camera_fb_return(frame);
  bool hadBaseline = baselineReady && previousSampleCount == sampleCount;
  baselineReady = true;
  previousSampleCount = sampleCount;
  if (!hadBaseline || sampleCount == 0) return false;

  uint8_t changedPercent = static_cast<uint8_t>(
      (changedPixels * 100UL) / sampleCount);
  if (changedPercent >= MOTION_PERCENT_THRESHOLD) {
    Serial.printf("Perubahan imej: %u%%\n", changedPercent);
    return true;
  }
  return false;
}

void handleCameraMotion() {
  Serial.println("Gerakan kamera disahkan. Mengambil gambar...");
  if (!connectWiFi()) {
    enterDetectionMode();
    return;
  }

  String imageUrl = captureAndUploadSnapshot();
  if (!imageUrl.isEmpty()) {
    insertActivityLog(imageUrl, "pergerakan_kamera");
  }

  enterDetectionMode();
  cameraReadyAt = millis() - STARTUP_WARMUP_MS + 1200;
  Serial.println("Kamera kembali memantau.");
}

String captureAndUploadSnapshot() {
  sensor_t* sensor = esp_camera_sensor_get();
  if (!sensor) return "";

  if (sensor->set_pixformat(sensor, PIXFORMAT_JPEG) != 0 ||
      sensor->set_framesize(sensor, FRAMESIZE_VGA) != 0) {
    Serial.println("Gagal menukar kamera kepada mod JPEG.");
    return "";
  }
  sensor->set_quality(sensor, 12);
  delay(300);
  discardFrames(2);

  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame || frame->format != PIXFORMAT_JPEG) {
    if (frame) esp_camera_fb_return(frame);
    Serial.println("Camera capture failed.");
    return "";
  }

  String deviceId = String((uint32_t)(ESP.getEfuseMac() >> 32), HEX);
  String fileName = "images/esp32_" + deviceId + "_" +
                    String(millis()) + ".jpg";
  String uploadUrl = supabaseUrl + "/storage/v1/object/" +
                     bucketName + "/" + fileName;

  HTTPClient http;
  http.setTimeout(25000);
  http.begin(uploadUrl);
  http.addHeader("apikey", apiKey);
  http.addHeader("Authorization", "Bearer " + apiKey);
  http.addHeader("Content-Type", "image/jpeg");
  int code = http.POST(frame->buf, frame->len);
  String response = http.getString();
  http.end();
  esp_camera_fb_return(frame);

  if (code < 200 || code >= 300) {
    Serial.println("Upload gambar gagal. HTTP: " + String(code));
    Serial.println(response);
    return "";
  }

  Serial.println("Gambar berjaya di-upload.");
  return supabaseUrl + "/storage/v1/object/public/" +
         bucketName + "/" + fileName;
}

bool insertActivityLog(const String& imageUrl, const String& eventStatus) {
  if (!connectWiFi()) return false;

  String payload = "{\"status\":\"" + eventStatus + "\",";
  payload += "\"image_url\":\"" + imageUrl + "\",";
  payload += "\"video_url\":null}";

  HTTPClient http;
  http.setTimeout(20000);
  http.begin(supabaseUrl + "/rest/v1/" + tableName);
  http.addHeader("apikey", apiKey);
  http.addHeader("Authorization", "Bearer " + apiKey);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Prefer", "return=minimal");
  int code = http.POST(payload);
  String response = http.getString();
  http.end();

  if (code < 200 || code >= 300) {
    Serial.println("Rekod database gagal. HTTP: " + String(code));
    Serial.println(response);
    return false;
  }

  Serial.println("Rekod aktiviti berjaya disimpan. Aplikasi akan menerima Realtime.");
  return true;
}

void discardFrames(uint8_t count) {
  for (uint8_t index = 0; index < count; index++) {
    camera_fb_t* frame = esp_camera_fb_get();
    if (frame) esp_camera_fb_return(frame);
    delay(60);
  }
}
