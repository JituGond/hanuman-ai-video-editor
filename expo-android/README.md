# Hanuman AI Video Editor — Steps 1–4 (React Native + Expo Android)

On-device video import, AI automatic video cutting, full automatic AI video & audio editing, and professional MP4 export for Android. 100% offline processing with zero cloud uploads or internet dependency.

## Implemented Features

### Step 1: Video Import & Playback (Preserved)
- **Gallery Video** (`expo-image-picker`), **Screen Recording Video** (`expo-media-library`), and **File Manager Video** (`expo-document-picker` SAF).
- On-device file persistence (`FileSystem.documentDirectory/hanuman_videos/`), thumbnail extraction, 30:00 max duration enforcement, and Play/Pause preview player.

### Step 2: AI Automatic Video Cutting (Preserved)
- Streaming `MediaExtractor` + `MediaCodec` audio RMS profiling and `64x36` visual scene/motion analysis (bounded memory for 30-min videos on 6GB RAM Android devices).
- **6 Smart Cutting Options** rendered cleanly into a new `.mp4` via Google Jetpack `androidx.media3:media3-transformer`, with interactive timeline and Original vs AI-Cut comparison.

### Step 3: Full Automatic AI Video Editing (Preserved)
- One-click **START AI FULL EDITING** button, `AUTO SELECT` + 6 editing styles, OpenGL ES 2.0 GPU shader enhancements (`HanumanEnhanceGlEffect.kt`), and `HanumanAudioEnhanceProcessor.kt` voice clarity/noise reduction/normalization/background music mix.

### Step 4: Professional Video Quality & Export System
- **Video Quality Options**: `360p`, `480p`, `720p HD`, `1080p Full HD`, `2K`, and `4K` (`4K` & `2K` only exposed when verified supported by hardware `MediaCodecList`; strictly prevents fake upscaling beyond source resolution).
- **FPS Options**: `24 FPS`, `30 FPS`, `60 FPS` (filtered by actual `VideoCapabilities.areSizeAndRateSupported` and source FPS).
- **Formats & Compression**: `MP4 (H.264 / AVC)` and `MP4 (H.265 / HEVC)` (when hardware encoder exists), with `Original Quality`, `High Quality`, `Balanced Quality`, and `Smaller File Size` presets.
- **Smart Export & Android Gallery Compatibility**: Pre-flight check displays target resolution, FPS, duration, estimated file size, available `StatFs` storage, and compatibility status; exports a real playable `.mp4` locally and registers it in Android Gallery via `MediaLibrary.createAssetAsync` with live progress % and safe cancellation.

## Running on a Real Android Device

```bash
cd expo-android
npm install
npm test
npx expo prebuild --platform android
npx expo run:android
```
