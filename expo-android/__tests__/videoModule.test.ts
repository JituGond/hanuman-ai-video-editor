import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VIDEO_DURATION_MS,
  MAX_VIDEO_DURATION_SECONDS,
  formatDuration,
  formatFileSize,
  getSourceLabel,
  isScreenRecordingCandidate,
  sanitizeFileName,
  validateVideoDuration,
} from '../src/utils/videoValidation';

test('supports videos up to exactly 30 minutes (1,800,000 ms)', () => {
  assert.equal(MAX_VIDEO_DURATION_SECONDS, 1800);
  assert.equal(MAX_VIDEO_DURATION_MS, 1_800_000);

  const exactLimit = validateVideoDuration(1_800_000);
  assert.equal(exactLimit.valid, true);
  assert.equal(exactLimit.durationMs, 1_800_000);

  const underLimit = validateVideoDuration(12 * 60 * 1000 + 34_000);
  assert.equal(underLimit.valid, true);
  assert.equal(underLimit.durationMs, 754_000);
});

test('rejects videos longer than 30 minutes', () => {
  const overLimit = validateVideoDuration(1_800_001);
  assert.equal(overLimit.valid, false);
  assert.match(overLimit.reason ?? '', /30:00/);

  const fortyMinutes = validateVideoDuration(40 * 60 * 1000);
  assert.equal(fortyMinutes.valid, false);
});

test('handles unknown duration safely for Android File Manager SAF files', () => {
  const disallowUnknown = validateVideoDuration(0, { allowUnknown: false });
  assert.equal(disallowUnknown.valid, false);

  const allowUnknown = validateVideoDuration(0, { allowUnknown: true });
  assert.equal(allowUnknown.valid, true);
  assert.equal(allowUnknown.durationMs, 0);
});

test('formats durations cleanly across seconds, minutes, and hours', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(9_000), '00:09');
  assert.equal(formatDuration(125_000), '02:05');
  assert.equal(formatDuration(1_800_000), '30:00');
  assert.equal(formatDuration(3_661_000), '1:01:01');
});

test('formats file sizes cleanly', () => {
  assert.equal(formatFileSize(0), 'Unknown size');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(15 * 1024 * 1024), '15.0 MB');
});

test('identifies Android screen recordings across Pixel, Samsung, Xiaomi, and OnePlus', () => {
  assert.equal(
    isScreenRecordingCandidate({
      albumTitle: 'Screen recordings',
      filename: 'screen-20261121-010203.mp4',
    }),
    true
  );

  assert.equal(
    isScreenRecordingCandidate({
      albumTitle: 'DCIM',
      filename: 'Screen_Recording_20261121_010203.mp4',
    }),
    true
  );

  assert.equal(
    isScreenRecordingCandidate({
      albumTitle: 'ScreenRecorder',
      filename: 'VID_001.mp4',
    }),
    true
  );

  assert.equal(
    isScreenRecordingCandidate({
      albumTitle: 'Camera',
      filename: 'PXL_20261121_010203.mp4',
    }),
    false
  );
});

test('sanitizes filenames safely for Expo FileSystem storage', () => {
  assert.equal(sanitizeFileName('My Clip (Final)!.mp4'), 'My_Clip__Final__.mp4');
  assert.equal(sanitizeFileName('recording'), 'recording.mp4');
});

test('maps import sources to readable labels', () => {
  assert.equal(getSourceLabel('gallery'), 'Gallery Video');
  assert.equal(getSourceLabel('screen_recording'), 'Screen Recording');
  assert.equal(getSourceLabel('file_manager'), 'File Manager');
});
