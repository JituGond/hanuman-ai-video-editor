import { Linking, PermissionsAndroid, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import type { PermissionCheckResult } from '../types/video';

/**
 * Requests Android gallery / photo library video access via expo-image-picker.
 * On Android 13+ (API 33+), ImagePicker uses the system Photo Picker or READ_MEDIA_VIDEO.
 */
export async function requestGalleryPermission(): Promise<PermissionCheckResult> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return { granted: true, canAskAgain: true };
  }

  const current = await ImagePicker.getMediaLibraryPermissionsAsync();
  if (current.granted) {
    return { granted: true, canAskAgain: true };
  }

  if (!current.canAskAgain) {
    return {
      granted: false,
      canAskAgain: false,
      message: 'Gallery permission was denied. Enable Photos & Videos access in Android App Settings.',
    };
  }

  const requested = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (requested.granted) {
    return { granted: true, canAskAgain: true };
  }

  return {
    granted: false,
    canAskAgain: requested.canAskAgain,
    message: 'Storage access is required to select videos from your device gallery.',
  };
}

/**
 * Requests scoped Android video permission (READ_MEDIA_VIDEO on API 33+,
 * READ_EXTERNAL_STORAGE on API <= 32) via expo-media-library to browse Screen Recordings.
 */
export async function requestScreenRecordingPermission(): Promise<PermissionCheckResult> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return { granted: true, canAskAgain: true };
  }

  const current = await MediaLibrary.getPermissionsAsync(false, ['video']);
  if (current.granted) {
    return { granted: true, canAskAgain: true };
  }

  if (!current.canAskAgain) {
    return {
      granted: false,
      canAskAgain: false,
      message: 'Video media permission is blocked. Open Android Settings and allow Video access.',
    };
  }

  const requested = await MediaLibrary.requestPermissionsAsync(false, ['video']);
  if (requested.granted) {
    return { granted: true, canAskAgain: true };
  }

  return {
    granted: false,
    canAskAgain: requested.canAskAgain,
    message: 'Video media permission is needed to scan your device Screen Recordings folder.',
  };
}

export async function openAndroidAppSettings(): Promise<void> {
  await Linking.openSettings();
}

/**
 * Step 5: Request only necessary permission to save exported MP4 videos to Movies/HanumanAI.
 * - Android 10+ (API 29+): Scoped MediaStore insert requires ZERO runtime storage permissions.
 * - Android 9 and below (API <= 28): Requires WRITE_EXTERNAL_STORAGE only.
 */
export async function requestGallerySavePermission(): Promise<PermissionCheckResult> {
  if (Platform.OS !== 'android') {
    return { granted: true, canAskAgain: true };
  }

  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version) || 30;
  if (apiLevel >= 29) {
    return { granted: true, canAskAgain: true };
  }

  const permission = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
  const alreadyGranted = await PermissionsAndroid.check(permission);
  if (alreadyGranted) {
    return { granted: true, canAskAgain: true };
  }

  const result = await PermissionsAndroid.request(permission, {
    title: 'Save Exported Video to Gallery',
    message: 'Allow saving your exported MP4 video inside Movies/HanumanAI so it appears in Gallery.',
    buttonPositive: 'Allow',
    buttonNegative: 'Deny',
  });

  if (result === PermissionsAndroid.RESULTS.GRANTED) {
    return { granted: true, canAskAgain: true };
  }

  return {
    granted: false,
    canAskAgain: result !== PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
    message:
      result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
        ? 'Storage write permission is disabled. Open Android Settings to allow saving to Movies/HanumanAI.'
        : 'Storage write permission is required on Android 9 and below to save videos to Gallery.',
  };
}
