package com.hanuman.videocutter

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.provider.MediaStore
import androidx.annotation.OptIn
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Contrast
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.HslAdjustment
import androidx.media3.effect.Presentation
import androidx.media3.effect.RgbAdjustment
import androidx.media3.effect.ScaleAndRotateTransformation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

class HanumanVideoCutterModule : Module() {
  private val moduleScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val mainHandler = Handler(Looper.getMainLooper())
  private var activeJob: Job? = null
  private var activeTransformer: Transformer? = null
  private val isCancelled = AtomicBoolean(false)

  override fun definition() = ModuleDefinition {
    Name("HanumanVideoCutter")

    Events("onAnalysisProgress", "onCuttingProgress", "onExportProgress")

    AsyncFunction("analyzeVideo") { inputUri: String, promise: Promise ->
      isCancelled.set(false)
      activeJob?.cancel()
      activeJob = moduleScope.launch {
        try {
          val context = appContext.reactContext
            ?: throw IllegalStateException("Android React context unavailable.")
          val result = performVideoAnalysis(context, inputUri)
          promise.resolve(result)
        } catch (err: Exception) {
          promise.reject("ERR_VIDEO_ANALYSIS", err.message ?: "Failed to analyze video.", err)
        }
      }
    }

    AsyncFunction("cutAndJoinVideo") {
        inputUri: String,
        outputPath: String,
        segments: List<Map<String, Any>>,
        promise: Promise ->
      isCancelled.set(false)
      performMedia3CutAndJoin(inputUri, outputPath, segments, promise)
    }

    AsyncFunction("fullAiEditVideo") {
        inputUri: String,
        outputPath: String,
        segments: List<Map<String, Any>>,
        profile: Map<String, Any>,
        musicUri: String?,
        musicVolume: Double,
        promise: Promise ->
      isCancelled.set(false)
      performMedia3FullAiEdit(inputUri, outputPath, segments, profile, musicUri, musicVolume, promise)
    }

    AsyncFunction("getDeviceExportCapabilities") { inputUri: String, promise: Promise ->
      moduleScope.launch {
        try {
          val context = appContext.reactContext
            ?: throw IllegalStateException("Android React context unavailable.")
          val result = inspectDeviceExportCapabilities(context, inputUri)
          promise.resolve(result)
        } catch (err: Exception) {
          promise.reject("ERR_EXPORT_CAPABILITIES", err.message ?: "Failed to inspect export capabilities.", err)
        }
      }
    }

    AsyncFunction("exportVideo") {
        inputUri: String,
        outputPath: String,
        options: Map<String, Any>,
        promise: Promise ->
      isCancelled.set(false)
      performMedia3Export(inputUri, outputPath, options, promise)
    }

    AsyncFunction("saveVideoToGallery") {
        localFilePath: String,
        displayName: String,
        expectedContentHash: String?,
        promise: Promise ->
      moduleScope.launch {
        try {
          val context = appContext.reactContext
            ?: throw IllegalStateException("Android React context unavailable.")
          val result = performSaveVideoToGallery(context, localFilePath, displayName, expectedContentHash)
          promise.resolve(result)
        } catch (err: Exception) {
          promise.reject("ERR_GALLERY_SAVE", err.message ?: "Failed to save video to Android Gallery.", err)
        }
      }
    }

    AsyncFunction("verifyMediaStoreVideo") { contentUri: String, promise: Promise ->
      moduleScope.launch {
        try {
          val context = appContext.reactContext
            ?: throw IllegalStateException("Android React context unavailable.")
          promise.resolve(verifyGalleryContentUri(context, contentUri))
        } catch (_: Exception) {
          promise.resolve(false)
        }
      }
    }

    AsyncFunction("openAndroidGallery") { contentUri: String?, promise: Promise ->
      mainHandler.post {
        try {
          val context = appContext.reactContext
            ?: throw IllegalStateException("Android React context unavailable.")
          launchAndroidGalleryIntent(context, contentUri)
          promise.resolve(true)
        } catch (err: Exception) {
          promise.reject("ERR_OPEN_GALLERY", err.message ?: "Could not open Android Gallery app.", err)
        }
      }
    }

    AsyncFunction("playVideoInAndroidPlayer") { videoUri: String, promise: Promise ->
      mainHandler.post {
        try {
          val context = appContext.reactContext
            ?: throw IllegalStateException("Android React context unavailable.")
          launchAndroidVideoPlayerIntent(context, videoUri)
          promise.resolve(true)
        } catch (err: Exception) {
          promise.reject("ERR_PLAY_VIDEO", err.message ?: "Could not launch Android video player.", err)
        }
      }
    }

    Function("cancelProcessing") {
      isCancelled.set(true)
      activeJob?.cancel()
      mainHandler.post {
        try {
          activeTransformer?.cancel()
          activeTransformer = null
        } catch (_: Exception) {
        }
      }
    }

    OnDestroy {
      isCancelled.set(true)
      moduleScope.cancel()
    }
  }

  private fun performVideoAnalysis(context: Context, inputUri: String): Map<String, Any> {
    val uri = Uri.parse(inputUri)
    val retriever = MediaMetadataRetriever()
    val durationMs: Long

    try {
      retriever.setDataSource(context, uri)
      val durationStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
      durationMs = durationStr?.toLongOrNull() ?: 0L
      if (durationMs <= 0L) {
        throw IllegalArgumentException("Could not determine video duration.")
      }

      // Adaptive window sizing keeps RAM low and bounds frame sampling <= 600 frames up to 30 min
      val sampleIntervalMs: Long = when {
        durationMs <= 120_000L -> 750L
        durationMs <= 600_000L -> 1500L
        else -> 3000L
      }

      val windowCount = max(1, ((durationMs + sampleIntervalMs - 1) / sampleIntervalMs).toInt())

      sendEvent(
        "onAnalysisProgress",
        mapOf("progress" to 0.05, "stage" to "Scanning audio track...")
      )

      val audioResult = analyzeAudioRmsWindows(context, uri, windowCount, sampleIntervalMs)

      val windows = ArrayList<Map<String, Any>>(windowCount)
      var prevLuma: FloatArray? = null
      var prevHist: DoubleArray? = null

      for (i in 0 until windowCount) {
        if (isCancelled.get()) {
          throw IllegalStateException("Video analysis cancelled by user.")
        }

        val startMs = i * sampleIntervalMs
        val endMs = min(durationMs, (i + 1) * sampleIntervalMs)
        val midpointUs = ((startMs + endMs) / 2L) * 1000L

        val bitmap = extractScaledFrame(retriever, midpointUs, 64, 36)
        var motionScore = 0.0
        var sceneDelta = 0.0
        var histogram = DoubleArray(12) { 0.0 }

        if (bitmap != null) {
          val stats = extractFrameFeatures(bitmap, prevLuma, prevHist)
          bitmap.recycle()
          motionScore = stats.motionScore
          sceneDelta = stats.sceneDelta
          histogram = stats.histogram
          prevLuma = stats.lumaGrid
          prevHist = stats.histogram
        }

        val rmsDb = audioResult.windowDb[i]
        windows.add(
          mapOf(
            "startMs" to startMs.toDouble(),
            "endMs" to endMs.toDouble(),
            "audioRmsDb" to rmsDb,
            "visualMotion" to motionScore,
            "sceneDelta" to sceneDelta,
            "histogram" to histogram.toList()
          )
        )

        val progress = 0.35 + (0.63 * (i + 1).toDouble() / windowCount.toDouble())
        if (i % 6 == 0 || i == windowCount - 1) {
          sendEvent(
            "onAnalysisProgress",
            mapOf(
              "progress" to min(0.98, progress),
              "stage" to "Analyzing scenes (${i + 1}/$windowCount)..."
            )
          )
        }
      }

      sendEvent(
        "onAnalysisProgress",
        mapOf("progress" to 1.0, "stage" to "Analysis complete")
      )

      return mapOf(
        "totalDurationMs" to durationMs.toDouble(),
        "hasAudioTrack" to audioResult.hasAudioTrack,
        "windows" to windows
      )
    } finally {
      try {
        retriever.release()
      } catch (_: Exception) {
      }
    }
  }

  private fun extractScaledFrame(
    retriever: MediaMetadataRetriever,
    timeUs: Long,
    width: Int,
    height: Int
  ): Bitmap? {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        retriever.getScaledFrameAtTime(
          timeUs,
          MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
          width,
          height
        )
      } else {
        val raw = retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        if (raw != null) {
          val scaled = Bitmap.createScaledBitmap(raw, width, height, true)
          if (scaled !== raw) raw.recycle()
          scaled
        } else {
          null
        }
      }
    } catch (_: Exception) {
      null
    }
  }

  private data class FrameStats(
    val motionScore: Double,
    val sceneDelta: Double,
    val histogram: DoubleArray,
    val lumaGrid: FloatArray
  )

  private fun extractFrameFeatures(
    bitmap: Bitmap,
    prevLuma: FloatArray?,
    prevHist: DoubleArray?
  ): FrameStats {
    val w = bitmap.width
    val h = bitmap.height
    val count = w * h
    val pixels = IntArray(count)
    bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

    val luma = FloatArray(count)
    val hist = DoubleArray(12) { 0.0 } // 4 R bins + 4 G bins + 4 B bins

    for (idx in 0 until count) {
      val c = pixels[idx]
      val r = Color.red(c)
      val g = Color.green(c)
      val b = Color.blue(c)
      luma[idx] = (0.299f * r + 0.587f * g + 0.114f * b) / 255.0f

      hist[min(3, r / 64)] += 1.0
      hist[4 + min(3, g / 64)] += 1.0
      hist[8 + min(3, b / 64)] += 1.0
    }

    val normFactor = max(1, count * 3).toDouble()
    for (i in hist.indices) {
      hist[i] /= normFactor
    }

    var motionScore = 0.0
    if (prevLuma != null && prevLuma.size == luma.size) {
      var diffSum = 0.0
      for (i in luma.indices) {
        diffSum += abs(luma[i] - prevLuma[i]).toDouble()
      }
      motionScore = min(1.0, (diffSum / luma.size.toDouble()) * 3.5)
    }

    var sceneDelta = 0.0
    if (prevHist != null && prevHist.size == hist.size) {
      var l1 = 0.0
      for (i in hist.indices) {
        l1 += abs(hist[i] - prevHist[i])
      }
      sceneDelta = min(1.0, l1 * 1.4)
    }

    return FrameStats(motionScore, sceneDelta, hist, luma)
  }

  private data class AudioAnalysisResult(
    val hasAudioTrack: Boolean,
    val windowDb: DoubleArray
  )

  private fun analyzeAudioRmsWindows(
    context: Context,
    uri: Uri,
    windowCount: Int,
    sampleIntervalMs: Long
  ): AudioAnalysisResult {
    val windowDb = DoubleArray(windowCount) { -90.0 }
    val sumSquares = DoubleArray(windowCount) { 0.0 }
    val sampleCounts = LongArray(windowCount) { 0L }

    val extractor = MediaExtractor()
    var codec: MediaCodec? = null

    try {
      extractor.setDataSource(context, uri, null)
      var audioTrackIndex = -1
      var audioFormat: MediaFormat? = null

      for (i in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
        if (mime.startsWith("audio/")) {
          audioTrackIndex = i
          audioFormat = format
          break
        }
      }

      if (audioTrackIndex < 0 || audioFormat == null) {
        return AudioAnalysisResult(false, windowDb)
      }

      extractor.selectTrack(audioTrackIndex)
      val mime = audioFormat.getString(MediaFormat.KEY_MIME) ?: return AudioAnalysisResult(false, windowDb)

      codec = MediaCodec.createDecoderByType(mime)
      codec.configure(audioFormat, null, null, 0)
      codec.start()

      val bufferInfo = MediaCodec.BufferInfo()
      var sawInputEOS = false
      var sawOutputEOS = false

      while (!sawOutputEOS && !isCancelled.get()) {
        if (!sawInputEOS) {
          val inIndex = codec.dequeueInputBuffer(5000)
          if (inIndex >= 0) {
            val inputBuffer: ByteBuffer? = codec.getInputBuffer(inIndex)
            if (inputBuffer != null) {
              val sampleSize = extractor.readSampleData(inputBuffer, 0)
              if (sampleSize < 0) {
                codec.queueInputBuffer(inIndex, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                sawInputEOS = true
              } else {
                val presentationTimeUs = extractor.sampleTime
                codec.queueInputBuffer(inIndex, 0, sampleSize, presentationTimeUs, 0)
                extractor.advance()
              }
            }
          }
        }

        val outIndex = codec.dequeueOutputBuffer(bufferInfo, 5000)
        if (outIndex >= 0) {
          val outBuffer = codec.getOutputBuffer(outIndex)
          if (outBuffer != null && bufferInfo.size > 0) {
            outBuffer.position(bufferInfo.offset)
            outBuffer.limit(bufferInfo.offset + bufferInfo.size)
            val shortBuf = outBuffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
            val windowIdx = min(
              windowCount - 1,
              max(0, ((bufferInfo.presentationTimeUs / 1000L) / sampleIntervalMs).toInt())
            )

            var localSq = 0.0
            var localCount = 0L
            // Stride by 4 samples for fast O(1)-memory energy profiling on 30-min videos
            var s = 0
            val totalShorts = shortBuf.remaining()
            while (s < totalShorts) {
              val normalized = shortBuf.get(s).toDouble() / 32768.0
              localSq += normalized * normalized
              localCount += 1L
              s += 4
            }
            sumSquares[windowIdx] += localSq
            sampleCounts[windowIdx] += localCount
          }

          codec.releaseOutputBuffer(outIndex, false)
          if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
            sawOutputEOS = true
          }
        }
      }

      for (i in 0 until windowCount) {
        if (sampleCounts[i] > 0) {
          val rms = sqrt(sumSquares[i] / sampleCounts[i].toDouble())
          windowDb[i] = if (rms > 1e-5) max(-90.0, 20.0 * log10(rms)) else -90.0
        }
      }

      return AudioAnalysisResult(true, windowDb)
    } catch (_: Exception) {
      return AudioAnalysisResult(false, windowDb)
    } finally {
      try {
        codec?.stop()
        codec?.release()
      } catch (_: Exception) {
      }
      try {
        extractor.release()
      } catch (_: Exception) {
      }
    }
  }

  @OptIn(UnstableApi::class)
  private fun performMedia3CutAndJoin(
    inputUri: String,
    outputPath: String,
    segments: List<Map<String, Any>>,
    promise: Promise
  ) {
    val context = appContext.reactContext
    if (context == null) {
      promise.reject("ERR_CONTEXT", "Android React context unavailable.", null)
      return
    }

    if (segments.isEmpty()) {
      promise.reject("ERR_NO_SEGMENTS", "At least one segment is required to generate an edited video.", null)
      return
    }

    val cleanOutPath = if (outputPath.startsWith("file://")) {
      Uri.parse(outputPath).path ?: outputPath
    } else {
      outputPath
    }

    val outFile = File(cleanOutPath)
    outFile.parentFile?.mkdirs()
    if (outFile.exists()) {
      outFile.delete()
    }

    val editedItems = ArrayList<EditedMediaItem>(segments.size)
    for (seg in segments) {
      val startMs = (seg["startMs"] as? Number)?.toLong() ?: 0L
      val endMs = (seg["endMs"] as? Number)?.toLong() ?: 0L
      if (endMs <= startMs) continue

      val clipping = MediaItem.ClippingConfiguration.Builder()
        .setStartPositionMs(max(0L, startMs))
        .setEndPositionMs(endMs)
        .build()

      val mediaItem = MediaItem.Builder()
        .setUri(Uri.parse(inputUri))
        .setClippingConfiguration(clipping)
        .build()

      editedItems.add(EditedMediaItem.Builder(mediaItem).build())
    }

    if (editedItems.isEmpty()) {
      promise.reject("ERR_INVALID_SEGMENTS", "No valid segment timestamps supplied.", null)
      return
    }

    mainHandler.post {
      try {
        val sequence = EditedMediaItemSequence.Builder(editedItems).build()
        val composition = Composition.Builder(listOf(sequence)).build()

        val progressHolder = ProgressHolder()
        var progressRunnable: Runnable? = null

        val transformer = Transformer.Builder(context)
          .addListener(object : Transformer.Listener {
            override fun onCompleted(composition: Composition, exportResult: ExportResult) {
              progressRunnable?.let { mainHandler.removeCallbacks(it) }
              activeTransformer = null
              sendEvent(
                "onCuttingProgress",
                mapOf("progress" to 1.0, "stage" to "Finalizing edited video...")
              )
              promise.resolve(
                mapOf(
                  "outputUri" to Uri.fromFile(outFile).toString(),
                  "durationMs" to exportResult.durationMs.toDouble(),
                  "fileSizeBytes" to outFile.length().toDouble()
                )
              )
            }

            override fun onError(
              composition: Composition,
              exportResult: ExportResult,
              exportException: ExportException
            ) {
              progressRunnable?.let { mainHandler.removeCallbacks(it) }
              activeTransformer = null
              if (outFile.exists()) {
                outFile.delete()
              }
              promise.reject(
                "ERR_MEDIA3_CUT",
                exportException.message ?: "Failed to cut and join video segments.",
                exportException
              )
            }
          })
          .build()

        activeTransformer = transformer
        transformer.start(composition, outFile.absolutePath)

        progressRunnable = object : Runnable {
          override fun run() {
            val current = activeTransformer ?: return
            if (isCancelled.get()) return
            val state = current.getProgress(progressHolder)
            if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
              val pct = min(0.99, max(0.0, progressHolder.progress.toDouble() / 100.0))
              sendEvent(
                "onCuttingProgress",
                mapOf(
                  "progress" to pct,
                  "stage" to "Cutting & joining clips (${progressHolder.progress}%)..."
                )
              )
            }
            mainHandler.postDelayed(this, 250L)
          }
        }
        mainHandler.postDelayed(progressRunnable, 200L)
      } catch (err: Exception) {
        if (outFile.exists()) {
          outFile.delete()
        }
        promise.reject("ERR_MEDIA3_INIT", err.message ?: "Failed to start Media3 Transformer.", err)
      }
    }
  }

  @OptIn(UnstableApi::class)
  private fun performMedia3FullAiEdit(
    inputUri: String,
    outputPath: String,
    segments: List<Map<String, Any>>,
    profile: Map<String, Any>,
    musicUri: String?,
    musicVolume: Double,
    promise: Promise
  ) {
    val context = appContext.reactContext
    if (context == null) {
      promise.reject("ERR_CONTEXT", "Android React context unavailable.", null)
      return
    }

    if (segments.isEmpty()) {
      promise.reject("ERR_NO_SEGMENTS", "At least one segment is required.", null)
      return
    }

    val cleanOutPath = if (outputPath.startsWith("file://")) {
      Uri.parse(outputPath).path ?: outputPath
    } else {
      outputPath
    }

    val outFile = File(cleanOutPath)
    outFile.parentFile?.mkdirs()
    if (outFile.exists()) {
      outFile.delete()
    }

    val brightnessDelta = ((profile["brightnessDelta"] as? Number)?.toFloat() ?: 0f).coerceIn(-0.4f, 0.4f)
    val contrastDelta = ((profile["contrastDelta"] as? Number)?.toFloat() ?: 0f).coerceIn(-0.4f, 0.45f)
    val saturationDelta = ((profile["saturationDelta"] as? Number)?.toFloat() ?: 0f).coerceIn(-40f, 45f)
    val redScale = ((profile["redScale"] as? Number)?.toFloat() ?: 1f).coerceIn(0.8f, 1.25f)
    val greenScale = ((profile["greenScale"] as? Number)?.toFloat() ?: 1f).coerceIn(0.8f, 1.25f)
    val blueScale = ((profile["blueScale"] as? Number)?.toFloat() ?: 1f).coerceIn(0.8f, 1.25f)
    val sharpnessAmount = ((profile["sharpnessAmount"] as? Number)?.toFloat() ?: 0f).coerceIn(0f, 0.8f)
    val denoiseStrength = ((profile["denoiseStrength"] as? Number)?.toFloat() ?: 0f).coerceIn(0f, 0.45f)
    val stabilizationZoom = ((profile["stabilizationZoom"] as? Number)?.toFloat() ?: 1f).coerceIn(1f, 1.12f)
    val transitionMs = ((profile["transitionDurationMs"] as? Number)?.toLong() ?: 240L).coerceIn(0L, 600L)

    val audioGainDb = (profile["audioGainDb"] as? Number)?.toFloat() ?: 0f
    val noiseGateDb = (profile["noiseGateDb"] as? Number)?.toFloat() ?: -90f
    val voiceClarityBoostDb = (profile["voiceClarityGainDb"] as? Number)?.toFloat() ?: 0f
    val highPassHz = (profile["highPassHz"] as? Number)?.toFloat() ?: 0f

    val editedItems = ArrayList<EditedMediaItem>(segments.size)
    var totalTargetDurationMs = 0L

    for ((index, seg) in segments.withIndex()) {
      val startMs = (seg["startMs"] as? Number)?.toLong() ?: 0L
      val endMs = (seg["endMs"] as? Number)?.toLong() ?: 0L
      if (endMs <= startMs) continue
      totalTargetDurationMs += (endMs - startMs)

      val videoEffects = ArrayList<Effect>()
      if (abs(contrastDelta) > 0.005f) {
        videoEffects.add(Contrast(contrastDelta))
      }
      if (abs(saturationDelta) > 0.5f || abs(brightnessDelta) > 0.005f) {
        videoEffects.add(
          HslAdjustment.Builder()
            .adjustSaturation(saturationDelta)
            .adjustLightness(brightnessDelta * 45f)
            .build()
        )
      }
      if (abs(redScale - 1f) > 0.005f || abs(greenScale - 1f) > 0.005f || abs(blueScale - 1f) > 0.005f) {
        videoEffects.add(
          RgbAdjustment.Builder()
            .setRedScale(redScale)
            .setGreenScale(greenScale)
            .setBlueScale(blueScale)
            .build()
        )
      }
      if (stabilizationZoom > 1.005f) {
        videoEffects.add(
          ScaleAndRotateTransformation.Builder()
            .setScale(stabilizationZoom, stabilizationZoom)
            .build()
        )
      }
      val transitionInStr = seg["transitionIn"] as? String ?: "none"
      val fadeDurationUs = if (index > 0 && transitionInStr != "none") transitionMs * 1000L else 0L
      if (sharpnessAmount > 0.01f || denoiseStrength > 0.01f || fadeDurationUs > 0L) {
        videoEffects.add(
          HanumanEnhanceGlEffect(
            sharpnessAmount = sharpnessAmount,
            denoiseStrength = denoiseStrength,
            fadeInDurationUs = fadeDurationUs
          )
        )
      }

      val audioProcessors = ArrayList<AudioProcessor>()
      if (audioGainDb > 0.1f || noiseGateDb > -85f || voiceClarityBoostDb > 0.1f || highPassHz > 1f) {
        audioProcessors.add(
          HanumanAudioEnhanceProcessor(
            gainDb = audioGainDb,
            noiseGateDb = noiseGateDb,
            voiceClarityBoostDb = voiceClarityBoostDb,
            highPassHz = highPassHz
          )
        )
      }

      val clipping = MediaItem.ClippingConfiguration.Builder()
        .setStartPositionMs(max(0L, startMs))
        .setEndPositionMs(endMs)
        .build()

      val mediaItem = MediaItem.Builder()
        .setUri(Uri.parse(inputUri))
        .setClippingConfiguration(clipping)
        .build()

      editedItems.add(
        EditedMediaItem.Builder(mediaItem)
          .setEffects(Effects(audioProcessors, videoEffects))
          .build()
      )
    }

    if (editedItems.isEmpty()) {
      promise.reject("ERR_INVALID_SEGMENTS", "No valid segments for AI editing.", null)
      return
    }

    mainHandler.post {
      try {
        val sequences = ArrayList<EditedMediaItemSequence>()
        sequences.add(EditedMediaItemSequence.Builder(editedItems).build())

        if (!musicUri.isNullOrBlank() && totalTargetDurationMs > 0L) {
          val clampedVol = musicVolume.toFloat().coerceIn(0.02f, 0.5f)
          val musicClip = MediaItem.Builder()
            .setUri(Uri.parse(musicUri))
            .setClippingConfiguration(
              MediaItem.ClippingConfiguration.Builder()
                .setStartPositionMs(0L)
                .setEndPositionMs(totalTargetDurationMs)
                .build()
            )
            .build()
          val musicEdited = EditedMediaItem.Builder(musicClip)
            .setRemoveVideo(true)
            .setEffects(
              Effects(
                listOf(
                  HanumanAudioEnhanceProcessor(
                    gainDb = 0f,
                    noiseGateDb = -90f,
                    voiceClarityBoostDb = 0f,
                    highPassHz = 0f,
                    fixedLinearScale = clampedVol
                  )
                ),
                emptyList()
              )
            )
            .build()
          sequences.add(
            EditedMediaItemSequence.Builder(listOf(musicEdited))
              .setIsLooping(true)
              .build()
          )
        }

        val composition = Composition.Builder(sequences).build()
        val progressHolder = ProgressHolder()
        var progressRunnable: Runnable? = null

        val transformer = Transformer.Builder(context)
          .addListener(object : Transformer.Listener {
            override fun onCompleted(composition: Composition, exportResult: ExportResult) {
              progressRunnable?.let { mainHandler.removeCallbacks(it) }
              activeTransformer = null
              sendEvent(
                "onCuttingProgress",
                mapOf("progress" to 1.0, "stage" to "Finalizing AI-edited video...")
              )
              promise.resolve(
                mapOf(
                  "outputUri" to Uri.fromFile(outFile).toString(),
                  "durationMs" to exportResult.durationMs.toDouble(),
                  "fileSizeBytes" to outFile.length().toDouble()
                )
              )
            }

            override fun onError(
              composition: Composition,
              exportResult: ExportResult,
              exportException: ExportException
            ) {
              progressRunnable?.let { mainHandler.removeCallbacks(it) }
              activeTransformer = null
              if (outFile.exists()) {
                outFile.delete()
              }
              promise.reject(
                "ERR_MEDIA3_EDIT",
                exportException.message ?: "Failed to render AI-edited video.",
                exportException
              )
            }
          })
          .build()

        activeTransformer = transformer
        transformer.start(composition, outFile.absolutePath)

        progressRunnable = object : Runnable {
          override fun run() {
            val current = activeTransformer ?: return
            if (isCancelled.get()) return
            val state = current.getProgress(progressHolder)
            if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
              val pct = min(0.99, max(0.0, progressHolder.progress.toDouble() / 100.0))
              sendEvent(
                "onCuttingProgress",
                mapOf(
                  "progress" to pct,
                  "stage" to "Rendering AI edits & audio (${progressHolder.progress}%)..."
                )
              )
            }
            mainHandler.postDelayed(this, 250L)
          }
        }
        mainHandler.postDelayed(progressRunnable, 200L)
      } catch (err: Exception) {
        if (outFile.exists()) {
          outFile.delete()
        }
        promise.reject("ERR_MEDIA3_EDIT_INIT", err.message ?: "Failed to initialize Media3 editor.", err)
      }
    }
  }

  private fun isEncoderSupported(
    mimeType: String,
    width: Int,
    height: Int,
    fps: Double,
    requireHardware: Boolean
  ): Boolean {
    val codecList = MediaCodecList(MediaCodecList.REGULAR_CODECS)
    for (info in codecList.codecInfos) {
      if (!info.isEncoder) continue
      val isSoftware = info.name.startsWith("OMX.google.", ignoreCase = true) ||
        info.name.startsWith("c2.android.", ignoreCase = true)
      if (requireHardware && isSoftware) continue

      val supportedTypes = info.supportedTypes
      if (!supportedTypes.any { it.equals(mimeType, ignoreCase = true) }) continue

      try {
        val caps = info.getCapabilitiesForType(mimeType)
        val videoCaps = caps.videoCapabilities ?: continue
        if (videoCaps.areSizeAndRateSupported(width, height, fps) ||
          videoCaps.areSizeAndRateSupported(height, width, fps)
        ) {
          return true
        }
      } catch (_: Exception) {
      }
    }
    return false
  }

  private fun hasAnyHardwareEncoder(mimeType: String): Boolean {
    val codecList = MediaCodecList(MediaCodecList.REGULAR_CODECS)
    for (info in codecList.codecInfos) {
      if (!info.isEncoder) continue
      val isSoftware = info.name.startsWith("OMX.google.", ignoreCase = true) ||
        info.name.startsWith("c2.android.", ignoreCase = true)
      if (isSoftware) continue
      if (info.supportedTypes.any { it.equals(mimeType, ignoreCase = true) }) {
        return true
      }
    }
    return false
  }

  private fun inspectDeviceExportCapabilities(context: Context, inputUri: String): Map<String, Any> {
    val uri = Uri.parse(inputUri)
    val retriever = MediaMetadataRetriever()
    var sourceWidth = 1280
    var sourceHeight = 720
    var sourceFps = 30.0
    var sourceDurationMs = 0L
    var hasAudioTrack = false

    try {
      retriever.setDataSource(context, uri)
      val rawW = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 1280
      val rawH = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 720
      val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      if (rotation == 90 || rotation == 270) {
        sourceWidth = rawH
        sourceHeight = rawW
      } else {
        sourceWidth = rawW
        sourceHeight = rawH
      }
      sourceDurationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
      val capFps = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)?.toDoubleOrNull()
      if (capFps != null && capFps > 0.0) {
        sourceFps = capFps
      }
    } catch (_: Exception) {
    } finally {
      try {
        retriever.release()
      } catch (_: Exception) {
      }
    }

    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(context, uri, null)
      for (i in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
        if (mime.startsWith("video/") && format.containsKey(MediaFormat.KEY_FRAME_RATE)) {
          val trackFps = format.getInteger(MediaFormat.KEY_FRAME_RATE).toDouble()
          if (trackFps > 0.0) {
            sourceFps = trackFps
          }
        } else if (mime.startsWith("audio/")) {
          hasAudioTrack = true
        }
      }
    } catch (_: Exception) {
    } finally {
      try {
        extractor.release()
      } catch (_: Exception) {
      }
    }

    val resDims = listOf(
      Triple("360p", 640, 360),
      Triple("480p", 854, 480),
      Triple("720p", 1280, 720),
      Triple("1080p", 1920, 1080),
      Triple("2k", 2560, 1440),
      Triple("4k", 3840, 2160)
    )
    val fpsOptions = listOf(24, 30, 60)

    val supportsH264Hw = hasAnyHardwareEncoder(MimeTypes.VIDEO_H264)
    val supportsH265Hw = hasAnyHardwareEncoder(MimeTypes.VIDEO_H265)
    val supportedResolutions = ArrayList<String>()
    val supportedFpsByResolution = HashMap<String, List<Int>>()

    for ((resId, w, h) in resDims) {
      val fpsList = ArrayList<Int>()
      for (fps in fpsOptions) {
        val hwOk = isEncoderSupported(MimeTypes.VIDEO_H264, w, h, fps.toDouble(), requireHardware = true) ||
          (supportsH265Hw && isEncoderSupported(MimeTypes.VIDEO_H265, w, h, fps.toDouble(), requireHardware = true))
        val anyOk = hwOk || (resId != "4k" && resId != "2k" &&
          isEncoderSupported(MimeTypes.VIDEO_H264, w, h, fps.toDouble(), requireHardware = false))
        if (anyOk) {
          fpsList.add(fps)
        }
      }
      if (fpsList.isEmpty() && (resId == "360p" || resId == "480p" || resId == "720p")) {
        fpsList.addAll(listOf(24, 30))
      }
      if (fpsList.isNotEmpty()) {
        supportedResolutions.add(resId)
        supportedFpsByResolution[resId] = fpsList
      } else {
        supportedFpsByResolution[resId] = emptyList()
      }
    }

    val statFs = StatFs(context.filesDir.absolutePath)
    val availableStorageBytes = statFs.availableBytes

    val supports4K = supportedResolutions.contains("4k")
    val hwSummary = buildString {
      append(if (supportsH264Hw) "Hardware H.264" else "Software H.264")
      if (supportsH265Hw) append(" · Hardware H.265/HEVC")
      if (supports4K) append(" · 4K Ready")
    }

    return mapOf(
      "sourceWidth" to sourceWidth,
      "sourceHeight" to sourceHeight,
      "sourceFps" to sourceFps,
      "sourceDurationMs" to sourceDurationMs.toDouble(),
      "hasAudioTrack" to hasAudioTrack,
      "supportedResolutions" to supportedResolutions,
      "supportedFpsByResolution" to supportedFpsByResolution,
      "supportsH264" to true,
      "supportsH265" to supportsH265Hw,
      "supports4K" to supports4K,
      "hardwareAccelerated" to supportsH264Hw,
      "availableStorageBytes" to availableStorageBytes.toDouble(),
      "encoderSummary" to hwSummary
    )
  }

  @OptIn(UnstableApi::class)
  private fun performMedia3Export(
    inputUri: String,
    outputPath: String,
    options: Map<String, Any>,
    promise: Promise
  ) {
    val context = appContext.reactContext
    if (context == null) {
      promise.reject("ERR_CONTEXT", "Android React context unavailable.", null)
      return
    }

    val targetWidth = ((options["targetWidth"] as? Number)?.toInt() ?: 1280).coerceIn(160, 3840)
    val targetHeight = ((options["targetHeight"] as? Number)?.toInt() ?: 720).coerceIn(160, 3840)
    val targetFps = ((options["targetFps"] as? Number)?.toInt() ?: 30).coerceIn(24, 60)
    val sourceWidth = ((options["sourceWidth"] as? Number)?.toInt() ?: targetWidth)
    val sourceHeight = ((options["sourceHeight"] as? Number)?.toInt() ?: targetHeight)
    val sourceFps = ((options["sourceFps"] as? Number)?.toDouble() ?: 30.0)
    val codecStr = (options["codec"] as? String) ?: "h264"
    val compressionStr = (options["compression"] as? String) ?: "high"
    val videoBitrateBps = ((options["videoBitrateBps"] as? Number)?.toInt() ?: 5_000_000).coerceIn(300_000, 60_000_000)
    val estimatedSizeBytes = ((options["estimatedFileSizeBytes"] as? Number)?.toLong() ?: 10_000_000L)

    val statFs = StatFs(context.filesDir.absolutePath)
    val freeBytes = statFs.availableBytes
    val requiredBytes = max(5L * 1024L * 1024L, (estimatedSizeBytes * 1.2).toLong())
    if (freeBytes < requiredBytes) {
      promise.reject(
        "ERR_LOW_STORAGE",
        "Insufficient free storage space on device for export. Free up space and retry.",
        null
      )
      return
    }

    val cleanOutPath = if (outputPath.startsWith("file://")) {
      Uri.parse(outputPath).path ?: outputPath
    } else {
      outputPath
    }

    val outFile = File(cleanOutPath)
    val partFile = File("$cleanOutPath.part")
    outFile.parentFile?.mkdirs()
    if (outFile.exists()) {
      outFile.delete()
    }
    if (partFile.exists()) {
      partFile.delete()
    }

    val videoEffects = ArrayList<Effect>()
    val needsScale = targetWidth != sourceWidth || targetHeight != sourceHeight
    if (needsScale) {
      videoEffects.add(
        Presentation.createForWidthAndHeight(
          targetWidth,
          targetHeight,
          Presentation.LAYOUT_SCALE_TO_FIT
        )
      )
    }

    val needsFpsAdjustment = sourceFps <= 0.0 || abs(sourceFps - targetFps.toDouble()) > 1.0
    if (needsFpsAdjustment && targetFps < sourceFps) {
      videoEffects.add(FrameDropEffect.createDefaultFrameDropEffect(targetFps.toFloat()))
    }

    val mediaItem = MediaItem.Builder()
      .setUri(Uri.parse(inputUri))
      .build()

    val editedItem = if (videoEffects.isNotEmpty()) {
      EditedMediaItem.Builder(mediaItem)
        .setEffects(Effects(emptyList(), videoEffects))
        .build()
    } else {
      EditedMediaItem.Builder(mediaItem).build()
    }

    val targetVideoMime = if (codecStr == "h265") MimeTypes.VIDEO_H265 else MimeTypes.VIDEO_H264

    mainHandler.post {
      try {
        val sequence = EditedMediaItemSequence.Builder(listOf(editedItem)).build()
        val composition = Composition.Builder(listOf(sequence)).build()

        val progressHolder = ProgressHolder()
        var progressRunnable: Runnable? = null

        val encoderBuilder = DefaultEncoderFactory.Builder(context)
        if (compressionStr != "original" || needsScale || codecStr == "h265") {
          encoderBuilder.setRequestedVideoEncoderSettings(
            VideoEncoderSettings.Builder()
              .setBitrate(videoBitrateBps)
              .build()
          )
        }

        val transformer = Transformer.Builder(context)
          .setVideoMimeType(targetVideoMime)
          .setAudioMimeType(MimeTypes.AUDIO_AAC)
          .setEncoderFactory(encoderBuilder.build())
          .addListener(object : Transformer.Listener {
            override fun onCompleted(composition: Composition, exportResult: ExportResult) {
              progressRunnable?.let { mainHandler.removeCallbacks(it) }
              activeTransformer = null
              if (isCancelled.get() || !partFile.exists() || partFile.length() <= 1024L) {
                if (partFile.exists()) partFile.delete()
                if (outFile.exists()) outFile.delete()
                promise.reject("ERR_INCOMPLETE_EXPORT", "Export was cancelled or produced an incomplete MP4.", null)
                return
              }

              // Validate output MP4 container before moving atomically to final destination
              val verifiedMeta = readMp4Metadata(context, Uri.fromFile(partFile))
              if (verifiedMeta.durationMs <= 0L || verifiedMeta.width <= 0 || verifiedMeta.height <= 0) {
                partFile.delete()
                promise.reject("ERR_INCOMPLETE_EXPORT", "Exported MP4 failed playable video verification.", null)
                return
              }

              if (!partFile.renameTo(outFile)) {
                partFile.copyTo(outFile, overwrite = true)
                partFile.delete()
              }

              sendEvent(
                "onExportProgress",
                mapOf("progress" to 1.0, "stage" to "MP4 export complete")
              )
              promise.resolve(
                mapOf(
                  "outputUri" to Uri.fromFile(outFile).toString(),
                  "durationMs" to max(exportResult.durationMs, verifiedMeta.durationMs).toDouble(),
                  "fileSizeBytes" to outFile.length().toDouble()
                )
              )
            }

            override fun onError(
              composition: Composition,
              exportResult: ExportResult,
              exportException: ExportException
            ) {
              progressRunnable?.let { mainHandler.removeCallbacks(it) }
              activeTransformer = null
              if (partFile.exists()) partFile.delete()
              if (outFile.exists()) outFile.delete()
              val msg = exportException.message ?: "Failed to export MP4 video."
              val code = if (msg.contains("ENOSPC", ignoreCase = true)) "ERR_LOW_STORAGE" else "ERR_MEDIA3_EXPORT"
              promise.reject(code, msg, exportException)
            }
          })
          .build()

        activeTransformer = transformer
        transformer.start(composition, partFile.absolutePath)

        progressRunnable = object : Runnable {
          override fun run() {
            val current = activeTransformer ?: return
            if (isCancelled.get()) return
            val state = current.getProgress(progressHolder)
            if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
              val pct = min(0.99, max(0.0, progressHolder.progress.toDouble() / 100.0))
              sendEvent(
                "onExportProgress",
                mapOf(
                  "progress" to pct,
                  "stage" to "Exporting ${targetHeight}p ${targetFps}fps MP4 (${progressHolder.progress}%)..."
                )
              )
            }
            mainHandler.postDelayed(this, 250L)
          }
        }
        mainHandler.postDelayed(progressRunnable, 200L)
      } catch (err: Exception) {
        if (partFile.exists()) partFile.delete()
        if (outFile.exists()) outFile.delete()
        promise.reject("ERR_MEDIA3_EXPORT_INIT", err.message ?: "Failed to start MP4 export.", err)
      }
    }
  }

  private data class Mp4InspectionResult(
    val width: Int,
    val height: Int,
    val durationMs: Long,
    val hasVideoTrack: Boolean
  )

  private fun readMp4Metadata(context: Context, uri: Uri): Mp4InspectionResult {
    val retriever = MediaMetadataRetriever()
    return try {
      retriever.setDataSource(context, uri)
      val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
      val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val hasVideo = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO)
        ?.equals("yes", ignoreCase = true) ?: (width > 0 && height > 0)
      Mp4InspectionResult(width, height, durationMs, hasVideo)
    } catch (_: Exception) {
      Mp4InspectionResult(0, 0, 0L, false)
    } finally {
      try {
        retriever.release()
      } catch (_: Exception) {
      }
    }
  }

  private fun computeFileSha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(65536)
    FileInputStream(file).use { input ->
      while (true) {
        val read = input.read(buf)
        if (read <= 0) break
        digest.update(buf, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun sanitizeMp4DisplayName(rawName: String, contentHash: String): String {
    val base = rawName
      .replace(Regex("\\.mp4$", RegexOption.IGNORE_CASE), "")
      .replace(Regex("[^a-zA-Z0-9._-]+"), "_")
      .trim('_')
      .ifEmpty { "HanumanAI_Export" }
    val shortHash = contentHash.take(6)
    val withHash = if (base.endsWith("_$shortHash")) base else "${base}_$shortHash"
    return "$withHash.mp4"
  }

  private fun findExistingGalleryEntry(
    context: Context,
    displayName: String,
    expectedSizeBytes: Long
  ): Uri? {
    val projection = arrayOf(
      MediaStore.Video.Media._ID,
      MediaStore.Video.Media.SIZE
    )
    val selection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      "${MediaStore.Video.Media.DISPLAY_NAME} = ? AND ${MediaStore.Video.Media.SIZE} = ? AND ${MediaStore.Video.Media.RELATIVE_PATH} LIKE ? AND ${MediaStore.Video.Media.IS_PENDING} = 0"
    } else {
      "${MediaStore.Video.Media.DISPLAY_NAME} = ? AND ${MediaStore.Video.Media.SIZE} = ? AND ${MediaStore.Video.Media.DATA} LIKE ?"
    }
    val selectionArgs = arrayOf(
      displayName,
      expectedSizeBytes.toString(),
      "%Movies/HanumanAI%"
    )

    context.contentResolver.query(
      MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
      projection,
      selection,
      selectionArgs,
      "${MediaStore.Video.Media.DATE_ADDED} DESC"
    )?.use { cursor ->
      if (cursor.moveToFirst()) {
        val idCol = cursor.getColumnIndexOrThrow(MediaStore.Video.Media._ID)
        val id = cursor.getLong(idCol)
        val candidateUri = ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, id)
        if (verifyGalleryContentUri(context, candidateUri.toString())) {
          return candidateUri
        }
      }
    }
    return null
  }

  private fun verifyGalleryContentUri(context: Context, contentUriStr: String): Boolean {
    return try {
      val uri = Uri.parse(contentUriStr)
      val projection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        arrayOf(MediaStore.Video.Media.SIZE, MediaStore.Video.Media.IS_PENDING)
      } else {
        arrayOf(MediaStore.Video.Media.SIZE)
      }
      var sizeOk = false
      context.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val size = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Video.Media.SIZE))
          val notPending = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            cursor.getInt(cursor.getColumnIndexOrThrow(MediaStore.Video.Media.IS_PENDING)) == 0
          } else {
            true
          }
          sizeOk = size > 1024L && notPending
        }
      }
      if (!sizeOk) return false
      val meta = readMp4Metadata(context, uri)
      meta.hasVideoTrack && meta.durationMs > 0L
    } catch (_: Exception) {
      false
    }
  }

  private fun performSaveVideoToGallery(
    context: Context,
    localFilePath: String,
    displayName: String,
    expectedContentHash: String?
  ): Map<String, Any> {
    val cleanPath = if (localFilePath.startsWith("file://")) {
      Uri.parse(localFilePath).path ?: localFilePath
    } else {
      localFilePath
    }
    val sourceFile = File(cleanPath)
    if (!sourceFile.exists() || !sourceFile.isFile || sourceFile.length() <= 1024L) {
      throw IllegalStateException("Exported MP4 file does not exist or is incomplete.")
    }

    val sourceMeta = readMp4Metadata(context, Uri.fromFile(sourceFile))
    if (!sourceMeta.hasVideoTrack || sourceMeta.durationMs <= 0L) {
      throw IllegalStateException("Exported MP4 failed video verification and was not added to Gallery.")
    }

    val actualHash = expectedContentHash?.takeIf { it.length >= 6 } ?: computeFileSha256(sourceFile)
    val sanitizedName = sanitizeMp4DisplayName(displayName, actualHash)
    val expectedSize = sourceFile.length()
    val relativeFolder = "${Environment.DIRECTORY_MOVIES}/HanumanAI"

    // Prevent duplicates: return existing complete entry if already in MediaStore Movies/HanumanAI
    val existingUri = findExistingGalleryEntry(context, sanitizedName, expectedSize)
    if (existingUri != null) {
      return mapOf(
        "contentUri" to existingUri.toString(),
        "filePath" to "$relativeFolder/$sanitizedName",
        "relativePath" to relativeFolder,
        "displayName" to sanitizedName,
        "fileSizeBytes" to expectedSize.toDouble(),
        "contentHash" to actualHash,
        "alreadySaved" to true,
        "verifiedPlayable" to true
      )
    }

    val resolver = context.contentResolver
    val nowMs = System.currentTimeMillis()
    val nowSec = nowMs / 1000L

    var savedUri: Uri? = null
    var savedFilePath = "$relativeFolder/$sanitizedName"

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val values = ContentValues().apply {
        put(MediaStore.Video.Media.DISPLAY_NAME, sanitizedName)
        put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
        put(MediaStore.Video.Media.RELATIVE_PATH, relativeFolder)
        put(MediaStore.Video.Media.DATE_ADDED, nowSec)
        put(MediaStore.Video.Media.DATE_MODIFIED, nowSec)
        put(MediaStore.Video.Media.DATE_TAKEN, nowMs)
        put(MediaStore.Video.Media.IS_PENDING, 1)
        if (sourceMeta.durationMs > 0L) put(MediaStore.Video.Media.DURATION, sourceMeta.durationMs)
        if (sourceMeta.width > 0) put(MediaStore.Video.Media.WIDTH, sourceMeta.width)
        if (sourceMeta.height > 0) put(MediaStore.Video.Media.HEIGHT, sourceMeta.height)
      }

      val itemUri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("MediaStore rejected video insert in Movies/HanumanAI.")

      try {
        var bytesCopied = 0L
        val buffer = ByteArray(65536)
        resolver.openOutputStream(itemUri, "w")?.use { output ->
          FileInputStream(sourceFile).use { input ->
            while (true) {
              val read = input.read(buffer)
              if (read <= 0) break
              output.write(buffer, 0, read)
              bytesCopied += read
            }
          }
          output.flush()
        } ?: throw IllegalStateException("Could not open MediaStore output stream.")

        if (bytesCopied != expectedSize) {
          throw IllegalStateException("Incomplete Gallery write ($bytesCopied of $expectedSize bytes).")
        }

        val publishValues = ContentValues().apply {
          put(MediaStore.Video.Media.IS_PENDING, 0)
        }
        resolver.update(itemUri, publishValues, null, null)
        resolver.notifyChange(itemUri, null)
        savedUri = itemUri
      } catch (err: Exception) {
        try {
          resolver.delete(itemUri, null, null)
        } catch (_: Exception) {
        }
        throw err
      }
    } else {
      @Suppress("DEPRECATION")
      val moviesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES)
      val targetDir = File(moviesDir, "HanumanAI")
      if (!targetDir.exists() && !targetDir.mkdirs()) {
        throw IllegalStateException("Unable to create Movies/HanumanAI directory.")
      }
      val finalFile = File(targetDir, sanitizedName)
      val tempPart = File(targetDir, "$sanitizedName.part")
      if (tempPart.exists()) tempPart.delete()

      try {
        var bytesCopied = 0L
        val buffer = ByteArray(65536)
        FileOutputStream(tempPart).use { output ->
          FileInputStream(sourceFile).use { input ->
            while (true) {
              val read = input.read(buffer)
              if (read <= 0) break
              output.write(buffer, 0, read)
              bytesCopied += read
            }
          }
          output.fd.sync()
        }
        if (bytesCopied != expectedSize) {
          throw IllegalStateException("Incomplete Gallery write ($bytesCopied of $expectedSize bytes).")
        }
        if (finalFile.exists()) finalFile.delete()
        if (!tempPart.renameTo(finalFile)) {
          throw IllegalStateException("Failed to finalize MP4 file in Movies/HanumanAI.")
        }
        savedFilePath = finalFile.absolutePath

        val scanLatch = CountDownLatch(1)
        var scannedUri: Uri? = null
        MediaScannerConnection.scanFile(
          context,
          arrayOf(finalFile.absolutePath),
          arrayOf("video/mp4")
        ) { _, uri ->
          scannedUri = uri
          scanLatch.countDown()
        }
        scanLatch.await(10, TimeUnit.SECONDS)
        savedUri = scannedUri ?: Uri.fromFile(finalFile)
      } catch (err: Exception) {
        if (tempPart.exists()) tempPart.delete()
        throw err
      }
    }

    val finalUri = savedUri ?: throw IllegalStateException("Gallery MediaStore URI missing after write.")
    val playableMeta = readMp4Metadata(context, finalUri)
    if (!playableMeta.hasVideoTrack || playableMeta.durationMs <= 0L) {
      throw IllegalStateException("Saved Gallery file failed final playback verification.")
    }

    postGallerySavedNotification(context, sanitizedName, finalUri)

    return mapOf(
      "contentUri" to finalUri.toString(),
      "filePath" to savedFilePath,
      "relativePath" to relativeFolder,
      "displayName" to sanitizedName,
      "fileSizeBytes" to expectedSize.toDouble(),
      "contentHash" to actualHash,
      "alreadySaved" to false,
      "verifiedPlayable" to true
    )
  }

  private fun postGallerySavedNotification(context: Context, displayName: String, contentUri: Uri) {
    try {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && !nm.areNotificationsEnabled()) {
        return
      }
      val channelId = "hanuman_gallery_exports"
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = NotificationChannel(
          channelId,
          "Gallery Video Exports",
          NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
          description = "Notifies after exported MP4 videos finish saving to Movies/HanumanAI."
        }
        nm.createNotificationChannel(channel)
      }

      val viewIntent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, "video/mp4")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }
      val pendingIntent = PendingIntent.getActivity(context, contentUri.hashCode(), viewIntent, pendingFlags)

      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, channelId)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }
      val notification = builder
        .setSmallIcon(android.R.drawable.stat_sys_download_done)
        .setContentTitle("Saved to Android Gallery")
        .setContentText("$displayName saved in Movies/HanumanAI")
        .setContentIntent(pendingIntent)
        .setAutoCancel(true)
        .build()

      nm.notify(contentUri.hashCode(), notification)
    } catch (_: Exception) {
      // Never fail gallery save if OS notification delivery is restricted
    }
  }

  private fun launchAndroidGalleryIntent(context: Context, contentUriStr: String?) {
    val pm = context.packageManager

    // 1. Prefer launching the device Gallery app directly
    val gallerySelector = Intent.makeMainSelectorActivity(
      Intent.ACTION_MAIN,
      Intent.CATEGORY_APP_GALLERY
    ).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    if (gallerySelector.resolveActivity(pm) != null) {
      context.startActivity(gallerySelector)
      return
    }

    // 2. Fallback: open saved MediaStore item or Video Media Collection in Gallery/Photos
    val targetUri = if (!contentUriStr.isNullOrBlank()) {
      Uri.parse(contentUriStr)
    } else {
      MediaStore.Video.Media.EXTERNAL_CONTENT_URI
    }
    val viewIntent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(targetUri, "video/mp4")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    if (viewIntent.resolveActivity(pm) != null) {
      context.startActivity(viewIntent)
      return
    }

    val mediaCollectionIntent = Intent(Intent.ACTION_VIEW, MediaStore.Video.Media.EXTERNAL_CONTENT_URI).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(mediaCollectionIntent)
  }

  private fun launchAndroidVideoPlayerIntent(context: Context, videoUriStr: String) {
    val parsedUri = Uri.parse(videoUriStr)
    val playIntent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(parsedUri, "video/mp4")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    if (playIntent.resolveActivity(context.packageManager) != null) {
      context.startActivity(playIntent)
      return
    }
    val chooser = Intent.createChooser(playIntent, "Play Exported MP4").apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(chooser)
  }
}
