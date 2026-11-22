import type { CuttingPreset, CutPlan, VideoAnalysisReport } from '../../expo-android/src/types/aiCutting';
import type { FullEditPlan } from '../../expo-android/src/types/aiEditing';
import type { VideoImportSource } from '../../expo-android/src/types/video';
import type {
  ExportCodec,
  ExportCompressionPreset,
  ExportFps,
  ExportResolutionId,
} from '../../expo-android/src/types/videoExport';
import { validateVideoDuration } from '../../expo-android/src/utils/videoValidation';

export interface LocalBrowserVideo {
  id: string;
  name: string;
  source: VideoImportSource;
  fileBlob: Blob;
  thumbnailDataUrl: string | null;
  durationMs: number;
  fileSizeBytes: number;
  importedAt: number;
}

export interface LocalEditedBrowserVideo {
  id: string;
  sourceVideoId: string;
  sourceVideoName: string;
  name: string;
  fileBlob: Blob;
  thumbnailDataUrl: string | null;
  durationMs: number;
  originalDurationMs: number;
  fileSizeBytes: number;
  preset: CuttingPreset;
  analysis: VideoAnalysisReport;
  cutPlan: CutPlan;
  createdAt: number;
}

export interface LocalFullEditedBrowserVideo {
  id: string;
  sourceVideoId: string;
  sourceVideoName: string;
  name: string;
  fileBlob: Blob;
  thumbnailDataUrl: string | null;
  durationMs: number;
  originalDurationMs: number;
  fileSizeBytes: number;
  editPlan: FullEditPlan;
  analysis: VideoAnalysisReport;
  createdAt: number;
}

export interface LocalExportedBrowserVideo {
  id: string;
  sourceVideoId: string;
  name: string;
  fileBlob: Blob;
  thumbnailDataUrl: string | null;
  durationMs: number;
  fileSizeBytes: number;
  width: number;
  height: number;
  fps: ExportFps;
  codec: ExportCodec;
  compression: ExportCompressionPreset;
  hasAudio: boolean;
  resId: ExportResolutionId;
  contentHash?: string;
  exportSignature?: string;
  gallerySaved?: boolean;
  galleryRelativePath?: string;
  gallerySavedAt?: number;
  verifiedPlayable?: boolean;
  createdAt: number;
}

const DB_NAME = 'hanuman_module1_device_db';
const IMPORTED_STORE = 'imported_videos';
const EDITED_STORE = 'edited_videos';
const FULL_EDITED_STORE = 'full_edited_videos';
const EXPORTED_STORE = 'exported_mp4_videos';
const DB_VERSION = 4;

function openVideoDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMPORTED_STORE)) {
        db.createObjectStore(IMPORTED_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(EDITED_STORE)) {
        db.createObjectStore(EDITED_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(FULL_EDITED_STORE)) {
        db.createObjectStore(FULL_EDITED_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(EXPORTED_STORE)) {
        db.createObjectStore(EXPORTED_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to open local IndexedDB storage.'));
  });
}

export async function getAllLocalBrowserVideos(): Promise<LocalBrowserVideo[]> {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMPORTED_STORE, 'readonly');
    const store = tx.objectStore(IMPORTED_STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const rows = (req.result as LocalBrowserVideo[]) ?? [];
      rows.sort((a, b) => b.importedAt - a.importedAt);
      resolve(rows);
    };
    req.onerror = () => reject(req.error ?? new Error('Failed to read local videos.'));
  });
}

export async function saveLocalBrowserVideo(video: LocalBrowserVideo): Promise<void> {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMPORTED_STORE, 'readwrite');
    tx.objectStore(IMPORTED_STORE).put(video);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('Failed to save video to local device storage.'));
  });
}

export async function deleteLocalBrowserVideo(id: string): Promise<void> {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMPORTED_STORE, 'readwrite');
    tx.objectStore(IMPORTED_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('Failed to delete video from local storage.'));
  });
}

export async function getAllEditedBrowserVideos(): Promise<LocalEditedBrowserVideo[]> {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EDITED_STORE, 'readonly');
    const req = tx.objectStore(EDITED_STORE).getAll();
    req.onsuccess = () => {
      const rows = (req.result as LocalEditedBrowserVideo[]) ?? [];
      rows.sort((a, b) => b.createdAt - a.createdAt);
      resolve(rows);
    };
    req.onerror = () => reject(req.error ?? new Error('Failed to read edited videos.'));
  });
}

export async function saveEditedBrowserVideo(video: LocalEditedBrowserVideo): Promise<void> {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EDITED_STORE, 'readwrite');
    tx.objectStore(EDITED_STORE).put(video);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to save edited video locally.'));
  });
}

export async function deleteEditedBrowserVideo(id: string): Promise<void> {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EDITED_STORE, 'readwrite');
    tx.objectStore(EDITED_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to delete edited video.'));
  });
}

export async function getAllFullEditedBrowserVideos(): Promise<LocalFullEditedBrowserVideo[]> {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FULL_EDITED_STORE, 'readonly');
    const req = tx.objectStore(FULL_EDITED_STORE).getAll();
    req.onsuccess = () => {
      const rows = (req.result as LocalFullEditedBrowserVideo[]) ?? [];
      rows.sort((a, b) => b.createdAt - a.createdAt);
      resolve(rows);
    };
    req.onerror = () => reject(req.error ?? new Error('Failed to read full edited videos.'));
  });
}

export async function saveFullEditedBrowserVideo(
  video: LocalFullEditedBrowserVideo
): Promise<void> {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FULL_EDITED_STORE, 'readwrite');
    tx.objectStore(FULL_EDITED_STORE).put(video);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to save full edited video.'));
  });
}

export async function deleteFullEditedBrowserVideo(id: string): Promise<void> {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FULL_EDITED_STORE, 'readwrite');
    tx.objectStore(FULL_EDITED_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to delete full edited video.'));
  });
}

export async function getAllExportedBrowserVideos(): Promise<LocalExportedBrowserVideo[]> {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPORTED_STORE, 'readonly');
    const req = tx.objectStore(EXPORTED_STORE).getAll();
    req.onsuccess = () => {
      const rows = (req.result as LocalExportedBrowserVideo[]) ?? [];
      rows.sort((a, b) => b.createdAt - a.createdAt);
      resolve(rows);
    };
    req.onerror = () => reject(req.error ?? new Error('Failed to read exported MP4 videos.'));
  });
}

export async function saveExportedBrowserVideo(video: LocalExportedBrowserVideo): Promise<void> {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPORTED_STORE, 'readwrite');
    tx.objectStore(EXPORTED_STORE).put(video);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to save exported MP4 locally.'));
  });
}

export async function deleteExportedBrowserVideo(id: string): Promise<void> {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPORTED_STORE, 'readwrite');
    tx.objectStore(EXPORTED_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to delete exported MP4.'));
  });
}

export async function computeBlobSha256(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  const bytes = new Uint8Array(buffer);
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i += 64) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}_${bytes.length}`;
}

export async function blobHasValidMp4Structure(blob: Blob): Promise<boolean> {
  if (blob.size < 1024) return false;
  const headerSlice = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ftyp = String.fromCharCode(headerSlice[4], headerSlice[5], headerSlice[6], headerSlice[7]);
  if (ftyp !== 'ftyp') return false;

  const buffer = new Uint8Array(await blob.arrayBuffer());
  let offset = 0;
  let hasMoov = false;
  let hasMdat = false;
  while (offset + 8 <= buffer.length) {
    let size =
      ((buffer[offset] << 24) |
        (buffer[offset + 1] << 16) |
        (buffer[offset + 2] << 8) |
        buffer[offset + 3]) >>>
      0;
    const type = String.fromCharCode(
      buffer[offset + 4],
      buffer[offset + 5],
      buffer[offset + 6],
      buffer[offset + 7]
    );
    if (size === 0) {
      size = buffer.length - offset;
    } else if (size === 1 && offset + 16 <= buffer.length) {
      const hi =
        ((buffer[offset + 8] << 24) |
          (buffer[offset + 9] << 16) |
          (buffer[offset + 10] << 8) |
          buffer[offset + 11]) >>>
        0;
      const lo =
        ((buffer[offset + 12] << 24) |
          (buffer[offset + 13] << 16) |
          (buffer[offset + 14] << 8) |
          buffer[offset + 15]) >>>
        0;
      size = hi * 4294967296 + lo;
    }
    if (size < 8 || offset + size > buffer.length) {
      return false;
    }
    if (type === 'moov') hasMoov = true;
    if (type === 'mdat' && size > 16) hasMdat = true;
    offset += size;
  }
  return hasMoov && hasMdat;
}

export async function verifyPlayableMp4Blob(blob: Blob): Promise<{
  width: number;
  height: number;
  durationMs: number;
}> {
  const validStructure = await blobHasValidMp4Structure(blob);
  if (!validStructure) {
    throw new Error('Exported MP4 has incomplete container atoms and was discarded.');
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      let done = false;

      const timer = window.setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error('Timed out verifying exported MP4 playback.'));
        }
      }, 10000);

      video.onerror = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        reject(new Error('Exported MP4 is not playable in browser decoder.'));
      };

      video.onloadedmetadata = () => {
        if (done) return;
        const w = video.videoWidth;
        const h = video.videoHeight;
        const d = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
        if (w <= 0 || h <= 0 || d <= 0) {
          done = true;
          window.clearTimeout(timer);
          reject(new Error('Exported MP4 has invalid video dimensions or zero duration.'));
          return;
        }
        done = true;
        window.clearTimeout(timer);
        video.removeAttribute('src');
        video.load();
        resolve({ width: w, height: h, durationMs: d });
      };

      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function saveExportedBrowserVideoToGallery(
  video: LocalExportedBrowserVideo
): Promise<{ record: LocalExportedBrowserVideo; alreadySaved: boolean }> {
  const verified = await verifyPlayableMp4Blob(video.fileBlob);
  const contentHash = video.contentHash ?? (await computeBlobSha256(video.fileBlob));

  const existingRows = await getAllExportedBrowserVideos();
  const duplicate = existingRows.find(
    (row) =>
      row.gallerySaved &&
      row.fileSizeBytes === video.fileSizeBytes &&
      (row.contentHash === contentHash ||
        (video.exportSignature && row.exportSignature === video.exportSignature))
  );

  if (duplicate) {
    return { record: duplicate, alreadySaved: true };
  }

  const savedRecord: LocalExportedBrowserVideo = {
    ...video,
    durationMs: verified.durationMs > 0 ? verified.durationMs : video.durationMs,
    contentHash,
    gallerySaved: true,
    galleryRelativePath: 'Movies/HanumanAI',
    gallerySavedAt: Date.now(),
    verifiedPlayable: true,
  };

  await saveExportedBrowserVideo(savedRecord);
  return { record: savedRecord, alreadySaved: false };
}

/**
 * Extracts real container duration and captures a JPEG frame thumbnail
 * directly on the device using an offscreen HTML5 video and canvas.
 */
export async function inspectLocalVideoFile(
  file: Blob,
  options?: { allowUnboundedDuration?: boolean }
): Promise<{ durationMs: number; thumbnailDataUrl: string | null }> {
  const objectUrl = URL.createObjectURL(file);

  try {
    return await new Promise((resolve, reject) => {
      const videoEl = document.createElement('video');
      videoEl.preload = 'metadata';
      videoEl.muted = true;
      videoEl.playsInline = true;

      let settled = false;
      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Timed out reading local video metadata.'));
        }
      }, 15000);

      const finish = (durationMs: number, thumbnailDataUrl: string | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        videoEl.removeAttribute('src');
        videoEl.load();
        resolve({ durationMs, thumbnailDataUrl });
      };

      videoEl.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(new Error('This video codec or file format could not be decoded by the browser.'));
      };

      videoEl.onloadedmetadata = () => {
        const rawSeconds = videoEl.duration;
        const durationMs = Number.isFinite(rawSeconds) ? Math.round(rawSeconds * 1000) : 0;

        if (!options?.allowUnboundedDuration) {
          const check = validateVideoDuration(durationMs, { allowUnknown: false });
          if (!check.valid) {
            if (!settled) {
              settled = true;
              window.clearTimeout(timeout);
              reject(new Error(check.reason ?? 'Video exceeds 30:00 maximum duration.'));
            }
            return;
          }
        }

        const seekTarget =
          Number.isFinite(rawSeconds) && rawSeconds > 1.2
            ? 1.0
            : Number.isFinite(rawSeconds)
              ? Math.max(0, rawSeconds * 0.25)
              : 0;
        videoEl.currentTime = seekTarget;
      };

      videoEl.onseeked = () => {
        const durationMs = Number.isFinite(videoEl.duration)
          ? Math.round(videoEl.duration * 1000)
          : 0;
        try {
          const width = videoEl.videoWidth || 320;
          const height = videoEl.videoHeight || 180;
          const scale = Math.min(1, 320 / width);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
            finish(durationMs, dataUrl);
            return;
          }
        } catch {
          // Fall back to null thumbnail if frame capture fails
        }
        finish(durationMs, null);
      };

      videoEl.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function processAndPersistBrowserVideo(
  file: File,
  source: VideoImportSource
): Promise<LocalBrowserVideo> {
  const { durationMs, thumbnailDataUrl } = await inspectLocalVideoFile(file);

  const check = validateVideoDuration(durationMs, { allowUnknown: false });
  if (!check.valid) {
    throw new Error(check.reason ?? 'Video exceeds the 30-minute limit.');
  }

  const record: LocalBrowserVideo = {
    id: `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    source,
    fileBlob: file,
    thumbnailDataUrl,
    durationMs: check.durationMs,
    fileSizeBytes: file.size,
    importedAt: Date.now(),
  };

  await saveLocalBrowserVideo(record);
  return record;
}
