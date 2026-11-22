import { useState } from 'react';
import { Check, Copy, FileCode2 } from 'lucide-react';
import appTsxRaw from '../../expo-android/App.tsx?raw';
import appJsonRaw from '../../expo-android/app.json?raw';
import packageJsonRaw from '../../expo-android/package.json?raw';
import nativeCutterKtRaw from '../../expo-android/modules/hanuman-video-cutter/android/src/main/java/com/hanuman/videocutter/HanumanVideoCutterModule.kt?raw';
import audioProcessorKtRaw from '../../expo-android/modules/hanuman-video-cutter/android/src/main/java/com/hanuman/videocutter/HanumanAudioEnhanceProcessor.kt?raw';
import glEffectKtRaw from '../../expo-android/modules/hanuman-video-cutter/android/src/main/java/com/hanuman/videocutter/HanumanEnhanceGlEffect.kt?raw';
import nativeManifestRaw from '../../expo-android/modules/hanuman-video-cutter/android/src/main/AndroidManifest.xml?raw';
import nativeCutterIndexRaw from '../../expo-android/modules/hanuman-video-cutter/index.ts?raw';
import videoExportTypesRaw from '../../expo-android/src/types/videoExport.ts?raw';
import exportCalculatorRaw from '../../expo-android/src/utils/exportCalculator.ts?raw';
import videoExportServiceRaw from '../../expo-android/src/services/videoExportService.ts?raw';
import aiFullEditorEngineRaw from '../../expo-android/src/utils/aiFullEditorEngine.ts?raw';
import aiFullEditingServiceRaw from '../../expo-android/src/services/aiFullEditingService.ts?raw';
import aiCuttingEngineRaw from '../../expo-android/src/utils/aiCuttingEngine.ts?raw';
import aiCuttingServiceRaw from '../../expo-android/src/services/aiVideoCuttingService.ts?raw';
import videoTimelineRaw from '../../expo-android/src/components/VideoTimeline.tsx?raw';
import videoImportersRaw from '../../expo-android/src/services/videoImporters.ts?raw';
import localVideoStorageRaw from '../../expo-android/src/services/localVideoStorage.ts?raw';
import androidPermissionsRaw from '../../expo-android/src/services/androidPermissions.ts?raw';
import videoPreviewPlayerRaw from '../../expo-android/src/components/VideoPreviewPlayer.tsx?raw';
import screenRecordingModalRaw from '../../expo-android/src/components/ScreenRecordingPickerModal.tsx?raw';
import videoValidationRaw from '../../expo-android/src/utils/videoValidation.ts?raw';
import videoExportTestRaw from '../../expo-android/__tests__/videoExport.test.ts?raw';
import aiFullEditingTestRaw from '../../expo-android/__tests__/aiFullEditing.test.ts?raw';
import aiCuttingTestRaw from '../../expo-android/__tests__/aiCutting.test.ts?raw';
import videoModuleTestRaw from '../../expo-android/__tests__/videoModule.test.ts?raw';

interface SourceFileEntry {
  path: string;
  content: string;
}

const EXPO_SOURCE_FILES: SourceFileEntry[] = [
  { path: 'expo-android/App.tsx', content: appTsxRaw },
  { path: 'expo-android/modules/hanuman-video-cutter/android/src/main/java/com/hanuman/videocutter/HanumanVideoCutterModule.kt', content: nativeCutterKtRaw },
  { path: 'expo-android/modules/hanuman-video-cutter/android/src/main/java/com/hanuman/videocutter/HanumanAudioEnhanceProcessor.kt', content: audioProcessorKtRaw },
  { path: 'expo-android/modules/hanuman-video-cutter/android/src/main/java/com/hanuman/videocutter/HanumanEnhanceGlEffect.kt', content: glEffectKtRaw },
  { path: 'expo-android/modules/hanuman-video-cutter/android/src/main/AndroidManifest.xml', content: nativeManifestRaw },
  { path: 'expo-android/modules/hanuman-video-cutter/index.ts', content: nativeCutterIndexRaw },
  { path: 'expo-android/src/types/videoExport.ts', content: videoExportTypesRaw },
  { path: 'expo-android/src/utils/exportCalculator.ts', content: exportCalculatorRaw },
  { path: 'expo-android/src/services/videoExportService.ts', content: videoExportServiceRaw },
  { path: 'expo-android/src/utils/aiFullEditorEngine.ts', content: aiFullEditorEngineRaw },
  { path: 'expo-android/src/services/aiFullEditingService.ts', content: aiFullEditingServiceRaw },
  { path: 'expo-android/src/utils/aiCuttingEngine.ts', content: aiCuttingEngineRaw },
  { path: 'expo-android/src/services/aiVideoCuttingService.ts', content: aiCuttingServiceRaw },
  { path: 'expo-android/src/components/VideoTimeline.tsx', content: videoTimelineRaw },
  { path: 'expo-android/app.json', content: appJsonRaw },
  { path: 'expo-android/package.json', content: packageJsonRaw },
  { path: 'expo-android/src/services/videoImporters.ts', content: videoImportersRaw },
  { path: 'expo-android/src/services/localVideoStorage.ts', content: localVideoStorageRaw },
  { path: 'expo-android/src/services/androidPermissions.ts', content: androidPermissionsRaw },
  { path: 'expo-android/src/components/VideoPreviewPlayer.tsx', content: videoPreviewPlayerRaw },
  { path: 'expo-android/src/components/ScreenRecordingPickerModal.tsx', content: screenRecordingModalRaw },
  { path: 'expo-android/src/utils/videoValidation.ts', content: videoValidationRaw },
  { path: 'expo-android/__tests__/videoExport.test.ts', content: videoExportTestRaw },
  { path: 'expo-android/__tests__/aiFullEditing.test.ts', content: aiFullEditingTestRaw },
  { path: 'expo-android/__tests__/aiCutting.test.ts', content: aiCuttingTestRaw },
  { path: 'expo-android/__tests__/videoModule.test.ts', content: videoModuleTestRaw },
];

export function ExpoSourceExplorer() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const activeFile = EXPO_SOURCE_FILES[activeIndex];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopiedPath(activeFile.path);
      window.setTimeout(() => setCopiedPath(null), 1800);
    } catch {
      // Clipboard access denied
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-[#232834] bg-[#12151C]">
      <div className="grid grid-cols-1 lg:grid-cols-12">
        <div className="max-h-[540px] overflow-y-auto border-b border-[#232834] bg-[#0E1117] p-3 lg:col-span-4 lg:border-b-0 lg:border-r">
          <p className="px-2 pb-2 text-xs font-medium text-zinc-400">
            React Native + Expo + Media3 Files
          </p>
          <div className="flex flex-col gap-1">
            {EXPO_SOURCE_FILES.map((file, idx) => {
              const isActive = idx === activeIndex;
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setActiveIndex(idx)}
                  className={`flex min-h-[38px] items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-[#1D222D] font-semibold text-zinc-100'
                      : 'text-zinc-400 hover:bg-[#171B24] hover:text-zinc-200'
                  }`}
                >
                  <FileCode2 className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-orange-400' : 'text-zinc-500'}`} />
                  <span className="truncate font-mono">{file.path}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col lg:col-span-8">
          <div className="flex items-center justify-between gap-4 border-b border-[#232834] px-4 py-3">
            <span className="truncate font-mono text-xs text-zinc-300">
              {activeFile.path}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-[#2B3140] bg-[#181C25] px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-orange-500/60 hover:text-white whitespace-nowrap"
            >
              {copiedPath === activeFile.path ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>
          <pre className="max-h-[488px] overflow-auto p-4 font-mono text-xs leading-relaxed text-zinc-300">
            <code>{activeFile.content}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
