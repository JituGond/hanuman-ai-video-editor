import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  GestureResponderEvent,
  Image,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AVPlaybackStatus, ResizeMode, Video } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import type { ImportedVideo } from '../types/video';
import {
  formatDuration,
  formatFileSize,
  getSourceLabel,
  MAX_VIDEO_DURATION_MS,
} from '../utils/videoValidation';

interface VideoPreviewPlayerProps {
  video: ImportedVideo | null;
  seekRequest?: { positionMs: number; nonce: number } | null;
  playerTitleLabel?: string;
  onDurationResolved: (videoId: string, durationMs: number) => void;
  onExceedsMaxDuration: (videoId: string, durationMs: number) => void;
}

export function VideoPreviewPlayer({
  video,
  seekRequest,
  playerTitleLabel,
  onDurationResolved,
  onExceedsMaxDuration,
}: VideoPreviewPlayerProps) {
  const videoRef = useRef<Video | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [trackWidth, setTrackWidth] = useState(1);
  const [playerError, setPlayerError] = useState<string | null>(null);

  useEffect(() => {
    setIsPlaying(false);
    setPositionMs(0);
    setDurationMs(video?.durationMs ?? 0);
    setPlayerError(null);
  }, [video?.id, video?.localUri, video?.durationMs]);

  useEffect(() => {
    if (!seekRequest || !videoRef.current || !video) return;
    (async () => {
      try {
        await videoRef.current?.setPositionAsync(Math.max(0, seekRequest.positionMs));
        await videoRef.current?.playAsync();
      } catch {
        // Ignore seek error if player is still initializing
      }
    })();
  }, [seekRequest, video]);

  const handlePlaybackStatusUpdate = (status: AVPlaybackStatus) => {
    if (!status.isLoaded) {
      if (status.error) {
        setPlayerError(`Playback error: ${status.error}`);
      }
      return;
    }

    setPlayerError(null);
    setIsPlaying(status.isPlaying);
    setIsBuffering(status.isBuffering);
    setPositionMs(status.positionMillis ?? 0);

    const resolvedDuration = status.durationMillis ?? 0;
    if (resolvedDuration > 0 && video) {
      setDurationMs(resolvedDuration);
      if (resolvedDuration > MAX_VIDEO_DURATION_MS) {
        void videoRef.current?.pauseAsync();
        onExceedsMaxDuration(video.id, resolvedDuration);
        return;
      }
      if (Math.abs(video.durationMs - resolvedDuration) > 1500) {
        onDurationResolved(video.id, resolvedDuration);
      }
    }

    if (status.didJustFinish) {
      setIsPlaying(false);
      void videoRef.current?.setPositionAsync(0);
    }
  };

  const handleTogglePlayPause = async () => {
    if (!videoRef.current || !video) {
      return;
    }
    try {
      if (isPlaying) {
        await videoRef.current.pauseAsync();
      } else {
        if (durationMs > 0 && positionMs >= durationMs - 250) {
          await videoRef.current.setPositionAsync(0);
        }
        await videoRef.current.playAsync();
      }
    } catch (error) {
      setPlayerError(error instanceof Error ? error.message : 'Unable to control playback.');
    }
  };

  const handleTrackLayout = (event: LayoutChangeEvent) => {
    const w = event.nativeEvent.layout.width;
    if (w > 0) {
      setTrackWidth(w);
    }
  };

  const handleSeekPress = async (event: GestureResponderEvent) => {
    if (!videoRef.current || durationMs <= 0 || trackWidth <= 0) {
      return;
    }
    const ratio = Math.max(0, Math.min(1, event.nativeEvent.locationX / trackWidth));
    const targetMs = Math.floor(ratio * durationMs);
    await videoRef.current.setPositionAsync(targetMs);
  };

  if (!video) {
    return (
      <View style={styles.emptyCard}>
        <Ionicons name="film-outline" size={34} color="#71717A" />
        <Text style={styles.emptyTitle}>No Video Selected</Text>
        <Text style={styles.emptyBody}>
          Select a video from Gallery, Screen Recordings, or File Manager below to preview it on this device.
        </Text>
      </View>
    );
  }

  const effectiveDuration = durationMs > 0 ? durationMs : video.durationMs;
  const progressPct =
    effectiveDuration > 0 ? Math.min(100, Math.max(0, (positionMs / effectiveDuration) * 100)) : 0;

  return (
    <View style={styles.container}>
      <View style={styles.videoFrame}>
        <Video
          ref={videoRef}
          source={{ uri: video.localUri }}
          style={styles.video}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay={false}
          progressUpdateIntervalMillis={200}
          onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
          onError={(err) => setPlayerError(typeof err === 'string' ? err : 'Cannot decode this video file.')}
        />

        {isBuffering && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#F97316" />
          </View>
        )}

        <Pressable
          onPress={handleTogglePlayPause}
          style={styles.centerTapOverlay}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'}
        >
          {!isPlaying && (
            <View style={styles.centerPlayBadge}>
              <Ionicons name="play" size={28} color="#FFFFFF" style={{ marginLeft: 3 }} />
            </View>
          )}
        </Pressable>
      </View>

      {playerError && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={16} color="#FCA5A5" />
          <Text style={styles.errorText}>{playerError}</Text>
        </View>
      )}

      <View style={styles.controlsRow}>
        <Pressable
          onPress={handleTogglePlayPause}
          style={({ pressed }) => [styles.playButton, pressed && styles.playButtonPressed]}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
        >
          <Ionicons name={isPlaying ? 'pause' : 'play'} size={20} color="#09090B" />
          <Text style={styles.playButtonText}>{isPlaying ? 'Pause' : 'Play'}</Text>
        </Pressable>

        <View style={styles.timelineWrap}>
          <Pressable
            onPress={handleSeekPress}
            onLayout={handleTrackLayout}
            style={styles.trackHitArea}
            accessibilityRole="adjustable"
            accessibilityLabel="Video timeline"
          >
            <View style={styles.trackBackground}>
              <View style={[styles.trackFill, { width: `${progressPct}%` }]} />
            </View>
          </Pressable>
          <View style={styles.timeRow}>
            <Text style={styles.timeText}>{formatDuration(positionMs)}</Text>
            <Text style={styles.timeText}>{formatDuration(effectiveDuration)}</Text>
          </View>
        </View>
      </View>

      <View style={styles.metadataBar}>
        {video.thumbnailUri ? (
          <Image source={{ uri: video.thumbnailUri }} style={styles.miniThumb} />
        ) : (
          <View style={[styles.miniThumb, styles.miniThumbFallback]}>
            <Ionicons name="videocam-outline" size={18} color="#A1A1AA" />
          </View>
        )}
        <View style={styles.metaTextCol}>
          <Text style={styles.videoTitle} numberOfLines={1}>
            {playerTitleLabel ? `${playerTitleLabel} · ${video.name}` : video.name}
          </Text>
          <Text style={styles.videoSubtext} numberOfLines={1}>
            {formatDuration(effectiveDuration)} · {getSourceLabel(video.source)} · {formatFileSize(video.fileSizeBytes)}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#14171E',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#232834',
    overflow: 'hidden',
  },
  emptyCard: {
    backgroundColor: '#14171E',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#232834',
    paddingVertical: 40,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    marginTop: 12,
    fontSize: 16,
    fontWeight: '700',
    color: '#F4F4F5',
  },
  emptyBody: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 19,
    color: '#A1A1AA',
    textAlign: 'center',
  },
  videoFrame: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#07080B',
    position: 'relative',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerTapOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerPlayBadge: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(15, 18, 24, 0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#3B1219',
  },
  errorText: {
    flex: 1,
    fontSize: 12,
    color: '#FECACA',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#232834',
  },
  playButton: {
    minWidth: 94,
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#F97316',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  playButtonPressed: {
    opacity: 0.85,
  },
  playButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#09090B',
  },
  timelineWrap: {
    flex: 1,
  },
  trackHitArea: {
    height: 28,
    justifyContent: 'center',
  },
  trackBackground: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#272C38',
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
    backgroundColor: '#F97316',
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  timeText: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: '#A1A1AA',
  },
  metadataBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#232834',
    backgroundColor: '#101319',
  },
  miniThumb: {
    width: 52,
    height: 36,
    borderRadius: 6,
    backgroundColor: '#1F2430',
  },
  miniThumbFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  metaTextCol: {
    flex: 1,
  },
  videoTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#F4F4F5',
  },
  videoSubtext: {
    marginTop: 2,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: '#9CA3AF',
  },
});
