export type VideoImportSource = 'gallery' | 'screen_recording' | 'file_manager';

export interface ImportedVideo {
  id: string;
  name: string;
  localUri: string;
  thumbnailUri: string | null;
  durationMs: number;
  fileSizeBytes: number;
  source: VideoImportSource;
  importedAt: number;
}

export interface ScreenRecordingCandidate {
  id: string;
  filename: string;
  uri: string;
  durationMs: number;
  width: number;
  height: number;
  creationTime: number;
  albumTitle: string;
  isLikelyScreenRecording: boolean;
}

export interface PermissionCheckResult {
  granted: boolean;
  canAskAgain: boolean;
  message?: string;
}

export interface ImportOutcome {
  status: 'imported' | 'cancelled' | 'error';
  video?: ImportedVideo;
  errorMessage?: string;
}
