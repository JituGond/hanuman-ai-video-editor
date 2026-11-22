import type { VideoAnalysisReport } from '../types/aiCutting';
import type {
  AudioEditOptions,
  ComputedEnhancementProfile,
  EditingStyle,
  EditingStyleSelection,
  FullEditClip,
  FullEditPlan,
  VideoEnhancementToggles,
} from '../types/aiEditing';
import { buildCutPlan } from './aiCuttingEngine';

export function getEditingStyleLabel(style: EditingStyleSelection): string {
  switch (style) {
    case 'auto_select':
      return 'AUTO SELECT (AI)';
    case 'auto_best':
      return 'Auto Best Editing';
    case 'cinematic':
      return 'Cinematic Editing';
    case 'professional':
      return 'Professional Editing';
    case 'gaming':
      return 'Gaming Editing';
    case 'vlog':
      return 'Vlog Editing';
    case 'natural':
      return 'Natural Editing';
  }
}

/**
 * Inspects real VideoAnalysisReport metrics to select the best editing style
 * automatically when the user picks AUTO SELECT.
 */
export function autoSelectBestEditingStyle(analysis: VideoAnalysisReport): {
  style: EditingStyle;
  reason: string;
} {
  const scenes = analysis.detectedScenes;
  if (scenes.length === 0) {
    return {
      style: 'auto_best',
      reason: 'Auto-selected Auto Best Editing as balanced default for footage.',
    };
  }

  const totalMs = Math.max(1, analysis.totalDurationMs);
  const speechScenes = scenes.filter((s) => !s.isSilent && !s.isPause);
  const speechRatio =
    speechScenes.reduce((sum, s) => sum + (s.endMs - s.startMs), 0) / totalMs;
  const avgMotion =
    scenes.reduce((sum, s) => sum + s.avgMotion, 0) / scenes.length;
  const avgSceneLengthMs = totalMs / scenes.length;

  if (avgMotion >= 0.28 && avgSceneLengthMs <= 5500) {
    return {
      style: 'gaming',
      reason: `Auto-selected Gaming Editing (${scenes.length} fast scenes, high visual motion).`,
    };
  }

  if (analysis.hasAudioTrack && speechRatio >= 0.55 && avgMotion >= 0.12) {
    return {
      style: 'vlog',
      reason: `Auto-selected Vlog Editing (${Math.round(speechRatio * 100)}% active speech & dynamic framing).`,
    };
  }

  if (analysis.hasAudioTrack && speechRatio >= 0.5 && avgMotion < 0.12) {
    return {
      style: 'professional',
      reason: `Auto-selected Professional Editing (${Math.round(speechRatio * 100)}% steady speech clarity).`,
    };
  }

  if (!analysis.hasAudioTrack || avgSceneLengthMs >= 6500) {
    return {
      style: 'cinematic',
      reason: `Auto-selected Cinematic Editing (${scenes.length} longer visual scenes).`,
    };
  }

  return {
    style: 'auto_best',
    reason: 'Auto-selected Auto Best Editing for balanced pacing, color, and audio.',
  };
}

/**
 * Computes real, bounded GPU color/lighting/sharpness/stabilization and audio DSP
 * parameters from the selected EditingStyle, enhancement toggles, and analysis report.
 */
export function computeEnhancementProfile(params: {
  style: EditingStyle;
  analysis: VideoAnalysisReport;
  enhancements: VideoEnhancementToggles;
  audioOptions: AudioEditOptions;
}): ComputedEnhancementProfile {
  const { style, analysis, enhancements, audioOptions } = params;

  const baseByStyle: Record<
    EditingStyle,
    {
      brightness: number;
      contrast: number;
      saturation: number;
      red: number;
      green: number;
      blue: number;
      sharpness: number;
      transitionType: 'crossfade' | 'dip_black' | 'cut';
      transitionMs: number;
    }
  > = {
    auto_best: {
      brightness: 0.04,
      contrast: 0.12,
      saturation: 10,
      red: 1.02,
      green: 1.0,
      blue: 0.99,
      sharpness: 0.26,
      transitionType: 'crossfade',
      transitionMs: 280,
    },
    cinematic: {
      brightness: -0.02,
      contrast: 0.22,
      saturation: 8,
      red: 1.05,
      green: 1.0,
      blue: 0.95,
      sharpness: 0.3,
      transitionType: 'dip_black',
      transitionMs: 420,
    },
    professional: {
      brightness: 0.05,
      contrast: 0.14,
      saturation: 4,
      red: 1.0,
      green: 1.0,
      blue: 1.01,
      sharpness: 0.28,
      transitionType: 'crossfade',
      transitionMs: 240,
    },
    gaming: {
      brightness: 0.06,
      contrast: 0.18,
      saturation: 22,
      red: 1.02,
      green: 1.01,
      blue: 1.03,
      sharpness: 0.38,
      transitionType: 'cut',
      transitionMs: 120,
    },
    vlog: {
      brightness: 0.08,
      contrast: 0.12,
      saturation: 14,
      red: 1.03,
      green: 1.01,
      blue: 0.98,
      sharpness: 0.24,
      transitionType: 'crossfade',
      transitionMs: 220,
    },
    natural: {
      brightness: 0.02,
      contrast: 0.06,
      saturation: 3,
      red: 1.01,
      green: 1.0,
      blue: 1.0,
      sharpness: 0.15,
      transitionType: 'crossfade',
      transitionMs: 200,
    },
  };

  const preset = baseByStyle[style];

  // Calculate real audio normalization gain based on analyzed noise floor and peak speech
  const scenes = analysis.detectedScenes;
  const maxAudioDb =
    scenes.length > 0 ? Math.max(...scenes.map((s) => s.avgAudioDb)) : -18;
  const targetPeakDb = -6;
  const computedGainDb =
    analysis.hasAudioTrack && audioOptions.normalizeVolume && !audioOptions.preserveOriginalAudio
      ? Math.max(0, Math.min(12, targetPeakDb - maxAudioDb))
      : 0;

  const noiseGateDb =
    analysis.hasAudioTrack && audioOptions.reduceBackgroundNoise && !audioOptions.preserveOriginalAudio
      ? Math.min(-32, Math.max(-56, analysis.noiseFloorDb + 3.5))
      : -90;

  const voiceClarityGainDb =
    analysis.hasAudioTrack && audioOptions.improveVoiceClarity && !audioOptions.preserveOriginalAudio
      ? style === 'professional' || style === 'vlog'
        ? 3.0
        : 2.0
      : 0;

  const highPassHz =
    analysis.hasAudioTrack && audioOptions.reduceBackgroundNoise && !audioOptions.preserveOriginalAudio
      ? 85
      : 0;

  return {
    brightnessDelta: enhancements.lightingCorrection ? preset.brightness : 0,
    contrastDelta: enhancements.contrastEnhancement ? preset.contrast : 0,
    saturationDelta: enhancements.colourEnhancement ? preset.saturation : 0,
    redScale: enhancements.colourEnhancement ? preset.red : 1.0,
    greenScale: enhancements.colourEnhancement ? preset.green : 1.0,
    blueScale: enhancements.colourEnhancement ? preset.blue : 1.0,
    sharpnessAmount: enhancements.visualQualityEnhancement ? preset.sharpness : 0,
    denoiseStrength: enhancements.noiseReduction ? 0.22 : 0,
    stabilizationZoom: enhancements.videoStabilization ? 1.05 : 1.0,
    transitionType: preset.transitionType,
    transitionDurationMs: preset.transitionMs,
    audioGainDb: Number(computedGainDb.toFixed(1)),
    noiseGateDb: Number(noiseGateDb.toFixed(1)),
    voiceClarityGainDb,
    highPassHz,
  };
}

/**
 * Builds the complete Step 3 Full Edit Plan combining Step 2 scene selection
 * with professional pacing, transitions, safe speed boosts on non-speech b-roll,
 * visual enhancement profile, and audio DSP settings.
 */
export function buildFullEditPlan(params: {
  analysis: VideoAnalysisReport;
  styleSelection: EditingStyleSelection;
  enhancements: VideoEnhancementToggles;
  audioOptions: AudioEditOptions;
}): FullEditPlan {
  const { analysis, styleSelection, enhancements, audioOptions } = params;

  const resolved =
    styleSelection === 'auto_select'
      ? autoSelectBestEditingStyle(analysis)
      : {
          style: styleSelection,
          reason: `Selected ${getEditingStyleLabel(styleSelection)}.`,
        };

  // Reuse Step 2 CutPlan engine so Step 2 & Step 3 share consistent scene intelligence
  const cutPreset =
    resolved.style === 'cinematic'
      ? 'smart_scene_detection'
      : resolved.style === 'gaming'
        ? 'keep_important_moments'
        : 'ai_auto_cut';

  const baseCutPlan = buildCutPlan(analysis, cutPreset);
  const profile = computeEnhancementProfile({
    style: resolved.style,
    analysis,
    enhancements,
    audioOptions,
  });

  const clips: FullEditClip[] = baseCutPlan.keepSegments.map((seg, idx) => {
    const durationMs = seg.endMs - seg.startMs;
    // Only speed up long non-speech b-roll / action stretches so speech never sounds distorted
    const matchingScene = analysis.detectedScenes.find(
      (sc) => sc.startMs >= seg.startMs && sc.endMs <= seg.endMs
    );
    const isLowSpeechAction =
      matchingScene !== undefined &&
      (!analysis.hasAudioTrack || matchingScene.avgAudioDb <= analysis.noiseFloorDb + 5) &&
      matchingScene.avgMotion >= 0.16 &&
      durationMs >= 4500;

    const playbackSpeed =
      isLowSpeechAction && (resolved.style === 'gaming' || resolved.style === 'vlog' || resolved.style === 'auto_best')
        ? 1.25
        : 1.0;

    const transitionIn: 'none' | 'crossfade' | 'dip_black' =
      idx === 0 || profile.transitionType === 'cut'
        ? 'none'
        : profile.transitionType;

    return {
      id: `full_clip_${idx + 1}`,
      startMs: seg.startMs,
      endMs: seg.endMs,
      playbackSpeed,
      transitionIn,
      reason:
        playbackSpeed > 1
          ? `${seg.reason} · 1.25x pace boost`
          : seg.reason,
    };
  });

  const estimatedEditedDurationMs = clips.reduce(
    (sum, clip) => sum + Math.round((clip.endMs - clip.startMs) / clip.playbackSpeed),
    0
  );

  return {
    requestedSelection: styleSelection,
    resolvedStyle: resolved.style,
    styleSelectionReason: resolved.reason,
    originalDurationMs: analysis.totalDurationMs,
    estimatedEditedDurationMs,
    clips,
    enhancements,
    audioOptions,
    profile,
    baseCutPlan,
  };
}
