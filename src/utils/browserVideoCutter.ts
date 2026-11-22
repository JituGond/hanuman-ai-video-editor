import { Muxer, StreamTarget } from 'mp4-muxer';
import type {
  CutPlan,
  CuttingPreset,
  VideoAnalysisReport,
} from '../../expo-android/src/types/aiCutting';
import { buildCutPlan, getPresetLabel } from '../../expo-android/src/utils/aiCuttingEngine';
import {
  decodeOptionalAudioBuffer,
  PagedMp4ByteStore,
  pickSupportedAudioConfig,
  pickSupportedVideoCodec,
  seekVideoToTime,
} from './browserMp4Exporter';
import {
  inspectLocalVideoFile,
  saveEditedBrowserVideo,
  type LocalBrowserVideo,
  type LocalEditedBrowserVideo,
} from './localBrowserVideoDb';

function pickSupportedRecorderMimeType(): string | undefined {
  const candidates = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return undefined;
}

function waitForSeek(video: HTMLVideoElement, targetSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve();
    }, 3000);
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Failed seeking video segment during cutting.'));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = Math.max(0, targetSec);
  });
}

async function generateCutWithWebCodecs(params: {
  sourceVideo: LocalBrowserVideo;
  cutPlan: CutPlan;
  preset: CuttingPreset;
  onProgress?: (progress: number, stage: string) => void;
  signal?: AbortSignal;
}): Promise<Blob | null> {
  const { sourceVideo, cutPlan, onProgress, signal } = params;
  if (typeof VideoEncoder === 'undefined') {
    return null;
  }

  const objectUrl = URL.createObjectURL(sourceVideo.fileBlob);
  const videoEl = document.createElement('video');
  videoEl.preload = 'auto';
  videoEl.muted = true;
  videoEl.playsInline = true;

  try {
    await new Promise<void>((resolve, reject) => {
      videoEl.onloadeddata = () => resolve();
      videoEl.onerror = () => reject(new Error('Could not load source video for cutting.'));
      videoEl.src = objectUrl;
    });

    const srcW = videoEl.videoWidth || 1280;
    const srcH = videoEl.videoHeight || 720;
    const scale = Math.min(1, 1280 / Math.max(srcW, srcH));
    const outW = Math.max(2, Math.round((srcW * scale) / 2) * 2);
    const outH = Math.max(2, Math.round((srcH * scale) / 2) * 2);
    const fps = 30;
    const bitrate = 3_500_000;

    const selectedVideoCodec = await pickSupportedVideoCodec(
      'h264',
      outH >= 1080 ? '1080p' : '720p',
      outW,
      outH,
      fps,
      bitrate
    );
    if (!selectedVideoCodec) {
      return null;
    }

    const audioBuffer = cutPlan.keepSegments.length > 0
      ? await decodeOptionalAudioBuffer(sourceVideo.fileBlob)
      : null;
    if (signal?.aborted) {
      throw new DOMException('Cutting cancelled', 'AbortError');
    }

    const hasUsableAudio =
      audioBuffer !== null &&
      audioBuffer.numberOfChannels > 0 &&
      audioBuffer.length > 0 &&
      audioBuffer.sampleRate > 0;

    const audioChannels = hasUsableAudio && audioBuffer ? Math.min(2, audioBuffer.numberOfChannels) : 0;
    const audioCodecInfo =
      hasUsableAudio && audioBuffer
        ? await pickSupportedAudioConfig(audioBuffer.sampleRate, audioChannels, 128_000)
        : null;

    const byteStore = new PagedMp4ByteStore(4 * 1024 * 1024);
    const useFragmented = cutPlan.estimatedEditedDurationMs > 360_000;
    const muxer = new Muxer({
      target: new StreamTarget({
        onData: (data: Uint8Array, position: number) => {
          byteStore.writeAt(data, position);
        },
        chunked: useFragmented,
        chunkSize: 8 * 1024 * 1024,
      }),
      video: {
        codec: 'avc',
        width: outW,
        height: outH,
        frameRate: fps,
      },
      audio:
        hasUsableAudio && audioBuffer && audioCodecInfo
          ? {
              codec: audioCodecInfo.muxerCodec,
              numberOfChannels: audioChannels,
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
      width: outW,
      height: outH,
      bitrate,
      framerate: fps,
    });

    let audioEncoder: AudioEncoder | null = null;
    if (hasUsableAudio && audioBuffer && audioCodecInfo) {
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
        numberOfChannels: audioChannels,
        bitrate: 128_000,
      });
    }

    try {
      const segmentPlans = cutPlan.keepSegments.map((seg) => {
        const durSec = Math.max(0.05, (seg.endMs - seg.startMs) / 1000);
        const frameCount = Math.max(1, Math.round(durSec * fps));
        return { seg, frameCount, exactDurSec: frameCount / fps };
      });
      const totalFrames = Math.max(
        1,
        segmentPlans.reduce((sum, item) => sum + item.frameCount, 0)
      );

      // Encode exact segment-matched audio samples so audio & video match frame-for-frame
      if (audioEncoder && audioBuffer) {
        onProgress?.(0.06, 'Synchronizing cut audio clips...');
        const sr = audioBuffer.sampleRate;
        const channelArrays = Array.from({ length: audioChannels }, (_, c) =>
          audioBuffer.getChannelData(c)
        );
        const chunkFrames = 1024;
        const fadeSamples = Math.min(Math.round(sr * 0.005), 256);
        let globalSampleCursor = 0;

        for (const plan of segmentPlans) {
          const segSamples = Math.max(1, Math.round(plan.exactDurSec * sr));
          const srcStartSample = Math.max(0, Math.round((plan.seg.startMs / 1000) * sr));

          for (let localOffset = 0; localOffset < segSamples; localOffset += chunkFrames) {
            if (signal?.aborted) throw new DOMException('Cutting cancelled', 'AbortError');
            if (encoderFailure) throw encoderFailure;

            const n = Math.min(chunkFrames, segSamples - localOffset);
            const planar = new Float32Array(n * audioChannels);
            for (let c = 0; c < audioChannels; c++) {
              const ch = channelArrays[c];
              for (let k = 0; k < n; k++) {
                const posInSeg = localOffset + k;
                const srcIdx = srcStartSample + posInSeg;
                let sample = srcIdx < ch.length ? ch[srcIdx] : 0;
                if (posInSeg < fadeSamples) {
                  sample *= posInSeg / fadeSamples;
                } else if (segSamples - 1 - posInSeg < fadeSamples) {
                  sample *= (segSamples - 1 - posInSeg) / fadeSamples;
                }
                planar[c * n + k] = sample;
              }
            }

            const audioData = new AudioData({
              format: 'f32-planar',
              sampleRate: sr,
              numberOfFrames: n,
              numberOfChannels: audioChannels,
              timestamp: Math.round((globalSampleCursor / sr) * 1_000_000),
              data: planar,
            });
            audioEncoder.encode(audioData);
            audioData.close();
            globalSampleCursor += n;

            while (audioEncoder.encodeQueueSize > 16) {
              await new Promise((r) => setTimeout(r, 4));
            }
          }
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('2D rendering context unavailable.');

      const frameDurationUs = Math.round(1_000_000 / fps);
      const keyFrameInterval = fps * 2;
      let globalFrameIdx = 0;

      for (let segIdx = 0; segIdx < segmentPlans.length; segIdx++) {
        const { seg, frameCount } = segmentPlans[segIdx];
        const segStartSec = seg.startMs / 1000;
        const maxSegSec = Math.max(segStartSec, seg.endMs / 1000 - 0.005);

        for (let f = 0; f < frameCount; f++) {
          if (signal?.aborted) throw new DOMException('Cutting cancelled', 'AbortError');
          if (encoderFailure) throw encoderFailure;

          const srcSec = Math.min(maxSegSec, segStartSec + f / fps);
          await seekVideoToTime(videoEl, srcSec);
          ctx.drawImage(videoEl, 0, 0, outW, outH);

          const frame = new VideoFrame(canvas, {
            timestamp: globalFrameIdx * frameDurationUs,
            duration: frameDurationUs,
          });
          videoEncoder.encode(frame, { keyFrame: globalFrameIdx % keyFrameInterval === 0 });
          frame.close();
          globalFrameIdx++;

          while (videoEncoder.encodeQueueSize > 8) {
            await new Promise((r) => setTimeout(r, 4));
          }

          if (globalFrameIdx % 4 === 0 || globalFrameIdx === totalFrames) {
            onProgress?.(
              0.12 + 0.85 * (globalFrameIdx / totalFrames),
              `Cutting & joining clip ${segIdx + 1} of ${segmentPlans.length}...`
            );
          }
        }
      }

      onProgress?.(0.98, 'Finalizing AI-cut MP4...');
      await videoEncoder.flush();
      if (videoEncoder.state !== 'closed') videoEncoder.close();
      if (audioEncoder) {
        await audioEncoder.flush();
        if (audioEncoder.state !== 'closed') audioEncoder.close();
      }
      if (encoderFailure) throw encoderFailure;

      muxer.finalize();
      if (byteStore.byteLength < 16) return null;
      return byteStore.toBlob('video/mp4');
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
    }
  } finally {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Generates an actual edited video file (Blob) locally in the browser by cutting & joining
 * kept clips deterministically (WebCodecs + mp4-muxer, or MediaRecorder fallback when unavailable),
 * skipping all removed sections cleanly while keeping the original file untouched.
 */
export async function generateEditedBrowserVideo(params: {
  sourceVideo: LocalBrowserVideo;
  analysis: VideoAnalysisReport;
  preset: CuttingPreset;
  onProgress?: (progress: number, stage: string) => void;
  signal?: AbortSignal;
}): Promise<LocalEditedBrowserVideo> {
  const { sourceVideo, analysis, preset, onProgress, signal } = params;
  const cutPlan: CutPlan = buildCutPlan(analysis, preset);
  const editedId = `cut_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  if (preset === 'preserve_original') {
    onProgress?.(0.5, 'Preserving original video copy...');
    const preservedBlob = sourceVideo.fileBlob.slice(0, sourceVideo.fileBlob.size, sourceVideo.fileBlob.type);
    const record: LocalEditedBrowserVideo = {
      id: editedId,
      sourceVideoId: sourceVideo.id,
      sourceVideoName: sourceVideo.name,
      name: `${sourceVideo.name.replace(/\.[^.]+$/, '')} · ${getPresetLabel(preset)}.mp4`,
      fileBlob: preservedBlob,
      thumbnailDataUrl: sourceVideo.thumbnailDataUrl,
      durationMs: sourceVideo.durationMs,
      originalDurationMs: sourceVideo.durationMs,
      fileSizeBytes: preservedBlob.size,
      preset,
      analysis,
      cutPlan,
      createdAt: Date.now(),
    };
    await saveEditedBrowserVideo(record);
    onProgress?.(1.0, 'Original preserved');
    return record;
  }

  const webCodecsBlob = await generateCutWithWebCodecs({
    sourceVideo,
    cutPlan,
    preset,
    onProgress,
    signal,
  });

  if (webCodecsBlob) {
    const inspected = await inspectLocalVideoFile(webCodecsBlob, { allowUnboundedDuration: true });
    const record: LocalEditedBrowserVideo = {
      id: editedId,
      sourceVideoId: sourceVideo.id,
      sourceVideoName: sourceVideo.name,
      name: `${sourceVideo.name.replace(/\.[^.]+$/, '')} · ${getPresetLabel(preset)}.mp4`,
      fileBlob: webCodecsBlob,
      thumbnailDataUrl: inspected.thumbnailDataUrl ?? sourceVideo.thumbnailDataUrl,
      durationMs:
        inspected.durationMs > 0 ? inspected.durationMs : cutPlan.estimatedEditedDurationMs,
      originalDurationMs: sourceVideo.durationMs,
      fileSizeBytes: webCodecsBlob.size,
      preset,
      analysis,
      cutPlan,
      createdAt: Date.now(),
    };
    await saveEditedBrowserVideo(record);
    onProgress?.(1.0, 'Edited video ready');
    return record;
  }

  const objectUrl = URL.createObjectURL(sourceVideo.fileBlob);
  const videoEl = document.createElement('video');
  videoEl.preload = 'auto';
  videoEl.playsInline = true;
  videoEl.muted = false;

  let audioCtx: AudioContext | null = null;
  let recorder: MediaRecorder | null = null;
  let rafId = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      videoEl.onloadedmetadata = () => resolve();
      videoEl.onerror = () => reject(new Error('Could not load source video for cutting.'));
      videoEl.src = objectUrl;
    });

    const srcW = videoEl.videoWidth || 1280;
    const srcH = videoEl.videoHeight || 720;
    const scale = Math.min(1, 1280 / Math.max(srcW, srcH));
    const outW = Math.max(2, Math.round((srcW * scale) / 2) * 2);
    const outH = Math.max(2, Math.round((srcH * scale) / 2) * 2);

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D rendering context unavailable.');
    }

    const canvasStream = canvas.captureStream(30);
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

    if (analysis.hasAudioTrack) {
      try {
        const AudioContextCtor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtx = new AudioContextCtor();
        if (audioCtx.state === 'suspended') {
          await audioCtx.resume();
        }
        const mediaSource = audioCtx.createMediaElementSource(videoEl);
        const streamDest = audioCtx.createMediaStreamDestination();
        mediaSource.connect(streamDest);
        // Intentionally do NOT connect to audioCtx.destination so processing stays silent
        for (const audioTrack of streamDest.stream.getAudioTracks()) {
          tracks.push(audioTrack);
        }
      } catch {
        // Continue with video-only stream if browser restricts audio capture
      }
    }

    const combinedStream = new MediaStream(tracks);
    const mimeType = pickSupportedRecorderMimeType();
    const chunks: BlobPart[] = [];

    recorder = mimeType
      ? new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: 3_500_000 })
      : new MediaRecorder(combinedStream);

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    const stoppedPromise = new Promise<Blob>((resolve, reject) => {
      if (!recorder) {
        reject(new Error('MediaRecorder failed to initialize.'));
        return;
      }
      recorder.onstop = () => {
        const finalType = mimeType?.includes('mp4') ? 'video/mp4' : 'video/webm';
        resolve(new Blob(chunks, { type: finalType }));
      };
      recorder.onerror = () => reject(new Error('MediaRecorder failed while writing edited video.'));
    });

    const totalKeptMs = Math.max(1, cutPlan.estimatedEditedDurationMs);
    let accumulatedMs = 0;

    recorder.start(250);
    recorder.pause();

    for (let idx = 0; idx < cutPlan.keepSegments.length; idx += 1) {
      if (signal?.aborted) {
        throw new DOMException('Cutting cancelled', 'AbortError');
      }

      const seg = cutPlan.keepSegments[idx];
      const segDurationMs = Math.max(1, seg.endMs - seg.startMs);

      await waitForSeek(videoEl, seg.startMs / 1000);
      ctx.drawImage(videoEl, 0, 0, outW, outH);

      if (recorder.state === 'paused') {
        recorder.resume();
      }

      await videoEl.play();

      await new Promise<void>((resolveSegment, rejectSegment) => {
        const tick = () => {
          if (signal?.aborted) {
            videoEl.pause();
            rejectSegment(new DOMException('Cutting cancelled', 'AbortError'));
            return;
          }

          ctx.drawImage(videoEl, 0, 0, outW, outH);

          const currentMs = videoEl.currentTime * 1000;
          const segElapsed = Math.max(0, Math.min(segDurationMs, currentMs - seg.startMs));
          const totalPct = Math.min(0.98, (accumulatedMs + segElapsed) / totalKeptMs);
          onProgress?.(
            totalPct,
            `Cutting & joining clip ${idx + 1} of ${cutPlan.keepSegments.length}...`
          );

          if (currentMs >= seg.endMs - 30 || videoEl.ended) {
            videoEl.pause();
            if (recorder && recorder.state === 'recording') {
              recorder.pause();
            }
            resolveSegment();
            return;
          }

          rafId = window.requestAnimationFrame(tick);
        };
        rafId = window.requestAnimationFrame(tick);
      });

      accumulatedMs += segDurationMs;
    }

    onProgress?.(0.99, 'Finalizing edited video file...');
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }

    const editedBlob = await stoppedPromise;
    const inspected = await inspectLocalVideoFile(editedBlob, { allowUnboundedDuration: true });

    const ext = editedBlob.type.includes('mp4') ? 'mp4' : 'webm';
    const record: LocalEditedBrowserVideo = {
      id: editedId,
      sourceVideoId: sourceVideo.id,
      sourceVideoName: sourceVideo.name,
      name: `${sourceVideo.name.replace(/\.[^.]+$/, '')} · ${getPresetLabel(preset)}.${ext}`,
      fileBlob: editedBlob,
      thumbnailDataUrl: inspected.thumbnailDataUrl ?? sourceVideo.thumbnailDataUrl,
      durationMs:
        inspected.durationMs > 0 ? inspected.durationMs : cutPlan.estimatedEditedDurationMs,
      originalDurationMs: sourceVideo.durationMs,
      fileSizeBytes: editedBlob.size,
      preset,
      analysis,
      cutPlan,
      createdAt: Date.now(),
    };

    await saveEditedBrowserVideo(record);
    onProgress?.(1.0, 'Edited video ready');
    return record;
  } finally {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
    }
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Ignore stop errors on abort
      }
    }
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    if (audioCtx) {
      await audioCtx.close().catch(() => {});
    }
    URL.revokeObjectURL(objectUrl);
  }
}
