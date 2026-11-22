import * as FileSystem from 'expo-file-system';
import * as VideoThumbnails from 'expo-video-thumbnails';
import {
  exportVideoOnAndroid,
  getAndroidExportCapabilities,
  isNativeVideoCutterAvailable,
  openAndroidGalleryApp,
  playVideoInAndroidSystemPlayer,
  saveVideoToAndroidGallery,
  subscribeExportProgress,
  verifyAndroidGalleryVideo,
  type NativeExportCapabilitiesResponse,
} from '../../modules/hanuman-video-cutter';
import type {
  ExportConfiguration,
  ExportedVideoRecord,
  SmartExportSummary,
} from '../types/videoExport';
import {
  buildExportSignature,
  buildGalleryDisplayName,
  findDuplicateExport,
  getResolutionSpec,
} from '../utils/exportCalculator';
import { requestGallerySavePermission } from './androidPermissions';

const EXPORTS_DIR = `${FileSystem.documentDirectory ?? ''}hanuman_videos/exports/`;
const EXPORTS_THUMBS_DIR = `${EXPORTS_DIR}thumbnails/`;
const EXPORTS_INDEX = `${EXPORTS_DIR}exports_library.json`;

export interface ExecuteExportResult {
  record: ExportedVideoRecord;
  deduplicated: boolean;
  galleryAlreadySaved: boolean;
  gallerySaveError: string | null;
}

export interface GallerySaveOutcome {
  record: ExportedVideoRecord;
  alreadySaved: boolean;
}

async function ensureExportDirs(): Promise<void> {
  const dirInfo = await FileSystem.getInfoAsync(EXPORTS_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(EXPORTS_DIR, { intermediates: true });
  }
  const thumbsInfo = await FileSystem.getInfoAsync(EXPORTS_THUMBS_DIR);
  if (!thumbsInfo.exists) {
    await FileSystem.makeDirectoryAsync(EXPORTS_THUMBS_DIR, { intermediates: true });
  }
}

export async function inspectVideoExportCapabilitiesOnAndroid(
  inputUri: string,
  fallbackDurationMs: number
): Promise<NativeExportCapabilitiesResponse> {
  if (isNativeVideoCutterAvailable()) {
    return getAndroidExportCapabilities(inputUri);
  }

  let freeBytes: number | null = null;
  try {
    freeBytes = await FileSystem.getFreeDiskStorageAsync();
  } catch {
    freeBytes = null;
  }

  return {
    sourceWidth: 1280,
    sourceHeight: 720,
    sourceFps: 30,
    sourceDurationMs: fallbackDurationMs,
    hasAudioTrack: true,
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
    hardwareAccelerated: false,
    availableStorageBytes: freeBytes,
    encoderSummary: 'Requires Android Development Build (MediaCodec inspection)',
  };
}

export async function loadExportedVideosLibrary(): Promise<ExportedVideoRecord[]> {
  await ensureExportDirs();
  const info = await FileSystem.getInfoAsync(EXPORTS_INDEX);
  if (!info.exists) {
    return [];
  }
  try {
    const raw = await FileSystem.readAsStringAsync(EXPORTS_INDEX);
    const parsed = JSON.parse(raw) as ExportedVideoRecord[];
    if (!Array.isArray(parsed)) return [];
    const verified: ExportedVideoRecord[] = [];
    for (const item of parsed) {
      const f = await FileSystem.getInfoAsync(item.localUri);
      if (f.exists && (f.size ?? 0) > 1024) {
        verified.push(item);
      }
    }
    if (verified.length !== parsed.length) {
      await FileSystem.writeAsStringAsync(EXPORTS_INDEX, JSON.stringify(verified, null, 2));
    }
    return verified.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

async function saveExportedVideosLibrary(records: ExportedVideoRecord[]): Promise<void> {
  await ensureExportDirs();
  await FileSystem.writeAsStringAsync(EXPORTS_INDEX, JSON.stringify(records, null, 2));
}

export async function saveExportedRecordToGalleryOnAndroid(
  record: ExportedVideoRecord
): Promise<GallerySaveOutcome> {
  const fileInfo = await FileSystem.getInfoAsync(record.localUri);
  if (!fileInfo.exists || (fileInfo.size ?? 0) <= 1024) {
    throw new Error('Exported MP4 file is missing or incomplete.');
  }

  // Prevent duplicate MediaStore entries if already verified in Gallery
  if (record.galleryAssetUri) {
    const stillInGallery = await verifyAndroidGalleryVideo(record.galleryAssetUri);
    if (stillInGallery) {
      return { record, alreadySaved: true };
    }
  }

  const perm = await requestGallerySavePermission();
  if (!perm.granted) {
    throw new Error(
      perm.message ?? 'Permission denied while saving video to Android Gallery (Movies/HanumanAI).'
    );
  }

  const displayName = buildGalleryDisplayName({
    sourceName: record.name,
    height: record.height,
    fps: record.fps,
    codec: record.codec,
    signatureSeed: record.exportSignature ?? record.id,
  });

  const saved = await saveVideoToAndroidGallery(
    record.localUri,
    displayName,
    record.contentHash ?? null
  );

  if (!saved.verifiedPlayable || !saved.contentUri) {
    throw new Error('Video could not be verified as playable inside Android Gallery.');
  }

  const updatedRecord: ExportedVideoRecord = {
    ...record,
    galleryAssetUri: saved.contentUri,
    galleryRelativePath: saved.relativePath,
    gallerySavedAt: record.gallerySavedAt ?? Date.now(),
    contentHash: saved.contentHash,
    verifiedPlayable: true,
  };

  const existing = await loadExportedVideosLibrary();
  const nextList = [updatedRecord, ...existing.filter((item) => item.id !== updatedRecord.id)];
  await saveExportedVideosLibrary(nextList);

  return {
    record: updatedRecord,
    alreadySaved: saved.alreadySaved,
  };
}

export async function executeVideoExportOnAndroid(params: {
  sourceVideoId: string;
  sourceTargetId: string;
  sourceName: string;
  sourceUri: string;
  sourceThumbnailUri: string | null;
  sourceWidth: number;
  sourceHeight: number;
  sourceFps: number;
  config: ExportConfiguration;
  summary: SmartExportSummary;
  onProgress?: (progress: number, stage: string) => void;
}): Promise<ExecuteExportResult> {
  const {
    sourceVideoId,
    sourceTargetId,
    sourceName,
    sourceUri,
    sourceThumbnailUri,
    sourceWidth,
    sourceHeight,
    sourceFps,
    config,
    summary,
    onProgress,
  } = params;

  if (!summary.compatible) {
    throw new Error(
      summary.compatibilityIssues[0] ??
        'Export configuration is incompatible with this device or available storage.'
    );
  }

  await ensureExportDirs();

  const exportSignature = buildExportSignature({
    sourceTargetId,
    sourceDurationMs: summary.durationMs,
    width: summary.effectiveWidth,
    height: summary.effectiveHeight,
    fps: summary.effectiveFps,
    codec: config.codec,
    compression: config.compression,
  });

  // Prevent duplicate export files for the exact same source + export configuration
  const existingLibrary = await loadExportedVideosLibrary();
  const duplicate = findDuplicateExport(existingLibrary, exportSignature);
  if (duplicate) {
    const dupInfo = await FileSystem.getInfoAsync(duplicate.localUri);
    if (dupInfo.exists && (dupInfo.size ?? 0) > 1024) {
      if (duplicate.galleryAssetUri && (await verifyAndroidGalleryVideo(duplicate.galleryAssetUri))) {
        return {
          record: duplicate,
          deduplicated: true,
          galleryAlreadySaved: true,
          gallerySaveError: null,
        };
      }
      try {
        const galleryOutcome = await saveExportedRecordToGalleryOnAndroid(duplicate);
        return {
          record: galleryOutcome.record,
          deduplicated: true,
          galleryAlreadySaved: galleryOutcome.alreadySaved,
          gallerySaveError: null,
        };
      } catch (galleryErr) {
        return {
          record: duplicate,
          deduplicated: true,
          galleryAlreadySaved: false,
          gallerySaveError:
            galleryErr instanceof Error ? galleryErr.message : 'Failed to save video to Gallery.',
        };
      }
    }
  }

  const resLabel = getResolutionSpec(config.resolution).id.toUpperCase();
  const safeBase = sourceName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const exportId = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const outputUri = `${EXPORTS_DIR}${safeBase}_${resLabel}_${summary.effectiveFps}fps_${exportId}.mp4`;

  let finalDurationMs = summary.durationMs;
  let finalFileSize = 0;

  const sub = subscribeExportProgress((evt) => {
    onProgress?.(evt.progress * 0.92, evt.stage);
  });

  try {
    const nativeRes = await exportVideoOnAndroid(sourceUri, outputUri, {
      targetWidth: summary.effectiveWidth,
      targetHeight: summary.effectiveHeight,
      targetFps: summary.effectiveFps,
      sourceWidth,
      sourceHeight,
      sourceFps,
      codec: config.codec,
      compression: config.compression,
      videoBitrateBps: summary.videoBitrateBps,
      estimatedFileSizeBytes: summary.estimatedFileSizeBytes,
    });

    finalDurationMs = nativeRes.durationMs > 0 ? nativeRes.durationMs : summary.durationMs;
    finalFileSize = nativeRes.fileSizeBytes;
  } catch (err) {
    try {
      await FileSystem.deleteAsync(outputUri, { idempotent: true });
    } catch {
      // Ignore partial file delete error
    }
    throw err;
  } finally {
    sub?.remove();
  }

  const outInfo = await FileSystem.getInfoAsync(outputUri);
  if (!outInfo.exists || (outInfo.size ?? 0) <= 1024 || finalFileSize <= 1024) {
    try {
      await FileSystem.deleteAsync(outputUri, { idempotent: true });
    } catch {
      // Ignore cleanup error
    }
    throw new Error('Export produced an incomplete MP4 file and was discarded.');
  }

  let thumbnailUri: string | null = null;
  try {
    const { uri } = await VideoThumbnails.getThumbnailAsync(outputUri, {
      time: 400,
      quality: 0.85,
    });
    const dest = `${EXPORTS_THUMBS_DIR}${exportId}.jpg`;
    await FileSystem.copyAsync({ from: uri, to: dest });
    thumbnailUri = dest;
  } catch {
    thumbnailUri = sourceThumbnailUri;
  }

  const baseRecord: ExportedVideoRecord = {
    id: exportId,
    sourceVideoId,
    name: `${sourceName.replace(/\.[^.]+$/, '')} · ${summary.effectiveHeight}p ${summary.effectiveFps}fps.mp4`,
    localUri: outputUri,
    galleryAssetUri: null,
    galleryRelativePath: null,
    gallerySavedAt: null,
    contentHash: null,
    exportSignature,
    verifiedPlayable: true,
    thumbnailUri,
    durationMs: finalDurationMs,
    fileSizeBytes: outInfo.size ?? finalFileSize,
    width: summary.effectiveWidth,
    height: summary.effectiveHeight,
    fps: summary.effectiveFps,
    codec: config.codec,
    compression: config.compression,
    createdAt: Date.now(),
  };

  await saveExportedVideosLibrary([baseRecord, ...existingLibrary]);

  // Step 5: Immediately save directly into Android Gallery (Movies/HanumanAI) via MediaStore
  onProgress?.(0.95, 'Saving MP4 to Android Gallery (Movies/HanumanAI)...');
  try {
    const galleryOutcome = await saveExportedRecordToGalleryOnAndroid(baseRecord);
    onProgress?.(1.0, 'Saved to Android Gallery (Movies/HanumanAI)');
    return {
      record: galleryOutcome.record,
      deduplicated: false,
      galleryAlreadySaved: galleryOutcome.alreadySaved,
      gallerySaveError: null,
    };
  } catch (galleryErr) {
    return {
      record: baseRecord,
      deduplicated: false,
      galleryAlreadySaved: false,
      gallerySaveError:
        galleryErr instanceof Error ? galleryErr.message : 'Failed to save video to Gallery.',
    };
  }
}

export async function openExportedInAndroidGallery(contentUri?: string | null): Promise<void> {
  await openAndroidGalleryApp(contentUri ?? null);
}

export async function playExportedInAndroidSystemPlayer(
  record: ExportedVideoRecord
): Promise<void> {
  const targetUri = record.galleryAssetUri ?? record.localUri;
  await playVideoInAndroidSystemPlayer(targetUri);
}

export async function removeExportedVideoRecord(
  exportId: string
): Promise<ExportedVideoRecord[]> {
  const existing = await loadExportedVideosLibrary();
  const target = existing.find((item) => item.id === exportId);
  if (target) {
    try {
      await FileSystem.deleteAsync(target.localUri, { idempotent: true });
    } catch {
      // Ignore cleanup error
    }
    if (target.thumbnailUri) {
      try {
        await FileSystem.deleteAsync(target.thumbnailUri, { idempotent: true });
      } catch {
        // Ignore cleanup error
      }
    }
  }
  const remaining = existing.filter((item) => item.id !== exportId);
  await saveExportedVideosLibrary(remaining);
  return remaining;
}
