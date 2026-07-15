#pragma once

#include <Arduino.h>
#include "FS.h"

struct AviRecordResult {
  bool ok = false;
  String path = "";
  uint32_t frames = 0;
  uint32_t bytes = 0;
};

// Merakam frame JPEG daripada esp_camera ke fail MJPEG/AVI.
AviRecordResult recordMjpegAvi(fs::FS& fs, const char* path,
                               uint32_t durationMs, uint8_t targetFps,
                               uint16_t width, uint16_t height);
