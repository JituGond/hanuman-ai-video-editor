import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { CutPlan, TimelineSegment, VideoAnalysisReport } from '../types/aiCutting';
import { formatDuration } from '../utils/videoValidation';

interface VideoTimelineProps {
  analysis: VideoAnalysisReport;
  cutPlan: CutPlan;
  onPreviewSegment: (segment: TimelineSegment) => void;
  activeSegmentId?: string | null;
}

export function VideoTimeline({
  analysis,
  cutPlan,
  onPreviewSegment,
  activeSegmentId,
}: VideoTimelineProps) {
  const totalMs = Math.max(1, cutPlan.originalDurationMs);

  return (
    <View style={styles.container}>
      <View style={styles.summaryHeader}>
        <Text style={styles.title}>Video Timeline</Text>
        <Text style={styles.durationMeta}>
          Original {formatDuration(cutPlan.originalDurationMs)} → Edited{' '}
          {formatDuration(cutPlan.estimatedEditedDurationMs)}
        </Text>
      </View>

      <Text style={styles.analysisLine}>
        {analysis.detectedScenes.length} scenes · {analysis.silentSectionsCount} silent ·{' '}
        {analysis.pauseSectionsCount} pauses · {analysis.repeatedScenesCount} repeated ·{' '}
        {analysis.importantMomentsCount} key moments
      </Text>

      {/* Proportional visual bar */}
      <View style={styles.barContainer}>
        {cutPlan.segments.map((seg) => {
          const widthPct = Math.max(1.5, ((seg.endMs - seg.startMs) / totalMs) * 100);
          const isKeep = seg.action === 'keep';
          return (
            <Pressable
              key={seg.id}
              onPress={() => onPreviewSegment(seg)}
              style={[
                styles.barSlice,
                { width: `${widthPct}%` },
                isKeep ? styles.barSliceKeep : styles.barSliceRemove,
                activeSegmentId === seg.id && styles.barSliceActive,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${isKeep ? 'Keep' : 'Removed'} clip ${formatDuration(seg.startMs)} to ${formatDuration(seg.endMs)}`}
            />
          );
        })}
      </View>

      <View style={styles.legendRow}>
        <Text style={styles.legendText}>
          Selected clips ({cutPlan.keepSegments.length}) · Removed ({cutPlan.removedSegments.length})
        </Text>
        <Text style={styles.legendText}>
          Saved {formatDuration(cutPlan.removedDurationMs)}
        </Text>
      </View>

      <View style={styles.segmentList}>
        {cutPlan.segments.map((seg, idx) => {
          const isKeep = seg.action === 'keep';
          const isActive = activeSegmentId === seg.id;
          return (
            <Pressable
              key={seg.id}
              onPress={() => onPreviewSegment(seg)}
              style={[
                styles.segmentRow,
                isKeep ? styles.segmentKeep : styles.segmentRemove,
                isActive && styles.segmentActive,
              ]}
            >
              <Ionicons
                name={isKeep ? 'play-circle-outline' : 'cut-outline'}
                size={18}
                color={isKeep ? '#F97316' : '#71717A'}
              />
              <View style={styles.segmentBody}>
                <Text style={styles.segmentTitle} numberOfLines={1}>
                  {idx + 1}. {isKeep ? 'Selected Clip' : 'Removed Section'} ·{' '}
                  {formatDuration(seg.startMs)} – {formatDuration(seg.endMs)}
                </Text>
                <Text style={styles.segmentReason} numberOfLines={1}>
                  {seg.reason}
                </Text>
              </View>
              <Text style={styles.segmentDuration}>
                {formatDuration(seg.endMs - seg.startMs)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 14,
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#232834',
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#F4F4F5',
  },
  durationMeta: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: '#F97316',
    fontWeight: '600',
  },
  analysisLine: {
    marginTop: 6,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: '#9CA3AF',
  },
  barContainer: {
    marginTop: 12,
    height: 22,
    borderRadius: 8,
    backgroundColor: '#0B0D12',
    overflow: 'hidden',
    flexDirection: 'row',
    gap: 1,
    padding: 2,
    borderWidth: 1,
    borderColor: '#232834',
  },
  barSlice: {
    height: '100%',
    borderRadius: 4,
  },
  barSliceKeep: {
    backgroundColor: '#F97316',
  },
  barSliceRemove: {
    backgroundColor: '#272C38',
  },
  barSliceActive: {
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },
  legendRow: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  legendText: {
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    color: '#9CA3AF',
  },
  segmentList: {
    marginTop: 12,
    gap: 8,
  },
  segmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  segmentKeep: {
    backgroundColor: '#181C25',
    borderColor: '#2B3140',
  },
  segmentRemove: {
    backgroundColor: '#101319',
    borderColor: '#1D222D',
    opacity: 0.72,
  },
  segmentActive: {
    borderColor: '#F97316',
  },
  segmentBody: {
    flex: 1,
  },
  segmentTitle: {
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: '#F4F4F5',
  },
  segmentReason: {
    marginTop: 2,
    fontSize: 11,
    color: '#9CA3AF',
  },
  segmentDuration: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: '#A1A1AA',
  },
});
