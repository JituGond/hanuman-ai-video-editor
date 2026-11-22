import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { ScreenRecordingPickerModal } from './src/components/ScreenRecordingPickerModal';
import { VideoPreviewPlayer } from './src/components/VideoPreviewPlayer';
import { VideoTimeline } from './src/components/VideoTimeline';
import {
  executeFullAiEditingOnAndroid,
  loadFullEditedLibrary,
  pickLocalBackgroundMusicOnAndroid,
  removeFullEditedVideoRecord,
} from './src/services/aiFullEditingService';
import {
  analyzeVideoLocallyOnAndroid,
  cancelActiveAndroidCut,
  generateEditedVideoOnAndroid,
  isAndroidNativeCuttingReady,
  loadEditedVideosLibrary,
  removeEditedVideoRecord,
} from './src/services/aiVideoCuttingService';
import { openAndroidAppSettings } from './src/services/androidPermissions';
import {
  loadLocalVideoLibrary,
  removeLocalVideo,
  updateStoredVideoDuration,
} from './src/services/localVideoStorage';
import {
  importFileManagerVideo,
  importGalleryVideo,
  importScreenRecordingAsset,
  loadDeviceScreenRecordings,
} from './src/services/videoImporters';
import {
  CUTTING_PRESET_OPTIONS,
  type CuttingPreset,
  type EditedVideoRecord,
  type TimelineSegment,
  type VideoAnalysisReport,
} from './src/types/aiCutting';
import {
  DEFAULT_AUDIO_EDIT_OPTIONS,
  DEFAULT_ENHANCEMENT_TOGGLES,
  EDITING_STYLE_OPTIONS,
  type AudioEditOptions,
  type EditingStyleSelection,
  type FullEditedVideoRecord,
  type VideoEnhancementToggles,
} from './src/types/aiEditing';
import type {
  ImportedVideo,
  ScreenRecordingCandidate,
  VideoImportSource,
} from './src/types/video';
import { buildCutPlan, getPresetLabel } from './src/utils/aiCuttingEngine';
import { getEditingStyleLabel } from './src/utils/aiFullEditorEngine';
import {
  executeVideoExportOnAndroid,
  inspectVideoExportCapabilitiesOnAndroid,
  loadExportedVideosLibrary,
  openExportedInAndroidGallery,
  playExportedInAndroidSystemPlayer,
  removeExportedVideoRecord,
  saveExportedRecordToGalleryOnAndroid,
} from './src/services/videoExportService';
import type { NativeExportCapabilitiesResponse } from './modules/hanuman-video-cutter';
import type {
  ExportConfiguration,
  ExportedVideoRecord,
  ExportFps,
} from './src/types/videoExport';
import {
  COMPRESSION_PRESETS,
  RESOLUTION_SPECS,
} from './src/types/videoExport';
import {
  computeSmartExportSummary,
  getCodecLabel,
  getCompressionLabel,
} from './src/utils/exportCalculator';
import {
  formatDuration,
  formatFileSize,
  getSourceLabel,
} from './src/utils/videoValidation';

function HanumanImportModuleScreen() {
  const [library, setLibrary] = useState<ImportedVideo[]>([]);
  const [editedLibrary, setEditedLibrary] = useState<EditedVideoRecord[]>([]);
  const [fullEditedLibrary, setFullEditedLibrary] = useState<FullEditedVideoRecord[]>([]);
  const [exportedLibrary, setExportedLibrary] = useState<ExportedVideoRecord[]>([]);

  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<'original' | 'cut' | 'full_edited' | 'exported'>(
    'original'
  );
  const [selectedExportedId, setSelectedExportedId] = useState<string | null>(null);

  // Step 2 states
  const [selectedPreset, setSelectedPreset] = useState<CuttingPreset>('ai_auto_cut');

  // Step 3 states
  const [styleSelection, setStyleSelection] = useState<EditingStyleSelection>('auto_select');
  const [enhancements, setEnhancements] = useState<VideoEnhancementToggles>(
    DEFAULT_ENHANCEMENT_TOGGLES
  );
  const [audioOptions, setAudioOptions] = useState<AudioEditOptions>(DEFAULT_AUDIO_EDIT_OPTIONS);

  // Step 4 states
  const [exportSourceTarget, setExportSourceTarget] = useState<'full_edited' | 'cut' | 'original'>(
    'full_edited'
  );
  const [exportConfig, setExportConfig] = useState<ExportConfiguration>({
    resolution: '1080p',
    fps: 30,
    codec: 'h264',
    compression: 'high',
  });
  const [exportCapabilities, setExportCapabilities] =
    useState<NativeExportCapabilitiesResponse | null>(null);

  const [analysisByVideoId, setAnalysisByVideoId] = useState<Record<string, VideoAnalysisReport>>({});
  const [processingState, setProcessingState] = useState<{
    active: boolean;
    progress: number;
    stage: string;
  }>({ active: false, progress: 0, stage: '' });

  const [seekRequest, setSeekRequest] = useState<{ positionMs: number; nonce: number } | null>(null);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);

  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [importingSource, setImportingSource] = useState<VideoImportSource | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [needsSettingsLink, setNeedsSettingsLink] = useState(false);

  // Step 5: Verified Gallery save notification state & double-tap mutex
  const [savedGalleryNotice, setSavedGalleryNotice] = useState<{
    record: ExportedVideoRecord;
    alreadySaved: boolean;
    deduplicatedExport: boolean;
  } | null>(null);
  const [savingToGalleryId, setSavingToGalleryId] = useState<string | null>(null);
  const exportMutexRef = useRef(false);

  const [srModalVisible, setSrModalVisible] = useState(false);
  const [srLoading, setSrLoading] = useState(false);
  const [screenRecordings, setScreenRecordings] = useState<ScreenRecordingCandidate[]>([]);
  const [allDeviceVideos, setAllDeviceVideos] = useState<ScreenRecordingCandidate[]>([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [items, cutItems, fullItems, expItems] = await Promise.all([
          loadLocalVideoLibrary(),
          loadEditedVideosLibrary(),
          loadFullEditedLibrary(),
          loadExportedVideosLibrary(),
        ]);
        if (!active) return;
        setLibrary(items);
        setEditedLibrary(cutItems);
        setFullEditedLibrary(fullItems);
        setExportedLibrary(expItems);
        if (items.length > 0) {
          setSelectedVideoId(items[0].id);
        }
      } finally {
        if (active) setLoadingLibrary(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const selectedOriginalVideo = library.find((v) => v.id === selectedVideoId) ?? null;
  const activeCutRecord =
    editedLibrary.find((e) => e.sourceVideoId === selectedVideoId) ?? null;
  const activeFullRecord =
    fullEditedLibrary.find((e) => e.sourceVideoId === selectedVideoId) ?? null;
  const activeExportedRecord =
    exportedLibrary.find((e) => e.id === selectedExportedId) ??
    exportedLibrary.find((e) => e.sourceVideoId === selectedVideoId) ??
    null;

  const resolvedExportTarget =
    exportSourceTarget === 'full_edited' && activeFullRecord
      ? {
          id: activeFullRecord.id,
          name: activeFullRecord.name,
          uri: activeFullRecord.localUri,
          thumb: activeFullRecord.thumbnailUri,
          durationMs: activeFullRecord.durationMs,
          label: 'Full AI Edit',
        }
      : exportSourceTarget === 'cut' && activeCutRecord
        ? {
            id: activeCutRecord.id,
            name: activeCutRecord.name,
            uri: activeCutRecord.localUri,
            thumb: activeCutRecord.thumbnailUri,
            durationMs: activeCutRecord.durationMs,
            label: 'AI Cut',
          }
        : activeFullRecord && exportSourceTarget === 'full_edited'
          ? null
          : selectedOriginalVideo
            ? {
                id: selectedOriginalVideo.id,
                name: selectedOriginalVideo.name,
                uri: selectedOriginalVideo.localUri,
                thumb: selectedOriginalVideo.thumbnailUri,
                durationMs: selectedOriginalVideo.durationMs,
                label: 'Original Video',
              }
            : null;

  const exportTargetInput =
    resolvedExportTarget ??
    (activeFullRecord
      ? {
          id: activeFullRecord.id,
          name: activeFullRecord.name,
          uri: activeFullRecord.localUri,
          thumb: activeFullRecord.thumbnailUri,
          durationMs: activeFullRecord.durationMs,
          label: 'Full AI Edit',
        }
      : activeCutRecord
        ? {
            id: activeCutRecord.id,
            name: activeCutRecord.name,
            uri: activeCutRecord.localUri,
            thumb: activeCutRecord.thumbnailUri,
            durationMs: activeCutRecord.durationMs,
            label: 'AI Cut',
          }
        : selectedOriginalVideo
          ? {
              id: selectedOriginalVideo.id,
              name: selectedOriginalVideo.name,
              uri: selectedOriginalVideo.localUri,
              thumb: selectedOriginalVideo.thumbnailUri,
              durationMs: selectedOriginalVideo.durationMs,
              label: 'Original Video',
            }
          : null);

  useEffect(() => {
    let active = true;
    if (!exportTargetInput) {
      setExportCapabilities(null);
      return;
    }
    (async () => {
      const caps = await inspectVideoExportCapabilitiesOnAndroid(
        exportTargetInput.uri,
        exportTargetInput.durationMs
      );
      if (!active) return;
      setExportCapabilities(caps);
      setExportConfig((prev) => {
        let nextRes = prev.resolution;
        if (!caps.supportedResolutions.includes(nextRes)) {
          nextRes = caps.supportedResolutions.includes('1080p')
            ? '1080p'
            : caps.supportedResolutions[caps.supportedResolutions.length - 1] ?? '720p';
        }
        const allowedFps = caps.supportedFpsByResolution[nextRes] ?? [24, 30];
        const nextFps = allowedFps.includes(prev.fps)
          ? prev.fps
          : allowedFps[allowedFps.length - 1] ?? 30;
        const nextCodec = prev.codec === 'h265' && !caps.supportsH265 ? 'h264' : prev.codec;
        return {
          ...prev,
          resolution: nextRes,
          fps: nextFps,
          codec: nextCodec,
        };
      });
    })();
    return () => {
      active = false;
    };
  }, [exportTargetInput?.uri, exportTargetInput?.durationMs]);

  const exportSummary =
    exportTargetInput && exportCapabilities
      ? computeSmartExportSummary({
          config: exportConfig,
          sourceWidth: exportCapabilities.sourceWidth,
          sourceHeight: exportCapabilities.sourceHeight,
          sourceFps: exportCapabilities.sourceFps,
          durationMs: exportTargetInput.durationMs || exportCapabilities.sourceDurationMs,
          capabilities: exportCapabilities,
          hasAudioTrack: exportCapabilities.hasAudioTrack,
        })
      : null;

  const activeAnalysis =
    (selectedVideoId ? analysisByVideoId[selectedVideoId] : undefined) ??
    activeFullRecord?.analysis ??
    activeCutRecord?.analysis ??
    null;

  const displayedCutPlan = activeAnalysis
    ? activeCutRecord && activeCutRecord.preset === selectedPreset
      ? activeCutRecord.cutPlan
      : buildCutPlan(activeAnalysis, selectedPreset)
    : null;

  const playerVideo: ImportedVideo | null =
    previewMode === 'exported' && activeExportedRecord
      ? {
          id: activeExportedRecord.id,
          name: activeExportedRecord.name,
          localUri: activeExportedRecord.localUri,
          thumbnailUri: activeExportedRecord.thumbnailUri,
          durationMs: activeExportedRecord.durationMs,
          fileSizeBytes: activeExportedRecord.fileSizeBytes,
          source: selectedOriginalVideo?.source ?? 'file_manager',
          importedAt: activeExportedRecord.createdAt,
        }
      : previewMode === 'full_edited' && activeFullRecord
        ? {
            id: activeFullRecord.id,
            name: activeFullRecord.name,
            localUri: activeFullRecord.localUri,
            thumbnailUri: activeFullRecord.thumbnailUri,
            durationMs: activeFullRecord.durationMs,
            fileSizeBytes: activeFullRecord.fileSizeBytes,
            source: selectedOriginalVideo?.source ?? 'file_manager',
            importedAt: activeFullRecord.createdAt,
          }
        : previewMode === 'cut' && activeCutRecord
          ? {
              id: activeCutRecord.id,
              name: activeCutRecord.name,
              localUri: activeCutRecord.localUri,
              thumbnailUri: activeCutRecord.thumbnailUri,
              durationMs: activeCutRecord.durationMs,
              fileSizeBytes: activeCutRecord.fileSizeBytes,
              source: selectedOriginalVideo?.source ?? 'file_manager',
              importedAt: activeCutRecord.createdAt,
            }
          : selectedOriginalVideo;

  const handleSelectOriginalVideo = (videoId: string) => {
    setSelectedVideoId(videoId);
    setPreviewMode('original');
    setActiveSegmentId(null);
    setSeekRequest(null);
  };

  const handleImported = useCallback((video: ImportedVideo) => {
    setLibrary((prev) => [video, ...prev.filter((item) => item.id !== video.id)]);
    setSelectedVideoId(video.id);
    setPreviewMode('original');
    setActiveSegmentId(null);
    setErrorMessage(null);
    setNeedsSettingsLink(false);
    setStatusMessage(`Saved "${video.name}" locally on this device.`);
  }, []);

  const handleImportGallery = async () => {
    setErrorMessage(null);
    setStatusMessage(null);
    setNeedsSettingsLink(false);
    setImportingSource('gallery');
    try {
      const outcome = await importGalleryVideo();
      if (outcome.status === 'imported' && outcome.video) {
        handleImported(outcome.video);
      } else if (outcome.status === 'error') {
        setErrorMessage(outcome.errorMessage ?? 'Unable to import gallery video.');
        if (outcome.errorMessage?.toLowerCase().includes('settings')) {
          setNeedsSettingsLink(true);
        }
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Gallery import failed.');
    } finally {
      setImportingSource(null);
    }
  };

  const handleOpenScreenRecordings = async () => {
    setErrorMessage(null);
    setStatusMessage(null);
    setNeedsSettingsLink(false);
    setSrModalVisible(true);
    setSrLoading(true);
    try {
      const scan = await loadDeviceScreenRecordings();
      if (!scan.granted) {
        setSrModalVisible(false);
        setErrorMessage(scan.errorMessage ?? 'Video media permission is required.');
        setNeedsSettingsLink(!scan.canAskAgain);
        return;
      }
      setScreenRecordings(scan.screenRecordings);
      setAllDeviceVideos(scan.allVideos);
    } catch (error) {
      setSrModalVisible(false);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to scan screen recordings.');
    } finally {
      setSrLoading(false);
    }
  };

  const handleSelectScreenRecording = async (candidate: ScreenRecordingCandidate) => {
    setSrModalVisible(false);
    setImportingSource('screen_recording');
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const outcome = await importScreenRecordingAsset(candidate);
      if (outcome.status === 'imported' && outcome.video) {
        handleImported(outcome.video);
      } else if (outcome.status === 'error') {
        setErrorMessage(outcome.errorMessage ?? 'Screen recording import failed.');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Screen recording import failed.');
    } finally {
      setImportingSource(null);
    }
  };

  const handleImportFileManager = async () => {
    setErrorMessage(null);
    setStatusMessage(null);
    setNeedsSettingsLink(false);
    setImportingSource('file_manager');
    try {
      const outcome = await importFileManagerVideo();
      if (outcome.status === 'imported' && outcome.video) {
        handleImported(outcome.video);
      } else if (outcome.status === 'error') {
        setErrorMessage(outcome.errorMessage ?? 'File manager import failed.');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'File manager import failed.');
    } finally {
      setImportingSource(null);
    }
  };

  const handleDurationResolved = useCallback(async (videoId: string, durationMs: number) => {
    const updated = await updateStoredVideoDuration(videoId, durationMs);
    setLibrary(updated);
  }, []);

  const handleExceedsMaxDuration = useCallback(async (videoId: string, durationMs: number) => {
    const remaining = await removeLocalVideo(videoId);
    setLibrary(remaining);
    setSelectedVideoId(remaining.length > 0 ? remaining[0].id : null);
    setStatusMessage(null);
    setErrorMessage(
      `Removed video (${formatDuration(durationMs)}) because it exceeds the 30:00 maximum duration limit.`
    );
  }, []);

  const handleDeleteVideo = (video: ImportedVideo) => {
    Alert.alert(
      'Remove Local Video',
      `Delete "${video.name}" from Hanuman on-device storage? The original file on your phone will remain untouched.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const remaining = await removeLocalVideo(video.id);
            setLibrary(remaining);
            if (selectedVideoId === video.id) {
              setSelectedVideoId(remaining.length > 0 ? remaining[0].id : null);
              setPreviewMode('original');
            }
          },
        },
      ]
    );
  };

  const ensureVideoAnalyzed = async (video: ImportedVideo): Promise<VideoAnalysisReport> => {
    const cached = analysisByVideoId[video.id];
    if (cached) return cached;

    const report = await analyzeVideoLocallyOnAndroid(video, (progress, stage) => {
      setProcessingState({
        active: true,
        progress: Math.min(0.42, progress * 0.42),
        stage,
      });
    });
    setAnalysisByVideoId((prev) => ({ ...prev, [video.id]: report }));
    return report;
  };

  // Step 2 Handler
  const handleRunAiVideoCut = async () => {
    if (!selectedOriginalVideo) return;
    setErrorMessage(null);
    setStatusMessage(null);

    if (!isAndroidNativeCuttingReady()) {
      setErrorMessage(
        'Native Media3 processing requires an Android Development Build (npx expo run:android).'
      );
      return;
    }

    setProcessingState({ active: true, progress: 0.02, stage: 'Analyzing video locally...' });

    try {
      const report = await ensureVideoAnalyzed(selectedOriginalVideo);
      const edited = await generateEditedVideoOnAndroid({
        sourceVideo: selectedOriginalVideo,
        analysis: report,
        preset: selectedPreset,
        onProgress: (progress, stage) => {
          setProcessingState({
            active: true,
            progress: 0.44 + progress * 0.56,
            stage,
          });
        },
      });

      setEditedLibrary((prev) => [edited, ...prev]);
      setPreviewMode('cut');
      setStatusMessage(
        `Generated AI cut (${getPresetLabel(selectedPreset)}): ${formatDuration(
          edited.durationMs
        )} from original ${formatDuration(edited.originalDurationMs)}.`
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'AI video cutting failed.');
    } finally {
      setProcessingState({ active: false, progress: 0, stage: '' });
    }
  };

  // Step 3 Handler: One-Click Full Automatic AI Editing
  const handleStartFullAiEditing = async () => {
    if (!selectedOriginalVideo) return;
    setErrorMessage(null);
    setStatusMessage(null);

    if (!isAndroidNativeCuttingReady()) {
      setErrorMessage(
        'Native Media3 AI editing requires an Android Development Build (npx expo run:android).'
      );
      return;
    }

    setProcessingState({
      active: true,
      progress: 0.02,
      stage: 'Running complete on-device video & audio analysis...',
    });

    try {
      const report = await ensureVideoAnalyzed(selectedOriginalVideo);
      const fullEdited = await executeFullAiEditingOnAndroid({
        sourceVideo: selectedOriginalVideo,
        analysis: report,
        styleSelection,
        enhancements,
        audioOptions,
        onProgress: (progress, stage) => {
          setProcessingState({
            active: true,
            progress: 0.44 + progress * 0.56,
            stage,
          });
        },
      });

      setFullEditedLibrary((prev) => [fullEdited, ...prev]);
      setPreviewMode('full_edited');
      setStatusMessage(
        `AI Full Editing finished (${getEditingStyleLabel(
          fullEdited.editPlan.resolvedStyle
        )}): ${formatDuration(fullEdited.durationMs)} rendered offline.`
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Full AI editing failed.');
    } finally {
      setProcessingState({ active: false, progress: 0, stage: '' });
    }
  };

  const handlePickBackgroundMusic = async () => {
    try {
      const picked = await pickLocalBackgroundMusicOnAndroid();
      if (picked) {
        setAudioOptions((prev) => ({
          ...prev,
          backgroundMusicUri: picked.uri,
          backgroundMusicName: picked.name,
        }));
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to pick music file.');
    }
  };

  const handleCancelProcessing = () => {
    cancelActiveAndroidCut();
    setProcessingState({ active: false, progress: 0, stage: '' });
    setStatusMessage('Processing cancelled. Original video remains intact.');
  };

  const handlePreviewTimelineSegment = (segment: TimelineSegment) => {
    setActiveSegmentId(segment.id);
    setPreviewMode('original');
    setSeekRequest({ positionMs: segment.startMs, nonce: Date.now() });
  };

  const handleDeleteCut = async (edited: EditedVideoRecord) => {
    const remaining = await removeEditedVideoRecord(edited.id);
    setEditedLibrary(remaining);
    if (previewMode === 'cut') setPreviewMode('original');
  };

  const handleDeleteFullEdited = async (edited: FullEditedVideoRecord) => {
    const remaining = await removeFullEditedVideoRecord(edited.id);
    setFullEditedLibrary(remaining);
    if (previewMode === 'full_edited') setPreviewMode('original');
  };

  const handleExportVideo = async () => {
    if (!selectedOriginalVideo || !exportTargetInput || !exportCapabilities || !exportSummary) return;
    if (exportMutexRef.current) return;
    exportMutexRef.current = true;
    setErrorMessage(null);
    setStatusMessage(null);
    setSavedGalleryNotice(null);
    setNeedsSettingsLink(false);

    if (!isAndroidNativeCuttingReady()) {
      exportMutexRef.current = false;
      setErrorMessage(
        'Native Media3 MP4 export requires an Android Development Build (npx expo run:android).'
      );
      return;
    }

    if (!exportSummary.compatible) {
      exportMutexRef.current = false;
      setErrorMessage(
        exportSummary.compatibilityIssues[0] ?? 'Selected export settings are incompatible.'
      );
      return;
    }

    setProcessingState({
      active: true,
      progress: 0.02,
      stage: `Preparing ${exportSummary.effectiveHeight}p ${exportSummary.effectiveFps}fps MP4 export...`,
    });

    try {
      const result = await executeVideoExportOnAndroid({
        sourceVideoId: selectedOriginalVideo.id,
        sourceTargetId: exportTargetInput.id,
        sourceName: exportTargetInput.name,
        sourceUri: exportTargetInput.uri,
        sourceThumbnailUri: exportTargetInput.thumb,
        sourceWidth: exportCapabilities.sourceWidth,
        sourceHeight: exportCapabilities.sourceHeight,
        sourceFps: exportCapabilities.sourceFps,
        config: exportConfig,
        summary: exportSummary,
        onProgress: (progress, stage) => {
          setProcessingState({ active: true, progress, stage });
        },
      });

      const exported = result.record;
      setExportedLibrary((prev) => [exported, ...prev.filter((item) => item.id !== exported.id)]);
      setSelectedExportedId(exported.id);
      setPreviewMode('exported');

      if (exported.galleryAssetUri) {
        setSavedGalleryNotice({
          record: exported,
          alreadySaved: result.galleryAlreadySaved,
          deduplicatedExport: result.deduplicated,
        });
        setStatusMessage(null);
      } else if (result.gallerySaveError) {
        setErrorMessage(`MP4 exported locally, but Gallery save did not complete: ${result.gallerySaveError}`);
        if (result.gallerySaveError.toLowerCase().includes('settings')) {
          setNeedsSettingsLink(true);
        }
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'MP4 export failed.');
    } finally {
      exportMutexRef.current = false;
      setProcessingState({ active: false, progress: 0, stage: '' });
    }
  };

  const handleSaveRecordToGallery = async (record: ExportedVideoRecord) => {
    if (savingToGalleryId) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setNeedsSettingsLink(false);
    setSavingToGalleryId(record.id);
    try {
      const outcome = await saveExportedRecordToGalleryOnAndroid(record);
      setExportedLibrary((prev) => [
        outcome.record,
        ...prev.filter((item) => item.id !== outcome.record.id),
      ]);
      setSelectedExportedId(outcome.record.id);
      setSavedGalleryNotice({
        record: outcome.record,
        alreadySaved: outcome.alreadySaved,
        deduplicatedExport: false,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to save video to Gallery.';
      setErrorMessage(msg);
      if (msg.toLowerCase().includes('settings')) {
        setNeedsSettingsLink(true);
      }
    } finally {
      setSavingToGalleryId(null);
    }
  };

  const handleOpenGallery = async (contentUri?: string | null) => {
    setErrorMessage(null);
    try {
      await openExportedInAndroidGallery(contentUri ?? null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to open Android Gallery.');
    }
  };

  const handlePlaySavedVideo = async (record: ExportedVideoRecord) => {
    setErrorMessage(null);
    setSelectedVideoId(record.sourceVideoId);
    setSelectedExportedId(record.id);
    setPreviewMode('exported');
    setSeekRequest({ positionMs: 0, nonce: Date.now() });

    if (isAndroidNativeCuttingReady()) {
      try {
        await playExportedInAndroidSystemPlayer(record);
      } catch {
        // Fallback already switched in-app VideoPreviewPlayer to play the exported MP4
      }
    }
  };

  const handleDeleteExported = async (exported: ExportedVideoRecord) => {
    const remaining = await removeExportedVideoRecord(exported.id);
    setExportedLibrary(remaining);
    if (savedGalleryNotice?.record.id === exported.id) {
      setSavedGalleryNotice(null);
    }
    if (selectedExportedId === exported.id) {
      setSelectedExportedId(null);
      if (previewMode === 'exported') setPreviewMode('original');
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Text style={styles.brandTitle}>HANUMAN AI VIDEO EDITOR</Text>
          <Text style={styles.brandSubtitle}>
            Offline Import, AI Cutting, Full Editing &amp; Pro MP4 Export · Max 30:00
          </Text>
        </View>

        {/* Original vs AI Cut vs Full Edited vs Exported Comparison Switcher */}
        {selectedOriginalVideo && (activeCutRecord || activeFullRecord || activeExportedRecord) && (
          <View style={styles.compareTabs}>
            <Pressable
              onPress={() => setPreviewMode('original')}
              style={[styles.compareTab, previewMode === 'original' && styles.compareTabActive]}
            >
              <Text
                style={[
                  styles.compareTabText,
                  previewMode === 'original' && styles.compareTabTextActive,
                ]}
              >
                Original ({formatDuration(selectedOriginalVideo.durationMs)})
              </Text>
            </Pressable>
            {activeCutRecord && (
              <Pressable
                onPress={() => setPreviewMode('cut')}
                style={[styles.compareTab, previewMode === 'cut' && styles.compareTabActive]}
              >
                <Text
                  style={[
                    styles.compareTabText,
                    previewMode === 'cut' && styles.compareTabTextActive,
                  ]}
                >
                  AI Cut ({formatDuration(activeCutRecord.durationMs)})
                </Text>
              </Pressable>
            )}
            {activeFullRecord && (
              <Pressable
                onPress={() => setPreviewMode('full_edited')}
                style={[
                  styles.compareTab,
                  previewMode === 'full_edited' && styles.compareTabActive,
                ]}
              >
                <Text
                  style={[
                    styles.compareTabText,
                    previewMode === 'full_edited' && styles.compareTabTextActive,
                  ]}
                >
                  Full AI Edit ({formatDuration(activeFullRecord.durationMs)})
                </Text>
              </Pressable>
            )}
            {activeExportedRecord && (
              <Pressable
                onPress={() => setPreviewMode('exported')}
                style={[styles.compareTab, previewMode === 'exported' && styles.compareTabActive]}
              >
                <Text
                  style={[
                    styles.compareTabText,
                    previewMode === 'exported' && styles.compareTabTextActive,
                  ]}
                >
                  MP4 ({activeExportedRecord.height}p)
                </Text>
              </Pressable>
            )}
          </View>
        )}

        <VideoPreviewPlayer
          video={playerVideo}
          seekRequest={seekRequest}
          playerTitleLabel={
            previewMode === 'exported'
              ? `Exported MP4 (${activeExportedRecord?.height ?? 720}p)`
              : previewMode === 'full_edited'
                ? 'Full AI Edit'
                : previewMode === 'cut'
                  ? 'AI Cut'
                  : activeCutRecord || activeFullRecord || activeExportedRecord
                    ? 'Original'
                    : undefined
          }
          onDurationResolved={handleDurationResolved}
          onExceedsMaxDuration={handleExceedsMaxDuration}
        />

        {errorMessage && (
          <View style={styles.errorBox}>
            <View style={styles.messageRow}>
              <Ionicons name="alert-circle" size={18} color="#FCA5A5" />
              <Text style={styles.errorBoxText}>{errorMessage}</Text>
            </View>
            {needsSettingsLink && (
              <Pressable onPress={openAndroidAppSettings} style={styles.settingsButton}>
                <Text style={styles.settingsButtonText}>Open Android Settings</Text>
              </Pressable>
            )}
          </View>
        )}

        {statusMessage && (
          <View style={styles.successBox}>
            <Ionicons name="checkmark-circle" size={18} color="#86EFAC" />
            <Text style={styles.successBoxText}>{statusMessage}</Text>
          </View>
        )}

        {/* Step 5: Verified Gallery Save Notification (shown ONLY after MediaStore save completes) */}
        {savedGalleryNotice && (
          <View style={styles.galleryNoticeCard}>
            <View style={styles.messageRow}>
              <Ionicons name="checkmark-circle" size={20} color="#86EFAC" />
              <View style={{ flex: 1 }}>
                <Text style={styles.galleryNoticeTitle}>
                  {savedGalleryNotice.alreadySaved || savedGalleryNotice.deduplicatedExport
                    ? 'Already Saved in Android Gallery'
                    : 'Saved to Android Gallery'}
                </Text>
                <Text style={styles.galleryNoticeMeta}>
                  {savedGalleryNotice.record.name} ·{' '}
                  {savedGalleryNotice.record.galleryRelativePath ?? 'Movies/HanumanAI'} ·{' '}
                  {formatFileSize(savedGalleryNotice.record.fileSizeBytes)}
                </Text>
              </View>
            </View>
            <View style={styles.galleryActionsRow}>
              <Pressable
                onPress={() => handleOpenGallery(savedGalleryNotice.record.galleryAssetUri)}
                style={styles.gallerySecondaryBtn}
              >
                <Ionicons name="images-outline" size={16} color="#F4F4F5" />
                <Text style={styles.gallerySecondaryBtnText}>Open Gallery</Text>
              </Pressable>
              <Pressable
                onPress={() => handlePlaySavedVideo(savedGalleryNotice.record)}
                style={styles.galleryPrimaryBtn}
              >
                <Ionicons name="play" size={16} color="#09090B" />
                <Text style={styles.galleryPrimaryBtnText}>Play Video</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Active Processing Progress */}
        {processingState.active && (
          <View style={styles.progressCard}>
            <View style={styles.progressHeader}>
              <Text style={styles.progressStage}>{processingState.stage}</Text>
              <Text style={styles.progressPct}>
                {Math.round(processingState.progress * 100)}%
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(processingState.progress * 100)}%` },
                ]}
              />
            </View>
            <Pressable onPress={handleCancelProcessing} style={styles.cancelCutBtn}>
              <Text style={styles.cancelCutText}>Cancel Processing</Text>
            </Pressable>
          </View>
        )}

        {/* Step 4: Professional Video Quality & Export System */}
        {selectedOriginalVideo && exportTargetInput && (
          <View style={styles.aiSection}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Step 4 · Quality &amp; MP4 Export</Text>
              <Text style={styles.sectionMeta}>
                {exportCapabilities?.encoderSummary ?? 'Inspecting device...'}
              </Text>
            </View>

            {/* Export Source Picker */}
            {(activeFullRecord || activeCutRecord) && (
              <View style={styles.exportSourceRow}>
                {activeFullRecord && (
                  <Pressable
                    disabled={processingState.active}
                    onPress={() => setExportSourceTarget('full_edited')}
                    style={[
                      styles.chipBtn,
                      exportTargetInput.id === activeFullRecord.id && styles.chipBtnActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipBtnText,
                        exportTargetInput.id === activeFullRecord.id && styles.chipBtnTextActive,
                      ]}
                    >
                      Full AI Edit
                    </Text>
                  </Pressable>
                )}
                {activeCutRecord && (
                  <Pressable
                    disabled={processingState.active}
                    onPress={() => setExportSourceTarget('cut')}
                    style={[
                      styles.chipBtn,
                      exportTargetInput.id === activeCutRecord.id && styles.chipBtnActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipBtnText,
                        exportTargetInput.id === activeCutRecord.id && styles.chipBtnTextActive,
                      ]}
                    >
                      AI Cut
                    </Text>
                  </Pressable>
                )}
                <Pressable
                  disabled={processingState.active}
                  onPress={() => setExportSourceTarget('original')}
                  style={[
                    styles.chipBtn,
                    exportTargetInput.id === selectedOriginalVideo.id && styles.chipBtnActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.chipBtnText,
                      exportTargetInput.id === selectedOriginalVideo.id && styles.chipBtnTextActive,
                    ]}
                  >
                    Original
                  </Text>
                </Pressable>
              </View>
            )}

            <Text style={styles.subGroupTitle}>Video Quality</Text>
            <View style={styles.optionRowWrap}>
              {RESOLUTION_SPECS.filter(
                (spec) =>
                  spec.id !== '4k' ||
                  (exportCapabilities?.supports4K &&
                    exportCapabilities.supportedResolutions.includes('4k'))
              ).map((spec) => {
                const supported =
                  exportCapabilities?.supportedResolutions.includes(spec.id) ?? true;
                const isSelected = exportConfig.resolution === spec.id;
                return (
                  <Pressable
                    key={spec.id}
                    disabled={processingState.active || !supported}
                    onPress={() => {
                      const nextFpsList =
                        exportCapabilities?.supportedFpsByResolution[spec.id] ?? [24, 30];
                      setExportConfig((prev) => ({
                        ...prev,
                        resolution: spec.id,
                        fps: nextFpsList.includes(prev.fps)
                          ? prev.fps
                          : nextFpsList[nextFpsList.length - 1] ?? 30,
                      }));
                    }}
                    style={[
                      styles.chipBtn,
                      isSelected && styles.chipBtnActive,
                      !supported && { opacity: 0.4 },
                    ]}
                  >
                    <Text style={[styles.chipBtnText, isSelected && styles.chipBtnTextActive]}>
                      {spec.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.subGroupTitle}>Frame Rate (FPS)</Text>
            <View style={styles.optionRowWrap}>
              {(
                exportCapabilities?.supportedFpsByResolution[exportConfig.resolution] ?? [24, 30]
              ).map((fpsOption: ExportFps) => {
                const isSelected = exportConfig.fps === fpsOption;
                return (
                  <Pressable
                    key={fpsOption}
                    disabled={processingState.active}
                    onPress={() => setExportConfig((prev) => ({ ...prev, fps: fpsOption }))}
                    style={[styles.chipBtn, isSelected && styles.chipBtnActive]}
                  >
                    <Text style={[styles.chipBtnText, isSelected && styles.chipBtnTextActive]}>
                      {fpsOption} FPS
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.subGroupTitle}>Video Format &amp; Codec</Text>
            <View style={styles.optionRowWrap}>
              <Pressable
                disabled={processingState.active}
                onPress={() => setExportConfig((prev) => ({ ...prev, codec: 'h264' }))}
                style={[styles.chipBtn, exportConfig.codec === 'h264' && styles.chipBtnActive]}
              >
                <Text
                  style={[
                    styles.chipBtnText,
                    exportConfig.codec === 'h264' && styles.chipBtnTextActive,
                  ]}
                >
                  MP4 · H.264
                </Text>
              </Pressable>
              {exportCapabilities?.supportsH265 && (
                <Pressable
                  disabled={processingState.active}
                  onPress={() => setExportConfig((prev) => ({ ...prev, codec: 'h265' }))}
                  style={[styles.chipBtn, exportConfig.codec === 'h265' && styles.chipBtnActive]}
                >
                  <Text
                    style={[
                      styles.chipBtnText,
                      exportConfig.codec === 'h265' && styles.chipBtnTextActive,
                    ]}
                  >
                    MP4 · H.265
                  </Text>
                </Pressable>
              )}
            </View>

            <Text style={styles.subGroupTitle}>Export Compression</Text>
            <View style={styles.presetGrid}>
              {COMPRESSION_PRESETS.map((preset) => {
                const isSelected = exportConfig.compression === preset.id;
                return (
                  <Pressable
                    key={preset.id}
                    disabled={processingState.active}
                    onPress={() =>
                      setExportConfig((prev) => ({ ...prev, compression: preset.id }))
                    }
                    style={[styles.presetCard, isSelected && styles.presetCardActive]}
                  >
                    <Text style={[styles.presetLabel, isSelected && styles.presetLabelActive]}>
                      {preset.label}
                    </Text>
                    <Text style={styles.presetDesc}>{preset.description}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Smart Export Pre-Flight Card */}
            {exportSummary && (
              <View style={styles.smartExportCard}>
                <Text style={styles.appliedSummaryTitle}>Smart Export Pre-Flight</Text>
                <Text style={styles.appliedSummaryMeta}>
                  Resolution: {exportSummary.effectiveWidth}x{exportSummary.effectiveHeight} · FPS:{' '}
                  {exportSummary.effectiveFps} fps · Duration:{' '}
                  {formatDuration(exportSummary.durationMs)}
                </Text>
                <Text style={styles.appliedSummaryMeta}>
                  Est. File Size: {formatFileSize(exportSummary.estimatedFileSizeBytes)} · Free
                  Storage:{' '}
                  {exportSummary.availableStorageBytes !== null
                    ? formatFileSize(exportSummary.availableStorageBytes)
                    : 'Checking...'}
                </Text>
                <Text style={styles.appliedSummaryMeta}>
                  Format: {getCodecLabel(exportConfig.codec)} · Preset:{' '}
                  {getCompressionLabel(exportConfig.compression)}
                </Text>
                {exportSummary.capNote && (
                  <Text style={styles.exportWarnText}>{exportSummary.capNote}</Text>
                )}
                {!exportSummary.compatible && (
                  <Text style={styles.exportErrorText}>
                    {exportSummary.compatibilityIssues[0]}
                  </Text>
                )}
              </View>
            )}

            <Pressable
              onPress={handleExportVideo}
              disabled={processingState.active || !(exportSummary?.compatible ?? false)}
              style={({ pressed }) => [
                styles.heroEditButton,
                { marginTop: 12 },
                (processingState.active || !(exportSummary?.compatible ?? false)) && {
                  opacity: 0.5,
                },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Ionicons name="download-outline" size={20} color="#09090B" />
              <Text style={styles.heroEditButtonText}>EXPORT VIDEO</Text>
            </Pressable>
          </View>
        )}

        {/* Step 3: One-Click Full Automatic AI Video Editing */}
        {selectedOriginalVideo && (
          <View style={styles.aiSection}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Step 3 · Full Automatic AI Editing</Text>
              <Text style={styles.sectionMeta}>GPU Media3 + Audio DSP</Text>
            </View>

            <Pressable
              onPress={handleStartFullAiEditing}
              disabled={processingState.active}
              style={({ pressed }) => [
                styles.heroEditButton,
                processingState.active && { opacity: 0.6 },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Ionicons name="sparkles" size={20} color="#09090B" />
              <Text style={styles.heroEditButtonText}>
                {activeFullRecord ? 'START AI FULL EDITING (EDIT AGAIN)' : 'START AI FULL EDITING'}
              </Text>
            </Pressable>

            {activeFullRecord && (
              <View style={styles.appliedSummaryCard}>
                <Text style={styles.appliedSummaryTitle}>
                  Applied: {getEditingStyleLabel(activeFullRecord.editPlan.resolvedStyle)}
                </Text>
                <Text style={styles.appliedSummaryMeta}>
                  {activeFullRecord.editPlan.styleSelectionReason}
                </Text>
                <Text style={styles.appliedSummaryMeta}>
                  Contrast {activeFullRecord.editPlan.profile.contrastDelta >= 0 ? '+' : ''}
                  {Math.round(activeFullRecord.editPlan.profile.contrastDelta * 100)}% ·
                  Saturation {activeFullRecord.editPlan.profile.saturationDelta >= 0 ? '+' : ''}
                  {activeFullRecord.editPlan.profile.saturationDelta} · Sharpness{' '}
                  {Math.round(activeFullRecord.editPlan.profile.sharpnessAmount * 100)}% · Audio +
                  {activeFullRecord.editPlan.profile.audioGainDb} dB
                </Text>
              </View>
            )}

            <Text style={styles.subGroupTitle}>Editing Style</Text>
            <View style={styles.presetGrid}>
              {EDITING_STYLE_OPTIONS.map((opt) => {
                const isSelected = styleSelection === opt.id;
                return (
                  <Pressable
                    key={opt.id}
                    disabled={processingState.active}
                    onPress={() => setStyleSelection(opt.id)}
                    style={[styles.presetCard, isSelected && styles.presetCardActive]}
                  >
                    <Text style={[styles.presetLabel, isSelected && styles.presetLabelActive]}>
                      {opt.label}
                    </Text>
                    <Text style={styles.presetDesc}>{opt.description}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.subGroupTitle}>Automatic Video Enhancement</Text>
            <View style={styles.togglesCard}>
              {(
                [
                  ['colourEnhancement', 'Colour Enhancement'],
                  ['lightingCorrection', 'Lighting Correction'],
                  ['contrastEnhancement', 'Contrast Enhancement'],
                  ['videoStabilization', 'Video Stabilization (1.05x Overscan)'],
                  ['noiseReduction', 'Noise Reduction (Spatial + High-Pass)'],
                  ['visualQualityEnhancement', 'Visual Quality Enhancement (3x3 Sharpen)'],
                ] as const
              ).map(([key, label]) => (
                <View key={key} style={styles.toggleRow}>
                  <Text style={styles.toggleLabel}>{label}</Text>
                  <Switch
                    value={enhancements[key]}
                    onValueChange={(val) =>
                      setEnhancements((prev) => ({ ...prev, [key]: val }))
                    }
                    trackColor={{ false: '#272C38', true: '#EA580C' }}
                    thumbColor="#F4F4F5"
                  />
                </View>
              ))}
            </View>

            <Text style={styles.subGroupTitle}>Automatic Audio Editing</Text>
            <View style={styles.togglesCard}>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Improve Voice Clarity (2.5kHz Boost)</Text>
                <Switch
                  value={audioOptions.improveVoiceClarity}
                  onValueChange={(val) =>
                    setAudioOptions((prev) => ({ ...prev, improveVoiceClarity: val }))
                  }
                  trackColor={{ false: '#272C38', true: '#EA580C' }}
                  thumbColor="#F4F4F5"
                />
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Reduce Background Noise (85Hz + Gate)</Text>
                <Switch
                  value={audioOptions.reduceBackgroundNoise}
                  onValueChange={(val) =>
                    setAudioOptions((prev) => ({ ...prev, reduceBackgroundNoise: val }))
                  }
                  trackColor={{ false: '#272C38', true: '#EA580C' }}
                  thumbColor="#F4F4F5"
                />
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Normalize Audio Volume</Text>
                <Switch
                  value={audioOptions.normalizeVolume}
                  onValueChange={(val) =>
                    setAudioOptions((prev) => ({ ...prev, normalizeVolume: val }))
                  }
                  trackColor={{ false: '#272C38', true: '#EA580C' }}
                  thumbColor="#F4F4F5"
                />
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Preserve Original Audio Uncolored</Text>
                <Switch
                  value={audioOptions.preserveOriginalAudio}
                  onValueChange={(val) =>
                    setAudioOptions((prev) => ({ ...prev, preserveOriginalAudio: val }))
                  }
                  trackColor={{ false: '#272C38', true: '#EA580C' }}
                  thumbColor="#F4F4F5"
                />
              </View>

              <View style={styles.musicRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>Optional Background Music</Text>
                  <Text style={styles.musicSubtext} numberOfLines={1}>
                    {audioOptions.backgroundMusicName ?? 'None selected (voice audio only)'}
                  </Text>
                </View>
                <Pressable onPress={handlePickBackgroundMusic} style={styles.musicBtn}>
                  <Text style={styles.musicBtnText}>
                    {audioOptions.backgroundMusicName ? 'Change' : 'Pick Audio'}
                  </Text>
                </Pressable>
                {audioOptions.backgroundMusicUri && (
                  <Pressable
                    onPress={() =>
                      setAudioOptions((prev) => ({
                        ...prev,
                        backgroundMusicUri: null,
                        backgroundMusicName: null,
                      }))
                    }
                    style={styles.musicClearBtn}
                  >
                    <Ionicons name="close" size={16} color="#E4E4E7" />
                  </Pressable>
                )}
              </View>
            </View>
          </View>
        )}

        {/* Step 2 Preserved: AI Automatic Video Cutting */}
        {selectedOriginalVideo && (
          <View style={styles.aiSection}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Step 2 · Smart Cutting Options</Text>
              <Text style={styles.sectionMeta}>100% On-Device Media3</Text>
            </View>

            <View style={styles.presetGrid}>
              {CUTTING_PRESET_OPTIONS.map((option) => {
                const isSelected = selectedPreset === option.id;
                return (
                  <Pressable
                    key={option.id}
                    disabled={processingState.active}
                    onPress={() => setSelectedPreset(option.id)}
                    style={[styles.presetCard, isSelected && styles.presetCardActive]}
                  >
                    <Text style={[styles.presetLabel, isSelected && styles.presetLabelActive]}>
                      {option.label}
                    </Text>
                    <Text style={styles.presetDesc}>{option.description}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              onPress={handleRunAiVideoCut}
              disabled={processingState.active}
              style={({ pressed }) => [
                styles.runAiButton,
                processingState.active && { opacity: 0.6 },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Ionicons name="cut-outline" size={20} color="#F4F4F5" />
              <Text style={styles.runAiButtonText}>
                {activeCutRecord ? 'Regenerate AI Cut' : 'Generate AI Cut Video'}
              </Text>
            </Pressable>

            {activeAnalysis && displayedCutPlan && (
              <VideoTimeline
                analysis={activeAnalysis}
                cutPlan={displayedCutPlan}
                onPreviewSegment={handlePreviewTimelineSegment}
                activeSegmentId={activeSegmentId}
              />
            )}
          </View>
        )}

        {/* Step 1 Preserved: Three Local Video Import Options */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Step 1 · Import Local Video</Text>
          <Text style={styles.sectionMeta}>Stored locally on device</Text>
        </View>

        <View style={styles.importGrid}>
          <Pressable
            onPress={handleImportGallery}
            disabled={importingSource !== null || processingState.active}
            style={({ pressed }) => [styles.importCard, pressed && styles.importCardPressed]}
          >
            <View style={styles.importIconWrap}>
              {importingSource === 'gallery' ? (
                <ActivityIndicator size="small" color="#F97316" />
              ) : (
                <Ionicons name="images-outline" size={22} color="#F97316" />
              )}
            </View>
            <View style={styles.importTextCol}>
              <Text style={styles.importTitle}>Gallery Video</Text>
              <Text style={styles.importDesc}>Pick a video from your Android photo gallery</Text>
            </View>
            <Ionicons name="add-circle-outline" size={22} color="#A1A1AA" />
          </Pressable>

          <Pressable
            onPress={handleOpenScreenRecordings}
            disabled={importingSource !== null || processingState.active}
            style={({ pressed }) => [styles.importCard, pressed && styles.importCardPressed]}
          >
            <View style={styles.importIconWrap}>
              {importingSource === 'screen_recording' ? (
                <ActivityIndicator size="small" color="#F97316" />
              ) : (
                <Ionicons name="phone-portrait-outline" size={22} color="#F97316" />
              )}
            </View>
            <View style={styles.importTextCol}>
              <Text style={styles.importTitle}>Screen Recording Video</Text>
              <Text style={styles.importDesc}>Browse recorded screen captures on your device</Text>
            </View>
            <Ionicons name="add-circle-outline" size={22} color="#A1A1AA" />
          </Pressable>

          <Pressable
            onPress={handleImportFileManager}
            disabled={importingSource !== null || processingState.active}
            style={({ pressed }) => [styles.importCard, pressed && styles.importCardPressed]}
          >
            <View style={styles.importIconWrap}>
              {importingSource === 'file_manager' ? (
                <ActivityIndicator size="small" color="#F97316" />
              ) : (
                <Ionicons name="folder-open-outline" size={22} color="#F97316" />
              )}
            </View>
            <View style={styles.importTextCol}>
              <Text style={styles.importTitle}>File Manager Video</Text>
              <Text style={styles.importDesc}>Choose any local video file via Android Files</Text>
            </View>
            <Ionicons name="add-circle-outline" size={22} color="#A1A1AA" />
          </Pressable>
        </View>

        {/* Exported Playable MP4 Library (Saved in Movies/HanumanAI) */}
        {exportedLibrary.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Exported MP4 Videos ({exportedLibrary.length})</Text>
              <Text style={styles.sectionMeta}>Movies/HanumanAI · Offline</Text>
            </View>
            <View style={styles.libraryList}>
              {exportedLibrary.map((exp) => (
                <View
                  key={exp.id}
                  style={[
                    styles.exportedCard,
                    previewMode === 'exported' &&
                      activeExportedRecord?.id === exp.id &&
                      styles.libraryRowActive,
                  ]}
                >
                  <Pressable
                    onPress={() => {
                      setSelectedVideoId(exp.sourceVideoId);
                      setSelectedExportedId(exp.id);
                      setPreviewMode('exported');
                    }}
                    style={styles.exportedTopRow}
                  >
                    {exp.thumbnailUri ? (
                      <Image source={{ uri: exp.thumbnailUri }} style={styles.thumb} />
                    ) : (
                      <View style={[styles.thumb, styles.thumbFallback]}>
                        <Ionicons name="film-outline" size={20} color="#F97316" />
                      </View>
                    )}
                    <View style={styles.libraryInfo}>
                      <Text style={styles.libraryName} numberOfLines={1}>
                        {exp.name}
                      </Text>
                      <Text style={styles.libraryMeta} numberOfLines={1}>
                        {exp.width}x{exp.height} · {exp.fps}fps · {exp.codec.toUpperCase()} ·{' '}
                        {formatFileSize(exp.fileSizeBytes)}
                      </Text>
                      <Text style={styles.galleryFolderText} numberOfLines={1}>
                        {exp.galleryAssetUri
                          ? `Saved in ${exp.galleryRelativePath ?? 'Movies/HanumanAI'}`
                          : 'Saved locally · Tap Save to Gallery'}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => handleDeleteExported(exp)}
                      style={styles.deleteButton}
                      accessibilityLabel={`Delete ${exp.name}`}
                    >
                      <Ionicons name="trash-outline" size={18} color="#9CA3AF" />
                    </Pressable>
                  </Pressable>

                  <View style={styles.galleryActionsRow}>
                    {exp.galleryAssetUri ? (
                      <Pressable
                        onPress={() => handleOpenGallery(exp.galleryAssetUri)}
                        style={styles.gallerySecondaryBtn}
                      >
                        <Ionicons name="images-outline" size={15} color="#F4F4F5" />
                        <Text style={styles.gallerySecondaryBtnText}>Open Gallery</Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        disabled={savingToGalleryId === exp.id}
                        onPress={() => handleSaveRecordToGallery(exp)}
                        style={styles.gallerySecondaryBtn}
                      >
                        <Ionicons name="save-outline" size={15} color="#F4F4F5" />
                        <Text style={styles.gallerySecondaryBtnText}>
                          {savingToGalleryId === exp.id ? 'Saving...' : 'Save to Gallery'}
                        </Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={() => handlePlaySavedVideo(exp)}
                      style={styles.galleryPrimaryBtn}
                    >
                      <Ionicons name="play" size={15} color="#09090B" />
                      <Text style={styles.galleryPrimaryBtnText}>Play Video</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          </>
        )}

        {/* Full AI-Edited Videos */}
        {fullEditedLibrary.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Full AI-Edited Videos ({fullEditedLibrary.length})</Text>
              <Text style={styles.sectionMeta}>Original kept unchanged</Text>
            </View>
            <View style={styles.libraryList}>
              {fullEditedLibrary.map((edited) => (
                <Pressable
                  key={edited.id}
                  onPress={() => {
                    setSelectedVideoId(edited.sourceVideoId);
                    setPreviewMode('full_edited');
                  }}
                  style={[
                    styles.libraryRow,
                    previewMode === 'full_edited' &&
                      activeFullRecord?.id === edited.id &&
                      styles.libraryRowActive,
                  ]}
                >
                  {edited.thumbnailUri ? (
                    <Image source={{ uri: edited.thumbnailUri }} style={styles.thumb} />
                  ) : (
                    <View style={[styles.thumb, styles.thumbFallback]}>
                      <Ionicons name="sparkles" size={20} color="#F97316" />
                    </View>
                  )}
                  <View style={styles.libraryInfo}>
                    <Text style={styles.libraryName} numberOfLines={1}>
                      {edited.name}
                    </Text>
                    <Text style={styles.libraryMeta} numberOfLines={1}>
                      {formatDuration(edited.durationMs)} (from {formatDuration(edited.originalDurationMs)}) ·{' '}
                      {formatFileSize(edited.fileSizeBytes)}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => handleDeleteFullEdited(edited)}
                    style={styles.deleteButton}
                  >
                    <Ionicons name="trash-outline" size={18} color="#9CA3AF" />
                  </Pressable>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {/* Step 2 Cut Outputs */}
        {editedLibrary.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>AI-Cut Videos ({editedLibrary.length})</Text>
              <Text style={styles.sectionMeta}>Original kept unchanged</Text>
            </View>
            <View style={styles.libraryList}>
              {editedLibrary.map((edited) => (
                <Pressable
                  key={edited.id}
                  onPress={() => {
                    setSelectedVideoId(edited.sourceVideoId);
                    setPreviewMode('cut');
                  }}
                  style={[
                    styles.libraryRow,
                    previewMode === 'cut' &&
                      activeCutRecord?.id === edited.id &&
                      styles.libraryRowActive,
                  ]}
                >
                  {edited.thumbnailUri ? (
                    <Image source={{ uri: edited.thumbnailUri }} style={styles.thumb} />
                  ) : (
                    <View style={[styles.thumb, styles.thumbFallback]}>
                      <Ionicons name="cut-outline" size={20} color="#F97316" />
                    </View>
                  )}
                  <View style={styles.libraryInfo}>
                    <Text style={styles.libraryName} numberOfLines={1}>
                      {edited.name}
                    </Text>
                    <Text style={styles.libraryMeta} numberOfLines={1}>
                      {formatDuration(edited.durationMs)} (from {formatDuration(edited.originalDurationMs)}) ·{' '}
                      {formatFileSize(edited.fileSizeBytes)}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => handleDeleteCut(edited)}
                    style={styles.deleteButton}
                  >
                    <Ionicons name="trash-outline" size={18} color="#9CA3AF" />
                  </Pressable>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {/* Step 1 Original Imported Library */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Imported on Device ({library.length})</Text>
          <Text style={styles.sectionMeta}>No cloud upload</Text>
        </View>

        {loadingLibrary ? (
          <View style={styles.libraryEmpty}>
            <ActivityIndicator size="small" color="#F97316" />
            <Text style={styles.libraryEmptyText}>Loading local device videos...</Text>
          </View>
        ) : library.length === 0 ? (
          <View style={styles.libraryEmpty}>
            <Text style={styles.libraryEmptyText}>
              No imported videos yet. Choose one of the three import options above.
            </Text>
          </View>
        ) : (
          <View style={styles.libraryList}>
            {library.map((item) => {
              const isSelected = item.id === selectedVideoId && previewMode === 'original';
              return (
                <Pressable
                  key={item.id}
                  onPress={() => handleSelectOriginalVideo(item.id)}
                  style={[styles.libraryRow, isSelected && styles.libraryRowActive]}
                >
                  {item.thumbnailUri ? (
                    <Image source={{ uri: item.thumbnailUri }} style={styles.thumb} />
                  ) : (
                    <View style={[styles.thumb, styles.thumbFallback]}>
                      <Ionicons name="film-outline" size={20} color="#71717A" />
                    </View>
                  )}
                  <View style={styles.libraryInfo}>
                    <Text style={styles.libraryName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.libraryMeta} numberOfLines={1}>
                      {item.durationMs > 0 ? formatDuration(item.durationMs) : 'Reading duration...'} ·{' '}
                      {getSourceLabel(item.source)} · {formatFileSize(item.fileSizeBytes)}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => handleDeleteVideo(item)}
                    style={styles.deleteButton}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${item.name}`}
                  >
                    <Ionicons name="trash-outline" size={18} color="#9CA3AF" />
                  </Pressable>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>

      <ScreenRecordingPickerModal
        visible={srModalVisible}
        loading={srLoading}
        screenRecordings={screenRecordings}
        allVideos={allDeviceVideos}
        onSelect={handleSelectScreenRecording}
        onClose={() => setSrModalVisible(false)}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <HanumanImportModuleScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0B0D12',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 42,
  },
  header: {
    marginBottom: 14,
  },
  brandTitle: {
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 0.4,
    color: '#F8FAFC',
  },
  brandSubtitle: {
    marginTop: 4,
    fontSize: 12,
    color: '#9CA3AF',
  },
  compareTabs: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 10,
  },
  compareTab: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#232834',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  compareTabActive: {
    backgroundColor: '#1E232E',
    borderColor: '#F97316',
  },
  compareTabText: {
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: '#9CA3AF',
  },
  compareTabTextActive: {
    color: '#F4F4F5',
  },
  errorBox: {
    marginTop: 14,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#3B1219',
    borderWidth: 1,
    borderColor: '#7F1D1D',
    gap: 10,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  errorBoxText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: '#FECACA',
  },
  settingsButton: {
    alignSelf: 'flex-start',
    minHeight: 38,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#F97316',
    justifyContent: 'center',
  },
  settingsButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#09090B',
  },
  successBox: {
    marginTop: 14,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#122B1D',
    borderWidth: 1,
    borderColor: '#166534',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  successBoxText: {
    flex: 1,
    fontSize: 13,
    color: '#DCFCE7',
  },
  aiSection: {
    marginTop: 8,
  },
  heroEditButton: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: '#F97316',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  heroEditButtonText: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.4,
    color: '#09090B',
  },
  appliedSummaryCard: {
    marginTop: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#141A24',
    borderWidth: 1,
    borderColor: '#2A3344',
    gap: 4,
  },
  appliedSummaryTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#F97316',
  },
  appliedSummaryMeta: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: '#D4D4D8',
  },
  subGroupTitle: {
    marginTop: 16,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: '700',
    color: '#D4D4D8',
  },
  presetGrid: {
    gap: 8,
  },
  presetCard: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#232834',
  },
  presetCardActive: {
    backgroundColor: '#1A1F29',
    borderColor: '#F97316',
  },
  presetLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#E4E4E7',
  },
  presetLabelActive: {
    color: '#F97316',
  },
  presetDesc: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 17,
    color: '#9CA3AF',
  },
  togglesCard: {
    borderRadius: 12,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#232834',
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1D222D',
  },
  toggleLabel: {
    flex: 1,
    fontSize: 13,
    color: '#E4E4E7',
    paddingRight: 8,
  },
  musicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  musicSubtext: {
    marginTop: 2,
    fontSize: 11,
    color: '#9CA3AF',
  },
  musicBtn: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#1F2533',
    borderWidth: 1,
    borderColor: '#323A4E',
    justifyContent: 'center',
  },
  musicBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#F4F4F5',
  },
  musicClearBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#272C38',
    alignItems: 'center',
    justifyContent: 'center',
  },
  runAiButton: {
    marginTop: 12,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#1E2430',
    borderWidth: 1,
    borderColor: '#F97316',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  runAiButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#F4F4F5',
  },
  progressCard: {
    marginTop: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#2B3140',
    gap: 10,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  progressStage: {
    fontSize: 13,
    fontWeight: '600',
    color: '#F4F4F5',
    flex: 1,
  },
  progressPct: {
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    color: '#F97316',
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#232834',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#F97316',
  },
  cancelCutBtn: {
    alignSelf: 'flex-start',
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#1E232E',
    justifyContent: 'center',
  },
  cancelCutText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#E4E4E7',
  },
  sectionHeader: {
    marginTop: 22,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#F4F4F5',
  },
  sectionMeta: {
    fontSize: 12,
    color: '#71717A',
  },
  importGrid: {
    gap: 10,
  },
  importCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 68,
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#232834',
  },
  importCardPressed: {
    backgroundColor: '#1B202A',
    borderColor: '#F97316',
  },
  importIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#1D222D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  importTextCol: {
    flex: 1,
  },
  importTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#F4F4F5',
  },
  importDesc: {
    marginTop: 2,
    fontSize: 12,
    color: '#9CA3AF',
  },
  libraryEmpty: {
    padding: 20,
    borderRadius: 14,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#232834',
    alignItems: 'center',
    gap: 8,
  },
  libraryEmptyText: {
    fontSize: 13,
    color: '#9CA3AF',
    textAlign: 'center',
  },
  libraryList: {
    gap: 10,
  },
  libraryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: 14,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#232834',
  },
  libraryRowActive: {
    borderColor: '#F97316',
    backgroundColor: '#191D26',
  },
  thumb: {
    width: 76,
    height: 50,
    borderRadius: 8,
    backgroundColor: '#1E232E',
  },
  thumbFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  libraryInfo: {
    flex: 1,
  },
  libraryName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#F4F4F5',
  },
  libraryMeta: {
    marginTop: 3,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: '#9CA3AF',
  },
  deleteButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  exportSourceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },
  optionRowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chipBtn: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#232834',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipBtnActive: {
    backgroundColor: '#1D222E',
    borderColor: '#F97316',
  },
  chipBtnText: {
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: '#D4D4D8',
  },
  chipBtnTextActive: {
    color: '#F97316',
  },
  smartExportCard: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#2B3140',
    gap: 4,
  },
  exportWarnText: {
    marginTop: 2,
    fontSize: 12,
    color: '#FBBF24',
  },
  exportErrorText: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: '600',
    color: '#FCA5A5',
  },
  galleryNoticeCard: {
    marginTop: 14,
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#10241A',
    borderWidth: 1,
    borderColor: '#166534',
    gap: 12,
  },
  galleryNoticeTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#DCFCE7',
  },
  galleryNoticeMeta: {
    marginTop: 2,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: '#86EFAC',
  },
  galleryActionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  gallerySecondaryBtn: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    backgroundColor: '#1D222D',
    borderWidth: 1,
    borderColor: '#323A4E',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
  },
  gallerySecondaryBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#F4F4F5',
  },
  galleryPrimaryBtn: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    backgroundColor: '#F97316',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
  },
  galleryPrimaryBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#09090B',
  },
  exportedCard: {
    padding: 10,
    borderRadius: 14,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#232834',
    gap: 10,
  },
  exportedTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  galleryFolderText: {
    marginTop: 2,
    fontSize: 11,
    color: '#86EFAC',
  },
});
