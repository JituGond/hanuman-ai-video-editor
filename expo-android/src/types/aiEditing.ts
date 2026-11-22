import type { CutPlan, VideoAnalysisReport } from './aiCutting';

export type EditingStyle =
  | 'auto_best'
  | 'cinematic'
  | 'professional'
  | 'gaming'
  | 'vlog'
  | 'natural';

export type EditingStyleSelection = 'auto_select' | EditingStyle;

export interface EditingStyleOption {
  id: EditingStyleSelection;
  label: string;
  description: string;
}

export const EDITING_STYLE_OPTIONS: EditingStyleOption[] = [
  {
    id: 'auto_select',
    label: 'AUTO SELECT (AI Picks Best)',
    description: 'AI inspects audio speech ratio, scene pace, and motion to pick the optimal style automatically.',
  },
  {
    id: 'auto_best',
    label: 'Auto Best Editing',
    description: 'Balanced color, crisp voice clarity, smooth transitions, and clean pacing across any footage.',
  },
  {
    id: 'cinematic',
    label: 'Cinematic Editing',
    description: 'Rich contrast, warm highlights, dip-to-black dissolves, and deliberate pacing.',
  },
  {
    id: 'professional',
    label: 'Professional Editing',
    description: 'Clean neutral white balance, broadcast voice normalization, and tight structured cuts.',
  },
  {
    id: 'gaming',
    label: 'Gaming Editing',
    description: 'Vibrant saturation, sharp UI/action edges, fast cuts, and speed boosts on downtime.',
  },
  {
    id: 'vlog',
    label: 'Vlog Editing',
    description: 'Bright lifted shadows, crisp speech presence, punchy crossfades, and dynamic pacing.',
  },
  {
    id: 'natural',
    label: 'Natural Editing',
    description: 'Gentle exposure/color correction and noise cleanup that preserves authentic camera look.',
  },
];

export interface VideoEnhancementToggles {
  colourEnhancement: boolean;
  lightingCorrection: boolean;
  contrastEnhancement: boolean;
  videoStabilization: boolean;
  noiseReduction: boolean;
  visualQualityEnhancement: boolean;
}

export const DEFAULT_ENHANCEMENT_TOGGLES: VideoEnhancementToggles = {
  colourEnhancement: true,
  lightingCorrection: true,
  contrastEnhancement: true,
  videoStabilization: true,
  noiseReduction: true,
  visualQualityEnhancement: true,
};

export interface AudioEditOptions {
  improveVoiceClarity: boolean;
  reduceBackgroundNoise: boolean;
  normalizeVolume: boolean;
  preserveOriginalAudio: boolean;
  backgroundMusicUri: string | null;
  backgroundMusicName: string | null;
  backgroundMusicVolume: number; // 0.0 to 0.5
}

export const DEFAULT_AUDIO_EDIT_OPTIONS: AudioEditOptions = {
  improveVoiceClarity: true,
  reduceBackgroundNoise: true,
  normalizeVolume: true,
  preserveOriginalAudio: false,
  backgroundMusicUri: null,
  backgroundMusicName: null,
  backgroundMusicVolume: 0.16,
};

export interface ComputedEnhancementProfile {
  brightnessDelta: number; // -0.35 to +0.35 (normalized)
  contrastDelta: number; // -0.30 to +0.40 (normalized)
  saturationDelta: number; // -30 to +40 (HSL scale)
  redScale: number; // ~0.92 to 1.08
  greenScale: number; // ~0.95 to 1.05
  blueScale: number; // ~0.92 to 1.08
  sharpnessAmount: number; // 0.0 to 0.55
  denoiseStrength: number; // 0.0 to 0.45
  stabilizationZoom: number; // 1.0 (off) to 1.06 (6% overscan crop stabilization)
  transitionType: 'crossfade' | 'dip_black' | 'cut';
  transitionDurationMs: number;
  audioGainDb: number;
  noiseGateDb: number;
  voiceClarityGainDb: number;
  highPassHz: number;
}

export interface FullEditClip {
  id: string;
  startMs: number;
  endMs: number;
  playbackSpeed: number; // 1.0 for speech, 1.25-1.35 for non-speech action/travel
  transitionIn: 'none' | 'crossfade' | 'dip_black';
  reason: string;
}

export interface FullEditPlan {
  requestedSelection: EditingStyleSelection;
  resolvedStyle: EditingStyle;
  styleSelectionReason: string;
  originalDurationMs: number;
  estimatedEditedDurationMs: number;
  clips: FullEditClip[];
  enhancements: VideoEnhancementToggles;
  audioOptions: AudioEditOptions;
  profile: ComputedEnhancementProfile;
  baseCutPlan: CutPlan;
}

export interface FullEditedVideoRecord {
  id: string;
  sourceVideoId: string;
  sourceVideoName: string;
  name: string;
  localUri: string;
  thumbnailUri: string | null;
  durationMs: number;
  originalDurationMs: number;
  fileSizeBytes: number;
  editPlan: FullEditPlan;
  analysis: VideoAnalysisReport;
  createdAt: number;
}
