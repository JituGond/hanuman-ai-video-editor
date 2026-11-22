import { Play, Scissors } from 'lucide-react';
import type {
  CutPlan,
  TimelineSegment,
  VideoAnalysisReport,
} from '../../expo-android/src/types/aiCutting';
import { formatDuration } from '../../expo-android/src/utils/videoValidation';

interface WebVideoTimelineProps {
  analysis: VideoAnalysisReport;
  cutPlan: CutPlan;
  activeSegmentId: string | null;
  onPreviewSegment: (segment: TimelineSegment) => void;
}

export function WebVideoTimeline({
  analysis,
  cutPlan,
  activeSegmentId,
  onPreviewSegment,
}: WebVideoTimelineProps) {
  const totalMs = Math.max(1, cutPlan.originalDurationMs);

  return (
    <div className="rounded-2xl border border-[#232834] bg-[#12151C] p-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h3 className="text-base font-semibold text-zinc-100">Video Timeline</h3>
        <p className="font-mono text-xs font-semibold text-orange-400 tabular-nums">
          Original {formatDuration(cutPlan.originalDurationMs)} → Edited{' '}
          {formatDuration(cutPlan.estimatedEditedDurationMs)} · Saved{' '}
          {formatDuration(cutPlan.removedDurationMs)}
        </p>
      </div>

      <p className="mt-1.5 font-mono text-xs text-zinc-400 tabular-nums">
        {analysis.detectedScenes.length} scenes · {analysis.silentSectionsCount} silent ·{' '}
        {analysis.pauseSectionsCount} pauses · {analysis.repeatedScenesCount} repeated ·{' '}
        {analysis.importantMomentsCount} key moments
      </p>

      {/* Proportional Interactive Timeline Track */}
      <div className="mt-4 flex h-8 w-full gap-0.5 overflow-hidden rounded-xl border border-[#232834] bg-[#0B0D12] p-1">
        {cutPlan.segments.map((seg) => {
          const widthPct = Math.max(1.5, ((seg.endMs - seg.startMs) / totalMs) * 100);
          const isKeep = seg.action === 'keep';
          const isActive = activeSegmentId === seg.id;
          return (
            <button
              key={seg.id}
              type="button"
              onClick={() => onPreviewSegment(seg)}
              style={{ width: `${widthPct}%` }}
              title={`${isKeep ? 'Keep' : 'Removed'}: ${formatDuration(seg.startMs)} – ${formatDuration(seg.endMs)} (${seg.reason})`}
              className={`h-full rounded transition-opacity focus-visible:outline-none ${
                isKeep
                  ? 'bg-orange-500 hover:bg-orange-400'
                  : 'bg-[#262B37] opacity-65 hover:opacity-95'
              } ${isActive ? 'ring-2 ring-white' : ''}`}
            />
          );
        })}
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-zinc-400 tabular-nums">
        <span>
          Selected clips ({cutPlan.keepSegments.length}) · Removed sections (
          {cutPlan.removedSegments.length})
        </span>
        <span>Tap any segment to preview</span>
      </div>

      {/* Segment Breakdown List */}
      <div className="mt-4 grid max-h-64 grid-cols-1 gap-2 overflow-y-auto pr-1 md:grid-cols-2">
        {cutPlan.segments.map((seg, idx) => {
          const isKeep = seg.action === 'keep';
          const isActive = activeSegmentId === seg.id;
          return (
            <button
              key={seg.id}
              type="button"
              onClick={() => onPreviewSegment(seg)}
              className={`flex min-h-[54px] items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${
                isActive
                  ? 'border-orange-500 bg-[#1B202C]'
                  : isKeep
                    ? 'border-[#2B3140] bg-[#161A23] hover:border-orange-500/60'
                    : 'border-[#1E222D] bg-[#0E1117] opacity-75 hover:opacity-100'
              }`}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  isKeep ? 'bg-orange-500/15 text-orange-400' : 'bg-[#1C2029] text-zinc-500'
                }`}
              >
                {isKeep ? <Play className="h-3.5 w-3.5" /> : <Scissors className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs font-semibold text-zinc-100 tabular-nums">
                  {idx + 1}. {isKeep ? 'Selected' : 'Removed'} · {formatDuration(seg.startMs)} –{' '}
                  {formatDuration(seg.endMs)}
                </span>
                <span className="mt-0.5 block truncate text-xs text-zinc-400">
                  {seg.reason}
                </span>
              </span>
              <span className="shrink-0 font-mono text-xs text-zinc-400 tabular-nums">
                {formatDuration(seg.endMs - seg.startMs)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
