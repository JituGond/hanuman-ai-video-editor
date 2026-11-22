import { EventSubscription, requireOptionalNativeModule } from 'expo-modules-core';
import type { AnalysisWindow } from '../../src/types/aiCutting';
import type { ComputedEnhancementProfile } from '../../src/types/aiEditing';
import type {
  DeviceExportCapabilities,
  ExportCodec,
  ExportCompressionPreset,
  ExportFps,
} from '../../src/types/videoExport';

export interface NativeProgressEvent {
  progress: number;
  stage: string;
}

export interface NativeAnalysisResponse {
  totalDurationMs: number;
  hasAudioTrack: boolean;
  windows: AnalysisWindow[];
}

export interface NativeCutSegmentInput {
  startMs: number;
  endMs: number;
  transitionIn?: 'none' | 'crossfade' | 'dip_black';
}

export interface NativeCutResponse {
  outputUri: string;
  durationMs: number;
  fileSizeBytes: number;
}

export interface NativeExportCapabilitiesResponse extends DeviceExportCapabilities {
  sourceWidth: number;
  sourceHeight: number;
  sourceFps: number;
  sourceDurationMs: number;
  hasAudioTrack: boolean;
}

export interface NativeExportOptionsInput {
  targetWidth: number;
  targetHeight: number;
  targetFps: ExportFps;
  sourceWidth: number;
  sourceHeight: number;
  sourceFps: number;
  codec: ExportCodec;
  compression: ExportCompressionPreset;
  videoBitrateBps: number;
  estimatedFileSizeBytes: number;
}

export interface NativeGallerySaveResponse {
  contentUri: string;
  filePath: string;
  relativePath: string;
  displayName: string;
  fileSizeBytes: number;
  contentHash: string;
  alreadySaved: boolean;
  verifiedPlayable: boolean;
}

interface HanumanVideoCutterNativeModule {
  analyzeVideo(inputUri: string): Promise<NativeAnalysisResponse>;
  cutAndJoinVideo(
    inputUri: string,
    outputPath: string,
    segments: NativeCutSegmentInput[]
  ): Promise<NativeCutResponse>;
  fullAiEditVideo(
    inputUri: string,
    outputPath: string,
    segments: NativeCutSegmentInput[],
    profile: ComputedEnhancementProfile,
    musicUri: string | null,
    musicVolume: number
  ): Promise<NativeCutResponse>;
  getDeviceExportCapabilities(inputUri: string): Promise<NativeExportCapabilitiesResponse>;
  exportVideo(
    inputUri: string,
    outputPath: string,
    options: NativeExportOptionsInput
  ): Promise<NativeCutResponse>;
  saveVideoToGallery(
    localFilePath: string,
    displayName: string,
    expectedContentHash: string | null
  ): Promise<NativeGallerySaveResponse>;
  verifyMediaStoreVideo(contentUri: string): Promise<boolean>;
  openAndroidGallery(contentUri: string | null): Promise<boolean>;
  playVideoInAndroidPlayer(videoUri: string): Promise<boolean>;
  cancelProcessing(): void;
  addListener(
    eventName: 'onAnalysisProgress' | 'onCuttingProgress' | 'onExportProgress',
    listener: (event: NativeProgressEvent) => void
  ): EventSubscription;
}

const nativeModule = requireOptionalNativeModule<HanumanVideoCutterNativeModule>('HanumanVideoCutter');

export function isNativeVideoCutterAvailable(): boolean {
  return nativeModule !== null;
}

export async function analyzeVideoOnAndroid(inputUri: string): Promise<NativeAnalysisResponse> {
  if (!nativeModule) {
    throw new Error(
      'Native Android video cutter module is unavailable. Run via an Expo Android Development Build (npx expo run:android).'
    );
  }
  return nativeModule.analyzeVideo(inputUri);
}

export async function cutAndJoinVideoOnAndroid(
  inputUri: string,
  outputPath: string,
  segments: NativeCutSegmentInput[]
): Promise<NativeCutResponse> {
  if (!nativeModule) {
    throw new Error(
      'Native Android video cutter module is unavailable. Run via an Expo Android Development Build (npx expo run:android).'
    );
  }
  return nativeModule.cutAndJoinVideo(inputUri, outputPath, segments);
}

export async function fullAiEditVideoOnAndroid(
  inputUri: string,
  outputPath: string,
  segments: NativeCutSegmentInput[],
  profile: ComputedEnhancementProfile,
  musicUri: string | null,
  musicVolume: number
): Promise<NativeCutResponse> {
  if (!nativeModule) {
    throw new Error(
      'Native Android AI editor module is unavailable. Run via an Expo Android Development Build (npx expo run:android).'
    );
  }
  return nativeModule.fullAiEditVideo(
    inputUri,
    outputPath,
    segments,
    profile,
    musicUri,
    musicVolume
  );
}

export async function getAndroidExportCapabilities(
  inputUri: string
): Promise<NativeExportCapabilitiesResponse> {
  if (!nativeModule) {
    throw new Error(
      'Native Android export module is unavailable. Run via an Expo Android Development Build (npx expo run:android).'
    );
  }
  return nativeModule.getDeviceExportCapabilities(inputUri);
}

export async function exportVideoOnAndroid(
  inputUri: string,
  outputPath: string,
  options: NativeExportOptionsInput
): Promise<NativeCutResponse> {
  if (!nativeModule) {
    throw new Error(
      'Native Android export module is unavailable. Run via an Expo Android Development Build (npx expo run:android).'
    );
  }
  return nativeModule.exportVideo(inputUri, outputPath, options);
}

export function cancelAndroidVideoProcessing(): void {
  nativeModule?.cancelProcessing();
}

export function subscribeAnalysisProgress(
  listener: (event: NativeProgressEvent) => void
): EventSubscription | null {
  return nativeModule ? nativeModule.addListener('onAnalysisProgress', listener) : null;
}

export function subscribeCuttingProgress(
  listener: (event: NativeProgressEvent) => void
): EventSubscription | null {
  return nativeModule ? nativeModule.addListener('onCuttingProgress', listener) : null;
}

export function subscribeExportProgress(
  listener: (event: NativeProgressEvent) => void
): EventSubscription | null {
  return nativeModule ? nativeModule.addListener('onExportProgress', listener) : null;
}

export async function saveVideoToAndroidGallery(
  localFilePath: string,
  displayName: string,
  expectedContentHash: string | null = null
): Promise<NativeGallerySaveResponse> {
  if (!nativeModule) {
    throw new Error(
      'Native Android MediaStore module is unavailable. Run via an Expo Android Development Build (npx expo run:android).'
    );
  }
  return nativeModule.saveVideoToGallery(localFilePath, displayName, expectedContentHash);
}

export async function verifyAndroidGalleryVideo(contentUri: string): Promise<boolean> {
  if (!nativeModule) return false;
  return nativeModule.verifyMediaStoreVideo(contentUri);
}

export async function openAndroidGalleryApp(contentUri: string | null = null): Promise<boolean> {
  if (!nativeModule) {
    throw new Error(
      'Opening Android Gallery requires the native Android build (npx expo run:android).'
    );
  }
  return nativeModule.openAndroidGallery(contentUri);
}

export async function playVideoInAndroidSystemPlayer(videoUri: string): Promise<boolean> {
  if (!nativeModule) {
    throw new Error(
      'Launching an external Android video player requires the native Android build (npx expo run:android).'
    );
  }
  return nativeModule.playVideoInAndroidPlayer(videoUri);
}
