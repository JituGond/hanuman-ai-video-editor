import { Muxer, StreamTarget } from 'mp4-muxer';
import type { VideoAnalysisReport } from '../../expo-android/src/types/aiCutting';
import type {
  AudioEditOptions,
  ComputedEnhancementProfile,
  EditingStyleSelection,
  FullEditPlan,
  VideoEnhancementToggles,
} from '../../expo-android/src/types/aiEditing';
import {
  buildFullEditPlan,
  getEditingStyleLabel,
} from '../../expo-android/src/utils/aiFullEditorEngine';
import {
  decodeOptionalAudioBuffer,
  PagedMp4ByteStore,
  pickSupportedAudioConfig,
  pickSupportedVideoCodec,
  seekVideoToTime,
} from './browserMp4Exporter';
import {
  inspectLocalVideoFile,
  saveFullEditedBrowserVideo,
  type LocalBrowserVideo,
  type LocalFullEditedBrowserVideo,
} from './localBrowserVideoDb';

interface WebGlFrameRenderer {
  drawFrame: (video: HTMLVideoElement, fadeFactor: number) => void;
  dispose: () => void;
}

function createWebGlFrameRenderer(
  canvas: HTMLCanvasElement,
  profile: ComputedEnhancementProfile
): WebGlFrameRenderer | null {
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) return null;

  const vertSrc = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      gl_Position = vec4(aPos, 0.0, 1.0);
      vUv = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
    }
  `;

  const fragSrc = `
    precision mediump float;
    uniform sampler2D uTex;
    uniform vec2 uTexel;
    uniform float uBrightness;
    uniform float uContrast;
    uniform float uSaturation;
    uniform vec3 uRgbScale;
    uniform float uSharpness;
    uniform float uDenoise;
    uniform float uZoom;
    uniform float uFade;
    varying vec2 vUv;

    void main() {
      vec2 uv = (vUv - 0.5) / uZoom + 0.5;
      vec3 c = texture2D(uTex, uv).rgb;
      vec3 n = texture2D(uTex, uv + vec2(0.0, uTexel.y)).rgb;
      vec3 s = texture2D(uTex, uv - vec2(0.0, uTexel.y)).rgb;
      vec3 e = texture2D(uTex, uv + vec2(uTexel.x, 0.0)).rgb;
      vec3 w = texture2D(uTex, uv - vec2(uTexel.x, 0.0)).rgb;

      vec3 avg = (n + s + e + w) * 0.25;
      vec3 baseCol = mix(c, avg, clamp(uDenoise, 0.0, 0.45));
      vec3 sharpened = clamp(baseCol + (baseCol - avg) * clamp(uSharpness, 0.0, 0.8), 0.0, 1.0);

      // RGB white-balance correction
      vec3 balanced = clamp(sharpened * uRgbScale, 0.0, 1.0);

      // Brightness & Contrast
      vec3 lit = clamp((balanced + uBrightness - 0.5) * (1.0 + uContrast) + 0.5, 0.0, 1.0);

      // Saturation adjustment
      float luma = dot(lit, vec3(0.299, 0.587, 0.114));
      vec3 finalRgb = clamp(mix(vec3(luma), lit, 1.0 + uSaturation / 100.0), 0.0, 1.0);

      gl_FragColor = vec4(finalRgb * uFade, 1.0);
    }
  `;

  const compileShader = (type: number, src: string) => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };

  const vs = compileShader(gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const locPos = gl.getAttribLocation(program, 'aPos');
  const locTex = gl.getUniformLocation(program, 'uTex');
  const locTexel = gl.getUniformLocation(program, 'uTexel');
  const locBrightness = gl.getUniformLocation(program, 'uBrightness');
  const locContrast = gl.getUniformLocation(program, 'uContrast');
  const locSaturation = gl.getUniformLocation(program, 'uSaturation');
  const locRgbScale = gl.getUniformLocation(program, 'uRgbScale');
  const locSharpness = gl.getUniformLocation(program, 'uSharpness');
  const locDenoise = gl.getUniformLocation(program, 'uDenoise');
  const locZoom = gl.getUniformLocation(program, 'uZoom');
  const locFade = gl.getUniformLocation(program, 'uFade');

  return {
    drawFrame(video: HTMLVideoElement, fadeFactor: number) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.enableVertexAttribArray(locPos);
      gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);

      gl.uniform1i(locTex, 0);
      gl.uniform2f(locTexel, 1 / canvas.width, 1 / canvas.height);
      gl.uniform1f(locBrightness, profile.brightnessDelta);
      gl.uniform1f(locContrast, profile.contrastDelta);
      gl.uniform1f(locSaturation, profile.saturationDelta);
      gl.uniform3f(locRgbScale, profile.redScale, profile.greenScale, profile.blueScale);
      gl.uniform1f(locSharpness, profile.sharpnessAmount);
      gl.uniform1f(locDenoise, profile.denoiseStrength);
      gl.uniform1f(locZoom, profile.stabilizationZoom);
      gl.uniform1f(locFade, fadeFactor);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      gl.deleteTexture(tex);
      gl.deleteBuffer(posBuf);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    },
  };
}

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
      reject(new Error('Failed seeking clip during AI video editing.'));
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

async function renderFullEditedAudioForClip(params: {
  sourceAudio: AudioBuffer | null;
  musicAudio: AudioBuffer | null;
  musicStartSec: number;
  srcStartSec: number;
  srcEndSec: number;
  playbackSpeed: number;
  outDurationSec: number;
  sampleRate: number;
  channels: number;
  profile: ComputedEnhancementProfile;
  audioOptions: AudioEditOptions;
}): Promise<AudioBuffer> {
  const {
    sourceAudio,
    musicAudio,
    musicStartSec,
    srcStartSec,
    srcEndSec,
    playbackSpeed,
    outDurationSec,
    sampleRate,
    channels,
    profile,
    audioOptions,
  } = params;

  const outFrames = Math.max(1, Math.round(outDurationSec * sampleRate));
  const OfflineCtx =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  const offline = new OfflineCtx(channels, outFrames, sampleRate);

  if (sourceAudio && srcEndSec > srcStartSec) {
    const sliceStart = Math.max(0, Math.floor(srcStartSec * sourceAudio.sampleRate));
    const sliceEnd = Math.min(sourceAudio.length, Math.ceil(srcEndSec * sourceAudio.sampleRate));
    const sliceLen = Math.max(1, sliceEnd - sliceStart);
    const clipBuf = offline.createBuffer(
      sourceAudio.numberOfChannels,
      sliceLen,
      sourceAudio.sampleRate
    );
    for (let c = 0; c < sourceAudio.numberOfChannels; c++) {
      const chData = sourceAudio.getChannelData(c);
      const copyCount = Math.min(sliceLen, Math.max(0, chData.length - sliceStart));
      if (copyCount > 0) {
        clipBuf.copyToChannel(chData.subarray(sliceStart, sliceStart + copyCount), c, 0);
      }
    }

    const srcNode = offline.createBufferSource();
    srcNode.buffer = clipBuf;
    srcNode.playbackRate.value = playbackSpeed;

    let lastNode: AudioNode = srcNode;
    if (profile.highPassHz > 0) {
      const hp = offline.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = profile.highPassHz;
      lastNode.connect(hp);
      lastNode = hp;
    }

    if (profile.voiceClarityGainDb > 0) {
      const voiceEq = offline.createBiquadFilter();
      voiceEq.type = 'peaking';
      voiceEq.frequency.value = 2500;
      voiceEq.Q.value = 1.1;
      voiceEq.gain.value = profile.voiceClarityGainDb;
      lastNode.connect(voiceEq);
      lastNode = voiceEq;
    }

    if (profile.audioGainDb > 0) {
      const gainNode = offline.createGain();
      gainNode.gain.value = Math.pow(10, profile.audioGainDb / 20);
      lastNode.connect(gainNode);
      lastNode = gainNode;
    }

    if (audioOptions.normalizeVolume && !audioOptions.preserveOriginalAudio) {
      const comp = offline.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 18;
      comp.ratio.value = 5;
      comp.attack.value = 0.005;
      comp.release.value = 0.2;
      lastNode.connect(comp);
      lastNode = comp;
    }

    lastNode.connect(offline.destination);
    srcNode.start(0);
  }

  if (musicAudio && musicAudio.duration > 0) {
    const musicNode = offline.createBufferSource();
    musicNode.buffer = musicAudio;
    musicNode.loop = true;
    const musicGain = offline.createGain();
    musicGain.gain.value = Math.max(0.02, Math.min(0.45, audioOptions.backgroundMusicVolume));
    musicNode.connect(musicGain);
    musicGain.connect(offline.destination);
    musicNode.start(0, musicStartSec % musicAudio.duration);
  }

  return await offline.startRendering();
}

async function generateFullEditWithWebCodecs(params: {
  sourceVideo: LocalBrowserVideo;
  analysis: VideoAnalysisReport;
  editPlan: FullEditPlan;
  audioOptions: AudioEditOptions;
  musicFile?: File | null;
  onProgress?: (progress: number, stage: string) => void;
  signal?: AbortSignal;
}): Promise<Blob | null> {
  const { sourceVideo, analysis, editPlan, audioOptions, musicFile, onProgress, signal } = params;
  if (typeof VideoEncoder === 'undefined') {
    return null;
  }

  const objectUrl = URL.createObjectURL(sourceVideo.fileBlob);
  const videoEl = document.createElement('video');
  videoEl.preload = 'auto';
  videoEl.muted = true;
  videoEl.playsInline = true;

  let glRenderer: WebGlFrameRenderer | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      videoEl.onloadeddata = () => resolve();
      videoEl.onerror = () => reject(new Error('Could not open video for AI editing.'));
      videoEl.src = objectUrl;
    });

    const srcW = videoEl.videoWidth || 1280;
    const srcH = videoEl.videoHeight || 720;
    const scale = Math.min(1, 1280 / Math.max(srcW, srcH));
    const outW = Math.max(2, Math.round((srcW * scale) / 2) * 2);
    const outH = Math.max(2, Math.round((srcH * scale) / 2) * 2);
    const fps = 30;
    const bitrate = 4_000_000;

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

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    glRenderer = createWebGlFrameRenderer(canvas, editPlan.profile);
    const fallbackCtx = glRenderer ? null : canvas.getContext('2d', { alpha: false });
    if (!glRenderer && !fallbackCtx) {
      return null;
    }

    const drawStyledFrame = (fadeFactor: number) => {
      if (glRenderer) {
        glRenderer.drawFrame(videoEl, fadeFactor);
        return;
      }
      if (!fallbackCtx) return;
      const p = editPlan.profile;
      const bPct = Math.round((1 + p.brightnessDelta) * 100);
      const cPct = Math.round((1 + p.contrastDelta) * 100);
      const sPct = Math.round(100 + p.saturationDelta);
      fallbackCtx.save();
      fallbackCtx.fillStyle = '#000000';
      fallbackCtx.fillRect(0, 0, outW, outH);
      fallbackCtx.globalAlpha = fadeFactor;
      fallbackCtx.filter = `brightness(${bPct}%) contrast(${cPct}%) saturate(${sPct}%)`;
      const sx = (srcW - srcW / p.stabilizationZoom) / 2;
      const sy = (srcH - srcH / p.stabilizationZoom) / 2;
      fallbackCtx.drawImage(
        videoEl,
        sx,
        sy,
        srcW / p.stabilizationZoom,
        srcH / p.stabilizationZoom,
        0,
        0,
        outW,
        outH
      );
      fallbackCtx.restore();
    };

    const sourceAudio = analysis.hasAudioTrack
      ? await decodeOptionalAudioBuffer(sourceVideo.fileBlob)
      : null;
    let musicAudio: AudioBuffer | null = null;
    if (musicFile) {
      musicAudio = await decodeOptionalAudioBuffer(musicFile);
    }
    if (signal?.aborted) {
      throw new DOMException('AI editing cancelled', 'AbortError');
    }

    const hasAnyAudio =
      (sourceAudio !== null && sourceAudio.length > 0 && sourceAudio.sampleRate > 0) ||
      (musicAudio !== null && musicAudio.length > 0 && musicAudio.sampleRate > 0);
    const sampleRate = sourceAudio?.sampleRate ?? musicAudio?.sampleRate ?? 48000;
    const channels = Math.min(
      2,
      Math.max(sourceAudio?.numberOfChannels ?? 0, musicAudio?.numberOfChannels ?? 0, 2)
    );

    const audioCodecInfo = hasAnyAudio
      ? await pickSupportedAudioConfig(sampleRate, channels, 128_000)
      : null;
    const encodeAudio = hasAnyAudio && audioCodecInfo !== null;

    const byteStore = new PagedMp4ByteStore(4 * 1024 * 1024);
    const useFragmented = editPlan.estimatedEditedDurationMs > 360_000;
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
        encodeAudio && audioCodecInfo
          ? {
              codec: audioCodecInfo.muxerCodec,
              numberOfChannels: channels,
              sampleRate,
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
    if (encodeAudio && audioCodecInfo) {
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
        sampleRate,
        numberOfChannels: channels,
        bitrate: 128_000,
      });
    }

    try {
      const clipPlans = editPlan.clips.map((clip) => {
        const srcDurSec = Math.max(0.05, (clip.endMs - clip.startMs) / 1000);
        const outDurSec = Math.max(0.05, srcDurSec / clip.playbackSpeed);
        const frameCount = Math.max(1, Math.round(outDurSec * fps));
        return { clip, frameCount, exactOutDurSec: frameCount / fps };
      });
      const totalFrames = Math.max(
        1,
        clipPlans.reduce((sum, item) => sum + item.frameCount, 0)
      );

      if (audioEncoder) {
        onProgress?.(0.08, 'Applying OfflineAudioContext DSP & voice clarity...');
        const chunkFrames = 1024;
        let globalSampleCursor = 0;
        let musicOffsetSec = 0;

        for (const plan of clipPlans) {
          if (signal?.aborted) throw new DOMException('AI editing cancelled', 'AbortError');
          if (encoderFailure) throw encoderFailure;

          const renderedClip = await renderFullEditedAudioForClip({
            sourceAudio,
            musicAudio,
            musicStartSec: musicOffsetSec,
            srcStartSec: plan.clip.startMs / 1000,
            srcEndSec: plan.clip.endMs / 1000,
            playbackSpeed: plan.clip.playbackSpeed,
            outDurationSec: plan.exactOutDurSec,
            sampleRate,
            channels,
            profile: editPlan.profile,
            audioOptions,
          });
          musicOffsetSec += plan.exactOutDurSec;

          const chArrays = Array.from({ length: channels }, (_, c) =>
            renderedClip.getChannelData(Math.min(c, renderedClip.numberOfChannels - 1))
          );

          for (let offset = 0; offset < renderedClip.length; offset += chunkFrames) {
            if (signal?.aborted) throw new DOMException('AI editing cancelled', 'AbortError');
            if (encoderFailure) throw encoderFailure;

            const n = Math.min(chunkFrames, renderedClip.length - offset);
            const planar = new Float32Array(n * channels);
            for (let c = 0; c < channels; c++) {
              planar.set(chArrays[c].subarray(offset, offset + n), c * n);
            }

            const audioData = new AudioData({
              format: 'f32-planar',
              sampleRate,
              numberOfFrames: n,
              numberOfChannels: channels,
              timestamp: Math.round((globalSampleCursor / sampleRate) * 1_000_000),
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

      const frameDurationUs = Math.round(1_000_000 / fps);
      const keyFrameInterval = fps * 2;
      let globalFrameIdx = 0;

      for (let idx = 0; idx < clipPlans.length; idx++) {
        const { clip, frameCount } = clipPlans[idx];
        const fadeWindowMs =
          clip.transitionIn !== 'none' ? editPlan.profile.transitionDurationMs : 0;
        const clipStartSec = clip.startMs / 1000;
        const maxClipSec = Math.max(clipStartSec, clip.endMs / 1000 - 0.005);

        for (let f = 0; f < frameCount; f++) {
          if (signal?.aborted) throw new DOMException('AI editing cancelled', 'AbortError');
          if (encoderFailure) throw encoderFailure;

          const elapsedOutSec = f / fps;
          const elapsedSrcMs = elapsedOutSec * clip.playbackSpeed * 1000;
          const srcSec = Math.min(maxClipSec, clipStartSec + elapsedSrcMs / 1000);

          await seekVideoToTime(videoEl, srcSec);
          const fadeFactor =
            fadeWindowMs > 0 && elapsedSrcMs < fadeWindowMs
              ? Math.max(0.15, Math.min(1, elapsedSrcMs / fadeWindowMs))
              : 1.0;
          drawStyledFrame(fadeFactor);

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
              0.14 + 0.83 * (globalFrameIdx / totalFrames),
              `Rendering ${getEditingStyleLabel(editPlan.resolvedStyle)} · Clip ${idx + 1}/${
                clipPlans.length
              }...`
            );
          }
        }
      }

      onProgress?.(0.98, 'Finalizing AI-edited MP4...');
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
    glRenderer?.dispose();
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Executes real local AI Full Video Editing in the browser using WebGL GPU shaders
 * (color, lighting, contrast, saturation, 3x3 sharpening, denoise, stabilization crop,
 * clip boundary transitions) + Web Audio DSP (high-pass rumble cut, 2.5kHz voice boost,
 * normalization compressor, and optional local background music mixing).
 */
export async function generateFullAiEditedBrowserVideo(params: {
  sourceVideo: LocalBrowserVideo;
  analysis: VideoAnalysisReport;
  styleSelection: EditingStyleSelection;
  enhancements: VideoEnhancementToggles;
  audioOptions: AudioEditOptions;
  musicFile?: File | null;
  onProgress?: (progress: number, stage: string) => void;
  signal?: AbortSignal;
}): Promise<LocalFullEditedBrowserVideo> {
  const {
    sourceVideo,
    analysis,
    styleSelection,
    enhancements,
    audioOptions,
    musicFile,
    onProgress,
    signal,
  } = params;

  const editPlan = buildFullEditPlan({
    analysis,
    styleSelection,
    enhancements,
    audioOptions,
  });

  const editedId = `full_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const webCodecsBlob = await generateFullEditWithWebCodecs({
    sourceVideo,
    analysis,
    editPlan,
    audioOptions,
    musicFile,
    onProgress,
    signal,
  });

  if (webCodecsBlob) {
    const inspected = await inspectLocalVideoFile(webCodecsBlob, { allowUnboundedDuration: true });
    const record: LocalFullEditedBrowserVideo = {
      id: editedId,
      sourceVideoId: sourceVideo.id,
      sourceVideoName: sourceVideo.name,
      name: `${sourceVideo.name.replace(/\.[^.]+$/, '')} · ${getEditingStyleLabel(
        editPlan.resolvedStyle
      )}.mp4`,
      fileBlob: webCodecsBlob,
      thumbnailDataUrl: inspected.thumbnailDataUrl ?? sourceVideo.thumbnailDataUrl,
      durationMs:
        inspected.durationMs > 0 ? inspected.durationMs : editPlan.estimatedEditedDurationMs,
      originalDurationMs: sourceVideo.durationMs,
      fileSizeBytes: webCodecsBlob.size,
      editPlan,
      analysis,
      createdAt: Date.now(),
    };
    await saveFullEditedBrowserVideo(record);
    onProgress?.(1.0, 'AI Full Editing complete');
    return record;
  }
  const objectUrl = URL.createObjectURL(sourceVideo.fileBlob);
  const videoEl = document.createElement('video');
  videoEl.preload = 'auto';
  videoEl.playsInline = true;
  videoEl.muted = false;

  let audioCtx: AudioContext | null = null;
  let musicSourceNode: AudioBufferSourceNode | null = null;
  let recorder: MediaRecorder | null = null;
  let glRenderer: WebGlFrameRenderer | null = null;
  let rafId = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      videoEl.onloadedmetadata = () => resolve();
      videoEl.onerror = () => reject(new Error('Could not open video for AI editing.'));
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

    glRenderer = createWebGlFrameRenderer(canvas, editPlan.profile);
    const fallbackCtx = glRenderer ? null : canvas.getContext('2d');

    if (!glRenderer && !fallbackCtx) {
      throw new Error('GPU/2D canvas rendering unavailable.');
    }

    const drawStyledFrame = (fadeFactor: number) => {
      if (glRenderer) {
        glRenderer.drawFrame(videoEl, fadeFactor);
        return;
      }
      if (!fallbackCtx) return;

      const p = editPlan.profile;
      const bPct = Math.round((1 + p.brightnessDelta) * 100);
      const cPct = Math.round((1 + p.contrastDelta) * 100);
      const sPct = Math.round(100 + p.saturationDelta);

      fallbackCtx.save();
      fallbackCtx.fillStyle = '#000000';
      fallbackCtx.fillRect(0, 0, outW, outH);
      fallbackCtx.globalAlpha = fadeFactor;
      fallbackCtx.filter = `brightness(${bPct}%) contrast(${cPct}%) saturate(${sPct}%)`;

      const cropW = outW / p.stabilizationZoom;
      const cropH = outH / p.stabilizationZoom;
      const sx = ((srcW - srcW / p.stabilizationZoom) / 2);
      const sy = ((srcH - srcH / p.stabilizationZoom) / 2);
      fallbackCtx.drawImage(
        videoEl,
        sx,
        sy,
        srcW / p.stabilizationZoom,
        srcH / p.stabilizationZoom,
        0,
        0,
        outW,
        outH
      );
      fallbackCtx.restore();
      void cropW;
      void cropH;
    };

    const canvasStream = canvas.captureStream(30);
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

    // Build Web Audio DSP graph (High-pass + Voice Clarity + Normalization Compressor + Music Mix)
    if (analysis.hasAudioTrack || musicFile) {
      try {
        const AudioContextCtor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtx = new AudioContextCtor();
        if (audioCtx.state === 'suspended') {
          await audioCtx.resume();
        }
        const streamDest = audioCtx.createMediaStreamDestination();

        if (analysis.hasAudioTrack) {
          let lastNode: AudioNode = audioCtx.createMediaElementSource(videoEl);

          if (editPlan.profile.highPassHz > 0) {
            const hp = audioCtx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = editPlan.profile.highPassHz;
            lastNode.connect(hp);
            lastNode = hp;
          }

          if (editPlan.profile.voiceClarityGainDb > 0) {
            const voiceEq = audioCtx.createBiquadFilter();
            voiceEq.type = 'peaking';
            voiceEq.frequency.value = 2500;
            voiceEq.Q.value = 1.1;
            voiceEq.gain.value = editPlan.profile.voiceClarityGainDb;
            lastNode.connect(voiceEq);
            lastNode = voiceEq;
          }

          if (editPlan.profile.audioGainDb > 0) {
            const gainNode = audioCtx.createGain();
            gainNode.gain.value = Math.pow(10, editPlan.profile.audioGainDb / 20);
            lastNode.connect(gainNode);
            lastNode = gainNode;
          }

          if (audioOptions.normalizeVolume && !audioOptions.preserveOriginalAudio) {
            const compressor = audioCtx.createDynamicsCompressor();
            compressor.threshold.value = -16;
            compressor.knee.value = 18;
            compressor.ratio.value = 5;
            compressor.attack.value = 0.005;
            compressor.release.value = 0.2;
            lastNode.connect(compressor);
            lastNode = compressor;
          }

          lastNode.connect(streamDest);
        }

        if (musicFile) {
          const musicBuf = await audioCtx.decodeAudioData(await musicFile.arrayBuffer());
          musicSourceNode = audioCtx.createBufferSource();
          musicSourceNode.buffer = musicBuf;
          musicSourceNode.loop = true;

          const musicGain = audioCtx.createGain();
          musicGain.gain.value = Math.max(0.02, Math.min(0.45, audioOptions.backgroundMusicVolume));
          musicSourceNode.connect(musicGain);
          musicGain.connect(streamDest);
          musicSourceNode.start(0);
        }

        for (const audioTrack of streamDest.stream.getAudioTracks()) {
          tracks.push(audioTrack);
        }
      } catch {
        // Proceed gracefully if audio subsystem is blocked
      }
    }

    const combinedStream = new MediaStream(tracks);
    const mimeType = pickSupportedRecorderMimeType();
    const chunks: BlobPart[] = [];

    recorder = mimeType
      ? new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: 4_000_000 })
      : new MediaRecorder(combinedStream);

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
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
      recorder.onerror = () => reject(new Error('MediaRecorder failed during AI editing.'));
    });

    const totalEditedTargetMs = Math.max(1, editPlan.estimatedEditedDurationMs);
    let accumulatedOutputMs = 0;

    recorder.start(250);
    recorder.pause();

    for (let idx = 0; idx < editPlan.clips.length; idx += 1) {
      if (signal?.aborted) {
        throw new DOMException('AI editing cancelled', 'AbortError');
      }

      const clip = editPlan.clips[idx];
      const clipSourceDurationMs = Math.max(1, clip.endMs - clip.startMs);
      const clipOutputDurationMs = clipSourceDurationMs / clip.playbackSpeed;

      videoEl.playbackRate = clip.playbackSpeed;
      await waitForSeek(videoEl, clip.startMs / 1000);

      const fadeWindowMs =
        clip.transitionIn !== 'none' ? editPlan.profile.transitionDurationMs : 0;
      drawStyledFrame(fadeWindowMs > 0 ? 0.2 : 1.0);

      if (recorder.state === 'paused') {
        recorder.resume();
      }
      await videoEl.play();

      await new Promise<void>((resolveClip, rejectClip) => {
        const tick = () => {
          if (signal?.aborted) {
            videoEl.pause();
            rejectClip(new DOMException('AI editing cancelled', 'AbortError'));
            return;
          }

          const currentMs = videoEl.currentTime * 1000;
          const elapsedSourceMs = Math.max(0, currentMs - clip.startMs);
          const fadeFactor =
            fadeWindowMs > 0 && elapsedSourceMs < fadeWindowMs
              ? Math.max(0.15, Math.min(1, elapsedSourceMs / fadeWindowMs))
              : 1.0;

          drawStyledFrame(fadeFactor);

          const elapsedOutMs = Math.min(
            clipOutputDurationMs,
            elapsedSourceMs / clip.playbackSpeed
          );
          const overallPct = Math.min(
            0.98,
            (accumulatedOutputMs + elapsedOutMs) / totalEditedTargetMs
          );
          onProgress?.(
            overallPct,
            `Rendering ${getEditingStyleLabel(editPlan.resolvedStyle)} · Clip ${idx + 1}/${
              editPlan.clips.length
            }...`
          );

          if (currentMs >= clip.endMs - 30 || videoEl.ended) {
            videoEl.pause();
            if (recorder && recorder.state === 'recording') {
              recorder.pause();
            }
            resolveClip();
            return;
          }

          rafId = window.requestAnimationFrame(tick);
        };
        rafId = window.requestAnimationFrame(tick);
      });

      accumulatedOutputMs += clipOutputDurationMs;
    }

    onProgress?.(0.99, 'Finalizing AI-edited video...');
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }

    const editedBlob = await stoppedPromise;
    const inspected = await inspectLocalVideoFile(editedBlob, { allowUnboundedDuration: true });

    const ext = editedBlob.type.includes('mp4') ? 'mp4' : 'webm';
    const record: LocalFullEditedBrowserVideo = {
      id: editedId,
      sourceVideoId: sourceVideo.id,
      sourceVideoName: sourceVideo.name,
      name: `${sourceVideo.name.replace(/\.[^.]+$/, '')} · ${getEditingStyleLabel(
        editPlan.resolvedStyle
      )}.${ext}`,
      fileBlob: editedBlob,
      thumbnailDataUrl: inspected.thumbnailDataUrl ?? sourceVideo.thumbnailDataUrl,
      durationMs:
        inspected.durationMs > 0 ? inspected.durationMs : editPlan.estimatedEditedDurationMs,
      originalDurationMs: sourceVideo.durationMs,
      fileSizeBytes: editedBlob.size,
      editPlan,
      analysis,
      createdAt: Date.now(),
    };

    await saveFullEditedBrowserVideo(record);
    onProgress?.(1.0, 'AI Full Editing complete');
    return record;
  } finally {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
    }
    try {
      musicSourceNode?.stop();
    } catch {
      // Ignore already-stopped audio source
    }
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Ignore stop errors
      }
    }
    glRenderer?.dispose();
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    if (audioCtx) {
      await audioCtx.close().catch(() => {});
    }
    URL.revokeObjectURL(objectUrl);
  }
}
