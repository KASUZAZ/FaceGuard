#include "avi_recorder.h"

#include "esp_camera.h"

namespace {

struct AviIndexEntry {
  uint32_t offset;
  uint32_t size;
};

bool writeBytes(File& file, const uint8_t* data, size_t length) {
  return file.write(data, length) == length;
}

bool writeFourCC(File& file, const char* value) {
  return file.write(reinterpret_cast<const uint8_t*>(value), 4) == 4;
}

bool writeU16(File& file, uint16_t value) {
  uint8_t bytes[2] = {
      static_cast<uint8_t>(value & 0xff),
      static_cast<uint8_t>((value >> 8) & 0xff)};
  return writeBytes(file, bytes, sizeof(bytes));
}

bool writeU32(File& file, uint32_t value) {
  uint8_t bytes[4] = {
      static_cast<uint8_t>(value & 0xff),
      static_cast<uint8_t>((value >> 8) & 0xff),
      static_cast<uint8_t>((value >> 16) & 0xff),
      static_cast<uint8_t>((value >> 24) & 0xff)};
  return writeBytes(file, bytes, sizeof(bytes));
}

bool patchU32(File& file, uint32_t position, uint32_t value) {
  uint32_t current = file.position();
  if (!file.seek(position)) {
    return false;
  }
  bool ok = writeU32(file, value);
  return file.seek(current) && ok;
}

bool writeZeroes(File& file, size_t count) {
  static const uint8_t zeroes[16] = {};
  while (count > 0) {
    size_t amount = count > sizeof(zeroes) ? sizeof(zeroes) : count;
    if (!writeBytes(file, zeroes, amount)) {
      return false;
    }
    count -= amount;
  }
  return true;
}

}  // namespace

AviRecordResult recordMjpegAvi(fs::FS& fs, const char* path,
                               uint32_t durationMs, uint8_t targetFps,
                               uint16_t width, uint16_t height) {
  AviRecordResult result;
  result.path = path;

  if (targetFps == 0 || durationMs == 0) {
    return result;
  }

  if (fs.exists(path)) {
    fs.remove(path);
  }
  File file = fs.open(path, FILE_WRITE);
  if (!file) {
    Serial.println("AVI: gagal mencipta fail.");
    return result;
  }

  const uint32_t maximumFrames =
      (durationMs / 1000 + 2) * static_cast<uint32_t>(targetFps);
  AviIndexEntry* index = static_cast<AviIndexEntry*>(
      malloc(maximumFrames * sizeof(AviIndexEntry)));
  if (!index) {
    Serial.println("AVI: memori index tidak mencukupi.");
    file.close();
    fs.remove(path);
    return result;
  }

  bool ok = true;
  uint32_t riffSizePosition = 0;
  uint32_t hdrlSizePosition = 0;
  uint32_t avihDataPosition = 0;
  uint32_t strlSizePosition = 0;
  uint32_t strhDataPosition = 0;
  uint32_t strfDataPosition = 0;
  uint32_t moviSizePosition = 0;
  uint32_t moviFourccPosition = 0;

  // RIFF AVI header.
  ok &= writeFourCC(file, "RIFF");
  riffSizePosition = file.position();
  ok &= writeU32(file, 0);
  ok &= writeFourCC(file, "AVI ");

  ok &= writeFourCC(file, "LIST");
  hdrlSizePosition = file.position();
  ok &= writeU32(file, 0);
  ok &= writeFourCC(file, "hdrl");

  // Main AVI header (AVIMAINHEADER, 56 bytes).
  ok &= writeFourCC(file, "avih");
  ok &= writeU32(file, 56);
  avihDataPosition = file.position();
  ok &= writeU32(file, 1000000UL / targetFps);  // microseconds/frame
  ok &= writeU32(file, 0);                      // max bytes/second
  ok &= writeU32(file, 0);                      // padding granularity
  ok &= writeU32(file, 0x10);                   // AVIF_HASINDEX
  ok &= writeU32(file, 0);                      // total frames
  ok &= writeU32(file, 0);                      // initial frames
  ok &= writeU32(file, 1);                      // streams
  ok &= writeU32(file, 0);                      // suggested buffer
  ok &= writeU32(file, width);
  ok &= writeU32(file, height);
  ok &= writeZeroes(file, 16);

  // Video stream list.
  ok &= writeFourCC(file, "LIST");
  strlSizePosition = file.position();
  ok &= writeU32(file, 0);
  ok &= writeFourCC(file, "strl");

  // AVI stream header (AVISTREAMHEADER, 56 bytes).
  ok &= writeFourCC(file, "strh");
  ok &= writeU32(file, 56);
  strhDataPosition = file.position();
  ok &= writeFourCC(file, "vids");
  ok &= writeFourCC(file, "MJPG");
  ok &= writeU32(file, 0);  // flags
  ok &= writeU16(file, 0);  // priority
  ok &= writeU16(file, 0);  // language
  ok &= writeU32(file, 0);  // initial frames
  ok &= writeU32(file, 1);  // scale
  ok &= writeU32(file, targetFps);
  ok &= writeU32(file, 0);           // start
  ok &= writeU32(file, 0);           // length
  ok &= writeU32(file, 0);           // suggested buffer
  ok &= writeU32(file, 0xffffffff);  // quality
  ok &= writeU32(file, 0);           // sample size
  ok &= writeU16(file, 0);
  ok &= writeU16(file, 0);
  ok &= writeU16(file, width);
  ok &= writeU16(file, height);

  // BITMAPINFOHEADER (40 bytes).
  ok &= writeFourCC(file, "strf");
  ok &= writeU32(file, 40);
  strfDataPosition = file.position();
  ok &= writeU32(file, 40);
  ok &= writeU32(file, width);
  ok &= writeU32(file, height);
  ok &= writeU16(file, 1);   // planes
  ok &= writeU16(file, 24);  // bits/pixel
  ok &= writeFourCC(file, "MJPG");
  ok &= writeU32(file, 0);  // image size, patched later
  ok &= writeU32(file, 0);
  ok &= writeU32(file, 0);
  ok &= writeU32(file, 0);
  ok &= writeU32(file, 0);

  uint32_t strlEnd = file.position();
  ok &= patchU32(file, strlSizePosition,
                 strlEnd - (strlSizePosition + 4));
  ok &= patchU32(file, hdrlSizePosition,
                 strlEnd - (hdrlSizePosition + 4));

  // Movie data list.
  ok &= writeFourCC(file, "LIST");
  moviSizePosition = file.position();
  ok &= writeU32(file, 0);
  moviFourccPosition = file.position();
  ok &= writeFourCC(file, "movi");

  if (!ok) {
    Serial.println("AVI: gagal menulis header.");
    free(index);
    file.close();
    fs.remove(path);
    return result;
  }

  uint32_t frameCount = 0;
  uint32_t maximumFrameSize = 0;
  uint32_t jpegBytes = 0;
  uint32_t startedAt = millis();
  uint32_t nextFrameAt = startedAt;
  const uint32_t frameInterval = 1000UL / targetFps;

  while (millis() - startedAt < durationMs && frameCount < maximumFrames) {
    while (static_cast<int32_t>(millis() - nextFrameAt) < 0) {
      delay(1);
    }

    camera_fb_t* frame = esp_camera_fb_get();
    if (!frame || frame->format != PIXFORMAT_JPEG) {
      if (frame) {
        esp_camera_fb_return(frame);
      }
      Serial.println("AVI: gagal mendapatkan frame JPEG.");
      ok = false;
      break;
    }

    uint32_t chunkPosition = file.position();
    index[frameCount].offset = chunkPosition - moviFourccPosition;
    index[frameCount].size = frame->len;

    ok = writeFourCC(file, "00dc") &&
         writeU32(file, frame->len) &&
         writeBytes(file, frame->buf, frame->len);

    uint8_t padding[3] = {};
    uint8_t paddingSize = (4 - (frame->len & 3)) & 3;
    if (paddingSize > 0) {
      ok &= writeBytes(file, padding, paddingSize);
    }

    uint32_t currentSize = frame->len;
    esp_camera_fb_return(frame);
    if (!ok) {
      Serial.println("AVI: microSD gagal menulis frame.");
      break;
    }

    jpegBytes += currentSize;
    if (currentSize > maximumFrameSize) {
      maximumFrameSize = currentSize;
    }
    frameCount++;
    if (frameCount % targetFps == 0) {
      Serial.printf("AVI: %lu saat\n", frameCount / targetFps);
    }

    nextFrameAt += frameInterval;
    if (static_cast<int32_t>(millis() - nextFrameAt) >
        static_cast<int32_t>(frameInterval)) {
      nextFrameAt = millis() + frameInterval;
    }
  }

  uint32_t actualDuration = millis() - startedAt;
  uint32_t moviEnd = file.position();

  if (ok && frameCount > 0) {
    // Write old-style AVI index.
    ok &= writeFourCC(file, "idx1");
    ok &= writeU32(file, frameCount * 16UL);
    for (uint32_t i = 0; i < frameCount && ok; i++) {
      ok &= writeFourCC(file, "00dc");
      ok &= writeU32(file, 0x10);  // keyframe
      ok &= writeU32(file, index[i].offset);
      ok &= writeU32(file, index[i].size);
    }

    uint32_t finalSize = file.position();
    uint32_t bytesPerSecond = actualDuration > 0
                                  ? static_cast<uint32_t>(
                                        (static_cast<uint64_t>(jpegBytes) * 1000) /
                                        actualDuration)
                                  : 0;

    ok &= patchU32(file, riffSizePosition, finalSize - 8);
    ok &= patchU32(file, moviSizePosition,
                   moviEnd - (moviSizePosition + 4));
    ok &= patchU32(file, avihDataPosition + 4, bytesPerSecond);
    ok &= patchU32(file, avihDataPosition + 16, frameCount);
    ok &= patchU32(file, avihDataPosition + 28, maximumFrameSize);
    ok &= patchU32(file, strhDataPosition + 32, frameCount);
    ok &= patchU32(file, strhDataPosition + 36, maximumFrameSize);
    ok &= patchU32(file, strfDataPosition + 20, maximumFrameSize);

    file.flush();
    result.bytes = finalSize;
  }

  free(index);
  file.close();

  if (!ok || frameCount == 0) {
    fs.remove(path);
    return result;
  }

  result.ok = true;
  result.frames = frameCount;
  return result;
}
