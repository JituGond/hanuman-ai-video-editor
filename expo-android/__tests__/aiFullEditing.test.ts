import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoSelectBestEditingStyle,
  buildFullEditPlan,
  computeEnhancementProfile,
  getEditingStyleLabel,
} from '../src/utils/aiFullEditorEngine';
import {
  DEFAULT_AUDIO_EDIT_OPTIONS,
  DEFAULT_ENHANCEMENT_TOGGLES,
} from '../src/types/aiEditing';
import type { VideoAnalysisReport } from '../src/types/aiCutting';

function makeAnalysis(overrides?: Partial<VideoAnalysisReport>): VideoAnalysisReport {
  return {
    videoId: 'vid_step3',
    totalDurationMs: 30_000,
    windowsAnalyzed: 30,
    hasAudioTrack: true,
    noiseFloorDb: -50,
    silentSectionsCount: 1,
    pauseSectionsCount: 1,
    repeatedScenesCount: 0,
    importantMomentsCount: 2,
    analyzedAt: Date.now(),
    detectedScenes: [
      {
        id: 's1',
        startMs: 0,
        endMs: 8000,
        avgAudioDb: -16,
        avgMotion: 0.22,
        isSilent: false,
        isPause: false,
        isRepeated: false,
        isStatic: false,
        importanceScore: 0.75,
        reason: 'Speech intro',
      },
      {
        id: 's2',
        startMs: 8000,
        endMs: 12000,
        avgAudioDb: -60,
        avgMotion: 0.01,
        isSilent: true,
        isPause: false,
        isRepeated: false,
        isStatic: true,
        importanceScore: 0.05,
        reason: 'Silent gap',
      },
      {
        id: 's3',
        startMs: 12000,
        endMs: 22000,
        avgAudioDb: -15,
        avgMotion: 0.25,
        isSilent: false,
        isPause: false,
        isRepeated: false,
        isStatic: false,
        importanceScore: 0.82,
        reason: 'Main speech',
      },
      {
        id: 's4',
        startMs: 22000,
        endMs: 30000,
        avgAudioDb: -49,
        avgMotion: 0.24,
        isSilent: false,
        isPause: false,
        isRepeated: false,
        isStatic: false,
        importanceScore: 0.55,
        reason: 'Non-speech action b-roll',
      },
    ],
    ...overrides,
  };
}

test('AUTO SELECT chooses vlog or gaming style based on speech and motion metrics', () => {
  const vlogAnalysis = makeAnalysis();
  const vlogPick = autoSelectBestEditingStyle(vlogAnalysis);
  assert.equal(vlogPick.style, 'vlog');
  assert.match(vlogPick.reason, /Vlog Editing/);

  const gamingAnalysis = makeAnalysis({
    detectedScenes: Array.from({ length: 10 }, (_, idx) => ({
      id: `g_${idx}`,
      startMs: idx * 3000,
      endMs: (idx + 1) * 3000,
      avgAudioDb: -12,
      avgMotion: 0.42,
      isSilent: false,
      isPause: false,
      isRepeated: false,
      isStatic: false,
      importanceScore: 0.85,
      reason: 'Fast gaming scene',
    })),
  });
  const gamingPick = autoSelectBestEditingStyle(gamingAnalysis);
  assert.equal(gamingPick.style, 'gaming');
});

test('computes real visual and audio enhancement profiles respecting user toggles', () => {
  const analysis = makeAnalysis();
  const enabledProfile = computeEnhancementProfile({
    style: 'cinematic',
    analysis,
    enhancements: DEFAULT_ENHANCEMENT_TOGGLES,
    audioOptions: DEFAULT_AUDIO_EDIT_OPTIONS,
  });

  assert.ok(enabledProfile.contrastDelta > 0.1);
  assert.ok(enabledProfile.sharpnessAmount > 0.2);
  assert.ok(enabledProfile.denoiseStrength > 0.1);
  assert.ok(enabledProfile.stabilizationZoom > 1.0);
  assert.ok(enabledProfile.audioGainDb > 0);
  assert.equal(enabledProfile.highPassHz, 85);

  const disabledProfile = computeEnhancementProfile({
    style: 'cinematic',
    analysis,
    enhancements: {
      colourEnhancement: false,
      lightingCorrection: false,
      contrastEnhancement: false,
      videoStabilization: false,
      noiseReduction: false,
      visualQualityEnhancement: false,
    },
    audioOptions: {
      ...DEFAULT_AUDIO_EDIT_OPTIONS,
      preserveOriginalAudio: true,
    },
  });

  assert.equal(disabledProfile.contrastDelta, 0);
  assert.equal(disabledProfile.sharpnessAmount, 0);
  assert.equal(disabledProfile.stabilizationZoom, 1.0);
  assert.equal(disabledProfile.audioGainDb, 0);
  assert.equal(disabledProfile.highPassHz, 0);
});

test('builds complete edit plans across all 6 styles and keeps speech at 1.0x speed', () => {
  const analysis = makeAnalysis();
  const selections = [
    'auto_select',
    'auto_best',
    'cinematic',
    'professional',
    'gaming',
    'vlog',
    'natural',
  ] as const;

  for (const sel of selections) {
    assert.ok(getEditingStyleLabel(sel).length > 0);
    const plan = buildFullEditPlan({
      analysis,
      styleSelection: sel,
      enhancements: DEFAULT_ENHANCEMENT_TOGGLES,
      audioOptions: DEFAULT_AUDIO_EDIT_OPTIONS,
    });

    assert.ok(plan.clips.length >= 1);
    assert.ok(plan.estimatedEditedDurationMs <= plan.originalDurationMs);
    // Speech clips must remain 1.0x speed
    assert.equal(plan.clips[0].playbackSpeed, 1.0);
  }
});

test('supports 30-minute video full editing plan cleanly', () => {
  const scenes = Array.from({ length: 60 }, (_, idx) => ({
    id: `m30_${idx}`,
    startMs: idx * 30_000,
    endMs: (idx + 1) * 30_000,
    avgAudioDb: idx % 5 === 0 ? -62 : -16,
    avgMotion: idx % 5 === 0 ? 0.01 : 0.24,
    isSilent: idx % 5 === 0,
    isPause: false,
    isRepeated: false,
    isStatic: idx % 5 === 0,
    importanceScore: idx % 5 === 0 ? 0.05 : 0.72,
    reason: idx % 5 === 0 ? 'Silent block' : 'Active scene',
  }));

  const analysis = makeAnalysis({
    totalDurationMs: 1_800_000,
    detectedScenes: scenes,
    silentSectionsCount: 12,
  });

  const plan = buildFullEditPlan({
    analysis,
    styleSelection: 'auto_select',
    enhancements: DEFAULT_ENHANCEMENT_TOGGLES,
    audioOptions: DEFAULT_AUDIO_EDIT_OPTIONS,
  });

  assert.equal(plan.originalDurationMs, 1_800_000);
  assert.ok(plan.clips.length > 0);
  assert.ok(plan.estimatedEditedDurationMs < 1_800_000);
});
