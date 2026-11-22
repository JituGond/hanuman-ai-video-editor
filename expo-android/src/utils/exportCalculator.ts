import {
  COMPRESSION_PRESETS,
  RESOLUTION_SPECS,
  type DeviceExportCapabilities,
  type ExportCodec,
  type ExportCompressionPreset,
  type ExportConfiguration,
  type ExportFps,
  type ExportResolutionId,
  type SmartExportSummary,
} from '../types/videoExport';

const BASE_720P_30FPS_BITRATE = 5_000_000; // 5 Mbps baseline for H.264 720p30

export function getResolutionSpec(id: ExportResolutionId) {
  return RESOLUTION_SPECS.find((r) => r.id === id) ?? RESOLUTION_SPECS[2];
}

export function getCodecLabel(codec: ExportCodec): string {
  return codec === 'h265' ? 'MP4 (H.265 / HEVC)' : 'MP4 (H.264 / AVC)';
}

export function getCompressionLabel(preset: ExportCompressionPreset): string {
  return COMPRESSION_PRESETS.find((c) => c.id === preset)?.label ?? 'High Quality';
}

/**
 * Computes realistic video & audio bitrates scaled by resolution, FPS, codec efficiency,
 * and selected compression preset. Enforces no fake upscaling above source quality.
 */
export function computeSmartExportSummary(params: {
  config: ExportConfiguration;
  sourceWidth: number;
  sourceHeight: number;
  sourceFps: number;
  durationMs: number;
  capabilities: DeviceExportCapabilities;
  hasAudioTrack: boolean;
}): SmartExportSummary {
  const {
    config,
    sourceWidth,
    sourceHeight,
    sourceFps,
    durationMs,
    capabilities,
    hasAudioTrack,
  } = params;

  const resSpec = getResolutionSpec(config.resolution);
  const safeSrcW = sourceWidth > 0 ? sourceWidth : 1280;
  const safeSrcH = sourceHeight > 0 ? sourceHeight : 720;
  const isPortrait = safeSrcH > safeSrcW;

  const srcShortSide = Math.min(safeSrcW, safeSrcH);
  const srcLongSide = Math.max(safeSrcW, safeSrcH);

  // Prevent fake upscaling beyond source resolution
  let targetShortSide = resSpec.height;
  let wasCappedToSource = false;
  let capNote: string | null = null;

  if (targetShortSide > srcShortSide) {
    targetShortSide = srcShortSide;
    wasCappedToSource = true;
    capNote = `Capped to source resolution (${safeSrcW}x${safeSrcH}) to avoid fake upscaling.`;
  }

  const aspectRatio = srcLongSide / Math.max(1, srcShortSide);
  const targetLongSide = Math.round((targetShortSide * aspectRatio) / 2) * 2;
  const evenShortSide = Math.round(targetShortSide / 2) * 2;

  const effectiveWidth = Math.max(2, isPortrait ? evenShortSide : targetLongSide);
  const effectiveHeight = Math.max(2, isPortrait ? targetLongSide : evenShortSide);

  // Respect device FPS capabilities and do not fabricate higher FPS than source when source FPS is known
  const supportedForRes = capabilities.supportedFpsByResolution[config.resolution] ?? [24, 30];
  let effectiveFps: ExportFps = config.fps;
  if (!supportedForRes.includes(effectiveFps)) {
    effectiveFps = supportedForRes[supportedForRes.length - 1] ?? 30;
  }
  if (sourceFps > 0 && effectiveFps > Math.ceil(sourceFps)) {
    if (sourceFps >= 29 && supportedForRes.includes(30)) {
      effectiveFps = 30;
    } else if (supportedForRes.includes(24)) {
      effectiveFps = 24;
    }
    wasCappedToSource = true;
    capNote = capNote
      ? `${capNote} FPS matched to source (${Math.round(sourceFps)} fps).`
      : `FPS capped to source frame rate (${Math.round(sourceFps)} fps).`;
  }

  const pixelFactor = (effectiveWidth * effectiveHeight) / (1280 * 720);
  const fpsFactor = effectiveFps === 60 ? 1.45 : effectiveFps === 24 ? 0.85 : 1.0;
  const codecFactor = config.codec === 'h265' ? 0.72 : 1.0;
  const compSpec =
    COMPRESSION_PRESETS.find((c) => c.id === config.compression) ?? COMPRESSION_PRESETS[1];

  const videoBitrateBps = Math.max(
    450_000,
    Math.min(
      55_000_000,
      Math.round(BASE_720P_30FPS_BITRATE * pixelFactor * fpsFactor * codecFactor * compSpec.bitrateMultiplier)
    )
  );

  const audioBitrateBps = hasAudioTrack
    ? config.compression === 'smaller'
      ? 96_000
      : config.compression === 'balanced'
        ? 128_000
        : 192_000
    : 0;

  const durationSec = Math.max(0, durationMs / 1000);
  // Add ~3% MP4 container muxing overhead
  const estimatedFileSizeBytes = Math.round(
    (((videoBitrateBps + audioBitrateBps) / 8) * durationSec) * 1.03
  );

  const compatibilityIssues: string[] = [];
  if (!capabilities.supportedResolutions.includes(config.resolution)) {
    compatibilityIssues.push(`${resSpec.label} is not supported by this device encoder.`);
  }
  if (config.codec === 'h265' && !capabilities.supportsH265) {
    compatibilityIssues.push('H.265 (HEVC) hardware encoding is unavailable on this device.');
  }
  if (durationMs <= 0) {
    compatibilityIssues.push('Video duration must be greater than 00:00.');
  }

  // Require at least 20% headroom above estimated output size to prevent low-storage crashes
  const requiredStorageBytes = Math.max(5 * 1024 * 1024, Math.round(estimatedFileSizeBytes * 1.2));
  const hasSufficientStorage =
    capabilities.availableStorageBytes === null ||
    capabilities.availableStorageBytes >= requiredStorageBytes;

  if (!hasSufficientStorage) {
    compatibilityIssues.push('Insufficient free device storage for this export size.');
  }

  return {
    effectiveWidth,
    effectiveHeight,
    effectiveFps,
    wasCappedToSource,
    capNote,
    durationMs,
    videoBitrateBps,
    audioBitrateBps,
    estimatedFileSizeBytes,
    availableStorageBytes: capabilities.availableStorageBytes,
    hasSufficientStorage,
    compatible: compatibilityIssues.length === 0,
    compatibilityIssues,
  };
}

export function buildExportSignature(params: {
  sourceTargetId: string;
  sourceDurationMs: number;
  width: number;
  height: number;
  fps: ExportFps;
  codec: ExportCodec;
  compression: ExportCompressionPreset;
}): string {
  return [
    params.sourceTargetId,
    Math.round(params.sourceDurationMs),
    `${params.width}x${params.height}`,
    `${params.fps}fps`,
    params.codec,
    params.compression,
  ].join('::');
}

export function buildGalleryDisplayName(params: {
  sourceName: string;
  height: number;
  fps: ExportFps;
  codec: ExportCodec;
  signatureSeed?: string | null;
}): string {
  const cleanBase = params.sourceName
    .replace(/\.(mp4|mov|mkv|webm|m4v|3gp)$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'HanumanAI_Video';

  const codecTag = params.codec.toUpperCase();
  let shortTag = '';
  if (params.signatureSeed) {
    let hash = 2166136261;
    for (let i = 0; i < params.signatureSeed.length; i += 1) {
      hash ^= params.signatureSeed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    shortTag = `_${(hash >>> 0).toString(16).padStart(8, '0').slice(0, 6)}`;
  }

  return `${cleanBase}_${params.height}p_${params.fps}fps_${codecTag}${shortTag}.mp4`;
}

export function findDuplicateExport<
  T extends {
    exportSignature?: string | null;
    fileSizeBytes: number;
    durationMs: number;
  },
>(existingExports: T[], signature: string): T | null {
  for (const item of existingExports) {
    if (
      item.exportSignature === signature &&
      item.fileSizeBytes > 1024 &&
      item.durationMs > 0
    ) {
      return item;
    }
  }
  return null;
}
