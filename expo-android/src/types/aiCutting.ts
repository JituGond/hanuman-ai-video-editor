export type CuttingPreset =
  | 'ai_auto_cut'
  | 'remove_silent'
  | 'remove_unwanted_scenes'
  | 'smart_scene_detection'
  | 'keep_important_moments'
  | 'preserve_original';

export interface CuttingPresetOption {
  id: CuttingPreset;
  label: string;
  description: string;
}

export const CUTTING_PRESET_OPTIONS: CuttingPresetOption[] = [
  {
    id: 'ai_auto_cut',
    label: 'AI Auto Cut',
    description: 'Removes silent pauses, repeated takes, and low-energy stretches while keeping key moments in order.',
  },
  {
    id: 'remove_silent',
    label: 'Remove Silent Parts',
    description: 'Detects and cuts sustained silence while preserving natural speech breathing margins.',
  },
  {
    id: 'remove_unwanted_scenes',
    label: 'Remove Unwanted Scenes',
    description: 'Cuts static, boring, or repeated scenes with minimal motion or audio activity.',
  },
  {
    id: 'smart_scene_detection',
    label: 'Smart Scene Detection',
    description: 'Splits along visual scene boundaries and retains distinct, high-value scenes.',
  },
  {
    id: 'keep_important_moments',
    label: 'Keep Important Moments',
    description: 'Extracts peak audio and visual motion highlights in chronological sequence.',
  },
  {
    id: 'preserve_original',
    label: 'Original Video Preservation',
    description: 'Keeps the full original timeline intact as a non-destructive master copy.',
  },
];

export interface AnalysisWindow {
  startMs: number;
  endMs: number;
  /** Audio RMS loudness in dBFS (-90 to 0). Use -90 when silent or no audio track. */
  audioRmsDb: number;
  /** Normalized frame-to-frame motion score (0.0 to 1.0). */
  visualMotion: number;
  /** Normalized visual scene change delta vs previous window (0.0 to 1.0). */
  sceneDelta: number;
  /** Compact 12-bin normalized RGB color histogram for repeat-scene matching. */
  histogram: number[];
}

export interface DetectedScene {
  id: string;
  startMs: number;
  endMs: number;
  avgAudioDb: number;
  avgMotion: number;
  isSilent: boolean;
  isPause: boolean;
  isRepeated: boolean;
  isStatic: boolean;
  importanceScore: number;
  reason: string;
}

export type SegmentCategory =
  | 'important'
  | 'speech_action'
  | 'scene'
  | 'silent'
  | 'pause'
  | 'repeated'
  | 'boring'
  | 'preserved';

export interface TimelineSegment {
  id: string;
  startMs: number;
  endMs: number;
  action: 'keep' | 'remove';
  category: SegmentCategory;
  reason: string;
  importanceScore: number;
}

export interface VideoAnalysisReport {
  videoId: string;
  totalDurationMs: number;
  windowsAnalyzed: number;
  hasAudioTrack: boolean;
  noiseFloorDb: number;
  detectedScenes: DetectedScene[];
  silentSectionsCount: number;
  pauseSectionsCount: number;
  repeatedScenesCount: number;
  importantMomentsCount: number;
  analyzedAt: number;
}

export interface CutPlan {
  preset: CuttingPreset;
  originalDurationMs: number;
  estimatedEditedDurationMs: number;
  removedDurationMs: number;
  segments: TimelineSegment[];
  keepSegments: TimelineSegment[];
  removedSegments: TimelineSegment[];
}

export interface EditedVideoRecord {
  id: string;
  sourceVideoId: string;
  sourceVideoName: string;
  name: string;
  localUri: string;
  thumbnailUri: string | null;
  durationMs: number;
  originalDurationMs: number;
  fileSizeBytes: number;
  preset: CuttingPreset;
  analysis: VideoAnalysisReport;
  cutPlan: CutPlan;
  createdAt: number;
}
