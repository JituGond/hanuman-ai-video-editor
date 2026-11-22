import { Download } from 'lucide-react';
import { getPresetLabel } from '../../expo-android/src/utils/aiCuttingEngine';
import { getEditingStyleLabel } from '../../expo-android/src/utils/aiFullEditorEngine';
import { formatDuration, formatFileSize } from '../../expo-android/src/utils/videoValidation';
import type {
  LocalBrowserVideo,
  LocalEditedBrowserVideo,
  LocalExportedBrowserVideo,
  LocalFullEditedBrowserVideo,
} from '../utils/localBrowserVideoDb';
import { WebVideoPreviewPlayer } from './WebVideoPreviewPlayer';

export type PreviewComparisonMode = 'original' | 'cut' | 'full_edited' | 'exported' | 'compare';

interface WebComparisonPlayerProps {
  originalVideo: LocalBrowserVideo | null;
  cutVideo: LocalEditedBrowserVideo | null;
  fullEditedVideo: LocalFullEditedBrowserVideo | null;
  exportedVideo: LocalExportedBrowserVideo | null;
  mode: PreviewComparisonMode;
  onModeChange: (mode: PreviewComparisonMode) => void;
  seekRequest: { positionMs: number; nonce: number } | null;
  playRequest?: { nonce: number } | null;
}

export function WebComparisonPlayer({
  originalVideo,
  cutVideo,
  fullEditedVideo,
  exportedVideo,
  mode,
  onModeChange,
  seekRequest,
  playRequest,
}: WebComparisonPlayerProps) {
  const activeOutput =
    mode === 'exported' && exportedVideo
      ? exportedVideo
      : mode === 'cut' && cutVideo
        ? cutVideo
        : fullEditedVideo ?? cutVideo ?? exportedVideo;

  const handleDownloadOutput = () => {
    if (!activeOutput) return;
    const url = URL.createObjectURL(activeOutput.fileBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeOutput.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!originalVideo) {
    return <WebVideoPreviewPlayer video={null} />;
  }

  const hasAnyEdited = Boolean(cutVideo || fullEditedVideo || exportedVideo);

  return (
    <div className="space-y-3">
      {hasAnyEdited && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#232834] bg-[#12151C] p-2">
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => onModeChange('original')}
              className={`min-h-[38px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                mode === 'original'
                  ? 'bg-orange-500 text-zinc-950'
                  : 'text-zinc-300 hover:bg-[#1B202A]'
              }`}
            >
              Original ({formatDuration(originalVideo.durationMs)})
            </button>
            {cutVideo && (
              <button
                type="button"
                onClick={() => onModeChange('cut')}
                className={`min-h-[38px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  mode === 'cut'
                    ? 'bg-orange-500 text-zinc-950'
                    : 'text-zinc-300 hover:bg-[#1B202A]'
                }`}
              >
                AI Cut ({formatDuration(cutVideo.durationMs)})
              </button>
            )}
            {fullEditedVideo && (
              <button
                type="button"
                onClick={() => onModeChange('full_edited')}
                className={`min-h-[38px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  mode === 'full_edited'
                    ? 'bg-orange-500 text-zinc-950'
                    : 'text-zinc-300 hover:bg-[#1B202A]'
                }`}
              >
                Full AI Edit ({formatDuration(fullEditedVideo.durationMs)})
              </button>
            )}
            {exportedVideo && (
              <button
                type="button"
                onClick={() => onModeChange('exported')}
                className={`min-h-[38px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  mode === 'exported'
                    ? 'bg-orange-500 text-zinc-950'
                    : 'text-zinc-300 hover:bg-[#1B202A]'
                }`}
              >
                MP4 ({exportedVideo.height}p · {exportedVideo.fps}fps)
              </button>
            )}
            {activeOutput && (
              <button
                type="button"
                onClick={() => onModeChange('compare')}
                className={`min-h-[38px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  mode === 'compare'
                    ? 'bg-orange-500 text-zinc-950'
                    : 'text-zinc-300 hover:bg-[#1B202A]'
                }`}
              >
                Compare Side-by-Side
              </button>
            )}
          </div>

          {activeOutput && (
            <button
              type="button"
              onClick={handleDownloadOutput}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-[#2B3140] bg-[#181C25] px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-orange-500/60 hover:text-white whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Save {mode === 'exported' ? 'MP4' : 'Copy'}</span>
            </button>
          )}
        </div>
      )}

      {mode === 'compare' && activeOutput ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <WebVideoPreviewPlayer
            video={originalVideo}
            seekRequest={seekRequest}
            titlePrefix="Original"
          />
          <WebVideoPreviewPlayer
            video={{
              id: activeOutput.id,
              name: activeOutput.name,
              fileBlob: activeOutput.fileBlob,
              thumbnailDataUrl: activeOutput.thumbnailDataUrl,
              durationMs: activeOutput.durationMs,
              fileSizeBytes: activeOutput.fileSizeBytes,
              subtitleMeta:
                'editPlan' in activeOutput
                  ? `${formatDuration(activeOutput.durationMs)} · ${getEditingStyleLabel(
                      activeOutput.editPlan.resolvedStyle
                    )} · ${formatFileSize(activeOutput.fileSizeBytes)}`
                  : 'preset' in activeOutput
                    ? `${formatDuration(activeOutput.durationMs)} · ${getPresetLabel(
                        activeOutput.preset
                      )} · ${formatFileSize(activeOutput.fileSizeBytes)}`
                    : `${formatDuration(activeOutput.durationMs)} · ${activeOutput.width}x${activeOutput.height} · ${activeOutput.fps}fps · ${formatFileSize(activeOutput.fileSizeBytes)}`,
            }}
            titlePrefix={
              'editPlan' in activeOutput
                ? 'Full AI Edit'
                : 'preset' in activeOutput
                  ? 'AI Cut'
                  : 'Exported MP4'
            }
          />
        </div>
      ) : mode === 'exported' && exportedVideo ? (
        <WebVideoPreviewPlayer
          video={{
            id: exportedVideo.id,
            name: exportedVideo.name,
            fileBlob: exportedVideo.fileBlob,
            thumbnailDataUrl: exportedVideo.thumbnailDataUrl,
            durationMs: exportedVideo.durationMs,
            fileSizeBytes: exportedVideo.fileSizeBytes,
            subtitleMeta: `${formatDuration(exportedVideo.durationMs)} · ${exportedVideo.width}x${exportedVideo.height} · ${exportedVideo.fps}fps · ${exportedVideo.codec.toUpperCase()} · ${formatFileSize(exportedVideo.fileSizeBytes)}`,
          }}
          playRequest={playRequest}
          titlePrefix="Exported MP4"
        />
      ) : mode === 'full_edited' && fullEditedVideo ? (
        <WebVideoPreviewPlayer
          video={{
            id: fullEditedVideo.id,
            name: fullEditedVideo.name,
            fileBlob: fullEditedVideo.fileBlob,
            thumbnailDataUrl: fullEditedVideo.thumbnailDataUrl,
            durationMs: fullEditedVideo.durationMs,
            fileSizeBytes: fullEditedVideo.fileSizeBytes,
            subtitleMeta: `${formatDuration(
              fullEditedVideo.durationMs
            )} · ${getEditingStyleLabel(
              fullEditedVideo.editPlan.resolvedStyle
            )} · ${formatFileSize(fullEditedVideo.fileSizeBytes)}`,
          }}
          titlePrefix="Full AI Edit"
        />
      ) : mode === 'cut' && cutVideo ? (
        <WebVideoPreviewPlayer
          video={{
            id: cutVideo.id,
            name: cutVideo.name,
            fileBlob: cutVideo.fileBlob,
            thumbnailDataUrl: cutVideo.thumbnailDataUrl,
            durationMs: cutVideo.durationMs,
            fileSizeBytes: cutVideo.fileSizeBytes,
            subtitleMeta: `${formatDuration(cutVideo.durationMs)} · ${getPresetLabel(
              cutVideo.preset
            )} · ${formatFileSize(cutVideo.fileSizeBytes)}`,
          }}
          titlePrefix="AI Cut"
        />
      ) : (
        <WebVideoPreviewPlayer
          video={originalVideo}
          seekRequest={seekRequest}
          titlePrefix={hasAnyEdited ? 'Original' : undefined}
        />
      )}
    </div>
  );
}
