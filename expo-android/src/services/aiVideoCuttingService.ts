import * as FileSystem from 'expo-file-system';
import * as VideoThumbnails from 'expo-video-thumbnails';
import {
  analyzeVideoOnAndroid,
  cancelAndroidVideoProcessing,
  cutAndJoinVideoOnAndroid,
  isNativeVideoCutterAvailable,
  subscribeAnalysisProgress,
  subscribeCuttingProgress,
} from '../../modules/hanuman-video-cutter';
import type {
  CuttingPreset,
  EditedVideoRecord,
  VideoAnalysisReport,
} from '../types/aiCutting';
import type { ImportedVideo } from '../types/video';
import { analyzeVideoWindows, buildCutPlan, getPresetLabel } from '../utils/aiCuttingEngine';

const EDITED_DIR = `${FileSystem.documentDirectory ?? ''}hanuman_videos/edited/`;
const EDITED_THUMBS_DIR = `${EDITED_DIR}thumbnails/`;
const EDITED_INDEX_FILE = `${EDITED_DIR}edited_library.json`;

async function ensureEditedDirs(): Promise<void> {
  const dirInfo = await FileSystem.getInfoAsync(EDITED_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(EDITED_DIR, { intermediates: true });
  }
  const thumbsInfo = await FileSystem.getInfoAsync(EDITED_THUMBS_DIR);
  if (!thumbsInfo.exists) {
    await FileSystem.makeDirectoryAsync(EDITED_THUMBS_DIR, { intermediates: true });
  }
}

export async function loadEditedVideosLibrary(): Promise<EditedVideoRecord[]> {
  await ensureEditedDirs();
  const info = await FileSystem.getInfoAsync(EDITED_INDEX_FILE);
  if (!info.exists) {
    return [];
  }
  try {
    const raw = await FileSystem.readAsStringAsync(EDITED_INDEX_FILE);
    const parsed = JSON.parse(raw) as EditedVideoRecord[];
    if (!Array.isArray(parsed)) return [];
    const verified: EditedVideoRecord[] = [];
    for (const record of parsed) {
      const fileInfo = await FileSystem.getInfoAsync(record.localUri);
      if (fileInfo.exists) {
        verified.push(record);
      }
    }
    if (verified.length !== parsed.length) {
      await FileSystem.writeAsStringAsync(EDITED_INDEX_FILE, JSON.stringify(verified, null, 2));
    }
    return verified.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

async function saveEditedVideosLibrary(records: EditedVideoRecord[]): Promise<void> {
  await ensureEditedDirs();
  await FileSystem.writeAsStringAsync(EDITED_INDEX_FILE, JSON.stringify(records, null, 2));
}

async function createEditedThumbnail(videoUri: string, editedId: string): Promise<string | null> {
  try {
    const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
      time: 500,
      quality: 0.85,
    });
    const dest = `${EDITED_THUMBS_DIR}${editedId}.jpg`;
    await FileSystem.copyAsync({ from: uri, to: dest });
    return dest;
  } catch {
    return null;
  }
}

export function isAndroidNativeCuttingReady(): boolean {
  return isNativeVideoCutterAvailable();
}

export function cancelActiveAndroidCut(): void {
  cancelAndroidVideoProcessing();
}

export async function analyzeVideoLocallyOnAndroid(
  video: ImportedVideo,
  onProgress?: (progress: number, stage: string) => void
): Promise<VideoAnalysisReport> {
  const sub = subscribeAnalysisProgress((evt) => {
    onProgress?.(evt.progress, evt.stage);
  });
  try {
    const raw = await analyzeVideoOnAndroid(video.localUri);
    return analyzeVideoWindows({
      videoId: video.id,
      totalDurationMs: raw.totalDurationMs > 0 ? raw.totalDurationMs : video.durationMs,
      windows: raw.windows,
      hasAudioTrack: raw.hasAudioTrack,
    });
  } finally {
    sub?.remove();
  }
}

export async function generateEditedVideoOnAndroid(params: {
  sourceVideo: ImportedVideo;
  analysis: VideoAnalysisReport;
  preset: CuttingPreset;
  onProgress?: (progress: number, stage: string) => void;
}): Promise<EditedVideoRecord> {
  const { sourceVideo, analysis, preset, onProgress } = params;
  await ensureEditedDirs();

  const cutPlan = buildCutPlan(analysis, preset);
  const editedId = `cut_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const outputUri = `${EDITED_DIR}${editedId}.mp4`;

  let finalDurationMs = cutPlan.estimatedEditedDurationMs;
  let finalFileSize = sourceVideo.fileSizeBytes;

  if (preset === 'preserve_original') {
    onProgress?.(0.5, 'Preserving non-destructive original copy...');
    await FileSystem.copyAsync({
      from: sourceVideo.localUri,
      to: outputUri,
    });
    const info = await FileSystem.getInfoAsync(outputUri);
    if (info.exists && 'size' in info && typeof info.size === 'number') {
      finalFileSize = info.size;
    }
    finalDurationMs = analysis.totalDurationMs || sourceVideo.durationMs;
    onProgress?.(1.0, 'Original copy preserved');
  } else {
    const sub = subscribeCuttingProgress((evt) => {
      onProgress?.(evt.progress, evt.stage);
    });
    try {
      const segments = cutPlan.keepSegments.map((seg) => ({
        startMs: seg.startMs,
        endMs: seg.endMs,
      }));
      const nativeResult = await cutAndJoinVideoOnAndroid(
        sourceVideo.localUri,
        outputUri,
        segments
      );
      if (nativeResult.durationMs > 0) {
        finalDurationMs = nativeResult.durationMs;
      }
      if (nativeResult.fileSizeBytes > 0) {
        finalFileSize = nativeResult.fileSizeBytes;
      }
    } finally {
      sub?.remove();
    }
  }

  const thumbnailUri = await createEditedThumbnail(outputUri, editedId);
  const record: EditedVideoRecord = {
    id: editedId,
    sourceVideoId: sourceVideo.id,
    sourceVideoName: sourceVideo.name,
    name: `${sourceVideo.name.replace(/\.[^.]+$/, '')} · ${getPresetLabel(preset)}.mp4`,
    localUri: outputUri,
    thumbnailUri: thumbnailUri ?? sourceVideo.thumbnailUri,
    durationMs: finalDurationMs,
    originalDurationMs: analysis.totalDurationMs || sourceVideo.durationMs,
    fileSizeBytes: finalFileSize,
    preset,
    analysis,
    cutPlan,
    createdAt: Date.now(),
  };

  const existing = await loadEditedVideosLibrary();
  await saveEditedVideosLibrary([record, ...existing]);
  return record;
}

export async function removeEditedVideoRecord(editedId: string): Promise<EditedVideoRecord[]> {
  const existing = await loadEditedVideosLibrary();
  const target = existing.find((item) => item.id === editedId);
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
  const remaining = existing.filter((item) => item.id !== editedId);
  await saveEditedVideosLibrary(remaining);
  return remaining;
}
