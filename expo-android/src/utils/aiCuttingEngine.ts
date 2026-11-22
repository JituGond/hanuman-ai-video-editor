import type {
  AnalysisWindow,
  CutPlan,
  CuttingPreset,
  DetectedScene,
  SegmentCategory,
  TimelineSegment,
  VideoAnalysisReport,
} from '../types/aiCutting';

const MIN_KEEP_SEGMENT_MS = 800;
const BOUNDARY_BREATH_PADDING_MS = 160;
const SCENE_CUT_THRESHOLD = 0.34;
const REPEAT_SIMILARITY_THRESHOLD = 0.965;

/**
 * Cosine similarity between two normalized histograms (0.0 to 1.0).
 */
export function computeHistogramSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA <= 0 || magB <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, dot / (Math.sqrt(magA) * Math.sqrt(magB))));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function averageHistograms(histograms: number[][]): number[] {
  const valid = histograms.filter((h) => h.length > 0);
  if (valid.length === 0) return [];
  const length = valid[0].length;
  const sums = new Array<number>(length).fill(0);
  for (const hist of valid) {
    for (let i = 0; i < length; i += 1) {
      sums[i] += hist[i] ?? 0;
    }
  }
  return sums.map((v) => v / valid.length);
}

/**
 * Analyzes sampled audio + visual windows across the full video to detect scenes,
 * silent sections, unnecessary pauses, repeated scenes, and important moments.
 */
export function analyzeVideoWindows(params: {
  videoId: string;
  totalDurationMs: number;
  windows: AnalysisWindow[];
  hasAudioTrack: boolean;
}): VideoAnalysisReport {
  const { videoId, totalDurationMs, windows, hasAudioTrack } = params;

  if (windows.length === 0 || totalDurationMs <= 0) {
    return {
      videoId,
      totalDurationMs: Math.max(0, totalDurationMs),
      windowsAnalyzed: 0,
      hasAudioTrack,
      noiseFloorDb: -60,
      detectedScenes: [],
      silentSectionsCount: 0,
      pauseSectionsCount: 0,
      repeatedScenesCount: 0,
      importantMomentsCount: 0,
      analyzedAt: Date.now(),
    };
  }

  // Adaptive noise floor from the 15th percentile of audio RMS dB
  const sortedDb = windows.map((w) => w.audioRmsDb).sort((a, b) => a - b);
  const p15Index = Math.min(sortedDb.length - 1, Math.floor(sortedDb.length * 0.15));
  const p85Index = Math.min(sortedDb.length - 1, Math.floor(sortedDb.length * 0.85));
  const noiseFloorDb = sortedDb[p15Index];
  const peakRefDb = Math.max(noiseFloorDb + 6, sortedDb[p85Index]);
  const silenceThresholdDb = Math.min(-34, Math.max(-58, noiseFloorDb + 4.5));

  // Group contiguous windows into candidate scenes based on visual scene boundaries
  // or sharp audio state transitions (speech <-> silence).
  const sceneGroups: AnalysisWindow[][] = [];
  let currentGroup: AnalysisWindow[] = [];

  for (let i = 0; i < windows.length; i += 1) {
    const win = windows[i];
    if (currentGroup.length === 0) {
      currentGroup.push(win);
      continue;
    }

    const prev = currentGroup[currentGroup.length - 1];
    const groupDuration = win.endMs - currentGroup[0].startMs;
    const prevSilent = hasAudioTrack ? prev.audioRmsDb <= silenceThresholdDb : prev.visualMotion < 0.03;
    const currSilent = hasAudioTrack ? win.audioRmsDb <= silenceThresholdDb : win.visualMotion < 0.03;
    const audioTransition = prevSilent !== currSilent && groupDuration >= 900;
    const visualCut = win.sceneDelta >= SCENE_CUT_THRESHOLD && groupDuration >= 900;
    const maxChunkReached = groupDuration >= 15000;

    if (visualCut || audioTransition || maxChunkReached) {
      sceneGroups.push(currentGroup);
      currentGroup = [win];
    } else {
      currentGroup.push(win);
    }
  }

  if (currentGroup.length > 0) {
    sceneGroups.push(currentGroup);
  }

  const sceneDescriptors: Array<{
    scene: DetectedScene;
    avgHistogram: number[];
  }> = [];

  let silentSectionsCount = 0;
  let pauseSectionsCount = 0;
  let repeatedScenesCount = 0;
  let importantMomentsCount = 0;

  for (let idx = 0; idx < sceneGroups.length; idx += 1) {
    const group = sceneGroups[idx];
    const startMs = group[0].startMs;
    const endMs = Math.min(totalDurationMs, group[group.length - 1].endMs);
    const durationMs = endMs - startMs;

    const avgAudioDb =
      group.reduce((sum, w) => sum + w.audioRmsDb, 0) / group.length;
    const avgMotion =
      group.reduce((sum, w) => sum + w.visualMotion, 0) / group.length;
    const maxSceneDelta = Math.max(...group.map((w) => w.sceneDelta));
    const avgHistogram = averageHistograms(group.map((w) => w.histogram));

    const audioNormalized = hasAudioTrack
      ? clamp01((avgAudioDb - noiseFloorDb) / Math.max(8, peakRefDb - noiseFloorDb))
      : 0.35;
    const motionNormalized = clamp01(avgMotion * 3.2);
    const cutBonus = clamp01(maxSceneDelta) * 0.2;

    const isSilent = hasAudioTrack
      ? avgAudioDb <= silenceThresholdDb && durationMs >= 1000
      : avgMotion < 0.025 && durationMs >= 1600;

    const isPause =
      !isSilent &&
      hasAudioTrack &&
      avgAudioDb <= silenceThresholdDb + 4 &&
      avgMotion < 0.06 &&
      durationMs >= 800 &&
      durationMs <= 3500;

    const isStatic = avgMotion < 0.035 && (!hasAudioTrack || avgAudioDb <= silenceThresholdDb + 5);

    // Check against earlier non-adjacent scenes for repeated takes / duplicate static shots
    let isRepeated = false;
    if (idx >= 2 && avgHistogram.length > 0 && avgMotion < 0.14) {
      for (let prevIdx = 0; prevIdx < idx - 1; prevIdx += 1) {
        const earlier = sceneDescriptors[prevIdx];
        const similarity = computeHistogramSimilarity(avgHistogram, earlier.avgHistogram);
        if (similarity >= REPEAT_SIMILARITY_THRESHOLD && Math.abs(avgMotion - earlier.scene.avgMotion) < 0.05) {
          isRepeated = true;
          break;
        }
      }
    }

    const importanceScore = clamp01(
      (hasAudioTrack ? audioNormalized * 0.55 + motionNormalized * 0.3 : motionNormalized * 0.8) +
        cutBonus
    );

    let reason = 'Active scene with speech or visual movement';
    if (isRepeated) {
      repeatedScenesCount += 1;
      reason = 'Repeated scene matching an earlier take';
    } else if (isSilent) {
      silentSectionsCount += 1;
      reason = 'Sustained silent section with minimal audio energy';
    } else if (isPause) {
      pauseSectionsCount += 1;
      reason = 'Unnecessary pause between active segments';
    } else if (importanceScore >= 0.6) {
      importantMomentsCount += 1;
      reason = 'High-energy key moment (audio + visual activity)';
    } else if (isStatic) {
      reason = 'Low-motion static section';
    }

    sceneDescriptors.push({
      avgHistogram,
      scene: {
        id: `scene_${idx + 1}`,
        startMs,
        endMs,
        avgAudioDb,
        avgMotion,
        isSilent,
        isPause,
        isRepeated,
        isStatic,
        importanceScore,
        reason,
      },
    });
  }

  return {
    videoId,
    totalDurationMs,
    windowsAnalyzed: windows.length,
    hasAudioTrack,
    noiseFloorDb,
    detectedScenes: sceneDescriptors.map((d) => d.scene),
    silentSectionsCount,
    pauseSectionsCount,
    repeatedScenesCount,
    importantMomentsCount,
    analyzedAt: Date.now(),
  };
}

function classifyForPreset(
  scene: DetectedScene,
  preset: CuttingPreset,
  medianImportance: number
): { action: 'keep' | 'remove'; category: SegmentCategory; reason: string } {
  switch (preset) {
    case 'preserve_original':
      return {
        action: 'keep',
        category: 'preserved',
        reason: 'Original video preserved without removing clips',
      };

    case 'remove_silent':
      if (scene.isSilent || scene.isPause) {
        return {
          action: 'remove',
          category: scene.isSilent ? 'silent' : 'pause',
          reason: scene.isSilent ? 'Silent section removed' : 'Unnecessary pause removed',
        };
      }
      return {
        action: 'keep',
        category: scene.importanceScore >= 0.6 ? 'important' : 'speech_action',
        reason: scene.reason,
      };

    case 'remove_unwanted_scenes':
      if (scene.isRepeated) {
        return { action: 'remove', category: 'repeated', reason: 'Repeated scene removed' };
      }
      if (scene.isStatic || scene.isSilent) {
        return { action: 'remove', category: 'boring', reason: 'Static / low-activity scene removed' };
      }
      return {
        action: 'keep',
        category: 'scene',
        reason: scene.reason,
      };

    case 'smart_scene_detection':
      if (scene.isRepeated) {
        return { action: 'remove', category: 'repeated', reason: 'Duplicate scene skipped' };
      }
      if (scene.isSilent && scene.endMs - scene.startMs >= 1500) {
        return { action: 'remove', category: 'silent', reason: 'Dead air between scenes removed' };
      }
      if (scene.importanceScore < Math.max(0.22, medianImportance * 0.55) && scene.isStatic) {
        return { action: 'remove', category: 'boring', reason: 'Low-impact transition scene removed' };
      }
      return {
        action: 'keep',
        category: 'scene',
        reason: `Scene retained (${Math.round(scene.importanceScore * 100)}% activity)`,
      };

    case 'keep_important_moments':
      if (
        !scene.isSilent &&
        !scene.isPause &&
        !scene.isRepeated &&
        scene.importanceScore >= Math.max(0.42, medianImportance)
      ) {
        return {
          action: 'keep',
          category: 'important',
          reason: `Important moment (${Math.round(scene.importanceScore * 100)}% score)`,
        };
      }
      return {
        action: 'remove',
        category: scene.isSilent ? 'silent' : scene.isRepeated ? 'repeated' : 'boring',
        reason: 'Lower-priority filler cut for highlight reel',
      };

    case 'ai_auto_cut':
    default:
      if (scene.isRepeated) {
        return { action: 'remove', category: 'repeated', reason: 'Repeated section removed' };
      }
      if (scene.isSilent) {
        return { action: 'remove', category: 'silent', reason: 'Silent section removed' };
      }
      if (scene.isPause) {
        return { action: 'remove', category: 'pause', reason: 'Unwanted pause removed' };
      }
      if (scene.isStatic && scene.importanceScore < 0.28) {
        return { action: 'remove', category: 'boring', reason: 'Boring static stretch removed' };
      }
      return {
        action: 'keep',
        category: scene.importanceScore >= 0.6 ? 'important' : 'speech_action',
        reason: scene.reason,
      };
  }
}

/**
 * Generates an ordered CutPlan from a VideoAnalysisReport and selected CuttingPreset.
 * Maintains strict chronological scene order, adds natural breathing margins, merges
 * adjacent kept segments, and guarantees at least one valid kept segment.
 */
export function buildCutPlan(
  report: VideoAnalysisReport,
  preset: CuttingPreset
): CutPlan {
  const { totalDurationMs, detectedScenes } = report;

  if (totalDurationMs <= 0) {
    return {
      preset,
      originalDurationMs: 0,
      estimatedEditedDurationMs: 0,
      removedDurationMs: 0,
      segments: [],
      keepSegments: [],
      removedSegments: [],
    };
  }

  if (preset === 'preserve_original' || detectedScenes.length === 0) {
    const fullSegment: TimelineSegment = {
      id: 'seg_1',
      startMs: 0,
      endMs: totalDurationMs,
      action: 'keep',
      category: 'preserved',
      reason: 'Full original video preserved',
      importanceScore: 1,
    };
    return {
      preset,
      originalDurationMs: totalDurationMs,
      estimatedEditedDurationMs: totalDurationMs,
      removedDurationMs: 0,
      segments: [fullSegment],
      keepSegments: [fullSegment],
      removedSegments: [],
    };
  }

  const sortedScores = detectedScenes.map((s) => s.importanceScore).sort((a, b) => a - b);
  const medianImportance = sortedScores[Math.floor(sortedScores.length / 2)] ?? 0.4;

  const rawDecisions: TimelineSegment[] = detectedScenes.map((scene, index) => {
    const classified = classifyForPreset(scene, preset, medianImportance);
    return {
      id: `seg_${index + 1}`,
      startMs: scene.startMs,
      endMs: scene.endMs,
      action: classified.action,
      category: classified.category,
      reason: classified.reason,
      importanceScore: scene.importanceScore,
    };
  });

  // Safety guarantee: if all scenes were marked remove (e.g. a silent screen recording),
  // keep the highest-scoring segment(s) so output is never empty.
  if (!rawDecisions.some((seg) => seg.action === 'keep')) {
    let bestIndex = 0;
    for (let i = 1; i < rawDecisions.length; i += 1) {
      if (rawDecisions[i].importanceScore > rawDecisions[bestIndex].importanceScore) {
        bestIndex = i;
      }
    }
    rawDecisions[bestIndex] = {
      ...rawDecisions[bestIndex],
      action: 'keep',
      category: 'important',
      reason: 'Best available segment preserved',
    };
  }

  // Merge adjacent segments of the same action and enforce minimum clip length
  const merged: TimelineSegment[] = [];
  for (const seg of rawDecisions) {
    const prev = merged[merged.length - 1];
    if (prev && prev.action === seg.action) {
      prev.endMs = seg.endMs;
      prev.importanceScore = Math.max(prev.importanceScore, seg.importanceScore);
    } else {
      merged.push({ ...seg });
    }
  }

  // Apply natural breathing margin around kept segments so speech/audio never clips abruptly
  for (let i = 0; i < merged.length; i += 1) {
    const seg = merged[i];
    if (seg.action === 'keep') {
      const prev = merged[i - 1];
      const next = merged[i + 1];
      if (prev && prev.action === 'remove' && prev.endMs - prev.startMs > BOUNDARY_BREATH_PADDING_MS * 2) {
        seg.startMs = Math.max(0, seg.startMs - BOUNDARY_BREATH_PADDING_MS);
        prev.endMs = seg.startMs;
      }
      if (next && next.action === 'remove' && next.endMs - next.startMs > BOUNDARY_BREATH_PADDING_MS * 2) {
        seg.endMs = Math.min(totalDurationMs, seg.endMs + BOUNDARY_BREATH_PADDING_MS);
        next.startMs = seg.endMs;
      }
    }
  }

  // Filter out micro-segments shorter than MIN_KEEP_SEGMENT_MS by absorbing small removals
  const normalized: TimelineSegment[] = [];
  for (const seg of merged) {
    const duration = seg.endMs - seg.startMs;
    if (duration <= 0) continue;

    if (seg.action === 'remove' && duration < MIN_KEEP_SEGMENT_MS && normalized.length > 0) {
      normalized[normalized.length - 1].endMs = seg.endMs;
      continue;
    }

    const prev = normalized[normalized.length - 1];
    if (prev && prev.action === seg.action) {
      prev.endMs = seg.endMs;
    } else {
      normalized.push({ ...seg, id: `clip_${normalized.length + 1}` });
    }
  }

  const keepSegments = normalized.filter((s) => s.action === 'keep');
  const removedSegments = normalized.filter((s) => s.action === 'remove');

  const estimatedEditedDurationMs = keepSegments.reduce(
    (sum, s) => sum + (s.endMs - s.startMs),
    0
  );
  const removedDurationMs = Math.max(0, totalDurationMs - estimatedEditedDurationMs);

  return {
    preset,
    originalDurationMs: totalDurationMs,
    estimatedEditedDurationMs,
    removedDurationMs,
    segments: normalized,
    keepSegments,
    removedSegments,
  };
}

export function getPresetLabel(preset: CuttingPreset): string {
  switch (preset) {
    case 'ai_auto_cut':
      return 'AI Auto Cut';
    case 'remove_silent':
      return 'Remove Silent Parts';
    case 'remove_unwanted_scenes':
      return 'Remove Unwanted Scenes';
    case 'smart_scene_detection':
      return 'Smart Scene Detection';
    case 'keep_important_moments':
      return 'Keep Important Moments';
    case 'preserve_original':
      return 'Original Video Preservation';
  }
}
