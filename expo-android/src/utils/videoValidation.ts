export const MAX_VIDEO_DURATION_SECONDS = 30 * 60; // 1800 seconds
export const MAX_VIDEO_DURATION_MS = MAX_VIDEO_DURATION_SECONDS * 1000; // 1,800,000 ms

export interface DurationValidationResult {
  valid: boolean;
  durationMs: number;
  reason?: string;
}

/**
 * Validates that a video duration does not exceed the 30-minute device module limit.
 * A durationMs of 0 is allowed temporarily when Android File Manager (SAF) does not
 * expose metadata until the native video player reads the container header.
 */
export function validateVideoDuration(
  durationMs: number | null | undefined,
  options?: { allowUnknown?: boolean }
): DurationValidationResult {
  if (durationMs === null || durationMs === undefined || Number.isNaN(durationMs) || durationMs < 0) {
    if (options?.allowUnknown) {
      return { valid: true, durationMs: 0 };
    }
    return {
      valid: false,
      durationMs: 0,
      reason: 'Could not read video duration from the selected file.',
    };
  }

  if (durationMs === 0) {
    if (options?.allowUnknown) {
      return { valid: true, durationMs: 0 };
    }
    return {
      valid: false,
      durationMs: 0,
      reason: 'Selected video has zero duration or is unreadable.',
    };
  }

  if (durationMs > MAX_VIDEO_DURATION_MS) {
    return {
      valid: false,
      durationMs,
      reason: `Video is ${formatDuration(durationMs)}, which exceeds the 30:00 maximum duration limit.`,
    };
  }

  return {
    valid: true,
    durationMs: Math.round(durationMs),
  };
}

/**
 * Formats milliseconds into MM:SS or H:MM:SS for durations up to 30+ minutes.
 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '00:00';
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Formats byte count into a human-readable size string.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 'Unknown size';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * Recognizes Android screen recordings across Pixel, Samsung, Xiaomi/MIUI, OnePlus,
 * Motorola, and stock AOSP folder and filename conventions.
 */
export function isScreenRecordingCandidate(asset: {
  filename?: string;
  uri?: string;
  albumTitle?: string;
}): boolean {
  const filename = (asset.filename ?? '').toLowerCase();
  const uri = (asset.uri ?? '').toLowerCase();
  const albumTitle = (asset.albumTitle ?? '').toLowerCase();

  const albumKeywords = [
    'screen recording',
    'screen recordings',
    'screenrecordings',
    'screen records',
    'screenrecords',
    'screenrecorder',
    'screen recorder',
    'screencapture',
  ];

  if (albumKeywords.some((kw) => albumTitle.includes(kw))) {
    return true;
  }

  const pathOrNamePatterns = [
    /screen[\s_-]?record/i,
    /screen[\s_-]?capture/i,
    /scr_\d+/i,
    /srecorder/i,
    /az_recorder/i,
    /xrecorder/i,
  ];

  return pathOrNamePatterns.some(
    (pattern) => pattern.test(filename) || pattern.test(uri)
  );
}

/**
 * Sanitizes a filename for safe storage inside Expo's documentDirectory.
 */
export function sanitizeFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return `video_${Date.now()}.mp4`;
  }
  const cleaned = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.includes('.') ? cleaned : `${cleaned}.mp4`;
}

export function getSourceLabel(source: 'gallery' | 'screen_recording' | 'file_manager'): string {
  switch (source) {
    case 'gallery':
      return 'Gallery Video';
    case 'screen_recording':
      return 'Screen Recording';
    case 'file_manager':
      return 'File Manager';
  }
}
