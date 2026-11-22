import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import type {
  ImportOutcome,
  ScreenRecordingCandidate,
} from '../types/video';
import {
  isScreenRecordingCandidate,
  validateVideoDuration,
} from '../utils/videoValidation';
import {
  requestGalleryPermission,
  requestScreenRecordingPermission,
} from './androidPermissions';
import { persistVideoOnDevice } from './localVideoStorage';

/**
 * Option 1: Gallery Video
 * Opens Android system gallery/photo picker scoped to videos.
 */
export async function importGalleryVideo(): Promise<ImportOutcome> {
  const perm = await requestGalleryPermission();
  if (!perm.granted) {
    return {
      status: 'error',
      errorMessage: perm.message ?? 'Gallery access permission denied.',
    };
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    allowsEditing: false,
    quality: 1,
    videoMaxDuration: 1800,
  });

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return { status: 'cancelled' };
  }

  const asset = result.assets[0];
  // ImagePicker returns duration in milliseconds on Android
  const durationCheck = validateVideoDuration(asset.duration, { allowUnknown: true });
  if (!durationCheck.valid) {
    return {
      status: 'error',
      errorMessage: durationCheck.reason,
    };
  }

  const fileName =
    asset.fileName ??
    asset.uri.split('/').pop() ??
    `gallery_video_${Date.now()}.mp4`;

  const video = await persistVideoOnDevice({
    sourceUri: asset.uri,
    originalName: fileName,
    source: 'gallery',
    durationMs: durationCheck.durationMs,
    fileSizeBytes: asset.fileSize ?? 0,
  });

  return { status: 'imported', video };
}

/**
 * Option 2A: Scan Device Screen Recordings via expo-media-library
 * Queries video albums and identifies screen recordings across Android OEMs.
 */
export async function loadDeviceScreenRecordings(): Promise<{
  granted: boolean;
  canAskAgain: boolean;
  errorMessage?: string;
  screenRecordings: ScreenRecordingCandidate[];
  allVideos: ScreenRecordingCandidate[];
}> {
  const perm = await requestScreenRecordingPermission();
  if (!perm.granted) {
    return {
      granted: false,
      canAskAgain: perm.canAskAgain,
      errorMessage: perm.message,
      screenRecordings: [],
      allVideos: [],
    };
  }

  const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
  const albumMap = new Map<string, string>();
  for (const album of albums) {
    albumMap.set(album.id, album.title);
  }

  const mediaPage = await MediaLibrary.getAssetsAsync({
    mediaType: MediaLibrary.MediaType.video,
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    first: 150,
  });

  const allVideos: ScreenRecordingCandidate[] = mediaPage.assets.map((asset: MediaLibrary.Asset) => {
    const albumTitle = asset.albumId ? albumMap.get(asset.albumId) ?? 'Device Videos' : 'Device Videos';
    // MediaLibrary returns asset.duration in SECONDS — convert to milliseconds
    const durationMs = Math.round((asset.duration ?? 0) * 1000);
    return {
      id: asset.id,
      filename: asset.filename,
      uri: asset.uri,
      durationMs,
      width: asset.width,
      height: asset.height,
      creationTime: asset.creationTime,
      albumTitle,
      isLikelyScreenRecording: isScreenRecordingCandidate({
        filename: asset.filename,
        uri: asset.uri,
        albumTitle,
      }),
    };
  });

  const screenRecordings = allVideos.filter((item) => item.isLikelyScreenRecording);

  return {
    granted: true,
    canAskAgain: true,
    screenRecordings,
    allVideos,
  };
}

/**
 * Option 2B: Import a chosen Screen Recording asset into app-private device storage.
 */
export async function importScreenRecordingAsset(
  candidate: ScreenRecordingCandidate
): Promise<ImportOutcome> {
  const durationCheck = validateVideoDuration(candidate.durationMs, { allowUnknown: false });
  if (!durationCheck.valid) {
    return {
      status: 'error',
      errorMessage: durationCheck.reason,
    };
  }

  const assetInfo = await MediaLibrary.getAssetInfoAsync(candidate.id);
  const resolvedUri = assetInfo.localUri ?? assetInfo.uri ?? candidate.uri;

  const video = await persistVideoOnDevice({
    sourceUri: resolvedUri,
    originalName: candidate.filename,
    source: 'screen_recording',
    durationMs: durationCheck.durationMs,
  });

  return { status: 'imported', video };
}

/**
 * Option 3: File Manager Video
 * Uses Android Storage Access Framework (SAF) via expo-document-picker.
 */
export async function importFileManagerVideo(): Promise<ImportOutcome> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'video/*',
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return { status: 'cancelled' };
  }

  const asset = result.assets[0];
  // DocumentPicker does not supply durationMs before loading into Video player;
  // VideoPreviewPlayer validates exact container duration onLoad against the 30:00 cap.
  const video = await persistVideoOnDevice({
    sourceUri: asset.uri,
    originalName: asset.name || `file_video_${Date.now()}.mp4`,
    source: 'file_manager',
    durationMs: 0,
    fileSizeBytes: asset.size ?? 0,
  });

  return { status: 'imported', video };
}
