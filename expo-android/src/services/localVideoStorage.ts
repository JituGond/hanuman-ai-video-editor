import * as FileSystem from 'expo-file-system';
import * as VideoThumbnails from 'expo-video-thumbnails';
import type { ImportedVideo, VideoImportSource } from '../types/video';
import { sanitizeFileName } from '../utils/videoValidation';

const WORKSPACE_DIR = `${FileSystem.documentDirectory ?? ''}hanuman_videos/`;
const THUMBNAILS_DIR = `${WORKSPACE_DIR}thumbnails/`;
const LIBRARY_INDEX_FILE = `${WORKSPACE_DIR}library.json`;

async function ensureDirectories(): Promise<void> {
  const workspaceInfo = await FileSystem.getInfoAsync(WORKSPACE_DIR);
  if (!workspaceInfo.exists) {
    await FileSystem.makeDirectoryAsync(WORKSPACE_DIR, { intermediates: true });
  }
  const thumbsInfo = await FileSystem.getInfoAsync(THUMBNAILS_DIR);
  if (!thumbsInfo.exists) {
    await FileSystem.makeDirectoryAsync(THUMBNAILS_DIR, { intermediates: true });
  }
}

async function generateLocalThumbnail(
  localVideoUri: string,
  videoId: string
): Promise<string | null> {
  try {
    const { uri: tempThumbUri } = await VideoThumbnails.getThumbnailAsync(localVideoUri, {
      time: 1000,
      quality: 0.85,
    });
    const persistedThumbUri = `${THUMBNAILS_DIR}${videoId}.jpg`;
    await FileSystem.copyAsync({
      from: tempThumbUri,
      to: persistedThumbUri,
    });
    return persistedThumbUri;
  } catch {
    try {
      const { uri: fallbackThumbUri } = await VideoThumbnails.getThumbnailAsync(localVideoUri, {
        time: 0,
        quality: 0.8,
      });
      const persistedThumbUri = `${THUMBNAILS_DIR}${videoId}.jpg`;
      await FileSystem.copyAsync({
        from: fallbackThumbUri,
        to: persistedThumbUri,
      });
      return persistedThumbUri;
    } catch {
      return null;
    }
  }
}

export async function loadLocalVideoLibrary(): Promise<ImportedVideo[]> {
  await ensureDirectories();
  const indexInfo = await FileSystem.getInfoAsync(LIBRARY_INDEX_FILE);
  if (!indexInfo.exists) {
    return [];
  }

  try {
    const raw = await FileSystem.readAsStringAsync(LIBRARY_INDEX_FILE);
    const parsed = JSON.parse(raw) as ImportedVideo[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    const verified: ImportedVideo[] = [];
    for (const item of parsed) {
      const fileInfo = await FileSystem.getInfoAsync(item.localUri);
      if (fileInfo.exists) {
        verified.push(item);
      }
    }

    if (verified.length !== parsed.length) {
      await saveLibraryIndex(verified);
    }
    return verified.sort((a, b) => b.importedAt - a.importedAt);
  } catch {
    return [];
  }
}

async function saveLibraryIndex(videos: ImportedVideo[]): Promise<void> {
  await ensureDirectories();
  await FileSystem.writeAsStringAsync(LIBRARY_INDEX_FILE, JSON.stringify(videos, null, 2));
}

/**
 * Copies the selected video directly on disk into app-private documentDirectory
 * without reading the file into JavaScript RAM (safe for 30-minute HD videos).
 */
export async function persistVideoOnDevice(params: {
  sourceUri: string;
  originalName: string;
  source: VideoImportSource;
  durationMs: number;
  fileSizeBytes?: number;
}): Promise<ImportedVideo> {
  await ensureDirectories();

  const id = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const safeName = sanitizeFileName(params.originalName);
  const destinationUri = `${WORKSPACE_DIR}${id}_${safeName}`;

  await FileSystem.copyAsync({
    from: params.sourceUri,
    to: destinationUri,
  });

  const copiedInfo = await FileSystem.getInfoAsync(destinationUri);
  const resolvedSize =
    params.fileSizeBytes && params.fileSizeBytes > 0
      ? params.fileSizeBytes
      : copiedInfo.exists && 'size' in copiedInfo && typeof copiedInfo.size === 'number'
        ? copiedInfo.size
        : 0;

  const thumbnailUri = await generateLocalThumbnail(destinationUri, id);

  const imported: ImportedVideo = {
    id,
    name: params.originalName.trim() || safeName,
    localUri: destinationUri,
    thumbnailUri,
    durationMs: params.durationMs,
    fileSizeBytes: resolvedSize,
    source: params.source,
    importedAt: Date.now(),
  };

  const existing = await loadLocalVideoLibrary();
  await saveLibraryIndex([imported, ...existing]);

  return imported;
}

export async function updateStoredVideoDuration(
  id: string,
  durationMs: number
): Promise<ImportedVideo[]> {
  const existing = await loadLocalVideoLibrary();
  const updated = existing.map((item) =>
    item.id === id ? { ...item, durationMs: Math.round(durationMs) } : item
  );
  await saveLibraryIndex(updated);
  return updated;
}

export async function removeLocalVideo(id: string): Promise<ImportedVideo[]> {
  const existing = await loadLocalVideoLibrary();
  const target = existing.find((item) => item.id === id);

  if (target) {
    try {
      await FileSystem.deleteAsync(target.localUri, { idempotent: true });
    } catch {
      // Ignore missing file errors on delete
    }
    if (target.thumbnailUri) {
      try {
        await FileSystem.deleteAsync(target.thumbnailUri, { idempotent: true });
      } catch {
        // Ignore missing thumbnail errors on delete
      }
    }
  }

  const remaining = existing.filter((item) => item.id !== id);
  await saveLibraryIndex(remaining);
  return remaining;
}
