import React, { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { ScreenRecordingCandidate } from '../types/video';
import { formatDuration, MAX_VIDEO_DURATION_MS } from '../utils/videoValidation';

interface ScreenRecordingPickerModalProps {
  visible: boolean;
  loading: boolean;
  screenRecordings: ScreenRecordingCandidate[];
  allVideos: ScreenRecordingCandidate[];
  onSelect: (candidate: ScreenRecordingCandidate) => void;
  onClose: () => void;
}

export function ScreenRecordingPickerModal({
  visible,
  loading,
  screenRecordings,
  allVideos,
  onSelect,
  onClose,
}: ScreenRecordingPickerModalProps) {
  const [showAllVideos, setShowAllVideos] = useState(false);

  const items = showAllVideos ? allVideos : screenRecordings;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <View style={styles.headerTitleCol}>
            <Text style={styles.title}>Screen Recording Video</Text>
            <Text style={styles.subtitle}>
              On-device recordings up to 30:00
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            style={styles.closeBtn}
            accessibilityRole="button"
            accessibilityLabel="Close screen recordings"
          >
            <Ionicons name="close" size={22} color="#F4F4F5" />
          </Pressable>
        </View>

        <View style={styles.filterBar}>
          <Pressable
            onPress={() => setShowAllVideos(false)}
            style={[styles.filterTab, !showAllVideos && styles.filterTabActive]}
          >
            <Text style={[styles.filterText, !showAllVideos && styles.filterTextActive]}>
              Screen Recordings ({screenRecordings.length})
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setShowAllVideos(true)}
            style={[styles.filterTab, showAllVideos && styles.filterTabActive]}
          >
            <Text style={[styles.filterText, showAllVideos && styles.filterTextActive]}>
              All Device Videos ({allVideos.length})
            </Text>
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.centerState}>
            <ActivityIndicator size="large" color="#F97316" />
            <Text style={styles.stateText}>Scanning device video folders...</Text>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.centerState}>
            <Ionicons name="videocam-off-outline" size={36} color="#71717A" />
            <Text style={styles.emptyTitle}>
              {showAllVideos
                ? 'No videos found on this device'
                : 'No dedicated Screen Recordings folder matched'}
            </Text>
            <Text style={styles.stateText}>
              {showAllVideos
                ? 'Record a screen video or use File Manager Video to pick a file.'
                : 'Some Android brands store screen recordings in another folder. Tap "All Device Videos" above to browse all local videos.'}
            </Text>
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => {
              const tooLong = item.durationMs > MAX_VIDEO_DURATION_MS;
              return (
                <Pressable
                  onPress={() => onSelect(item)}
                  style={({ pressed }) => [
                    styles.rowCard,
                    tooLong && styles.rowCardDisabled,
                    pressed && styles.rowCardPressed,
                  ]}
                >
                  <View style={styles.rowIcon}>
                    <Ionicons
                      name={item.isLikelyScreenRecording ? 'phone-portrait-outline' : 'film-outline'}
                      size={20}
                      color={tooLong ? '#71717A' : '#F97316'}
                    />
                  </View>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {item.filename}
                    </Text>
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      {formatDuration(item.durationMs)} · {item.albumTitle}
                      {tooLong ? ' · Exceeds 30:00 limit' : ''}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color="#71717A" />
                </Pressable>
              );
            }}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0B0D12',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2430',
  },
  headerTitleCol: {
    flex: 1,
    paddingRight: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#F4F4F5',
  },
  subtitle: {
    marginTop: 2,
    fontSize: 12,
    color: '#9CA3AF',
  },
  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#171B24',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBar: {
    flexDirection: 'row',
    gap: 8,
    padding: 16,
  },
  filterTab: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#232834',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  filterTabActive: {
    backgroundColor: '#1E232E',
    borderColor: '#F97316',
  },
  filterText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#A1A1AA',
  },
  filterTextActive: {
    color: '#F4F4F5',
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  emptyTitle: {
    marginTop: 12,
    fontSize: 15,
    fontWeight: '600',
    color: '#F4F4F5',
    textAlign: 'center',
  },
  stateText: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 19,
    color: '#9CA3AF',
    textAlign: 'center',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    gap: 10,
  },
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 64,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: '#14171E',
    borderWidth: 1,
    borderColor: '#232834',
  },
  rowCardDisabled: {
    opacity: 0.55,
  },
  rowCardPressed: {
    backgroundColor: '#1B202A',
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#1D222D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
  },
  rowName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#F4F4F5',
  },
  rowMeta: {
    marginTop: 3,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: '#9CA3AF',
  },
});
