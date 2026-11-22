import { Muxer, StreamTarget } from 'mp4-muxer';
import {
  RESOLUTION_SPECS,
  type DeviceExportCapabilities,
  type ExportCodec,
  type ExportConfiguration,
  type ExportFps,
  type ExportResolutionId,
  type SmartExportSummary,
} from '../../expo-android/src/types/videoExport';
import { getResolutionSpec } from '../../expo-android/src/utils/exportCalculator';
import {
  computeBlobSha256,
  verifyPlayableMp4Blob,
  type LocalExportedBrowserVideo,
} from './localBrowserVideoDb';

export interface BrowserExportProbe extends DeviceExportCapabilities {
  sourceWidth: number;
  sourceHeight: number;
  sourceFps: number;
  sourceDurationMs: number;
  hasAudioTrack: boolean;
  resolvedVideoCodecString: string | null;
}

const H264_CANDIDATES_BY_RES: Record<ExportResolutionId, string[]> = {
  '360p': ['avc1.4D401E', 'avc1.42E01E', 'avc1.64001E'],
  '480p': ['avc1.4D401F', 'avc1.42E01F', 'avc1.64001F'],
  '720p': ['avc1.4D401F', 'avc1.64001F', 'avc1.42E01F'],
  '1080p': ['avc1.64002A', 'avc1.4D4028', 'avc1.42E028'],
  '2k': ['avc1.640032', 'avc1.640033', 'avc1.4D4032'],
  '4k': ['avc1.640033', 'avc1.4D4033', 'avc1.640034'],
};

const H265_CANDIDATES = [
  'hvc1.1.6.L120.B0',
  'hvc1.1.6.L150.B0',
  'hev1.1.6.L120.B0',
  'hvc1.1.6.L93.B0',
];

export async function pickSupportedVideoCodec(
  codec: ExportCodec,
  resId: ExportResolutionId,
  width: number,
  height: number,
  fps: number,
  bitrate: number
): Promise<{ codec: string; hardwareAccelerated: boolean } | null> {
  if (typeof VideoEncoder === 'undefined') {
    return null;
  }

  const candidates = codec === 'h265' ? H265_CANDIDATES : H264_CANDIDATES_BY_RES[resId];
  for (const hardwarePref of ['prefer-hardware', 'no-preference'] as const) {
    for (const candidate of candidates) {
      try {
        const res = await VideoEncoder.isConfigSupported({
          codec: candidate,
          width,
          height,
          framerate: fps,
          bitrate,
          hardwareAcceleration: hardwarePref,
        });
        if (res.supported) {
          return {
            codec: candidate,
            hardwareAccelerated: hardwarePref === 'prefer-hardware',
          };
        }
      } catch {
        // Probe next candidate
      }
    }
  }
  return null;
}

export async function pickSupportedAudioConfig(
  sampleRate: number,
  numberOfChannels: number,
  bitrate: number
): Promise<{ webCodecsCodec: string; muxerCodec: 'aac' | 'opus' } | null> {
  if (typeof AudioEncoder === 'undefined') {
    return null;
  }

  const attempts: Array<{ webCodecsCodec: string; muxerCodec: 'aac' | 'opus' }> = [
    { webCodecsCodec: 'mp4a.40.2', muxerCodec: 'aac' },
    { webCodecsCodec: 'opus', muxerCodec: 'opus' },
  ];

  for (const attempt of attempts) {
    try {
      const res = await AudioEncoder.isConfigSupported({
        codec: attempt.webCodecsCodec,
        sampleRate,
        numberOfChannels,
        bitrate,
      });
      if (res.supported) {
        return attempt;
      }
    } catch {
      // Try next audio codec
    }
  }
  return null;
}

async function readSourceVideoMetadata(fileBlob: Blob): Promise<{
  width: number;
  height: number;
  durationMs: number;
  hasAudioTrack: boolean;
}> {
  const url = URL.createObjectURL(fileBlob);
  try {
    return await new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;

      const timeout = window.setTimeout(() => {
        reject(new Error('Timed out reading video metadata for export.'));
      }, 10000);

      video.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('Could not decode source video metadata.'));
      };

      video.onloadedmetadata = () => {
        const finalizeMeta = () => {
          window.clearTimeout(timeout);
          const width = video.videoWidth || 1280;
          const height = video.videoHeight || 720;
          const durationMs = Number.isFinite(video.duration)
            ? Math.round(video.duration * 1000)
            : 0;
          const audioVideo = video as HTMLVideoElement & {
            mozHasAudio?: boolean;
            webkitAudioDecodedByteCount?: number;
            audioTracks?: { length: number };
          };
          const hasAudioTrack =
            typeof audioVideo.mozHasAudio === 'boolean'
              ? audioVideo.mozHasAudio
              : audioVideo.audioTracks
                ? audioVideo.audioTracks.length > 0
                : true;

          video.removeAttribute('src');
          video.load();
          resolve({ width, height, durationMs, hasAudioTrack });
        };

        if (!Number.isFinite(video.duration) || video.duration <= 0) {
          // Force browser demuxer to scan container end on unindexed MediaRecorder WebM blobs
          const onResolvedSeek = () => {
            video.removeEventListener('seeked', onResolvedSeek);
            finalizeMeta();
          };
          video.addEventListener('seeked', onResolvedSeek, { once: true });
          video.currentTime = 1e10;
          return;
        }

        finalizeMeta();
      };

      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function detectBrowserExportCapabilities(
  fileBlob: Blob,
  fallbackDurationMs: number
): Promise<BrowserExportProbe> {
  const meta = await readSourceVideoMetadata(fileBlob);
  const sourceDurationMs = meta.durationMs > 0 ? meta.durationMs : fallbackDurationMs;

  let availableStorageBytes: number | null = null;
  try {
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      const est = await navigator.storage.estimate();
      if (typeof est.quota === 'number' && typeof est.usage === 'number') {
        availableStorageBytes = Math.max(0, est.quota - est.usage);
      }
    }
  } catch {
    availableStorageBytes = null;
  }

  const hasWebCodecs = typeof VideoEncoder !== 'undefined';
  const supportedResolutions: ExportResolutionId[] = [];
  const supportedFpsByResolution: Record<ExportResolutionId, ExportFps[]> = {
    '360p': [],
    '480p': [],
    '720p': [],
    '1080p': [],
    '2k': [],
    '4k': [],
  };

  let supportsH264 = false;
  let supportsH265 = false;
  let hardwareAccelerated = false;
  let defaultVideoCodecString: string | null = null;

  if (hasWebCodecs) {
    const hevc720 = await pickSupportedVideoCodec('h265', '720p', 1280, 720, 30, 4_000_000);
    supportsH265 = hevc720 !== null;

    for (const spec of RESOLUTION_SPECS) {
      const fpsSupported: ExportFps[] = [];
      for (const fps of [24, 30, 60] as ExportFps[]) {
        const avc = await pickSupportedVideoCodec(
          'h264',
          spec.id,
          spec.width16x9,
          spec.height,
          fps,
          spec.height >= 1440 ? 18_000_000 : spec.height >= 1080 ? 8_000_000 : 4_000_000
        );
        if (avc) {
          fpsSupported.push(fps);
          supportsH264 = true;
          if (avc.hardwareAccelerated) hardwareAccelerated = true;
          if (!defaultVideoCodecString) defaultVideoCodecString = avc.codec;
        }
      }
      supportedFpsByResolution[spec.id] = fpsSupported;
      if (fpsSupported.length > 0) {
        supportedResolutions.push(spec.id);
      }
    }
  } else if (typeof MediaRecorder !== 'undefined') {
    const mp4Supported =
      MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2') ||
      MediaRecorder.isTypeSupported('video/mp4');
    if (mp4Supported) {
      supportsH264 = true;
      supportedResolutions.push('360p', '480p', '720p', '1080p');
      supportedFpsByResolution['360p'] = [24, 30];
      supportedFpsByResolution['480p'] = [24, 30];
      supportedFpsByResolution['720p'] = [24, 30];
      supportedFpsByResolution['1080p'] = [24, 30];
    }
  }

  const supports4K = supportedResolutions.includes('4k');
  const encoderParts = [
    supportsH264 ? (hardwareAccelerated ? 'Hardware H.264' : 'WebCodecs H.264') : 'MP4 Unavailable',
  ];
  if (supportsH265) encoderParts.push('H.265/HEVC');
  if (supports4K) encoderParts.push('4K Ready');

  return {
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    sourceFps: 30,
    sourceDurationMs,
    hasAudioTrack: meta.hasAudioTrack,
    resolvedVideoCodecString: defaultVideoCodecString,
    supportedResolutions,
    supportedFpsByResolution,
    supportsH264,
    supportsH265,
    supports4K,
    hardwareAccelerated,
    availableStorageBytes,
    encoderSummary: encoderParts.join(' · '),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('MP4 export cancelled by user.', 'AbortError');
  }
}

/**
 * Random-access paged byte writer for mp4-muxer StreamTarget.
 * Writes incoming Uint8Array slices at the exact byte `position` reported by
 * `onData(data, position)`, preserving out-of-order MP4 atom patches (e.g. mdat/moov)
 * without allocating a single monolithic contiguous ArrayBuffer.
 */
export class PagedMp4ByteStore {
  private readonly pageSize: number;
  private readonly pages = new Map<number, Uint8Array>();
  private maxByteLength = 0;

  constructor(pageSize = 4 * 1024 * 1024) {
    this.pageSize = pageSize;
  }

  get byteLength(): number {
    return this.maxByteLength;
  }

  writeAt(data: Uint8Array, position: number): void {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError('PagedMp4ByteStore.writeAt expected Uint8Array data.');
    }
    if (!Number.isFinite(position) || position < 0) {
      throw new RangeError(`Invalid MP4 byte write position: ${position}`);
    }
    if (data.byteLength === 0) return;

    let written = 0;
    while (written < data.byteLength) {
      const globalOffset = position + written;
      const pageIndex = Math.floor(globalOffset / this.pageSize);
      const pageOffset = globalOffset % this.pageSize;

      let page = this.pages.get(pageIndex);
      if (!page) {
        page = new Uint8Array(this.pageSize);
        this.pages.set(pageIndex, page);
      }

      const sliceLen = Math.min(data.byteLength - written, this.pageSize - pageOffset);
      page.set(data.subarray(written, written + sliceLen), pageOffset);
      written += sliceLen;
    }

    const endOffset = position + data.byteLength;
    if (endOffset > this.maxByteLength) {
      this.maxByteLength = endOffset;
    }
  }

  toChunks(): Uint8Array<ArrayBuffer>[] {
    if (this.maxByteLength === 0) return [];
    const totalPages = Math.ceil(this.maxByteLength / this.pageSize);
    const chunks: Uint8Array<ArrayBuffer>[] = [];

    for (let i = 0; i < totalPages; i++) {
      const page = this.pages.get(i) ?? new Uint8Array(this.pageSize);
      const remaining = this.maxByteLength - i * this.pageSize;
      const used = Math.min(this.pageSize, remaining);
      const slice = used === this.pageSize ? page : page.subarray(0, used);
      // Ensure ArrayBuffer-backed copy for Blob/TypedArray compatibility
      chunks.push(new Uint8Array(slice));
    }

    return chunks;
  }

  toBlob(mimeType = 'video/mp4'): Blob {
    return new Blob(this.toChunks(), { type: mimeType });
  }
}

export async function seekVideoToTime(video: HTMLVideoElement, seconds: number): Promise<void> {
  const maxSeek = Number.isFinite(video.duration) && video.duration > 0
    ? Math.max(0, video.duration - 0.005)
    : Math.max(0, seconds);
  const clamped = Math.max(0, Math.min(seconds, maxSeek));

  if (Math.abs(video.currentTime - clamped) < 0.001 && video.readyState >= 2) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Timed out seeking source video frame during MP4 export.'));
    }, 8000);

    const onSeeked = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      cleanup();
      resolve();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      cleanup();
      reject(new Error('Failed seeking video frame during MP4 export.'));
    };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };

    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = clamped;

    // Some browsers synchronously snap currentTime without firing seeked if delta is sub-frame
    if (!video.seeking && Math.abs(video.currentTime - clamped) < 0.001 && video.readyState >= 2) {
      settled = true;
      window.clearTimeout(timeout);
      cleanup();
      resolve();
    }
  });
}

export async function decodeOptionalAudioBuffer(fileBlob: Blob): Promise<AudioBuffer | null> {
  if (fileBlob.size > 450 * 1024 * 1024) {
    return null;
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;

  const ctx = new AudioCtx();
  try {
    const buf = await fileBlob.arrayBuffer();
    return await ctx.decodeAudioData(buf);
  } catch {
    return null;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function fallbackMediaRecorderMp4(params: {
  fileBlob: Blob;
  targetWidth: number;
  targetHeight: number;
  targetFps: ExportFps;
  videoBitrateBps: number;
  durationMs: number;
  onProgress?: (progress: number, stage: string) => void;
  signal?: AbortSignal;
}): Promise<Blob> {
  const {
    fileBlob,
    targetWidth,
    targetHeight,
    targetFps,
    videoBitrateBps,
    durationMs,
    onProgress,
    signal,
  } = params;

  const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2')
    ? 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'
    : MediaRecorder.isTypeSupported('video/mp4')
      ? 'video/mp4'
      : '';

  if (!mimeType) {
    throw new Error(
      'This browser does not expose WebCodecs H.264/MP4 or native MediaRecorder video/mp4 encoding.'
    );
  }

  const url = URL.createObjectURL(fileBlob);
  const video = document.createElement('video');
  video.src = url;
  video.muted = false;
  video.playsInline = true;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Failed loading video for MP4 recording.'));
    });

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable.');

    const stream = canvas.captureStream(targetFps);
    const AudioCtx = window.AudioContext;
    let audioCtx: AudioContext | null = null;
    if (AudioCtx) {
      audioCtx = new AudioCtx();
      const srcNode = audioCtx.createMediaElementSource(video);
      const dest = audioCtx.createMediaStreamDestination();
      srcNode.connect(dest);
      for (const track of dest.stream.getAudioTracks()) {
        stream.addTrack(track);
      }
    }

    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: videoBitrateBps });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const donePromise = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/mp4' }));
      recorder.onerror = () => reject(new Error('MediaRecorder MP4 export error.'));
    });

    let rafId = 0;
    const abortHandler = () => {
      cancelAnimationFrame(rafId);
      if (recorder.state !== 'inactive') recorder.stop();
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    recorder.start(500);
    await video.play();

    const drawTick = () => {
      if (signal?.aborted || video.ended) {
        if (recorder.state !== 'inactive') recorder.stop();
        return;
      }
      ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
      const pct = Math.min(0.98, (video.currentTime * 1000) / Math.max(1, durationMs));
      onProgress?.(pct, `Encoding MP4 (${Math.round(pct * 100)}%)...`);
      rafId = requestAnimationFrame(drawTick);
    };
    rafId = requestAnimationFrame(drawTick);

    video.onended = () => {
      cancelAnimationFrame(rafId);
      if (recorder.state !== 'inactive') recorder.stop();
    };

    const resultBlob = await donePromise;
    signal?.removeEventListener('abort', abortHandler);
    throwIfAborted(signal);
    if (audioCtx) await audioCtx.close().catch(() => {});
    return resultBlob;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function exportBrowserVideoToMp4(params: {
  sourceVideoId: string;
  sourceName: string;
  sourceBlob: Blob;
  thumbnailDataUrl: string | null;
  config: ExportConfiguration;
  summary: SmartExportSummary;
  onProgress?: (progress: number, stage: string) => void;
  signal?: AbortSignal;
}): Promise<LocalExportedBrowserVideo> {
  const {
    sourceVideoId,
    sourceName,
    sourceBlob,
    thumbnailDataUrl,
    config,
    summary,
    onProgress,
    signal,
  } = params;

  throwIfAborted(signal);

  if (!summary.compatible) {
    throw new Error(
      summary.compatibilityIssues[0] ??
        'Export configuration is incompatible with this device or free storage.'
    );
  }

  const width = summary.effectiveWidth;
  const height = summary.effectiveHeight;
  const fps = summary.effectiveFps;

  onProgress?.(0.03, `Checking ${height}p ${fps}fps MP4 encoder...`);

  const selectedVideoCodec = await pickSupportedVideoCodec(
    config.codec,
    config.resolution,
    width,
    height,
    fps,
    summary.videoBitrateBps
  );

  let mp4Blob: Blob;
  let actualAudioPresent = false;

  if (!selectedVideoCodec) {
    mp4Blob = await fallbackMediaRecorderMp4({
      fileBlob: sourceBlob,
      targetWidth: width,
      targetHeight: height,
      targetFps: fps,
      videoBitrateBps: summary.videoBitrateBps,
      durationMs: summary.durationMs,
      onProgress,
      signal,
    });
  } else {
    const audioBuffer = await decodeOptionalAudioBuffer(sourceBlob);
    throwIfAborted(signal);

    const hasUsableAudio =
      audioBuffer !== null &&
      audioBuffer.numberOfChannels > 0 &&
      audioBuffer.length > 0 &&
      audioBuffer.sampleRate > 0;

    const audioCodecInfo = hasUsableAudio
      ? await pickSupportedAudioConfig(
          audioBuffer.sampleRate,
          Math.min(2, audioBuffer.numberOfChannels),
          Math.max(64_000, summary.audioBitrateBps || 128_000)
        )
      : null;

    actualAudioPresent = Boolean(hasUsableAudio && audioCodecInfo);

    const byteStore = new PagedMp4ByteStore(4 * 1024 * 1024);
    const useFragmented = summary.estimatedFileSizeBytes > 160 * 1024 * 1024;
    const muxerTarget = new StreamTarget({
      onData: (data: Uint8Array, position: number) => {
        byteStore.writeAt(data, position);
      },
      chunked: useFragmented,
      chunkSize: 8 * 1024 * 1024,
    });

    const muxer = new Muxer({
      target: muxerTarget,
      video: {
        codec: config.codec === 'h265' ? 'hevc' : 'avc',
        width,
        height,
        frameRate: fps,
      },
      audio: actualAudioPresent && audioBuffer && audioCodecInfo
        ? {
            codec: audioCodecInfo.muxerCodec,
            numberOfChannels: Math.min(2, audioBuffer.numberOfChannels),
            sampleRate: audioBuffer.sampleRate,
          }
        : undefined,
      fastStart: useFragmented ? 'fragmented' : 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    let encoderFailure: Error | null = null;

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta);
        } catch (err) {
          encoderFailure = err instanceof Error ? err : new Error(String(err));
        }
      },
      error: (err) => {
        encoderFailure = err instanceof Error ? err : new Error(String(err));
      },
    });

    videoEncoder.configure({
      codec: selectedVideoCodec.codec,
      width,
      height,
      bitrate: summary.videoBitrateBps,
      framerate: fps,
    });

    let audioEncoder: AudioEncoder | null = null;
    if (actualAudioPresent && audioBuffer && audioCodecInfo) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          try {
            muxer.addAudioChunk(chunk, meta);
          } catch (err) {
            encoderFailure = err instanceof Error ? err : new Error(String(err));
          }
        },
        error: (err) => {
          encoderFailure = err instanceof Error ? err : new Error(String(err));
        },
      });
      audioEncoder.configure({
        codec: audioCodecInfo.webCodecsCodec,
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: Math.min(2, audioBuffer.numberOfChannels),
        bitrate: Math.max(64_000, summary.audioBitrateBps || 128_000),
      });
    }

    // Encode audio chunks in bounded 1024-sample windows aligned to target duration
    if (audioEncoder && audioBuffer) {
      onProgress?.(0.08, 'Encoding synchronized audio stream...');
      const channels = Math.min(2, audioBuffer.numberOfChannels);
      const sr = audioBuffer.sampleRate;
      const targetDurationSec = Math.max(0.1, summary.durationMs / 1000);
      const targetAudioSamples = Math.max(1, Math.round(targetDurationSec * sr));
      const chunkFrames = 1024;

      const channelArrays = Array.from({ length: channels }, (_, c) =>
        audioBuffer.getChannelData(c)
      );

      for (let offset = 0; offset < targetAudioSamples; offset += chunkFrames) {
        throwIfAborted(signal);
        if (encoderFailure) throw encoderFailure;

        const framesThisChunk = Math.min(chunkFrames, targetAudioSamples - offset);
        const planar = new Float32Array(framesThisChunk * channels);
        const copyLen = Math.max(0, Math.min(framesThisChunk, audioBuffer.length - offset));
        if (copyLen > 0) {
          for (let c = 0; c < channels; c++) {
            planar.set(
              channelArrays[c].subarray(offset, offset + copyLen),
              c * framesThisChunk
            );
          }
        }

        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: sr,
          numberOfFrames: framesThisChunk,
          numberOfChannels: channels,
          timestamp: Math.round((offset / sr) * 1_000_000),
          data: planar,
        });

        audioEncoder.encode(audioData);
        audioData.close();

        while (audioEncoder.encodeQueueSize > 16) {
          await new Promise((r) => setTimeout(r, 4));
        }
      }
    }

    // Step video frames deterministically onto target canvas without storing frames in RAM
    const videoUrl = URL.createObjectURL(sourceBlob);
    const videoEl = document.createElement('video');
    videoEl.preload = 'auto';
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.src = videoUrl;

    try {
      await new Promise<void>((resolve, reject) => {
        videoEl.onloadeddata = () => resolve();
        videoEl.onerror = () => reject(new Error('Failed opening source video for MP4 export.'));
      });

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('2D canvas unavailable for export scaling.');

      const durationSec = Math.max(0.1, summary.durationMs / 1000);
      const totalFrames = Math.max(1, Math.round(durationSec * fps));
      const frameDurationUs = Math.round(1_000_000 / fps);
      const keyFrameInterval = fps * 2;

      for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        throwIfAborted(signal);
        if (encoderFailure) throw encoderFailure;

        const timeSec = Math.min(Math.max(0, durationSec - 0.005), frameIdx / fps);
        await seekVideoToTime(videoEl, timeSec);
        ctx.drawImage(videoEl, 0, 0, width, height);

        const timestampUs = frameIdx * frameDurationUs;
        const frame = new VideoFrame(canvas, {
          timestamp: timestampUs,
          duration: frameDurationUs,
        });

        videoEncoder.encode(frame, { keyFrame: frameIdx % keyFrameInterval === 0 });
        frame.close();

        while (videoEncoder.encodeQueueSize > 8) {
          await new Promise((r) => setTimeout(r, 4));
        }

        if (frameIdx % 4 === 0 || frameIdx === totalFrames - 1) {
          const pct = 0.12 + 0.84 * ((frameIdx + 1) / totalFrames);
          onProgress?.(
            Math.min(0.96, pct),
            `Exporting ${height}p ${fps}fps MP4 (${Math.round(((frameIdx + 1) / totalFrames) * 100)}%)...`
          );
        }
      }

      onProgress?.(0.98, 'Finalizing MP4 container & moov index...');
      await videoEncoder.flush();
      if (videoEncoder.state !== 'closed') videoEncoder.close();
      if (audioEncoder) {
        await audioEncoder.flush();
        if (audioEncoder.state !== 'closed') audioEncoder.close();
      }
      if (encoderFailure) throw encoderFailure;

      muxer.finalize();
      if (byteStore.byteLength < 16) {
        throw new Error('Export produced an incomplete MP4 file.');
      }
      mp4Blob = byteStore.toBlob('video/mp4');
    } catch (err) {
      try {
        if (videoEncoder.state !== 'closed') videoEncoder.close();
      } catch {
        // Ignore close error
      }
      try {
        if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
      } catch {
        // Ignore close error
      }
      throw err;
    } finally {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
      URL.revokeObjectURL(videoUrl);
    }
  }

  if (mp4Blob.size < 1024) {
    throw new Error('Generated MP4 file is incomplete or empty.');
  }

  onProgress?.(0.99, 'Verifying playable MP4 atoms & checksum...');
  const verifiedMeta = await verifyPlayableMp4Blob(mp4Blob);
  const contentHash = await computeBlobSha256(mp4Blob);

  onProgress?.(1, 'MP4 export complete');

  const resLabel = getResolutionSpec(config.resolution).id;
  const baseName = sourceName.replace(/\.[^.]+$/, '');

  return {
    id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    sourceVideoId,
    name: `${baseName} · ${height}p ${fps}fps.mp4`,
    fileBlob: mp4Blob,
    thumbnailDataUrl,
    durationMs: verifiedMeta.durationMs > 0 ? verifiedMeta.durationMs : summary.durationMs,
    fileSizeBytes: mp4Blob.size,
    width,
    height,
    fps,
    codec: config.codec,
    compression: config.compression,
    hasAudio: actualAudioPresent || summary.audioBitrateBps > 0,
    resId: resLabel,
    contentHash,
    verifiedPlayable: true,
    createdAt: Date.now(),
  };
}
