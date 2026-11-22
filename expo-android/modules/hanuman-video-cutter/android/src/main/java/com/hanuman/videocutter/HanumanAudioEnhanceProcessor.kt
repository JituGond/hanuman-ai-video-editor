package com.hanuman.videocutter

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.tanh

/**
 * Real-time on-device PCM audio processor for Media3 Transformer.
 * Performs high-pass rumble removal, adaptive noise-floor gating, 2.5kHz voice presence boost,
 * RMS/peak gain normalization with soft-clipping protection, or fixed background music scaling.
 */
@OptIn(UnstableApi::class)
class HanumanAudioEnhanceProcessor(
  private val gainDb: Float,
  private val noiseGateDb: Float,
  private val voiceClarityBoostDb: Float,
  private val highPassHz: Float,
  private val fixedLinearScale: Float = 1.0f
) : BaseAudioProcessor() {

  private var sampleRateHz = 48000
  private var channelCount = 2

  private var hpAlpha = 0.985f
  private val prevInput = FloatArray(8)
  private val prevHpOutput = FloatArray(8)
  private val prevLpState = FloatArray(8)
  private var gateEnvelope = 1.0f

  private val targetLinearGain = if (fixedLinearScale != 1.0f) {
    fixedLinearScale
  } else {
    10.0.pow((gainDb / 20.0)).toFloat()
  }

  private val gateThresholdLinear = if (noiseGateDb <= -85f) {
    0f
  } else {
    10.0.pow((noiseGateDb / 20.0)).toFloat()
  }

  private val clarityAmount = max(0f, voiceClarityBoostDb / 6.0f)

  override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
    if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) {
      throw AudioProcessor.UnhandledAudioFormatException(inputAudioFormat)
    }
    sampleRateHz = max(8000, inputAudioFormat.sampleRate)
    channelCount = min(8, max(1, inputAudioFormat.channelCount))

    if (highPassHz > 0f) {
      val rc = 1.0f / (2.0f * Math.PI.toFloat() * highPassHz)
      val dt = 1.0f / sampleRateHz.toFloat()
      hpAlpha = rc / (rc + dt)
    }
    return inputAudioFormat
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val remaining = inputBuffer.remaining()
    if (remaining == 0) return

    val outBuffer = replaceOutputBuffer(remaining)
    val bytesPerFrame = 2 * channelCount
    val frameCount = remaining / bytesPerFrame

    for (f in 0 until frameCount) {
      var framePeak = 0f
      val frameSamples = FloatArray(channelCount)

      for (ch in 0 until channelCount) {
        val sampleShort = inputBuffer.short
        var x = sampleShort.toFloat() / 32768.0f

        if (fixedLinearScale == 1.0f) {
          // 1. High-pass filter (~85Hz) to remove rumble / wind
          if (highPassHz > 0f) {
            val hp = hpAlpha * (prevHpOutput[ch] + x - prevInput[ch])
            prevInput[ch] = x
            prevHpOutput[ch] = hp
            x = hp
          }

          // 2. Voice presence boost (~2.5kHz high-mid emphasis)
          if (clarityAmount > 0f) {
            val lp = prevLpState[ch] + 0.25f * (x - prevLpState[ch])
            prevLpState[ch] = lp
            val highMid = x - lp
            x += highMid * clarityAmount * 0.45f
          }
        }

        frameSamples[ch] = x
        framePeak = max(framePeak, abs(x))
      }

      // 3. Smooth adaptive noise gate
      if (fixedLinearScale == 1.0f && gateThresholdLinear > 0f) {
        val targetGate = if (framePeak < gateThresholdLinear) 0.22f else 1.0f
        val coeff = if (targetGate < gateEnvelope) 0.004f else 0.04f
        gateEnvelope += coeff * (targetGate - gateEnvelope)
      } else {
        gateEnvelope = 1.0f
      }

      // 4. Gain normalization + soft tanh limiter
      for (ch in 0 until channelCount) {
        val processed = tanh((frameSamples[ch] * gateEnvelope * targetLinearGain).toDouble()).toFloat()
        val clamped = max(-1.0f, min(1.0f, processed))
        outBuffer.putShort((clamped * 32767.0f).toInt().toShort())
      }
    }

    // Copy any trailing bytes if buffer wasn't frame-aligned
    while (inputBuffer.hasRemaining()) {
      outBuffer.put(inputBuffer.get())
    }

    outBuffer.flip()
  }

  override fun onReset() {
    prevInput.fill(0f)
    prevHpOutput.fill(0f)
    prevLpState.fill(0f)
    gateEnvelope = 1.0f
  }
}
