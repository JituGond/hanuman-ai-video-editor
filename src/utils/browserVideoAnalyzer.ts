import type { AnalysisWindow, VideoAnalysisReport } from '../../expo-android/src/types/aiCutting';
import { analyzeVideoWindows } from '../../expo-android/src/utils/aiCuttingEngine';
import type { LocalBrowserVideo } from './localBrowserVideoDb';

async function decodeAudioRmsWindows(
  blob: Blob,
  windowCount: number,
  sampleIntervalMs: number
): Promise<{ hasAudioTrack: boolean; windowDb: number[] }> {
  const windowDb = new Array<number>(windowCount).fill(-90);
  // Avoid allocating huge PCM buffers on very large multi-hundred-MB 30-min uploads if AudioContext fails
  if (blob.size > 450 * 1024 * 1024) {
    return { hasAudioTrack: false, windowDb };
  }

  let audioCtx: AudioContext | null = null;
  try {
    const AudioContextCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new AudioContextCtor();
    const arrayBuf = await blob.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arrayBuf);
    const channelData = decoded.getChannelData(0);
    const sampleRate = decoded.sampleRate;

    if (!channelData || channelData.length === 0 || sampleRate <= 0) {
      return { hasAudioTrack: false, windowDb };
    }

    const samplesPerWindow = Math.max(1, Math.floor((sampleRate * sampleIntervalMs) / 1000));
    const stride = Math.max(1, Math.floor(samplesPerWindow / 240));

    for (let w = 0; w < windowCount; w += 1) {
      const startSample = w * samplesPerWindow;
      const endSample = Math.min(channelData.length, (w + 1) * samplesPerWindow);
      if (startSample >= endSample) break;

      let sumSq = 0;
      let count = 0;
      for (let s = startSample; s < endSample; s += stride) {
        const v = channelData[s];
        sumSq += v * v;
        count += 1;
      }

      if (count > 0) {
        const rms = Math.sqrt(sumSq / count);
        windowDb[w] = rms > 1e-5 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
      }
    }

    return { hasAudioTrack: true, windowDb };
  } catch {
    return { hasAudioTrack: false, windowDb };
  } finally {
    if (audioCtx) {
      await audioCtx.close().catch(() => {});
    }
  }
}

function seekVideoOnce(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve();
      }
    }, 2500);

    const onSeeked = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Failed to decode video frame during analysis.'));
    };

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };

    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = timeSec;
  });
}

function extractCanvasFeatures(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  prevLuma: Float32Array | null,
  prevHist: number[] | null
): {
  motionScore: number;
  sceneDelta: number;
  histogram: number[];
  luma: Float32Array;
} {
  const imageData = ctx.getImageData(0, 0, width, height).data;
  const pixelCount = width * height;
  const luma = new Float32Array(pixelCount);
  const hist = new Array<number>(12).fill(0);

  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4;
    const r = imageData[offset];
    const g = imageData[offset + 1];
    const b = imageData[offset + 2];
    luma[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    hist[Math.min(3, Math.floor(r / 64))] += 1;
    hist[4 + Math.min(3, Math.floor(g / 64))] += 1;
    hist[8 + Math.min(3, Math.floor(b / 64))] += 1;
  }

  const norm = Math.max(1, pixelCount * 3);
  for (let i = 0; i < hist.length; i += 1) {
    hist[i] /= norm;
  }

  let motionScore = 0;
  if (prevLuma && prevLuma.length === luma.length) {
    let diff = 0;
    for (let i = 0; i < luma.length; i += 1) {
      diff += Math.abs(luma[i] - prevLuma[i]);
    }
    motionScore = Math.min(1, (diff / luma.length) * 3.5);
  }

  let sceneDelta = 0;
  if (prevHist && prevHist.length === hist.length) {
    let l1 = 0;
    for (let i = 0; i < hist.length; i += 1) {
      l1 += Math.abs(hist[i] - prevHist[i]);
    }
    sceneDelta = Math.min(1, l1 * 1.4);
  }

  return { motionScore, sceneDelta, histogram: hist, luma };
}

/**
 * Performs genuine local audio RMS + scaled 64x36 frame histogram/motion analysis
 * on the uploaded video without sending any bytes over the network.
 */
export async function analyzeBrowserVideoLocally(
  videoRecord: LocalBrowserVideo,
  onProgress?: (progress: number, stage: string) => void,
  signal?: AbortSignal
): Promise<VideoAnalysisReport> {
  const objectUrl = URL.createObjectURL(videoRecord.fileBlob);
  const videoEl = document.createElement('video');
  videoEl.preload = 'auto';
  videoEl.muted = true;
  videoEl.playsInline = true;

  try {
    await new Promise<void>((resolve, reject) => {
      videoEl.onloadedmetadata = () => resolve();
      videoEl.onerror = () => reject(new Error('Could not open video for local analysis.'));
      videoEl.src = objectUrl;
    });

    const totalDurationMs =
      Number.isFinite(videoEl.duration) && videoEl.duration > 0
        ? Math.round(videoEl.duration * 1000)
        : videoRecord.durationMs;

    const sampleIntervalMs =
      totalDurationMs <= 120_000 ? 750 : totalDurationMs <= 600_000 ? 1500 : 3000;
    const windowCount = Math.max(1, Math.ceil(totalDurationMs / sampleIntervalMs));

    onProgress?.(0.08, 'Analyzing audio waveform & silence...');
    const audioResult = await decodeAudioRmsWindows(
      videoRecord.fileBlob,
      windowCount,
      sampleIntervalMs
    );

    if (signal?.aborted) {
      throw new DOMException('Analysis cancelled', 'AbortError');
    }

    const canvasW = 64;
    const canvasH = 36;
    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Canvas 2D context unavailable for frame analysis.');
    }

    const windows: AnalysisWindow[] = [];
    let prevLuma: Float32Array | null = null;
    let prevHist: number[] | null = null;

    for (let i = 0; i < windowCount; i += 1) {
      if (signal?.aborted) {
        throw new DOMException('Analysis cancelled', 'AbortError');
      }

      const startMs = i * sampleIntervalMs;
      const endMs = Math.min(totalDurationMs, (i + 1) * sampleIntervalMs);
      const midpointSec = Math.min(
        Math.max(0, (totalDurationMs - 50) / 1000),
        (startMs + endMs) / 2000
      );

      await seekVideoOnce(videoEl, midpointSec);
      ctx.drawImage(videoEl, 0, 0, canvasW, canvasH);
      const features = extractCanvasFeatures(ctx, canvasW, canvasH, prevLuma, prevHist);

      prevLuma = features.luma;
      prevHist = features.histogram;

      windows.push({
        startMs,
        endMs,
        audioRmsDb: audioResult.windowDb[i],
        visualMotion: features.motionScore,
        sceneDelta: features.sceneDelta,
        histogram: features.histogram,
      });

      const pct = 0.25 + (0.73 * (i + 1)) / windowCount;
      onProgress?.(pct, `Detecting scenes & pauses (${i + 1}/${windowCount})...`);
    }

    onProgress?.(1.0, 'Analysis complete');

    return analyzeVideoWindows({
      videoId: videoRecord.id,
      totalDurationMs,
      windows,
      hasAudioTrack: audioResult.hasAudioTrack,
    });
  } finally {
    videoEl.removeAttribute('src');
    videoEl.load();
    URL.revokeObjectURL(objectUrl);
  }
}
