import test from 'node:test';
import assert from 'node:assert/strict';
import type { DeviceExportCapabilities } from '../src/types/videoExport';
import {
  computeSmartExportSummary,
  getCodecLabel,
  getCompressionLabel,
} from '../src/utils/exportCalculator';

const FULL_CAPABILITIES: DeviceExportCapabilities = {
  supportedResolutions: ['360p', '480p', '720p', '1080p', '2k', '4k'],
  supportedFpsByResolution: {
    '360p': [24, 30, 60],
    '480p': [24, 30, 60],
    '720p': [24, 30, 60],
    '1080p': [24, 30, 60],
    '2k': [24, 30, 60],
    '4k': [24, 30],
  },
  supportsH264: true,
  supportsH265: true,
  supports4K: true,
  hardwareAccelerated: true,
  availableStorageBytes: 12 * 1024 * 1024 * 1024, // 12 GB free
  encoderSummary: 'Hardware H.264 · Hardware H.265/HEVC · 4K Ready',
};

const MIDRANGE_CAPABILITIES: DeviceExportCapabilities = {
  supportedResolutions: ['360p', '480p', '720p', '1080p'],
  supportedFpsByResolution: {
    '360p': [24, 30, 60],
    '480p': [24, 30, 60],
    '720p': [24, 30, 60],
    '1080p': [24, 30],
    '2k': [],
    '4k': [],
  },
  supportsH264: true,
  supportsH265: false,
  supports4K: false,
  hardwareAccelerated: true,
  availableStorageBytes: 4 * 1024 * 1024 * 1024,
  encoderSummary: 'Hardware H.264',
};

test('computeSmartExportSummary computes exact landscape dimensions across 360p..4K', () => {
  const targets = [
    ['360p', 640, 360],
    ['480p', 854, 480],
    ['720p', 1280, 720],
    ['1080p', 1920, 1080],
    ['2k', 2560, 1440],
    ['4k', 3840, 2160],
  ] as const;

  for (const [resId, expectedW, expectedH] of targets) {
    const summary = computeSmartExportSummary({
      config: { resolution: resId, fps: 30, codec: 'h264', compression: 'high' },
      sourceWidth: 3840,
      sourceHeight: 2160,
      sourceFps: 60,
      durationMs: 60_000,
      capabilities: FULL_CAPABILITIES,
      hasAudioTrack: true,
    });
    assert.equal(summary.effectiveWidth, expectedW);
    assert.equal(summary.effectiveHeight, expectedH);
    assert.equal(summary.wasCappedToSource, false);
    assert.equal(summary.compatible, true);
  }
});

test('prevents fake upscaling above source resolution and FPS', () => {
  const summary = computeSmartExportSummary({
    config: { resolution: '4k', fps: 60, codec: 'h264', compression: 'high' },
    sourceWidth: 1280,
    sourceHeight: 720,
    sourceFps: 30,
    durationMs: 120_000,
    capabilities: FULL_CAPABILITIES,
    hasAudioTrack: true,
  });

  assert.equal(summary.effectiveWidth, 1280);
  assert.equal(summary.effectiveHeight, 720);
  assert.equal(summary.effectiveFps, 30);
  assert.equal(summary.wasCappedToSource, true);
  assert.ok(summary.capNote && summary.capNote.includes('1280x720'));
});

test('preserves portrait aspect ratio with even pixel dimensions', () => {
  const summary = computeSmartExportSummary({
    config: { resolution: '720p', fps: 30, codec: 'h264', compression: 'balanced' },
    sourceWidth: 1080,
    sourceHeight: 1920,
    sourceFps: 30,
    durationMs: 45_000,
    capabilities: MIDRANGE_CAPABILITIES,
    hasAudioTrack: true,
  });

  assert.equal(summary.effectiveWidth, 720);
  assert.equal(summary.effectiveHeight, 1280);
  assert.equal(summary.effectiveWidth % 2, 0);
  assert.equal(summary.effectiveHeight % 2, 0);
});

test('compression presets and H.265 vs H.264 produce monotonic file size estimates', () => {
  const makeSummary = (
    compression: 'original' | 'high' | 'balanced' | 'smaller',
    codec: 'h264' | 'h265' = 'h264'
  ) =>
    computeSmartExportSummary({
      config: { resolution: '1080p', fps: 30, codec, compression },
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceFps: 30,
      durationMs: 300_000, // 5 min
      capabilities: FULL_CAPABILITIES,
      hasAudioTrack: true,
    });

  const orig = makeSummary('original');
  const high = makeSummary('high');
  const bal = makeSummary('balanced');
  const small = makeSummary('smaller');
  const hevcHigh = makeSummary('high', 'h265');

  assert.ok(orig.estimatedFileSizeBytes > high.estimatedFileSizeBytes);
  assert.ok(high.estimatedFileSizeBytes > bal.estimatedFileSizeBytes);
  assert.ok(bal.estimatedFileSizeBytes > small.estimatedFileSizeBytes);
  assert.ok(hevcHigh.estimatedFileSizeBytes < high.estimatedFileSizeBytes);
});

test('blocks unsupported 4K, unsupported H.265, and low-storage 30-minute exports cleanly', () => {
  const unsupported4kAndHevc = computeSmartExportSummary({
    config: { resolution: '4k', fps: 30, codec: 'h265', compression: 'high' },
    sourceWidth: 3840,
    sourceHeight: 2160,
    sourceFps: 30,
    durationMs: 60_000,
    capabilities: MIDRANGE_CAPABILITIES,
    hasAudioTrack: true,
  });

  assert.equal(unsupported4kAndHevc.compatible, false);
  assert.ok(unsupported4kAndHevc.compatibilityIssues.length >= 2);

  const lowStorage30Min = computeSmartExportSummary({
    config: { resolution: '1080p', fps: 60, codec: 'h264', compression: 'original' },
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceFps: 60,
    durationMs: 30 * 60 * 1000,
    capabilities: {
      ...FULL_CAPABILITIES,
      availableStorageBytes: 250 * 1024 * 1024, // 250 MB free — insufficient for 30m 1080p60
    },
    hasAudioTrack: true,
  });

  assert.equal(lowStorage30Min.hasSufficientStorage, false);
  assert.equal(lowStorage30Min.compatible, false);
  assert.equal(getCodecLabel('h265'), 'MP4 (H.265 / HEVC)');
  assert.equal(getCompressionLabel('smaller'), 'Smaller File Size');
});

test('PagedMp4ByteStore writes at exact byte positions including out-of-order patches and page spans', () => {
  const { PagedMp4ByteStore } = require('../../src/utils/browserMp4Exporter') as typeof import('../../src/utils/browserMp4Exporter');
  // Small 16-byte page size to stress multi-page spanning and out-of-order patching
  const store = new PagedMp4ByteStore(16);

  store.writeAt(new Uint8Array([1, 2, 3, 4]), 0);
  store.writeAt(new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]), 12); // spans page 0 -> page 1
  // Simulate MP4 mdat box header patch back at byte offset 4..8
  store.writeAt(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]), 4);

  const merged = Buffer.concat(store.toChunks());
  assert.equal(merged.byteLength, 22);
  assert.deepEqual(Array.from(merged.subarray(0, 8)), [1, 2, 3, 4, 0xaa, 0xbb, 0xcc, 0xdd]);
  assert.deepEqual(Array.from(merged.subarray(12, 22)), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test('mp4-muxer StreamTarget accepts (data, position) and produces byte-identical valid MP4 vs ArrayBufferTarget', () => {
  const { ArrayBufferTarget, Muxer, StreamTarget } = require('mp4-muxer') as typeof import('mp4-muxer');
  const { PagedMp4ByteStore } = require('../../src/utils/browserMp4Exporter') as typeof import('../../src/utils/browserMp4Exporter');

  // Minimal valid AVCDecoderConfigurationRecord (baseline 640x360) for raw chunk muxing
  const avcDescription = new Uint8Array([
    0x01, 0x42, 0xe0, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x1e,
    0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
  ]);
  const aacDescription = new Uint8Array([0x12, 0x10]);

  for (const fastStart of ['in-memory', 'fragmented', false] as const) {
    const refTarget = new ArrayBufferTarget();
    const refMuxer = new Muxer({
      target: refTarget,
      video: { codec: 'avc', width: 640, height: 360, frameRate: 30 },
      audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 44100 },
      fastStart,
    });

    const store = new PagedMp4ByteStore(1024);
    const streamTarget = new StreamTarget({
      onData: (data: Uint8Array, position: number) => {
        store.writeAt(data, position);
      },
      chunked: fastStart === 'fragmented',
      chunkSize: 1024,
    });
    const streamMuxer = new Muxer({
      target: streamTarget,
      video: { codec: 'avc', width: 640, height: 360, frameRate: 30 },
      audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 44100 },
      fastStart,
    });

    const sampleVideoKey = new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x65, 0x88, 0x84, 0x21]);
    const sampleVideoDelta = new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x41, 0x9a, 0x12, 0x34]);
    const sampleAudio = new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]);

    const feed = (m: InstanceType<typeof Muxer>) => {
      m.addVideoChunkRaw(sampleVideoKey, 'key', 0, 33333, {
        decoderConfig: { codec: 'avc1.42E01E', description: avcDescription },
      });
      m.addVideoChunkRaw(sampleVideoDelta, 'delta', 33333, 33333);
      m.addAudioChunkRaw(sampleAudio, 'key', 0, 23219, {
        decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 44100, description: aacDescription },
      });
      m.addAudioChunkRaw(sampleAudio, 'key', 23219, 23219);
      m.finalize();
    };

    feed(refMuxer);
    feed(streamMuxer);

    const refBuf = Buffer.from(refTarget.buffer);
    const streamBuf = Buffer.concat(store.toChunks());

    assert.equal(
      Buffer.compare(streamBuf, refBuf),
      0,
      `StreamTarget output must match ArrayBufferTarget byte-for-byte for fastStart=${String(fastStart)}`
    );
    assert.equal(streamBuf.subarray(4, 8).toString('ascii'), 'ftyp');
    assert.ok(streamBuf.includes(Buffer.from('moov')), 'MP4 must contain moov atom');
    assert.ok(streamBuf.includes(Buffer.from('mdat')), 'MP4 must contain mdat atom');
  }
});

test('Step 5: buildExportSignature & findDuplicateExport prevent duplicate exports and ignore incomplete files', () => {
  const {
    buildExportSignature,
    buildGalleryDisplayName,
    findDuplicateExport,
  } = require('../src/utils/exportCalculator') as typeof import('../src/utils/exportCalculator');

  const sig = buildExportSignature({
    sourceTargetId: 'full_vid_1',
    sourceDurationMs: 12450,
    width: 1280,
    height: 720,
    fps: 30,
    codec: 'h264',
    compression: 'high',
  });

  const name = buildGalleryDisplayName({
    sourceName: 'My Vlog Clip?.mp4',
    height: 720,
    fps: 30,
    codec: 'h264',
    signatureSeed: sig,
  });
  assert.match(name, /^My_Vlog_Clip_720p_30fps_H264_[0-9a-f]{6}\.mp4$/);

  // Incomplete export (too small / zero duration) must never satisfy duplicate cache
  const incompleteMatch = findDuplicateExport(
    [{ exportSignature: sig, fileSizeBytes: 512, durationMs: 0 }],
    sig
  );
  assert.equal(incompleteMatch, null);

  // Complete export matches deterministically
  const completeRecord = { id: 'exp_1', exportSignature: sig, fileSizeBytes: 2_450_000, durationMs: 12450 };
  const duplicateMatch = findDuplicateExport([completeRecord], sig);
  assert.equal(duplicateMatch?.id, 'exp_1');
});

test('Step 5: Native AndroidManifest requests WRITE_EXTERNAL_STORAGE only for API <= 28', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const manifest = fs.readFileSync(
    path.resolve(__dirname, '../modules/hanuman-video-cutter/android/src/main/AndroidManifest.xml'),
    'utf8'
  );
  assert.match(manifest, /android\.permission\.WRITE_EXTERNAL_STORAGE/);
  assert.match(manifest, /android:maxSdkVersion="28"/);
  assert.match(manifest, /android\.intent\.category\.APP_GALLERY/);
});


