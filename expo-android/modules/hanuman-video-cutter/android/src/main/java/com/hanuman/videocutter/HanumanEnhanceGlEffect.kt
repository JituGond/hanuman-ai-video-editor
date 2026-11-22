package com.hanuman.videocutter

import android.content.Context
import android.opengl.GLES20
import androidx.annotation.OptIn
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.common.util.GlProgram
import androidx.media3.common.util.GlUtil
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BaseGlShaderProgram
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram

/**
 * Hardware-accelerated OpenGL ES 2.0 fragment shader effect for Media3 Transformer.
 * Performs real 3x3 unsharp-mask sharpness, 4-neighbor spatial noise reduction,
 * and smooth clip-in transition fade over the first 280ms.
 */
@OptIn(UnstableApi::class)
class HanumanEnhanceGlEffect(
  private val sharpnessAmount: Float,
  private val denoiseStrength: Float,
  private val fadeInDurationUs: Long
) : GlEffect {

  override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram {
    return HanumanEnhanceShaderProgram(
      useHdr = useHdr,
      sharpnessAmount = sharpnessAmount,
      denoiseStrength = denoiseStrength,
      fadeInDurationUs = fadeInDurationUs
    )
  }
}

@OptIn(UnstableApi::class)
private class HanumanEnhanceShaderProgram(
  useHdr: Boolean,
  private val sharpnessAmount: Float,
  private val denoiseStrength: Float,
  private val fadeInDurationUs: Long
) : BaseGlShaderProgram(useHdr, 1) {

  private var glProgram: GlProgram? = null
  private var texWidth = 1280
  private var texHeight = 720

  init {
    val vertexShader = """
      attribute vec4 aFramePosition;
      varying vec2 vTexSamplingCoord;
      void main() {
        gl_Position = aFramePosition;
        vTexSamplingCoord = vec2(aFramePosition.x * 0.5 + 0.5, aFramePosition.y * 0.5 + 0.5);
      }
    """.trimIndent()

    val fragmentShader = """
      precision mediump float;
      uniform sampler2D uTexSampler;
      uniform vec2 uTexelSize;
      uniform float uSharpness;
      uniform float uDenoise;
      uniform float uFadeFactor;
      varying vec2 vTexSamplingCoord;

      void main() {
        vec4 center = texture2D(uTexSampler, vTexSamplingCoord);
        vec3 n = texture2D(uTexSampler, vTexSamplingCoord + vec2(0.0, uTexelSize.y)).rgb;
        vec3 s = texture2D(uTexSampler, vTexSamplingCoord - vec2(0.0, uTexelSize.y)).rgb;
        vec3 e = texture2D(uTexSampler, vTexSamplingCoord + vec2(uTexelSize.x, 0.0)).rgb;
        vec3 w = texture2D(uTexSampler, vTexSamplingCoord - vec2(uTexelSize.x, 0.0)).rgb;

        vec3 avg = (n + s + e + w) * 0.25;
        vec3 baseColor = mix(center.rgb, avg, clamp(uDenoise, 0.0, 0.45));
        vec3 detail = baseColor - avg;
        vec3 sharpened = clamp(baseColor + detail * clamp(uSharpness, 0.0, 0.8), 0.0, 1.0);

        gl_FragColor = vec4(sharpened * uFadeFactor, center.a);
      }
    """.trimIndent()

    glProgram = GlProgram(vertexShader, fragmentShader)
  }

  override fun configure(inputWidth: Int, inputHeight: Int): Size {
    texWidth = inputWidth
    texHeight = inputHeight
    return Size(inputWidth, inputHeight)
  }

  override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
    val program = glProgram ?: throw VideoFrameProcessingException("Shader program released.")
    try {
      program.use()
      program.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
      program.setFloatsUniform(
        "uTexelSize",
        floatArrayOf(1.0f / texWidth.toFloat(), 1.0f / texHeight.toFloat())
      )
      program.setFloatUniform("uSharpness", sharpnessAmount)
      program.setFloatUniform("uDenoise", denoiseStrength)

      val fadeFactor = if (fadeInDurationUs > 0L && presentationTimeUs < fadeInDurationUs) {
        (presentationTimeUs.toFloat() / fadeInDurationUs.toFloat()).coerceIn(0.15f, 1.0f)
      } else {
        1.0f
      }
      program.setFloatUniform("uFadeFactor", fadeFactor)

      program.setBufferAttribute(
        "aFramePosition",
        GlUtil.getNormalizedCoordinateBounds(),
        GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE
      )
      program.bindAttributesAndUniforms()

      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    } catch (e: GlUtil.GlException) {
      throw VideoFrameProcessingException(e)
    }
  }

  override fun release() {
    super.release()
    try {
      glProgram?.delete()
      glProgram = null
    } catch (_: Exception) {
    }
  }
}
