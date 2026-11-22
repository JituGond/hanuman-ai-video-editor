export type ExportResolutionId = '360p' | '480p' | '720p' | '1080p' | '2k' | '4k';

export type ExportFps = 24 | 30 | 60;

export type ExportCodec = 'h264' | 'h265';

export type ExportCompressionPreset =
  | 'original'
  | 'high'
  | 'balanced'
  | 'smaller';

export interface ResolutionSpec {
  id: ExportResolutionId;
  label: string;
  height: number;
  width16x9: number;
}

export const RESOLUTION_SPECS: ResolutionSpec[] = [
  { id: '360p', label: '360p', height: 360, width16x9: 640 },
  { id: '480p', label: '480p', height: 480, width16x9: 854 },
  { id: '720p', label: '720p HD', height: 720, width16x9: 1280 },
  { id: '1080p', label: '1080p Full HD', height: 1080, width16x9: 1920 },
  { id: '2k', label: '2K', height: 1440, width16x9: 2560 },
  { id: '4k', label: '4K', height: 2160, width16x9: 3840 },
];

export interface CompressionSpec {
  id: ExportCompressionPreset;
  label: string;
  description: string;
  bitrateMultiplier: number;
}

export const COMPRESSION_PRESETS: CompressionSpec[] = [
  {
    id: 'original',
    label: 'Original Quality',
    description: 'Preserves source-level bitrate with minimal compression loss.',
    bitrateMultiplier: 1.35,
  },
  {
    id: 'high',
    label: 'High Quality',
    description: 'Crisp detail for sharing and archival on Android Gallery.',
    bitrateMultiplier: 1.0,
  },
  {
    id: 'balanced',
    label: 'Balanced Quality',
    description: 'Clean visual quality with practical file size for long videos.',
    bitrateMultiplier: 0.65,
  },
  {
    id: 'smaller',
    label: 'Smaller File Size',
    description: 'Compact MP4 file size optimized for quick local sharing.',
    bitrateMultiplier: 0.38,
  },
];

export interface DeviceExportCapabilities {
  supportedResolutions: ExportResolutionId[];
  supportedFpsByResolution: Record<ExportResolutionId, ExportFps[]>;
  supportsH264: boolean;
  supportsH265: boolean;
  supports4K: boolean;
  hardwareAccelerated: boolean;
  availableStorageBytes: number | null;
  encoderSummary: string;
}

export interface ExportConfiguration {
  resolution: ExportResolutionId;
  fps: ExportFps;
  codec: ExportCodec;
  compression: ExportCompressionPreset;
}

export interface SmartExportSummary {
  effectiveWidth: number;
  effectiveHeight: number;
  effectiveFps: ExportFps;
  wasCappedToSource: boolean;
  capNote: string | null;
  durationMs: number;
  videoBitrateBps: number;
  audioBitrateBps: number;
  estimatedFileSizeBytes: number;
  availableStorageBytes: number | null;
  hasSufficientStorage: boolean;
  compatible: boolean;
  compatibilityIssues: string[];
}

export interface ExportedVideoRecord {
  id: string;
  sourceVideoId: string;
  name: string;
  localUri: string;
  galleryAssetUri?: string | null;
  galleryRelativePath?: string | null;
  gallerySavedAt?: number | null;
  contentHash?: string | null;
  exportSignature?: string | null;
  verifiedPlayable?: boolean;
  thumbnailUri: string | null;
  durationMs: number;
  fileSizeBytes: number;
  width: number;
  height: number;
  fps: ExportFps;
  codec: ExportCodec;
  compression: ExportCompressionPreset;
  createdAt: number;
}
