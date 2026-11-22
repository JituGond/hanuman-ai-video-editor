import { useEffect, useMemo, useRef, useState } from 'react';
import { Film, Pause, Play } from 'lucide-react';
import {
  formatDuration,
  formatFileSize,
  getSourceLabel,
} from '../../expo-android/src/utils/videoValidation';
import type { VideoImportSource } from '../../expo-android/src/types/video';

export interface PlayableBrowserVideo {
  id: string;
  name: string;
  fileBlob: Blob;
  thumbnailDataUrl: string | null;
  durationMs: number;
  fileSizeBytes: number;
  source?: VideoImportSource;
  subtitleMeta?: string;
}

interface WebVideoPreviewPlayerProps {
  video: PlayableBrowserVideo | null;
  seekRequest?: { positionMs: number; nonce: number } | null;
  playRequest?: { nonce: number } | null;
  titlePrefix?: string;
}

export function WebVideoPreviewPlayer({
  video,
  seekRequest,
  playRequest,
  titlePrefix,
}: WebVideoPreviewPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const objectUrl = useMemo(() => {
    if (!video) return null;
    return URL.createObjectURL(video.fileBlob);
  }, [video]);

  useEffect(() => {
    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [objectUrl]);

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTimeMs(0);
    setDurationMs(video?.durationMs ?? 0);
    setPlaybackError(null);
  }, [video?.id, video?.durationMs]);

  useEffect(() => {
    const el = videoRef.current;
    if (!seekRequest || !el || !video) return;
    el.currentTime = Math.max(0, seekRequest.positionMs / 1000);
    setCurrentTimeMs(seekRequest.positionMs);
    void el.play().catch(() => {});
  }, [seekRequest, video]);

  useEffect(() => {
    const el = videoRef.current;
    if (!playRequest || !el || !video) return;
    el.currentTime = 0;
    setCurrentTimeMs(0);
    void el.play().catch((err) => {
      setPlaybackError(err instanceof Error ? err.message : 'Unable to start video playback.');
    });
  }, [playRequest, video]);

  const togglePlayPause = async () => {
    const el = videoRef.current;
    if (!el || !video) return;
    try {
      if (el.paused) {
        await el.play();
      } else {
        el.pause();
      }
    } catch (err) {
      setPlaybackError(err instanceof Error ? err.message : 'Unable to start video playback.');
    }
  };

  const handleSeek = (nextMs: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = nextMs / 1000;
    setCurrentTimeMs(nextMs);
  };

  if (!video || !objectUrl) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-[#232834] bg-[#12151C] px-6 py-20 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#1A1F29] text-zinc-400">
          <Film className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-zinc-100">
          No local video selected
        </h2>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-zinc-400">
          Import a video using Gallery Video, Screen Recording Video, or File Manager Video to inspect its thumbnail, duration, AI cutting, and playback on this device.
        </p>
      </div>
    );
  }

  const effectiveDurationMs = durationMs > 0 ? durationMs : video.durationMs;

  return (
    <div className="overflow-hidden rounded-2xl border border-[#232834] bg-[#12151C]">
      <div className="relative aspect-video w-full bg-[#060709]">
        <video
          ref={videoRef}
          src={objectUrl}
          playsInline
          onClick={togglePlayPause}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) {
              setDurationMs(Math.round(d * 1000));
            }
          }}
          onTimeUpdate={(e) => {
            setCurrentTimeMs(Math.round(e.currentTarget.currentTime * 1000));
          }}
          onError={() => setPlaybackError('Could not play this video stream locally.')}
          className="h-full w-full cursor-pointer object-contain"
        />

        {!isPlaying && (
          <button
            type="button"
            onClick={togglePlayPause}
            aria-label="Play video"
            className="absolute inset-0 flex items-center justify-center bg-black/25 transition-opacity hover:bg-black/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full border border-white/25 bg-zinc-950/80 text-white transition-transform hover:scale-105">
              <Play className="ml-0.5 h-6 w-6 fill-current" />
            </span>
          </button>
        )}
      </div>

      {playbackError && (
        <div className="border-t border-red-900/60 bg-red-950/50 px-4 py-2.5 text-xs text-red-200">
          {playbackError}
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-[#232834] p-4 sm:flex-row sm:items-center sm:gap-4">
        <button
          type="button"
          onClick={togglePlayPause}
          className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-xl bg-orange-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-orange-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 whitespace-nowrap"
        >
          {isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
          <span>{isPlaying ? 'Pause' : 'Play'}</span>
        </button>

        <div className="flex flex-1 flex-col gap-1.5">
          <input
            type="range"
            min={0}
            max={Math.max(1, effectiveDurationMs)}
            value={Math.min(currentTimeMs, effectiveDurationMs)}
            onChange={(e) => handleSeek(Number(e.target.value))}
            aria-label="Seek video position"
            className="h-2 w-full cursor-pointer appearance-none rounded-full bg-[#252B37] accent-orange-500"
          />
          <div className="flex items-center justify-between font-mono text-xs text-zinc-400 tabular-nums">
            <span>{formatDuration(currentTimeMs)}</span>
            <span>{formatDuration(effectiveDurationMs)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-[#232834] bg-[#0E1117] px-4 py-3">
        {video.thumbnailDataUrl ? (
          <img
            src={video.thumbnailDataUrl}
            alt={`Thumbnail of ${video.name}`}
            referrerPolicy="no-referrer"
            className="h-11 w-16 shrink-0 rounded-lg border border-[#252B37] object-cover"
          />
        ) : (
          <div className="flex h-11 w-16 shrink-0 items-center justify-center rounded-lg border border-[#252B37] bg-[#171B24] text-zinc-500">
            <Film className="h-4 w-4" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-100">
            {titlePrefix ? `${titlePrefix} · ${video.name}` : video.name}
          </p>
          <p className="mt-0.5 truncate font-mono text-xs text-zinc-400 tabular-nums">
            {video.subtitleMeta
              ? video.subtitleMeta
              : `${formatDuration(effectiveDurationMs)} · ${
                  video.source ? getSourceLabel(video.source) : 'Edited Output'
                } · ${formatFileSize(video.fileSizeBytes)}`}
          </p>
        </div>
      </div>
    </div>
  );
}
