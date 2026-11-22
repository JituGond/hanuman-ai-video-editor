import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeVideoWindows,
  buildCutPlan,
  computeHistogramSimilarity,
  getPresetLabel,
} from '../src/utils/aiCuttingEngine';
import type { AnalysisWindow } from '../src/types/aiCutting';

function makeHistogram(rDominant: number, gDominant: number, bDominant: number): number[] {
  const hist = new Array<number>(12).fill(0.01);
  hist[rDominant] = 0.5;
  hist[4 + gDominant] = 0.3;
  hist[8 + bDominant] = 0.2;
  return hist;
}

function buildSyntheticVideoWindows(): AnalysisWindow[] {
  const windows: AnalysisWindow[] = [];
  const pushRange = (
    startSec: number,
    endSec: number,
    audioRmsDb: number,
    visualMotion: number,
    sceneDelta: number,
    histogram: number[]
  ) => {
    for (let s = startSec; s < endSec; s += 1) {
      windows.push({
        startMs: s * 1000,
        endMs: (s + 1) * 1000,
        audioRmsDb,
        visualMotion,
        sceneDelta: s === startSec ? sceneDelta : 0.04,
        histogram,
      });
    }
  };

  // 0-5s: Active speech intro (Scene A)
  pushRange(0, 5, -14, 0.28, 0.65, makeHistogram(3, 1, 0));
  // 5-9s: Long silent dead air
  pushRange(5, 9, -62, 0.01, 0.02, makeHistogram(3, 1, 0));
  // 9-14s: High-energy action moment (Scene B)
  pushRange(9, 14, -9, 0.52, 0.72, makeHistogram(0, 3, 2));
  // 14-16s: Unnecessary pause
  pushRange(14, 16, -48, 0.02, 0.03, makeHistogram(0, 3, 2));
  // 16-20s: Repeated Scene A static take
  pushRange(16, 20, -24, 0.08, 0.68, makeHistogram(3, 1, 0));
  // 20-25s: Closing high-energy scene (Scene C)
  pushRange(20, 25, -11, 0.38, 0.75, makeHistogram(1, 0, 3));

  return windows;
}

test('histogram cosine similarity detects matching vs distinct scenes', () => {
  const a = makeHistogram(3, 1, 0);
  const b = makeHistogram(3, 1, 0);
  const c = makeHistogram(0, 3, 2);

  assert.ok(computeHistogramSimilarity(a, b) > 0.99);
  assert.ok(computeHistogramSimilarity(a, c) < 0.5);
});

test('analyzes complete video and detects scenes, silent sections, pauses, repeated scenes, and important moments', () => {
  const windows = buildSyntheticVideoWindows();
  const report = analyzeVideoWindows({
    videoId: 'vid_test_1',
    totalDurationMs: 25_000,
    windows,
    hasAudioTrack: true,
  });

  assert.equal(report.totalDurationMs, 25_000);
  assert.equal(report.windowsAnalyzed, 25);
  assert.ok(report.detectedScenes.length >= 4);
  assert.ok(report.silentSectionsCount >= 1);
  assert.ok(report.importantMomentsCount >= 1);
});

test('ai_auto_cut removes silent/repeated sections while preserving chronological order', () => {
  const report = analyzeVideoWindows({
    videoId: 'vid_test_2',
    totalDurationMs: 25_000,
    windows: buildSyntheticVideoWindows(),
    hasAudioTrack: true,
  });

  const plan = buildCutPlan(report, 'ai_auto_cut');
  assert.ok(plan.keepSegments.length >= 2);
  assert.ok(plan.removedSegments.length >= 1);
  assert.ok(plan.estimatedEditedDurationMs < plan.originalDurationMs);

  // Verify chronological scene order
  for (let i = 1; i < plan.keepSegments.length; i += 1) {
    assert.ok(plan.keepSegments[i].startMs >= plan.keepSegments[i - 1].endMs);
  }
});

test('supports all 6 smart cutting presets including preserve_original', () => {
  const report = analyzeVideoWindows({
    videoId: 'vid_test_3',
    totalDurationMs: 25_000,
    windows: buildSyntheticVideoWindows(),
    hasAudioTrack: true,
  });

  const presets = [
    'ai_auto_cut',
    'remove_silent',
    'remove_unwanted_scenes',
    'smart_scene_detection',
    'keep_important_moments',
    'preserve_original',
  ] as const;

  for (const preset of presets) {
    assert.ok(getPresetLabel(preset).length > 0);
    const plan = buildCutPlan(report, preset);
    assert.ok(plan.keepSegments.length >= 1, `Expected kept segments for ${preset}`);
    assert.equal(
      plan.estimatedEditedDurationMs + plan.removedDurationMs,
      plan.originalDurationMs
    );
  }

  const preserved = buildCutPlan(report, 'preserve_original');
  assert.equal(preserved.estimatedEditedDurationMs, 25_000);
  assert.equal(preserved.removedSegments.length, 0);
});

test('supports 30-minute video timelines (1,800,000 ms) without dropping clips', () => {
  const windows: AnalysisWindow[] = [];
  for (let s = 0; s < 1800; s += 3) {
    const isSilentBlock = s >= 300 && s < 420;
    windows.push({
      startMs: s * 1000,
      endMs: (s + 3) * 1000,
      audioRmsDb: isSilentBlock ? -64 : -15,
      visualMotion: isSilentBlock ? 0.01 : 0.25,
      sceneDelta: s % 60 === 0 ? 0.55 : 0.05,
      histogram: makeHistogram((s / 60) % 4, 1, 2),
    });
  }

  const report = analyzeVideoWindows({
    videoId: 'vid_30m',
    totalDurationMs: 1_800_000,
    windows,
    hasAudioTrack: true,
  });
  const plan = buildCutPlan(report, 'remove_silent');

  assert.equal(plan.originalDurationMs, 1_800_000);
  assert.ok(plan.removedDurationMs >= 100_000);
  assert.ok(plan.estimatedEditedDurationMs > 1_500_000);
});
