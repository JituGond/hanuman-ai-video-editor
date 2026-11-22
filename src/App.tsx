import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Film,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  MonitorPlay,
  Music,
  Play,
  Plus,
  RefreshCw,
  Scissors,
  Smartphone,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  CUTTING_PRESET_OPTIONS,
  type CuttingPreset,
  type TimelineSegment,
  type VideoAnalysisReport,
} from '../expo-android/src/types/aiCutting';
import {
  DEFAULT_AUDIO_EDIT_OPTIONS,
  DEFAULT_ENHANCEMENT_TOGGLES,
  EDITING_STYLE_OPTIONS,
  type AudioEditOptions,
  type EditingStyleSelection,
  type VideoEnhancementToggles,
} from '../expo-android/src/types/aiEditing';
import type { VideoImportSource } from '../expo-android/src/types/video';
import {
  COMPRESSION_PRESETS,
  RESOLUTION_SPECS,
  type ExportConfiguration,
  type ExportFps,
} from '../expo-android/src/types/videoExport';
import { buildCutPlan, getPresetLabel } from '../expo-android/src/utils/aiCuttingEngine';
import { getEditingStyleLabel } from '../expo-android/src/utils/aiFullEditorEngine';
import {
  buildExportSignature,
  computeSmartExportSummary,
  findDuplicateExport,
  getCodecLabel,
  getCompressionLabel,
} from '../expo-android/src/utils/exportCalculator';
import {
  formatDuration,
  formatFileSize,
  getSourceLabel,
  isScreenRecordingCandidate,
} from '../expo-android/src/utils/videoValidation';
import { ExpoSourceExplorer } from './components/ExpoSourceExplorer';
import {
  WebComparisonPlayer,
  type PreviewComparisonMode,
} from './components/WebComparisonPlayer';
import { WebVideoTimeline } from './components/WebVideoTimeline';
import { generateFullAiEditedBrowserVideo } from './utils/browserFullEditor';
import {
  detectBrowserExportCapabilities,
  exportBrowserVideoToMp4,
  type BrowserExportProbe,
} from './utils/browserMp4Exporter';
import { analyzeBrowserVideoLocally } from './utils/browserVideoAnalyzer';
import { generateEditedBrowserVideo } from './utils/browserVideoCutter';
import {
  deleteEditedBrowserVideo,
  deleteExportedBrowserVideo,
  deleteFullEditedBrowserVideo,
  deleteLocalBrowserVideo,
  getAllEditedBrowserVideos,
  getAllExportedBrowserVideos,
  getAllFullEditedBrowserVideos,
  getAllLocalBrowserVideos,
  processAndPersistBrowserVideo,
  saveExportedBrowserVideoToGallery,
  type LocalBrowserVideo,
  type LocalEditedBrowserVideo,
  type LocalExportedBrowserVideo,
  type LocalFullEditedBrowserVideo,
} from './utils/localBrowserVideoDb';

interface FilePickerHandle {
  getFile: () => Promise<File>;
}

interface WindowWithFilePicker extends Window {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FilePickerHandle[]>;
}

export default function App() {
  const [videos, setVideos] = useState<LocalBrowserVideo[]>([]);
  const [editedVideos, setEditedVideos] = useState<LocalEditedBrowserVideo[]>([]);
  const [fullEditedVideos, setFullEditedVideos] = useState<LocalFullEditedBrowserVideo[]>([]);
  const [exportedVideos, setExportedVideos] = useState<LocalExportedBrowserVideo[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [selectedExportedId, setSelectedExportedId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewComparisonMode>('original');

  // Step 2 cutting state
  const [selectedPreset, setSelectedPreset] = useState<CuttingPreset>('ai_auto_cut');

  // Step 3 full editing state
  const [styleSelection, setStyleSelection] = useState<EditingStyleSelection>('auto_select');
  const [enhancements, setEnhancements] = useState<VideoEnhancementToggles>(
    DEFAULT_ENHANCEMENT_TOGGLES
  );
  const [audioOptions, setAudioOptions] = useState<AudioEditOptions>(DEFAULT_AUDIO_EDIT_OPTIONS);
  const [musicFile, setMusicFile] = useState<File | null>(null);

  // Step 4 export state
  const [exportSourceTarget, setExportSourceTarget] = useState<'full_edited' | 'cut' | 'original'>(
    'full_edited'
  );
  const [exportConfig, setExportConfig] = useState<ExportConfiguration>({
    resolution: '1080p',
    fps: 30,
    codec: 'h264',
    compression: 'high',
  });
  const [exportProbe, setExportProbe] = useState<BrowserExportProbe | null>(null);

  const [analysisByVideoId, setAnalysisByVideoId] = useState<Record<string, VideoAnalysisReport>>({});
  const [processingState, setProcessingState] = useState<{
    active: boolean;
    progress: number;
    stage: string;
  }>({ active: false, progress: 0, stage: '' });

  const [seekRequest, setSeekRequest] = useState<{ positionMs: number; nonce: number } | null>(null);
  const [playRequest, setPlayRequest] = useState<{ nonce: number } | null>(null);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);

  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [importingSource, setImportingSource] = useState<VideoImportSource | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Step 5: Verified Gallery save notice & Gallery browser drawer
  const [savedGalleryNotice, setSavedGalleryNotice] = useState<{
    record: LocalExportedBrowserVideo;
    alreadySaved: boolean;
    deduplicatedExport: boolean;
  } | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);

  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const screenRecordingInputRef = useRef<HTMLInputElement | null>(null);
  const fileManagerInputRef = useRef<HTMLInputElement | null>(null);
  const musicInputRef = useRef<HTMLInputElement | null>(null);
  const workbenchRef = useRef<HTMLElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const exportMutexRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [stored, storedEdited, storedFullEdited, storedExported] = await Promise.all([
          getAllLocalBrowserVideos(),
          getAllEditedBrowserVideos(),
          getAllFullEditedBrowserVideos(),
          getAllExportedBrowserVideos(),
        ]);
        if (!mounted) return;
        setVideos(stored);
        setEditedVideos(storedEdited);
        setFullEditedVideos(storedFullEdited);
        setExportedVideos(storedExported);
        if (stored.length > 0) {
          setSelectedVideoId(stored[0].id);
        }
      } catch (err) {
        if (!mounted) return;
        setErrorMessage(err instanceof Error ? err.message : 'Unable to read local video storage.');
      } finally {
        if (mounted) setLoadingLibrary(false);
      }
    })();
    return () => {
      mounted = false;
      abortControllerRef.current?.abort();
    };
  }, []);

  const selectedOriginalVideo = videos.find((v) => v.id === selectedVideoId) ?? null;
  const activeCutVideo =
    editedVideos.find((e) => e.sourceVideoId === selectedVideoId) ?? null;
  const activeFullEditedVideo =
    fullEditedVideos.find((e) => e.sourceVideoId === selectedVideoId) ?? null;
  const activeExportedVideo =
    exportedVideos.find((e) => e.id === selectedExportedId) ??
    exportedVideos.find((e) => e.sourceVideoId === selectedVideoId) ??
    null;

  const exportTargetInput =
    exportSourceTarget === 'full_edited' && activeFullEditedVideo
      ? {
          id: activeFullEditedVideo.id,
          name: activeFullEditedVideo.name,
          fileBlob: activeFullEditedVideo.fileBlob,
          thumbnailDataUrl: activeFullEditedVideo.thumbnailDataUrl,
          durationMs: activeFullEditedVideo.durationMs,
        }
      : exportSourceTarget === 'cut' && activeCutVideo
        ? {
            id: activeCutVideo.id,
            name: activeCutVideo.name,
            fileBlob: activeCutVideo.fileBlob,
            thumbnailDataUrl: activeCutVideo.thumbnailDataUrl,
            durationMs: activeCutVideo.durationMs,
          }
        : activeFullEditedVideo && exportSourceTarget === 'full_edited'
          ? {
              id: activeFullEditedVideo.id,
              name: activeFullEditedVideo.name,
              fileBlob: activeFullEditedVideo.fileBlob,
              thumbnailDataUrl: activeFullEditedVideo.thumbnailDataUrl,
              durationMs: activeFullEditedVideo.durationMs,
            }
          : activeCutVideo && exportSourceTarget === 'cut'
            ? {
                id: activeCutVideo.id,
                name: activeCutVideo.name,
                fileBlob: activeCutVideo.fileBlob,
                thumbnailDataUrl: activeCutVideo.thumbnailDataUrl,
                durationMs: activeCutVideo.durationMs,
              }
            : selectedOriginalVideo
              ? {
                  id: selectedOriginalVideo.id,
                  name: selectedOriginalVideo.name,
                  fileBlob: selectedOriginalVideo.fileBlob,
                  thumbnailDataUrl: selectedOriginalVideo.thumbnailDataUrl,
                  durationMs: selectedOriginalVideo.durationMs,
                }
              : null;

  useEffect(() => {
    let active = true;
    if (!exportTargetInput) {
      setExportProbe(null);
      return;
    }
    (async () => {
      try {
        const probe = await detectBrowserExportCapabilities(
          exportTargetInput.fileBlob,
          exportTargetInput.durationMs
        );
        if (!active) return;
        setExportProbe(probe);
        setExportConfig((prev) => {
          let nextRes = prev.resolution;
          if (
            probe.supportedResolutions.length > 0 &&
            !probe.supportedResolutions.includes(nextRes)
          ) {
            nextRes = probe.supportedResolutions.includes('1080p')
              ? '1080p'
              : probe.supportedResolutions[probe.supportedResolutions.length - 1];
          }
          const allowedFps = probe.supportedFpsByResolution[nextRes] ?? [24, 30];
          const nextFps = allowedFps.includes(prev.fps)
            ? prev.fps
            : allowedFps[allowedFps.length - 1] ?? 30;
          const nextCodec = prev.codec === 'h265' && !probe.supportsH265 ? 'h264' : prev.codec;
          return {
            ...prev,
            resolution: nextRes,
            fps: nextFps,
            codec: nextCodec,
          };
        });
      } catch {
        if (active) setExportProbe(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [exportTargetInput?.id]);

  const exportSummary =
    exportTargetInput && exportProbe
      ? computeSmartExportSummary({
          config: exportConfig,
          sourceWidth: exportProbe.sourceWidth,
          sourceHeight: exportProbe.sourceHeight,
          sourceFps: exportProbe.sourceFps,
          durationMs: exportTargetInput.durationMs || exportProbe.sourceDurationMs,
          capabilities: exportProbe,
          hasAudioTrack: exportProbe.hasAudioTrack,
        })
      : null;

  const activeAnalysis =
    (selectedVideoId ? analysisByVideoId[selectedVideoId] : undefined) ??
    activeFullEditedVideo?.analysis ??
    activeCutVideo?.analysis ??
    null;

  const displayedCutPlan = activeAnalysis
    ? activeCutVideo && activeCutVideo.preset === selectedPreset
      ? activeCutVideo.cutPlan
      : buildCutPlan(activeAnalysis, selectedPreset)
    : null;

  const importLocalFile = useCallback(async (file: File, source: VideoImportSource) => {
    setErrorMessage(null);
    setStatusMessage(null);
    setImportingSource(source);

    try {
      const saved = await processAndPersistBrowserVideo(file, source);
      setVideos((prev) => [saved, ...prev.filter((item) => item.id !== saved.id)]);
      setSelectedVideoId(saved.id);
      setPreviewMode('original');
      setActiveSegmentId(null);
      setSeekRequest(null);

      const screenHint =
        source === 'screen_recording' && !isScreenRecordingCandidate({ filename: file.name })
          ? ' (Saved as Screen Recording)'
          : '';
      setStatusMessage(
        `Saved "${saved.name}" (${formatDuration(saved.durationMs)}) locally on this device${screenHint}.`
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not import the selected video.');
    } finally {
      setImportingSource(null);
    }
  }, []);

  const handleFileInputChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
    source: VideoImportSource
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await importLocalFile(file, source);
  };

  const handleMusicInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setMusicFile(file);
    setAudioOptions((prev) => ({
      ...prev,
      backgroundMusicUri: file.name,
      backgroundMusicName: file.name,
    }));
  };

  const handleFileManagerClick = async () => {
    const pickerWindow = window as WindowWithFilePicker;
    if (typeof pickerWindow.showOpenFilePicker === 'function') {
      try {
        const [handle] = await pickerWindow.showOpenFilePicker({
          multiple: false,
          types: [
            {
              description: 'Local Video Files',
              accept: {
                'video/*': ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.3gp'],
              },
            },
          ],
        });
        if (handle) {
          const file = await handle.getFile();
          await importLocalFile(file, 'file_manager');
          return;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
      }
    }
    fileManagerInputRef.current?.click();
  };

  const handleDeleteVideo = async (video: LocalBrowserVideo) => {
    try {
      await deleteLocalBrowserVideo(video.id);
      setVideos((prev) => {
        const next = prev.filter((item) => item.id !== video.id);
        if (selectedVideoId === video.id) {
          setSelectedVideoId(next.length > 0 ? next[0].id : null);
          setPreviewMode('original');
        }
        return next;
      });
      setStatusMessage(`Removed "${video.name}" from local device storage.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to remove local video.');
    }
  };

  const handleDeleteEditedVideo = async (edited: LocalEditedBrowserVideo) => {
    try {
      await deleteEditedBrowserVideo(edited.id);
      setEditedVideos((prev) => prev.filter((item) => item.id !== edited.id));
      if (previewMode === 'cut') {
        setPreviewMode('original');
      }
      setStatusMessage(`Removed AI-cut video "${edited.name}". Original video remains untouched.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to remove edited video.');
    }
  };

  const handleDeleteFullEditedVideo = async (edited: LocalFullEditedBrowserVideo) => {
    try {
      await deleteFullEditedBrowserVideo(edited.id);
      setFullEditedVideos((prev) => prev.filter((item) => item.id !== edited.id));
      if (previewMode === 'full_edited' || previewMode === 'compare') {
        setPreviewMode('original');
      }
      setStatusMessage(`Removed full AI-edited video "${edited.name}". Original remains untouched.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to remove full edited video.');
    }
  };

  const ensureBrowserAnalysis = async (
    video: LocalBrowserVideo,
    signal: AbortSignal
  ): Promise<VideoAnalysisReport> => {
    const cached = analysisByVideoId[video.id];
    if (cached) return cached;

    const report = await analyzeBrowserVideoLocally(
      video,
      (progress, stage) => {
        setProcessingState({
          active: true,
          progress: Math.min(0.4, progress * 0.4),
          stage,
        });
      },
      signal
    );
    setAnalysisByVideoId((prev) => ({
      ...prev,
      [video.id]: report,
    }));
    return report;
  };

  // Step 2: Smart Cutting
  const handleRunAiVideoCut = async () => {
    if (!selectedOriginalVideo) return;
    setErrorMessage(null);
    setStatusMessage(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessingState({
      active: true,
      progress: 0.02,
      stage: 'Analyzing video audio & visual scenes locally...',
    });

    try {
      const report = await ensureBrowserAnalysis(selectedOriginalVideo, controller.signal);
      const editedRecord = await generateEditedBrowserVideo({
        sourceVideo: selectedOriginalVideo,
        analysis: report,
        preset: selectedPreset,
        onProgress: (progress, stage) => {
          setProcessingState({
            active: true,
            progress: 0.42 + progress * 0.58,
            stage,
          });
        },
        signal: controller.signal,
      });

      setEditedVideos((prev) => [editedRecord, ...prev]);
      setPreviewMode('cut');
      setStatusMessage(
        `Generated AI-cut video (${getPresetLabel(selectedPreset)}): ${formatDuration(
          editedRecord.durationMs
        )} from original ${formatDuration(editedRecord.originalDurationMs)}. Original preserved untouched.`
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatusMessage('AI video cutting cancelled. Original video remains untouched.');
      } else {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to generate AI-cut video.');
      }
    } finally {
      abortControllerRef.current = null;
      setProcessingState({ active: false, progress: 0, stage: '' });
    }
  };

  // Step 3: One-Click Full Automatic AI Editing
  const handleStartFullAiEditing = async () => {
    if (!selectedOriginalVideo) return;
    setErrorMessage(null);
    setStatusMessage(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessingState({
      active: true,
      progress: 0.02,
      stage: 'Analyzing complete video for Full AI Editing...',
    });

    try {
      const report = await ensureBrowserAnalysis(selectedOriginalVideo, controller.signal);
      const fullRecord = await generateFullAiEditedBrowserVideo({
        sourceVideo: selectedOriginalVideo,
        analysis: report,
        styleSelection,
        enhancements,
        audioOptions,
        musicFile,
        onProgress: (progress, stage) => {
          setProcessingState({
            active: true,
            progress: 0.42 + progress * 0.58,
            stage,
          });
        },
        signal: controller.signal,
      });

      setFullEditedVideos((prev) => [fullRecord, ...prev]);
      setPreviewMode('full_edited');
      setStatusMessage(
        `AI Full Editing completed (${getEditingStyleLabel(
          fullRecord.editPlan.resolvedStyle
        )}): ${formatDuration(fullRecord.durationMs)} rendered offline. Original preserved untouched.`
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatusMessage('Full AI editing cancelled. Original video remains untouched.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to render full AI-edited video.'
        );
      }
    } finally {
      abortControllerRef.current = null;
      setProcessingState({ active: false, progress: 0, stage: '' });
    }
  };

  const handleCancelProcessing = () => {
    abortControllerRef.current?.abort();
  };

  const handlePreviewSegment = (segment: TimelineSegment) => {
    setActiveSegmentId(segment.id);
    if (previewMode === 'cut' || previewMode === 'full_edited' || previewMode === 'exported') {
      setPreviewMode('original');
    }
    setSeekRequest({ positionMs: segment.startMs, nonce: Date.now() });
  };

  // Step 4 + Step 5: Real MP4 Video Export + Verified Gallery Save (with duplicate/incomplete guards)
  const handleExportMp4 = async () => {
    if (!selectedOriginalVideo || !exportTargetInput || !exportSummary) return;
    if (exportMutexRef.current) return;
    exportMutexRef.current = true;
    setErrorMessage(null);
    setStatusMessage(null);
    setSavedGalleryNotice(null);

    if (!exportSummary.compatible) {
      exportMutexRef.current = false;
      setErrorMessage(
        exportSummary.compatibilityIssues[0] ??
          'Selected export settings are incompatible with device encoder or free storage.'
      );
      return;
    }

    const exportSignature = buildExportSignature({
      sourceTargetId: exportTargetInput.id,
      sourceDurationMs: exportSummary.durationMs,
      width: exportSummary.effectiveWidth,
      height: exportSummary.effectiveHeight,
      fps: exportSummary.effectiveFps,
      codec: exportConfig.codec,
      compression: exportConfig.compression,
    });

    // Prevent duplicate MP4 files for exact same source and export configuration
    const existingDuplicate = findDuplicateExport(exportedVideos, exportSignature);
    if (existingDuplicate) {
      try {
        const galleryOutcome = await saveExportedBrowserVideoToGallery({
          ...existingDuplicate,
          exportSignature,
        });
        setExportedVideos((prev) => [
          galleryOutcome.record,
          ...prev.filter((item) => item.id !== galleryOutcome.record.id),
        ]);
        setSelectedExportedId(galleryOutcome.record.id);
        setPreviewMode('exported');
        setSavedGalleryNotice({
          record: galleryOutcome.record,
          alreadySaved: true,
          deduplicatedExport: true,
        });
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to verify existing export.');
      } finally {
        exportMutexRef.current = false;
      }
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessingState({
      active: true,
      progress: 0.02,
      stage: `Initializing ${exportSummary.effectiveHeight}p ${exportSummary.effectiveFps}fps MP4 encoder...`,
    });

    try {
      const exportedRecord = await exportBrowserVideoToMp4({
        sourceVideoId: selectedOriginalVideo.id,
        sourceName: exportTargetInput.name,
        sourceBlob: exportTargetInput.fileBlob,
        thumbnailDataUrl: exportTargetInput.thumbnailDataUrl,
        config: exportConfig,
        summary: exportSummary,
        onProgress: (progress, stage) => {
          setProcessingState({ active: true, progress: progress * 0.94, stage });
        },
        signal: controller.signal,
      });

      setProcessingState({
        active: true,
        progress: 0.96,
        stage: 'Saving verified MP4 to Gallery (Movies/HanumanAI)...',
      });

      const galleryOutcome = await saveExportedBrowserVideoToGallery({
        ...exportedRecord,
        exportSignature,
      });

      setExportedVideos((prev) => [
        galleryOutcome.record,
        ...prev.filter((item) => item.id !== galleryOutcome.record.id),
      ]);
      setSelectedExportedId(galleryOutcome.record.id);
      setPreviewMode('exported');
      setSavedGalleryNotice({
        record: galleryOutcome.record,
        alreadySaved: galleryOutcome.alreadySaved,
        deduplicatedExport: false,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatusMessage('MP4 export cancelled safely. Incomplete file discarded.');
      } else {
        setErrorMessage(err instanceof Error ? err.message : 'MP4 export failed.');
      }
    } finally {
      abortControllerRef.current = null;
      exportMutexRef.current = false;
      setProcessingState({ active: false, progress: 0, stage: '' });
    }
  };

  const handlePlayExportedVideo = (exported: LocalExportedBrowserVideo) => {
    setGalleryOpen(false);
    setSelectedVideoId(exported.sourceVideoId);
    setSelectedExportedId(exported.id);
    setPreviewMode('exported');
    setPlayRequest({ nonce: Date.now() });
    workbenchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleOpenGallery = () => {
    setGalleryOpen(true);
  };

  const handleDeleteExportedVideo = async (exported: LocalExportedBrowserVideo) => {
    try {
      await deleteExportedBrowserVideo(exported.id);
      setExportedVideos((prev) => prev.filter((item) => item.id !== exported.id));
      if (savedGalleryNotice?.record.id === exported.id) {
        setSavedGalleryNotice(null);
      }
      if (selectedExportedId === exported.id) {
        setSelectedExportedId(null);
        if (previewMode === 'exported') setPreviewMode('original');
      }
      setStatusMessage(`Removed exported MP4 "${exported.name}".`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to remove exported MP4.');
    }
  };

  const handleDownloadExportedRecord = (exported: LocalExportedBrowserVideo) => {
    const url = URL.createObjectURL(exported.fileBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exported.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="min-h-screen bg-[#0B0D12] text-zinc-100">
      {/* Hidden local file inputs for zero-upload on-device browser testing */}
      <input
        ref={galleryInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => void handleFileInputChange(e, 'gallery')}
      />
      <input
        ref={screenRecordingInputRef}
        type="file"
        accept="video/mp4,video/webm,video/quicktime,video/*"
        className="hidden"
        onChange={(e) => void handleFileInputChange(e, 'screen_recording')}
      />
      <input
        ref={fileManagerInputRef}
        type="file"
        accept="video/*,.mp4,.mov,.mkv,.webm,.3gp"
        className="hidden"
        onChange={(e) => void handleFileInputChange(e, 'file_manager')}
      />
      <input
        ref={musicInputRef}
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
        className="hidden"
        onChange={handleMusicInputChange}
      />

      {/* Top Navigation Bar — 3-Zone Contract */}
      <header className="sticky top-0 z-30 border-b border-[#1E222D] bg-[#0B0D12]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 py-3.5 sm:px-6">
          <a
            href="#workbench"
            className="text-base font-bold tracking-tight text-zinc-100 whitespace-nowrap shrink-0 sm:text-lg"
          >
            Hanuman Video Editor
          </a>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-zinc-400">
            <a
              href="#workbench"
              className="transition-colors hover:text-zinc-100 whitespace-nowrap shrink-0"
            >
              AI Studio
            </a>
            <a
              href="#saved-videos"
              className="transition-colors hover:text-zinc-100 whitespace-nowrap shrink-0"
            >
              Saved Videos
            </a>
            <a
              href="#android-code"
              className="transition-colors hover:text-zinc-100 whitespace-nowrap shrink-0"
            >
              Android Source
            </a>
            <a
              href="#device-setup"
              className="transition-colors hover:text-zinc-100 whitespace-nowrap shrink-0"
            >
              Device Setup
            </a>
          </nav>

          <button
            type="button"
            onClick={() => galleryInputRef.current?.click()}
            className="inline-flex min-h-[40px] shrink-0 items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-xs font-semibold text-zinc-950 transition-colors hover:bg-orange-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>Import Video</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {/* Header */}
        <section className="mb-8">
          <p className="text-xs font-medium text-orange-400">
            Steps 1–5 · Import, AI Cutting, Full AI Editing, MP4 Export &amp; Gallery Save
          </p>
          <h1 className="mt-1.5 max-w-2xl text-2xl font-bold tracking-tight text-zinc-100 sm:text-3xl [text-wrap:balance]">
            Offline One-Click AI Video Editor
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
            Import local videos up to 30:00, auto-cut silence and repeated scenes, run Full AI Editing, export MP4s, and save verified playable videos directly into Movies/HanumanAI on Android Gallery.
          </p>
        </section>

        {/* Feedback */}
        {errorMessage && (
          <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-900/70 bg-red-950/40 p-4 text-sm text-red-200">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
            <p>{errorMessage}</p>
          </div>
        )}

        {statusMessage && (
          <div className="mb-6 flex items-start gap-3 rounded-xl border border-emerald-900/70 bg-emerald-950/40 p-4 text-sm text-emerald-200">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
            <p>{statusMessage}</p>
          </div>
        )}

        {/* Step 5: Verified Gallery Save Notification (rendered ONLY after verification + save completes) */}
        {savedGalleryNotice && (
          <div
            role="status"
            className="mb-6 flex flex-col gap-4 rounded-2xl border border-emerald-800/80 bg-[#0F2218] p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
              <div>
                <p className="text-sm font-semibold text-emerald-100">
                  {savedGalleryNotice.alreadySaved || savedGalleryNotice.deduplicatedExport
                    ? 'Already Saved in Gallery (Duplicate Prevented)'
                    : 'Saved to Gallery Successfully'}
                </p>
                <p className="mt-0.5 font-mono text-xs text-emerald-300 tabular-nums">
                  {savedGalleryNotice.record.name} ·{' '}
                  {savedGalleryNotice.record.galleryRelativePath ?? 'Movies/HanumanAI'} ·{' '}
                  {savedGalleryNotice.record.width}x{savedGalleryNotice.record.height} ·{' '}
                  {savedGalleryNotice.record.fps}fps ·{' '}
                  {formatFileSize(savedGalleryNotice.record.fileSizeBytes)}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={handleOpenGallery}
                className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-[#2F3B4D] bg-[#171D28] px-4 py-2 text-xs font-semibold text-zinc-100 transition-colors hover:border-orange-500/70 hover:text-white whitespace-nowrap"
              >
                <ImageIcon className="h-4 w-4 text-orange-400" />
                <span>Open Gallery</span>
              </button>
              <button
                type="button"
                onClick={() => handlePlayExportedVideo(savedGalleryNotice.record)}
                className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-orange-500 px-4 py-2 text-xs font-bold text-zinc-950 transition-colors hover:bg-orange-400 whitespace-nowrap"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>Play Video</span>
              </button>
            </div>
          </div>
        )}

        {/* Active Processing Progress */}
        {processingState.active && (
          <div className="mb-6 rounded-2xl border border-[#2B3140] bg-[#12151C] p-4">
            <div className="flex items-center justify-between gap-4 text-xs">
              <span className="font-medium text-zinc-200">{processingState.stage}</span>
              <div className="flex items-center gap-3">
                <span className="font-mono font-semibold text-orange-400 tabular-nums">
                  {Math.round(processingState.progress * 100)}%
                </span>
                <button
                  type="button"
                  onClick={handleCancelProcessing}
                  className="rounded-lg border border-red-800/70 bg-red-950/50 px-3 py-1 text-xs font-semibold text-red-200 hover:bg-red-900/60"
                >
                  Cancel
                </button>
              </div>
            </div>
            <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-[#232834]">
              <div
                className="h-full bg-orange-500 transition-all duration-150"
                style={{ width: `${Math.round(processingState.progress * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Workbench Split: Preview / Comparison Player + 3 Import Options */}
        <section
          id="workbench"
          ref={workbenchRef}
          className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12"
        >
          <div className="lg:col-span-7">
            <WebComparisonPlayer
              originalVideo={selectedOriginalVideo}
              cutVideo={activeCutVideo}
              fullEditedVideo={activeFullEditedVideo}
              exportedVideo={activeExportedVideo}
              mode={previewMode}
              onModeChange={setPreviewMode}
              seekRequest={seekRequest}
              playRequest={playRequest}
            />
          </div>

          <div className="flex flex-col gap-3 lg:col-span-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-base font-semibold text-zinc-100">
                Select Local Video
              </h2>
              <span className="font-mono text-xs text-zinc-400 tabular-nums">
                Max 30:00
              </span>
            </div>

            <button
              type="button"
              disabled={importingSource !== null || processingState.active}
              onClick={() => galleryInputRef.current?.click()}
              className="flex min-h-[76px] w-full items-center gap-4 rounded-2xl border border-[#232834] bg-[#12151C] p-4 text-left transition-colors hover:border-orange-500/60 hover:bg-[#171B24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:opacity-60"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#1C212C] text-orange-400">
                <ImageIcon className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-zinc-100">
                  {importingSource === 'gallery' ? 'Importing Gallery Video...' : 'Gallery Video'}
                </span>
                <span className="mt-0.5 block text-xs text-zinc-400">
                  Import from local photos &amp; gallery (Expo ImagePicker on Android)
                </span>
              </span>
              <Plus className="h-4 w-4 shrink-0 text-zinc-500" />
            </button>

            <button
              type="button"
              disabled={importingSource !== null || processingState.active}
              onClick={() => screenRecordingInputRef.current?.click()}
              className="flex min-h-[76px] w-full items-center gap-4 rounded-2xl border border-[#232834] bg-[#12151C] p-4 text-left transition-colors hover:border-orange-500/60 hover:bg-[#171B24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:opacity-60"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#1C212C] text-orange-400">
                <MonitorPlay className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-zinc-100">
                  {importingSource === 'screen_recording'
                    ? 'Importing Screen Recording...'
                    : 'Screen Recording Video'}
                </span>
                <span className="mt-0.5 block text-xs text-zinc-400">
                  Select recorded screen captures (MediaLibrary scan on Android)
                </span>
              </span>
              <Plus className="h-4 w-4 shrink-0 text-zinc-500" />
            </button>

            <button
              type="button"
              disabled={importingSource !== null || processingState.active}
              onClick={() => void handleFileManagerClick()}
              className="flex min-h-[76px] w-full items-center gap-4 rounded-2xl border border-[#232834] bg-[#12151C] p-4 text-left transition-colors hover:border-orange-500/60 hover:bg-[#171B24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:opacity-60"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#1C212C] text-orange-400">
                <FolderOpen className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-zinc-100">
                  {importingSource === 'file_manager'
                    ? 'Importing File Manager Video...'
                    : 'File Manager Video'}
                </span>
                <span className="mt-0.5 block text-xs text-zinc-400">
                  Pick any local video file (DocumentPicker / Android SAF)
                </span>
              </span>
              <Plus className="h-4 w-4 shrink-0 text-zinc-500" />
            </button>

            <div className="mt-1 flex items-center gap-2.5 px-1 text-xs text-zinc-400">
              <HardDrive className="h-4 w-4 shrink-0 text-zinc-500" />
              <span>100% local processing · Zero internet or cloud dependency</span>
            </div>
          </div>
        </section>

        {/* Step 3: Full Automatic AI Video Editing */}
        {selectedOriginalVideo && (
          <section className="mt-10 space-y-6 border-t border-[#1E222D] pt-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-medium text-orange-400">
                  Step 3 · One-Click Full Automatic AI Editing
                </p>
                <h2 className="mt-1 text-xl font-bold text-zinc-100">
                  Automatic Video &amp; Audio Studio
                </h2>
                <p className="mt-0.5 text-xs text-zinc-400">
                  Target: {selectedOriginalVideo.name} ·{' '}
                  {formatDuration(selectedOriginalVideo.durationMs)}
                </p>
              </div>

              <button
                type="button"
                disabled={processingState.active}
                onClick={() => void handleStartFullAiEditing()}
                className="inline-flex min-h-[48px] shrink-0 items-center justify-center gap-2.5 rounded-xl bg-orange-500 px-6 py-3 text-sm font-bold tracking-wide text-zinc-950 transition-colors hover:bg-orange-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-60 whitespace-nowrap"
              >
                <Sparkles className="h-4 w-4" />
                <span>
                  {activeFullEditedVideo
                    ? 'START AI FULL EDITING (EDIT AGAIN)'
                    : 'START AI FULL EDITING'}
                </span>
              </button>
            </div>

            {activeFullEditedVideo && (
              <div className="rounded-2xl border border-[#2A3344] bg-[#131822] p-4">
                <p className="text-xs font-semibold text-orange-400">
                  Applied Style: {getEditingStyleLabel(activeFullEditedVideo.editPlan.resolvedStyle)}
                </p>
                <p className="mt-1 text-xs text-zinc-300">
                  {activeFullEditedVideo.editPlan.styleSelectionReason}
                </p>
                <p className="mt-1.5 font-mono text-xs text-zinc-400 tabular-nums">
                  Contrast {activeFullEditedVideo.editPlan.profile.contrastDelta >= 0 ? '+' : ''}
                  {Math.round(activeFullEditedVideo.editPlan.profile.contrastDelta * 100)}% ·
                  Saturation {activeFullEditedVideo.editPlan.profile.saturationDelta >= 0 ? '+' : ''}
                  {activeFullEditedVideo.editPlan.profile.saturationDelta} · Sharpness{' '}
                  {Math.round(activeFullEditedVideo.editPlan.profile.sharpnessAmount * 100)}% ·
                  Stabilization {activeFullEditedVideo.editPlan.profile.stabilizationZoom}x · Voice
                  Gain +{activeFullEditedVideo.editPlan.profile.audioGainDb} dB · High-Pass{' '}
                  {activeFullEditedVideo.editPlan.profile.highPassHz} Hz
                </p>
              </div>
            )}

            {/* Style Choices (AUTO SELECT + 6 Styles) */}
            <div>
              <h3 className="mb-3 text-sm font-semibold text-zinc-200">
                Professional Editing Styles
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {EDITING_STYLE_OPTIONS.map((option) => {
                  const isSelected = styleSelection === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      disabled={processingState.active}
                      onClick={() => setStyleSelection(option.id)}
                      className={`flex flex-col items-start rounded-2xl border p-4 text-left transition-colors ${
                        isSelected
                          ? 'border-orange-500 bg-[#171B24]'
                          : 'border-[#232834] bg-[#12151C] hover:border-[#32394A]'
                      } disabled:opacity-60`}
                    >
                      <span
                        className={`text-sm font-semibold ${
                          isSelected ? 'text-orange-400' : 'text-zinc-100'
                        }`}
                      >
                        {option.label}
                      </span>
                      <span className="mt-1 text-xs leading-relaxed text-zinc-400">
                        {option.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Video Enhancements + Audio Editing */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="rounded-2xl border border-[#232834] bg-[#12151C] p-5">
                <h3 className="text-sm font-semibold text-zinc-100">
                  Automatic Video Enhancement
                </h3>
                <p className="mt-1 text-xs text-zinc-400">
                  GPU WebGL2 shader pipeline (OpenGL ES 2.0 on Android Media3)
                </p>
                <div className="mt-4 divide-y divide-[#1D222D]">
                  {(
                    [
                      ['colourEnhancement', 'Colour Enhancement (Saturation & White Balance)'],
                      ['lightingCorrection', 'Lighting Correction (Exposure Lift)'],
                      ['contrastEnhancement', 'Contrast Enhancement'],
                      ['videoStabilization', 'Video Stabilization (1.05x Overscan Crop)'],
                      ['noiseReduction', 'Noise Reduction (4-Neighbor Spatial Denoise)'],
                      ['visualQualityEnhancement', 'Visual Quality Enhancement (3x3 Unsharp)'],
                    ] as const
                  ).map(([key, label]) => (
                    <label
                      key={key}
                      className="flex min-h-[44px] cursor-pointer items-center justify-between gap-4 py-2"
                    >
                      <span className="text-xs font-medium text-zinc-200">{label}</span>
                      <input
                        type="checkbox"
                        checked={enhancements[key]}
                        disabled={processingState.active}
                        onChange={(e) =>
                          setEnhancements((prev) => ({ ...prev, [key]: e.target.checked }))
                        }
                        className="h-4 w-4 accent-orange-500"
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-[#232834] bg-[#12151C] p-5">
                <h3 className="text-sm font-semibold text-zinc-100">
                  Automatic Audio Editing
                </h3>
                <p className="mt-1 text-xs text-zinc-400">
                  Web Audio DSP chain (Media3 BaseAudioProcessor on Android)
                </p>
                <div className="mt-4 divide-y divide-[#1D222D]">
                  <label className="flex min-h-[44px] cursor-pointer items-center justify-between gap-4 py-2">
                    <span className="text-xs font-medium text-zinc-200">
                      Improve Voice Clarity (2.5 kHz Presence Boost)
                    </span>
                    <input
                      type="checkbox"
                      checked={audioOptions.improveVoiceClarity}
                      disabled={processingState.active}
                      onChange={(e) =>
                        setAudioOptions((prev) => ({
                          ...prev,
                          improveVoiceClarity: e.target.checked,
                        }))
                      }
                      className="h-4 w-4 accent-orange-500"
                    />
                  </label>
                  <label className="flex min-h-[44px] cursor-pointer items-center justify-between gap-4 py-2">
                    <span className="text-xs font-medium text-zinc-200">
                      Reduce Background Noise (85 Hz High-Pass &amp; Gate)
                    </span>
                    <input
                      type="checkbox"
                      checked={audioOptions.reduceBackgroundNoise}
                      disabled={processingState.active}
                      onChange={(e) =>
                        setAudioOptions((prev) => ({
                          ...prev,
                          reduceBackgroundNoise: e.target.checked,
                        }))
                      }
                      className="h-4 w-4 accent-orange-500"
                    />
                  </label>
                  <label className="flex min-h-[44px] cursor-pointer items-center justify-between gap-4 py-2">
                    <span className="text-xs font-medium text-zinc-200">
                      Normalize Audio Volume (Dynamics Compressor)
                    </span>
                    <input
                      type="checkbox"
                      checked={audioOptions.normalizeVolume}
                      disabled={processingState.active}
                      onChange={(e) =>
                        setAudioOptions((prev) => ({
                          ...prev,
                          normalizeVolume: e.target.checked,
                        }))
                      }
                      className="h-4 w-4 accent-orange-500"
                    />
                  </label>
                  <label className="flex min-h-[44px] cursor-pointer items-center justify-between gap-4 py-2">
                    <span className="text-xs font-medium text-zinc-200">
                      Preserve Original Audio Uncolored
                    </span>
                    <input
                      type="checkbox"
                      checked={audioOptions.preserveOriginalAudio}
                      disabled={processingState.active}
                      onChange={(e) =>
                        setAudioOptions((prev) => ({
                          ...prev,
                          preserveOriginalAudio: e.target.checked,
                        }))
                      }
                      className="h-4 w-4 accent-orange-500"
                    />
                  </label>

                  <div className="flex items-center justify-between gap-3 pt-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-zinc-200">
                        Optional Background Music (Local File)
                      </p>
                      <p className="mt-0.5 truncate text-xs text-zinc-400">
                        {musicFile ? musicFile.name : 'No background track selected'}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={processingState.active}
                      onClick={() => musicInputRef.current?.click()}
                      className="inline-flex min-h-[38px] shrink-0 items-center gap-1.5 rounded-lg border border-[#2B3140] bg-[#181C25] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-orange-500/60"
                    >
                      <Music className="h-3.5 w-3.5" />
                      <span>{musicFile ? 'Change' : 'Pick Audio'}</span>
                    </button>
                    {musicFile && (
                      <button
                        type="button"
                        onClick={() => {
                          setMusicFile(null);
                          setAudioOptions((prev) => ({
                            ...prev,
                            backgroundMusicUri: null,
                            backgroundMusicName: null,
                          }));
                        }}
                        aria-label="Remove background music"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#2B3140] bg-[#181C25] text-zinc-400 hover:text-red-400"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Step 2 Preserved: AI Automatic Video Cutting Options & Real Video Timeline */}
        {selectedOriginalVideo && (
          <section className="mt-10 space-y-5 border-t border-[#1E222D] pt-8">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-medium text-zinc-400">Step 2 · Smart Cutting</p>
                <h2 className="mt-0.5 text-lg font-semibold text-zinc-100">
                  AI Automatic Video Cutting
                </h2>
              </div>

              <button
                type="button"
                disabled={processingState.active}
                onClick={() => void handleRunAiVideoCut()}
                className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-orange-500/70 bg-[#181C25] px-5 py-2.5 text-sm font-semibold text-zinc-100 transition-colors hover:bg-[#1F2533] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-60 whitespace-nowrap"
              >
                {activeCutVideo ? (
                  <RefreshCw className="h-4 w-4 text-orange-400" />
                ) : (
                  <Scissors className="h-4 w-4 text-orange-400" />
                )}
                <span>{activeCutVideo ? 'Regenerate AI Cut' : 'Generate AI Cut Video'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {CUTTING_PRESET_OPTIONS.map((option) => {
                const isSelected = selectedPreset === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={processingState.active}
                    onClick={() => setSelectedPreset(option.id)}
                    className={`flex flex-col items-start rounded-2xl border p-4 text-left transition-colors ${
                      isSelected
                        ? 'border-orange-500 bg-[#171B24]'
                        : 'border-[#232834] bg-[#12151C] hover:border-[#32394A]'
                    } disabled:opacity-60`}
                  >
                    <span
                      className={`text-sm font-semibold ${
                        isSelected ? 'text-orange-400' : 'text-zinc-100'
                      }`}
                    >
                      {option.label}
                    </span>
                    <span className="mt-1 text-xs leading-relaxed text-zinc-400">
                      {option.description}
                    </span>
                  </button>
                );
              })}
            </div>

            {activeAnalysis && displayedCutPlan && (
              <WebVideoTimeline
                analysis={activeAnalysis}
                cutPlan={displayedCutPlan}
                activeSegmentId={activeSegmentId}
                onPreviewSegment={handlePreviewSegment}
              />
            )}
          </section>
        )}

        {/* Step 4: Professional Video Quality & Export System */}
        {selectedOriginalVideo && exportTargetInput && (
          <section className="mt-10 space-y-6 border-t border-[#1E222D] pt-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-medium text-orange-400">
                  Step 4 · Professional Video Quality &amp; Export System
                </p>
                <h2 className="mt-1 text-xl font-bold text-zinc-100">
                  Offline MP4 Export
                </h2>
                <p className="mt-0.5 text-xs text-zinc-400">
                  {exportProbe?.encoderSummary ?? 'Inspecting device encoder capabilities...'}
                </p>
              </div>

              <button
                type="button"
                disabled={processingState.active || !(exportSummary?.compatible ?? false)}
                onClick={() => void handleExportMp4()}
                className="inline-flex min-h-[48px] shrink-0 items-center justify-center gap-2.5 rounded-xl bg-orange-500 px-6 py-3 text-sm font-bold tracking-wide text-zinc-950 transition-colors hover:bg-orange-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50 whitespace-nowrap"
              >
                <Download className="h-4 w-4" />
                <span>EXPORT VIDEO</span>
              </button>
            </div>

            {(activeFullEditedVideo || activeCutVideo) && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-1 text-xs font-medium text-zinc-400">Export Source:</span>
                {activeFullEditedVideo && (
                  <button
                    type="button"
                    disabled={processingState.active}
                    onClick={() => setExportSourceTarget('full_edited')}
                    className={`min-h-[38px] rounded-xl border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                      exportTargetInput.id === activeFullEditedVideo.id
                        ? 'border-orange-500 bg-[#171B24] text-orange-400'
                        : 'border-[#232834] bg-[#12151C] text-zinc-300 hover:border-[#32394A]'
                    }`}
                  >
                    Full AI Edit
                  </button>
                )}
                {activeCutVideo && (
                  <button
                    type="button"
                    disabled={processingState.active}
                    onClick={() => setExportSourceTarget('cut')}
                    className={`min-h-[38px] rounded-xl border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                      exportTargetInput.id === activeCutVideo.id
                        ? 'border-orange-500 bg-[#171B24] text-orange-400'
                        : 'border-[#232834] bg-[#12151C] text-zinc-300 hover:border-[#32394A]'
                    }`}
                  >
                    AI Cut
                  </button>
                )}
                <button
                  type="button"
                  disabled={processingState.active}
                  onClick={() => setExportSourceTarget('original')}
                  className={`min-h-[38px] rounded-xl border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                    exportTargetInput.id === selectedOriginalVideo.id
                      ? 'border-orange-500 bg-[#171B24] text-orange-400'
                      : 'border-[#232834] bg-[#12151C] text-zinc-300 hover:border-[#32394A]'
                  }`}
                >
                  Original Video
                </button>
              </div>
            )}

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <div className="space-y-5 lg:col-span-7">
                <div>
                  <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-zinc-300 uppercase">
                    Video Quality
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {RESOLUTION_SPECS.filter(
                      (spec) =>
                        spec.id !== '4k' ||
                        (exportProbe?.supports4K &&
                          exportProbe.supportedResolutions.includes('4k'))
                    ).map((spec) => {
                      const supported =
                        exportProbe?.supportedResolutions.includes(spec.id) ?? true;
                      const isSelected = exportConfig.resolution === spec.id;
                      return (
                        <button
                          key={spec.id}
                          type="button"
                          disabled={processingState.active || !supported}
                          onClick={() => {
                            const nextFpsList =
                              exportProbe?.supportedFpsByResolution[spec.id] ?? [24, 30];
                            setExportConfig((prev) => ({
                              ...prev,
                              resolution: spec.id,
                              fps: nextFpsList.includes(prev.fps)
                                ? prev.fps
                                : nextFpsList[nextFpsList.length - 1] ?? 30,
                            }));
                          }}
                          className={`min-h-[42px] rounded-xl border px-4 py-2 text-xs font-semibold transition-colors tabular-nums ${
                            isSelected
                              ? 'border-orange-500 bg-[#171B24] text-orange-400'
                              : 'border-[#232834] bg-[#12151C] text-zinc-200 hover:border-[#32394A]'
                          } disabled:opacity-40`}
                        >
                          {spec.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <div>
                    <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-zinc-300 uppercase">
                      Frame Rate (FPS)
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {(
                        exportProbe?.supportedFpsByResolution[exportConfig.resolution] ?? [24, 30]
                      ).map((fpsOpt: ExportFps) => {
                        const isSelected = exportConfig.fps === fpsOpt;
                        return (
                          <button
                            key={fpsOpt}
                            type="button"
                            disabled={processingState.active}
                            onClick={() =>
                              setExportConfig((prev) => ({ ...prev, fps: fpsOpt }))
                            }
                            className={`min-h-[42px] rounded-xl border px-4 py-2 text-xs font-semibold transition-colors tabular-nums ${
                              isSelected
                                ? 'border-orange-500 bg-[#171B24] text-orange-400'
                                : 'border-[#232834] bg-[#12151C] text-zinc-200 hover:border-[#32394A]'
                            }`}
                          >
                            {fpsOpt} FPS
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-zinc-300 uppercase">
                      Format &amp; Codec
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={processingState.active}
                        onClick={() =>
                          setExportConfig((prev) => ({ ...prev, codec: 'h264' }))
                        }
                        className={`min-h-[42px] rounded-xl border px-4 py-2 text-xs font-semibold transition-colors ${
                          exportConfig.codec === 'h264'
                            ? 'border-orange-500 bg-[#171B24] text-orange-400'
                            : 'border-[#232834] bg-[#12151C] text-zinc-200 hover:border-[#32394A]'
                        }`}
                      >
                        MP4 · H.264
                      </button>
                      {exportProbe?.supportsH265 && (
                        <button
                          type="button"
                          disabled={processingState.active}
                          onClick={() =>
                            setExportConfig((prev) => ({ ...prev, codec: 'h265' }))
                          }
                          className={`min-h-[42px] rounded-xl border px-4 py-2 text-xs font-semibold transition-colors ${
                            exportConfig.codec === 'h265'
                              ? 'border-orange-500 bg-[#171B24] text-orange-400'
                              : 'border-[#232834] bg-[#12151C] text-zinc-200 hover:border-[#32394A]'
                          }`}
                        >
                          MP4 · H.265
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-zinc-300 uppercase">
                    Export Compression Settings
                  </h3>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {COMPRESSION_PRESETS.map((preset) => {
                      const isSelected = exportConfig.compression === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          disabled={processingState.active}
                          onClick={() =>
                            setExportConfig((prev) => ({ ...prev, compression: preset.id }))
                          }
                          className={`flex flex-col items-start rounded-2xl border p-3.5 text-left transition-colors ${
                            isSelected
                              ? 'border-orange-500 bg-[#171B24]'
                              : 'border-[#232834] bg-[#12151C] hover:border-[#32394A]'
                          }`}
                        >
                          <span
                            className={`text-sm font-semibold ${
                              isSelected ? 'text-orange-400' : 'text-zinc-100'
                            }`}
                          >
                            {preset.label}
                          </span>
                          <span className="mt-1 text-xs leading-relaxed text-zinc-400">
                            {preset.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Smart Export Pre-Flight Summary */}
              <div className="rounded-2xl border border-[#232834] bg-[#12151C] p-5 lg:col-span-5">
                <h3 className="text-sm font-semibold text-zinc-100">
                  Smart Export Pre-Flight
                </h3>
                <p className="mt-1 text-xs text-zinc-400">
                  Target: {exportTargetInput.name}
                </p>

                {exportSummary ? (
                  <dl className="mt-4 divide-y divide-[#1D222D] text-xs">
                    <div className="flex items-center justify-between py-2.5">
                      <dt className="text-zinc-400">Output Resolution</dt>
                      <dd className="font-mono font-semibold text-zinc-100 tabular-nums">
                        {exportSummary.effectiveWidth}x{exportSummary.effectiveHeight}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between py-2.5">
                      <dt className="text-zinc-400">Frame Rate</dt>
                      <dd className="font-mono font-semibold text-zinc-100 tabular-nums">
                        {exportSummary.effectiveFps} FPS
                      </dd>
                    </div>
                    <div className="flex items-center justify-between py-2.5">
                      <dt className="text-zinc-400">Duration</dt>
                      <dd className="font-mono font-semibold text-zinc-100 tabular-nums">
                        {formatDuration(exportSummary.durationMs)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between py-2.5">
                      <dt className="text-zinc-400">Format &amp; Quality</dt>
                      <dd className="font-medium text-zinc-100">
                        {getCodecLabel(exportConfig.codec)} · {getCompressionLabel(exportConfig.compression)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between py-2.5">
                      <dt className="text-zinc-400">Estimated File Size</dt>
                      <dd className="font-mono font-semibold text-orange-400 tabular-nums">
                        {formatFileSize(exportSummary.estimatedFileSizeBytes)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between py-2.5">
                      <dt className="text-zinc-400">Available Storage</dt>
                      <dd className="font-mono font-semibold text-zinc-100 tabular-nums">
                        {exportSummary.availableStorageBytes !== null
                          ? formatFileSize(exportSummary.availableStorageBytes)
                          : 'Device storage OK'}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between py-2.5">
                      <dt className="text-zinc-400">Device Compatibility</dt>
                      <dd
                        className={`font-semibold ${
                          exportSummary.compatible ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {exportSummary.compatible ? 'Ready · Android Gallery MP4' : 'Check issues below'}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-4 text-xs text-zinc-400">
                    Reading source video stream and encoder profiles...
                  </p>
                )}

                {exportSummary?.capNote && (
                  <p className="mt-3 rounded-xl border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-200">
                    {exportSummary.capNote}
                  </p>
                )}

                {exportSummary && !exportSummary.compatible && (
                  <p className="mt-3 rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-xs text-red-200">
                    {exportSummary.compatibilityIssues.join(' ')}
                  </p>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Saved Videos (Original + Step 2 Cut + Step 3 Full AI Edited + Step 4 Exported MP4) */}
        <section id="saved-videos" className="mt-12 space-y-8 border-t border-[#1E222D] pt-10">
          {exportedVideos.length > 0 && (
            <div>
              <div className="mb-4 flex items-baseline justify-between gap-4">
                <h2 className="text-lg font-semibold text-zinc-100">
                  Exported MP4 Videos ({exportedVideos.length})
                </h2>
                <span className="text-xs text-zinc-400">
                  Saved in Movies/HanumanAI · Verified Playable MP4 · Zero Upload
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {exportedVideos.map((exp) => (
                  <div
                    key={exp.id}
                    className={`flex flex-col gap-3 rounded-2xl border p-3.5 transition-colors ${
                      activeExportedVideo?.id === exp.id && previewMode === 'exported'
                        ? 'border-orange-500 bg-[#171B24]'
                        : 'border-[#232834] bg-[#12151C] hover:border-[#32394A]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedVideoId(exp.sourceVideoId);
                          setSelectedExportedId(exp.id);
                          setPreviewMode('exported');
                        }}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none"
                      >
                        {exp.thumbnailDataUrl ? (
                          <img
                            src={exp.thumbnailDataUrl}
                            alt={`Thumbnail of ${exp.name}`}
                            referrerPolicy="no-referrer"
                            className="h-14 w-24 shrink-0 rounded-lg border border-[#252B37] object-cover"
                          />
                        ) : (
                          <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded-lg border border-[#252B37] bg-[#181C25] text-orange-400">
                            <Film className="h-5 w-5" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-zinc-100">
                            {exp.name}
                          </p>
                          <p className="mt-1 truncate font-mono text-xs text-zinc-400 tabular-nums">
                            {exp.width}x{exp.height} · {exp.fps}fps · {exp.codec.toUpperCase()} ·{' '}
                            {formatDuration(exp.durationMs)} · {formatFileSize(exp.fileSizeBytes)}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-emerald-400">
                            {exp.galleryRelativePath ?? 'Movies/HanumanAI'}
                          </p>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDownloadExportedRecord(exp)}
                        aria-label={`Download ${exp.name}`}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-300 transition-colors hover:bg-[#232834] hover:text-orange-400"
                      >
                        <Download className="h-4 w-4" />
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleDeleteExportedVideo(exp)}
                        aria-label={`Delete ${exp.name}`}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-[#232834] hover:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>

                    <div className="flex items-center gap-2 border-t border-[#1E232F] pt-3">
                      <button
                        type="button"
                        onClick={handleOpenGallery}
                        className="inline-flex min-h-[40px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-[#2B3140] bg-[#181C25] px-3 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:border-orange-500/60 hover:text-white whitespace-nowrap"
                      >
                        <ImageIcon className="h-3.5 w-3.5 text-orange-400" />
                        <span>Open Gallery</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePlayExportedVideo(exp)}
                        className="inline-flex min-h-[40px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-orange-500 px-3 py-2 text-xs font-bold text-zinc-950 transition-colors hover:bg-orange-400 whitespace-nowrap"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                        <span>Play Video</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {fullEditedVideos.length > 0 && (
            <div>
              <div className="mb-4 flex items-baseline justify-between gap-4">
                <h2 className="text-lg font-semibold text-zinc-100">
                  Full AI-Edited Videos ({fullEditedVideos.length})
                </h2>
                <span className="text-xs text-zinc-400">
                  Rendered locally · Original preserved unchanged
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {fullEditedVideos.map((edited) => (
                  <div
                    key={edited.id}
                    className={`flex items-center gap-3 rounded-2xl border p-3 transition-colors ${
                      activeFullEditedVideo?.id === edited.id && previewMode === 'full_edited'
                        ? 'border-orange-500 bg-[#171B24]'
                        : 'border-[#232834] bg-[#12151C] hover:border-[#32394A]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedVideoId(edited.sourceVideoId);
                        setPreviewMode('full_edited');
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none"
                    >
                      {edited.thumbnailDataUrl ? (
                        <img
                          src={edited.thumbnailDataUrl}
                          alt={`Thumbnail of ${edited.name}`}
                          referrerPolicy="no-referrer"
                          className="h-14 w-24 shrink-0 rounded-lg border border-[#252B37] object-cover"
                        />
                      ) : (
                        <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded-lg border border-[#252B37] bg-[#181C25] text-orange-400">
                          <Sparkles className="h-5 w-5" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-zinc-100">
                          {edited.name}
                        </p>
                        <p className="mt-1 truncate font-mono text-xs text-zinc-400 tabular-nums">
                          {formatDuration(edited.durationMs)} (from{' '}
                          {formatDuration(edited.originalDurationMs)}) ·{' '}
                          {formatFileSize(edited.fileSizeBytes)}
                        </p>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleDeleteFullEditedVideo(edited)}
                      aria-label={`Delete ${edited.name}`}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-[#232834] hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {editedVideos.length > 0 && (
            <div>
              <div className="mb-4 flex items-baseline justify-between gap-4">
                <h2 className="text-lg font-semibold text-zinc-100">
                  AI-Cut Videos ({editedVideos.length})
                </h2>
                <span className="text-xs text-zinc-400">
                  Generated locally · Original preserved unchanged
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {editedVideos.map((edited) => (
                  <div
                    key={edited.id}
                    className={`flex items-center gap-3 rounded-2xl border p-3 transition-colors ${
                      activeCutVideo?.id === edited.id && previewMode === 'cut'
                        ? 'border-orange-500 bg-[#171B24]'
                        : 'border-[#232834] bg-[#12151C] hover:border-[#32394A]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedVideoId(edited.sourceVideoId);
                        setPreviewMode('cut');
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none"
                    >
                      {edited.thumbnailDataUrl ? (
                        <img
                          src={edited.thumbnailDataUrl}
                          alt={`Thumbnail of ${edited.name}`}
                          referrerPolicy="no-referrer"
                          className="h-14 w-24 shrink-0 rounded-lg border border-[#252B37] object-cover"
                        />
                      ) : (
                        <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded-lg border border-[#252B37] bg-[#181C25] text-orange-400">
                          <Scissors className="h-5 w-5" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-zinc-100">
                          {edited.name}
                        </p>
                        <p className="mt-1 truncate font-mono text-xs text-zinc-400 tabular-nums">
                          {formatDuration(edited.durationMs)} (from{' '}
                          {formatDuration(edited.originalDurationMs)}) ·{' '}
                          {formatFileSize(edited.fileSizeBytes)}
                        </p>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleDeleteEditedVideo(edited)}
                      aria-label={`Delete ${edited.name}`}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-[#232834] hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <h2 className="text-lg font-semibold text-zinc-100">
                Imported on Device ({videos.length})
              </h2>
              <span className="text-xs text-zinc-400">
                Original source files · Persists locally
              </span>
            </div>

            {loadingLibrary ? (
              <div className="rounded-2xl border border-[#232834] bg-[#12151C] p-8 text-center text-sm text-zinc-400">
                Reading local device library...
              </div>
            ) : videos.length === 0 ? (
              <div className="rounded-2xl border border-[#232834] bg-[#12151C] p-8 text-center text-sm text-zinc-400">
                No videos imported on this device yet. Choose Gallery Video, Screen Recording Video, or File Manager Video above to start.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {videos.map((video) => {
                  const isSelected = video.id === selectedVideoId && previewMode === 'original';
                  return (
                    <div
                      key={video.id}
                      className={`flex items-center gap-3 rounded-2xl border p-3 transition-colors ${
                        isSelected
                          ? 'border-orange-500 bg-[#171B24]'
                          : 'border-[#232834] bg-[#12151C] hover:border-[#32394A]'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedVideoId(video.id);
                          setPreviewMode('original');
                          setActiveSegmentId(null);
                          setSeekRequest(null);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none"
                      >
                        {video.thumbnailDataUrl ? (
                          <img
                            src={video.thumbnailDataUrl}
                            alt={`Thumbnail of ${video.name}`}
                            referrerPolicy="no-referrer"
                            className="h-14 w-24 shrink-0 rounded-lg border border-[#252B37] object-cover"
                          />
                        ) : (
                          <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded-lg border border-[#252B37] bg-[#181C25] text-zinc-500">
                            <Film className="h-5 w-5" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-zinc-100">
                            {video.name}
                          </p>
                          <p className="mt-1 truncate font-mono text-xs text-zinc-400 tabular-nums">
                            {formatDuration(video.durationMs)} · {getSourceLabel(video.source)} ·{' '}
                            {formatFileSize(video.fileSizeBytes)}
                          </p>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleDeleteVideo(video)}
                        aria-label={`Delete ${video.name}`}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-[#232834] hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* Native Android React Native + Expo + Media3 Source Explorer */}
        <section id="android-code" className="mt-12 border-t border-[#1E222D] pt-10">
          <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
            <h2 className="text-lg font-semibold text-zinc-100">
              Native Android Source (React Native + Expo + Media3 Effects &amp; Audio DSP)
            </h2>
            <span className="font-mono text-xs text-zinc-400">
              expo-android/ · Kotlin Media3 · 6GB RAM Optimized
            </span>
          </div>
          <ExpoSourceExplorer />
        </section>

        {/* Real Android Device Verification Guide */}
        <section id="device-setup" className="mt-12 border-t border-[#1E222D] pt-10">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <div className="flex items-center gap-2.5 text-zinc-100">
                <Smartphone className="h-5 w-5 text-orange-400" />
                <h2 className="text-lg font-semibold">
                  Test Pro MP4 Export on Android
                </h2>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                Step 4 queries Android <code className="font-mono text-zinc-200">MediaCodecList</code> and <code className="font-mono text-zinc-200">StatFs</code> inside <code className="font-mono text-zinc-200">HanumanVideoCutterModule.kt</code>, runs hardware Media3 <code className="font-mono text-zinc-200">Transformer</code> export (360p–4K, 24/30/60 FPS, H.264/H.265, AAC audio) with zero upscaling, and saves playable MP4 files straight to Android Gallery.
              </p>
            </div>

            <div className="rounded-2xl border border-[#232834] bg-[#12151C] p-5 lg:col-span-7">
              <ol className="space-y-4 text-sm text-zinc-300">
                <li>
                  <span className="font-semibold text-zinc-100">1. Install Android Expo dependencies</span>
                  <pre className="mt-1.5 overflow-x-auto rounded-lg border border-[#232834] bg-[#0B0D12] p-3 font-mono text-xs text-zinc-300">
                    cd expo-android &amp;&amp; npm install
                  </pre>
                </li>
                <li>
                  <span className="font-semibold text-zinc-100">2. Run Steps 1–4 unit tests</span>
                  <pre className="mt-1.5 overflow-x-auto rounded-lg border border-[#232834] bg-[#0B0D12] p-3 font-mono text-xs text-zinc-300">
                    npm test
                  </pre>
                </li>
                <li>
                  <span className="font-semibold text-zinc-100">3. Compile &amp; install native Android build</span>
                  <pre className="mt-1.5 overflow-x-auto rounded-lg border border-[#232834] bg-[#0B0D12] p-3 font-mono text-xs text-zinc-300">
                    npx expo prebuild --platform android &amp;&amp; npx expo run:android
                  </pre>
                </li>
              </ol>
            </div>
          </div>
        </section>
      </main>

      {/* Step 5: Movies/HanumanAI Saved Gallery Modal */}
      {galleryOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="hanuman-gallery-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
        >
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[#2B3140] bg-[#12151C]">
            <div className="flex items-center justify-between gap-4 border-b border-[#232834] px-5 py-4">
              <div>
                <h2 id="hanuman-gallery-title" className="text-base font-semibold text-zinc-100">
                  Saved Video Gallery (Movies/HanumanAI)
                </h2>
                <p className="mt-0.5 text-xs text-zinc-400">
                  Verified playable MP4 exports saved offline · {exportedVideos.length} file
                  {exportedVideos.length === 1 ? '' : 's'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setGalleryOpen(false)}
                aria-label="Close Gallery"
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#2B3140] bg-[#181C25] text-zinc-300 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              {exportedVideos.length === 0 ? (
                <p className="py-10 text-center text-sm text-zinc-400">
                  No exported MP4 videos saved in Movies/HanumanAI yet.
                </p>
              ) : (
                exportedVideos.map((exp) => (
                  <div
                    key={exp.id}
                    className="flex flex-col gap-3 rounded-2xl border border-[#232834] bg-[#0E1117] p-3.5 sm:flex-row sm:items-center"
                  >
                    {exp.thumbnailDataUrl ? (
                      <img
                        src={exp.thumbnailDataUrl}
                        alt={`Gallery preview of ${exp.name}`}
                        referrerPolicy="no-referrer"
                        className="h-16 w-28 shrink-0 rounded-lg border border-[#252B37] object-cover"
                      />
                    ) : (
                      <div className="flex h-16 w-28 shrink-0 items-center justify-center rounded-lg border border-[#252B37] bg-[#181C25] text-orange-400">
                        <Film className="h-5 w-5" />
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-zinc-100">{exp.name}</p>
                      <p className="mt-0.5 truncate font-mono text-xs text-zinc-400 tabular-nums">
                        {exp.width}x{exp.height} · {exp.fps}fps · {exp.codec.toUpperCase()} ·{' '}
                        {formatDuration(exp.durationMs)} · {formatFileSize(exp.fileSizeBytes)}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-xs text-emerald-400 tabular-nums">
                        {exp.galleryRelativePath ?? 'Movies/HanumanAI'}
                        {exp.contentHash ? ` · sha256:${exp.contentHash.slice(0, 8)}` : ''}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleDownloadExportedRecord(exp)}
                        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-[#2B3140] bg-[#181C25] px-3 py-2 text-xs font-semibold text-zinc-200 hover:border-orange-500/60 whitespace-nowrap"
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span>Save MP4</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePlayExportedVideo(exp)}
                        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-orange-500 px-3.5 py-2 text-xs font-bold text-zinc-950 hover:bg-orange-400 whitespace-nowrap"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                        <span>Play Video</span>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
