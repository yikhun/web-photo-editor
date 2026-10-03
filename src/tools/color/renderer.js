// WebGL2 渲染器：編譯 shader、上傳來源影像為材質、依參數畫出結果，讀回 2D canvas。
// 大圖超過 MAX_TEXTURE_SIZE 時改用重疊分塊（applyTiled）避免整張失敗。
import { VERTEX_SRC, FRAGMENT_SRC, UNIFORM_NAMES } from './shader.js';
import { createCanvas } from '../../core/canvasUtil.js';

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

export function createGlRenderer() {
  let gl;
  const glCanvas = document.createElement('canvas');
  try {
    gl = glCanvas.getContext('webgl2', {
      premultipliedAlpha: false,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;

  let program;
  try {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
    }
  } catch (err) {
    console.error('[color/renderer] shader 編譯失敗', err);
    return null;
  }

  const uniforms = {};
  for (const name of UNIFORM_NAMES) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }

  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  let texW = 0;
  let texH = 0;

  function uploadSource(srcCanvas) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
    texW = srcCanvas.width;
    texH = srcCanvas.height;
  }

  function setUniforms(p) {
    gl.uniform1i(uniforms.uTex, 0);
    gl.uniform2f(uniforms.uTexel, 1 / texW, 1 / texH);
    gl.uniform1f(uniforms.uAspect, texW / texH);

    gl.uniform1f(uniforms.uExposure, p.exposure);
    gl.uniform1f(uniforms.uBrightness, p.brightness);
    gl.uniform1f(uniforms.uContrast, p.contrast);
    gl.uniform1f(uniforms.uSaturation, p.saturation);
    gl.uniform1f(uniforms.uVibrance, p.vibrance);
    gl.uniform1f(uniforms.uTemperature, p.temperature);
    gl.uniform1f(uniforms.uTint, p.tint);
    gl.uniform1f(uniforms.uHighlights, p.highlights);
    gl.uniform1f(uniforms.uShadows, p.shadows);
    gl.uniform1f(uniforms.uWhites, p.whites);
    gl.uniform1f(uniforms.uBlacks, p.blacks);
    gl.uniform1f(uniforms.uClarity, p.clarity);
    gl.uniform1f(uniforms.uSharpen, p.sharpen);
    gl.uniform1f(uniforms.uVignette, p.vignette);
    gl.uniform1f(uniforms.uGrain, p.grain);
    gl.uniform1f(uniforms.uFade, p.fade);
    gl.uniform1f(uniforms.uIntensity, p.intensity);

    const ss = p.splitShadowColor || [0.5, 0.5, 0.5];
    const sh = p.splitHighlightColor || [0.5, 0.5, 0.5];
    gl.uniform3f(uniforms.uSplitShadowColor, ss[0], ss[1], ss[2]);
    gl.uniform3f(uniforms.uSplitHighlightColor, sh[0], sh[1], sh[2]);
    gl.uniform1f(uniforms.uSplitStrength, p.splitStrength || 0);

    const filter = p.filter || { mode: 0, intensity: 100 };
    gl.uniform1i(uniforms.uFilterMode, filter.mode || 0);
    gl.uniform1f(uniforms.uFilterIntensity, (filter.intensity ?? 100) / 100);
    const d1 = filter.duotoneColor1 || [0.05, 0.05, 0.2];
    const d2 = filter.duotoneColor2 || [1, 0.8, 0.4];
    gl.uniform3f(uniforms.uDuotoneColor1, d1[0], d1[1], d1[2]);
    gl.uniform3f(uniforms.uDuotoneColor2, d2[0], d2[1], d2[2]);
    const blockPx = Math.max(2, filter.pixelBlock || 10);
    gl.uniform1f(uniforms.uPixelSize, blockPx / Math.max(texW, texH));

    const cr = p.colorReplace || { enabled: false };
    gl.uniform1i(uniforms.uColorReplaceEnabled, cr.enabled ? 1 : 0);
    gl.uniform1f(uniforms.uSourceHue, cr.sourceHue || 0);
    gl.uniform1f(uniforms.uTargetHue, cr.targetHue || 0);
    gl.uniform1f(uniforms.uTolerance, cr.tolerance ?? 30);
    gl.uniform1i(uniforms.uPreserveLightness, cr.preserveLightness === false ? 0 : 1);
    gl.uniform1f(uniforms.uTargetSat, cr.targetSat ?? 0.6);
    gl.uniform1f(uniforms.uTargetLight, cr.targetLight ?? 0.5);
  }

  // 畫到內部 gl canvas（尺寸 = 目前材質尺寸），回傳一個新的 2D canvas（複製結果，避免依賴 drawing buffer 存活）
  function renderToCanvas(params) {
    if (texW === 0 || texH === 0) return null;
    if (glCanvas.width !== texW || glCanvas.height !== texH) {
      glCanvas.width = texW;
      glCanvas.height = texH;
    }
    gl.viewport(0, 0, texW, texH);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    setUniforms(params);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    const out = createCanvas(texW, texH);
    out.getContext('2d').drawImage(glCanvas, 0, 0);
    return out;
  }

  function getMaxTextureSize() {
    return gl.getParameter(gl.MAX_TEXTURE_SIZE);
  }

  function destroy() {
    gl.deleteTexture(texture);
    gl.deleteBuffer(buf);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
  }

  return { uploadSource, renderToCanvas, getMaxTextureSize, destroy };
}

// 全尺寸套用：若超過材質上限，切成有重疊（避免鄰域取樣接縫）的直條分塊分別渲染再拼回。
export function applyFull(renderer, srcCanvas, params) {
  const maxSize = renderer.getMaxTextureSize();
  if (srcCanvas.width <= maxSize && srcCanvas.height <= maxSize) {
    renderer.uploadSource(srcCanvas);
    return renderer.renderToCanvas(params);
  }

  const overlap = 24;
  const tileW = Math.max(64, Math.min(maxSize, 2048));
  const out = createCanvas(srcCanvas.width, srcCanvas.height);
  const octx = out.getContext('2d');
  const srcCtx = srcCanvas.getContext('2d');

  for (let x0 = 0; x0 < srcCanvas.width; x0 += tileW) {
    const padLeft = x0 === 0 ? 0 : overlap;
    const sx = x0 - padLeft;
    const ex = Math.min(srcCanvas.width, x0 + tileW + overlap);
    const w = ex - sx;
    const tile = createCanvas(w, srcCanvas.height);
    tile.getContext('2d').putImageData(srcCtx.getImageData(sx, 0, w, srcCanvas.height), 0, 0);
    renderer.uploadSource(tile);
    const rendered = renderer.renderToCanvas(params);
    const destW = Math.min(tileW, srcCanvas.width - x0);
    octx.drawImage(rendered, padLeft, 0, destW, srcCanvas.height, x0, 0, destW, srcCanvas.height);
  }
  return out;
}
