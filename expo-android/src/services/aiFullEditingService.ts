import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as VideoThumbnails from 'expo-video-thumbnails';
import {
  fullAiEditVideoOnAndroid,
  subscribeCuttingProgress,
} from '../../modules/hanuman-video-cutter';
import type { VideoAnalysisReport } from '../types/aiCutting';
import type {
  AudioEditOptions,
  EditingStyleSelection,
  FullEditedVideoRecord,
  VideoEnhancementToggles,
} from '../types/aiEditing';
import type { ImportedVideo } from '../types/video';
import { buildFullEditPlan, getEditingStyleLabel } from '../utils/aiFullEditorEngine';

const FULL_EDITED_DIR = `${FileSystem.documentDirectory ?? ''}hanuman_videos/full_edited/`;
const FULL_EDITED_THUMBS_DIR = `${FULL_EDITED_DIR}thumbnails/`;
const FULL_EDITED_INDEX = `${FULL_EDITED_DIR}full_edited_library.json`;

async function ensureFullEditDirs(): Promise<void> {
  const dirInfo = await FileSystem.getInfoAsync(FULL_EDITED_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(FULL_EDITED_DIR, { intermediates: true });
  }
  const thumbsInfo = await FileSystem.getInfoAsync(FULL_EDITED_THUMBS_DIR);
  if (!thumbsInfo.exists) {
    await FileSystem.makeDirectoryAsync(FULL_EDITED_THUMBS_DIR, { intermediates: true });
  }
}

export async function pickLocalBackgroundMusicOnAndroid(): Promise<{
  uri: string;
  name: string;
} | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'audio/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets || result.assets.length === 0) {
    return null;
  }
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.name || 'background_music.mp3',
  };
}

export async function loadFullEditedLibrary(): Promise<FullEditedVideoRecord[]> {
  await ensureFullEditDirs();
  const info = await FileSystem.getInfoAsync(FULL_EDITED_INDEX);
  if (!info.exists) {
    return [];
  }
  try {
    const raw = await FileSystem.readAsStringAsync(FULL_EDITED_INDEX);
    const parsed = JSON.parse(raw) as FullEditedVideoRecord[];
    if (!Array.isArray(parsed)) return [];
    const verified: FullEditedVideoRecord[] = [];
    for (const item of parsed) {
      const f = await FileSystem.getInfoAsync(item.localUri);
      if (f.exists) {
        verified.push(item);
      }
    }
    if (verified.length !== parsed.length) {
      await FileSystem.writeAsStringAsync(FULL_EDITED_INDEX, JSON.stringify(verified, null, 2));
    }
    return verified.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

async function saveFullEditedLibrary(records: FullEditedVideoRecord[]): Promise<void> {
  await ensureFullEditDirs();
  await FileSystem.writeAsStringAsync(FULL_EDITED_INDEX, JSON.stringify(records, null, 2));
}

export async function executeFullAiEditingOnAndroid(params: {
  sourceVideo: ImportedVideo;
  analysis: VideoAnalysisReport;
  styleSelection: EditingStyleSelection;
  enhancements: VideoEnhancementToggles;
  audioOptions: AudioEditOptions;
  onProgress?: (progress: number, stage: string) => void;
}): Promise<FullEditedVideoRecord> {
  const {
    sourceVideo,
    analysis,
    styleSelection,
    enhancements,
    audioOptions,
    onProgress,
  } = params;
  await ensureFullEditDirs();

  const editPlan = buildFullEditPlan({
    analysis,
    styleSelection,
    enhancements,
    audioOptions,
  });

  const editedId = `full_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const outputUri = `${FULL_EDITED_DIR}${editedId}.mp4`;

  let finalDurationMs = editPlan.estimatedEditedDurationMs;
  let finalFileSize = sourceVideo.fileSizeBytes;

  const sub = subscribeCuttingProgress((evt) => {
    onProgress?.(evt.progress, evt.stage);
  });

  try {
    const nativeRes = await fullAiEditVideoOnAndroid(
      sourceVideo.localUri,
      outputUri,
      editPlan.clips.map((c) => ({
        startMs: c.startMs,
        endMs: c.endMs,
        transitionIn: c.transitionIn,
      })),
      editPlan.profile,
      audioOptions.backgroundMusicUri,
      audioOptions.backgroundMusicVolume
    );

    if (nativeRes.durationMs > 0) {
      finalDurationMs = nativeRes.durationMs;
    }
    if (nativeRes.fileSizeBytes > 0) {
      finalFileSize = nativeRes.fileSizeBytes;
    }
  } finally {
    sub?.remove();
  }

  let thumbnailUri: string | null = null;
  try {
    const { uri } = await VideoThumbnails.getThumbnailAsync(outputUri, {
      time: 500,
      quality: 0.85,
    });
    const dest = `${FULL_EDITED_THUMBS_DIR}${editedId}.jpg`;
    await FileSystem.copyAsync({ from: uri, to: dest });
    thumbnailUri = dest;
  } catch {
    thumbnailUri = sourceVideo.thumbnailUri;
  }

  const record: FullEditedVideoRecord = {
    id: editedId,
    sourceVideoId: sourceVideo.id,
    sourceVideoName: sourceVideo.name,
    name: `${sourceVideo.name.replace(/\.[^.]+$/, '')} · ${getEditingStyleLabel(
      editPlan.resolvedStyle
    )}.mp4`,
    localUri: outputUri,
    thumbnailUri,
    durationMs: finalDurationMs,
    originalDurationMs: analysis.totalDurationMs || sourceVideo.durationMs,
    fileSizeBytes: finalFileSize,
    editPlan,
    analysis,
    createdAt: Date.now(),
  };

  const existing = await loadFullEditedLibrary();
  await saveFullEditedLibrary([record, ...existing]);
  return record;
}

export async function removeFullEditedVideoRecord(
  editedId: string
): Promise<FullEditedVideoRecord[]> {
  const existing = await loadFullEditedLibrary();
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
  await saveFullEditedLibrary(remaining);
  return remaining;
}
