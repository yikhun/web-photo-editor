// WebGL2 調色 shader：所有預設/滑桿/分離色調/暈影/顆粒/褪色/一鍵換色/獨立濾鏡都在這顆 fragment shader 內完成。
// alpha 全程不受影響（透明 PNG 套色後 alpha 不變）。

export const VERTEX_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2 uTexel;     // 1/width, 1/height
uniform float uAspect;   // width/height

uniform float uExposure, uBrightness, uContrast, uSaturation, uVibrance;
uniform float uTemperature, uTint;
uniform float uHighlights, uShadows, uWhites, uBlacks;
uniform float uClarity, uSharpen, uVignette, uGrain, uFade;
uniform float uIntensity;

uniform vec3 uSplitShadowColor;
uniform vec3 uSplitHighlightColor;
uniform float uSplitStrength;

uniform int uFilterMode; // 0 none 1 blur 2 emboss 3 sketch 4 oil 5 pixelate 6 invert 7 sepia 8 lomo 9 duotone
uniform float uFilterIntensity;
uniform vec3 uDuotoneColor1;
uniform vec3 uDuotoneColor2;
uniform float uPixelSize;

uniform int uColorReplaceEnabled;
uniform float uSourceHue;
uniform float uTargetHue;
uniform float uTolerance;
uniform int uPreserveLightness;
uniform float uTargetSat;
uniform float uTargetLight;

const float PI = 3.14159265359;

float luminance(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  float h = 0.0;
  float s = 0.0;
  if (d > 1e-6) {
    s = d / (1.0 - abs(2.0 * l - 1.0));
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
    if (h < 0.0) h += 360.0;
  }
  return vec3(h, s, l);
}

vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x;
  float s = hsl.y;
  float l = hsl.z;
  float c = (1.0 - abs(2.0 * l - 1.0)) * s;
  float hp = mod(h, 360.0) / 60.0;
  float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb1;
  if (hp < 1.0) rgb1 = vec3(c, x, 0.0);
  else if (hp < 2.0) rgb1 = vec3(x, c, 0.0);
  else if (hp < 3.0) rgb1 = vec3(0.0, c, x);
  else if (hp < 4.0) rgb1 = vec3(0.0, x, c);
  else if (hp < 5.0) rgb1 = vec3(x, 0.0, c);
  else rgb1 = vec3(c, 0.0, x);
  float m = l - c * 0.5;
  return rgb1 + vec3(m);
}

vec3 box3(vec2 uv) {
  vec3 sum = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      sum += texture(uTex, uv + vec2(float(x), float(y)) * uTexel).rgb;
    }
  }
  return sum / 9.0;
}

vec3 sobelSketch(vec2 uv) {
  float tl = luminance(texture(uTex, uv + vec2(-1.0, -1.0) * uTexel).rgb);
  float t  = luminance(texture(uTex, uv + vec2( 0.0, -1.0) * uTexel).rgb);
  float tr = luminance(texture(uTex, uv + vec2( 1.0, -1.0) * uTexel).rgb);
  float l  = luminance(texture(uTex, uv + vec2(-1.0,  0.0) * uTexel).rgb);
  float r  = luminance(texture(uTex, uv + vec2( 1.0,  0.0) * uTexel).rgb);
  float bl = luminance(texture(uTex, uv + vec2(-1.0,  1.0) * uTexel).rgb);
  float b  = luminance(texture(uTex, uv + vec2( 0.0,  1.0) * uTexel).rgb);
  float br = luminance(texture(uTex, uv + vec2( 1.0,  1.0) * uTexel).rgb);
  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
  float edge = clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);
  float v = 1.0 - edge;
  return vec3(v);
}

vec3 embossEffect(vec2 uv) {
  vec3 c0 = texture(uTex, uv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 c1 = texture(uTex, uv + vec2(1.0, 1.0) * uTexel).rgb;
  vec3 diff = (c1 - c0) * 2.0 + vec3(0.5);
  float g = luminance(diff);
  return vec3(g);
}

// 簡化版油畫感：5x5 鄰域依亮度分桶，取樣本數最多的桶內平均色
vec3 oilEffect(vec2 uv) {
  const int BINS = 8;
  float binCount[BINS];
  vec3 binColor[BINS];
  for (int i = 0; i < BINS; i++) { binCount[i] = 0.0; binColor[i] = vec3(0.0); }
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec3 c = texture(uTex, uv + vec2(float(x), float(y)) * uTexel).rgb;
      int bin = int(clamp(luminance(c), 0.0, 0.999) * float(BINS));
      for (int k = 0; k < BINS; k++) {
        if (k == bin) {
          binCount[k] += 1.0;
          binColor[k] += c;
        }
      }
    }
  }
  float bestCount = -1.0;
  vec3 bestColor = vec3(0.0);
  for (int k = 0; k < BINS; k++) {
    if (binCount[k] > bestCount) {
      bestCount = binCount[k];
      bestColor = binColor[k] / max(binCount[k], 1.0);
    }
  }
  return bestColor;
}

vec3 lomoEffect(vec3 rgb, vec2 uv) {
  vec3 hsl = rgb2hsl(rgb);
  hsl.y = clamp(hsl.y * 1.35, 0.0, 1.0);
  vec3 c = hsl2rgb(hsl);
  c = (c - 0.5) * 1.25 + 0.5;
  c.r += 0.03;
  c.b -= 0.02;
  vec2 centered = (uv - 0.5) * vec2(uAspect, 1.0);
  float d = length(centered);
  float vig = smoothstep(0.95, 0.25, d);
  c *= mix(0.55, 1.0, vig);
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec4 srcSample = texture(uTex, vUv);
  vec3 original = srcSample.rgb;
  float alpha = srcSample.a;
  vec3 rgb = original;

  // ---- 獨立濾鏡（取鄰域樣本，疊在原圖上，再依強度混合）----
  if (uFilterMode == 5) {
    vec2 uvp = (floor(vUv / uPixelSize) + 0.5) * uPixelSize;
    rgb = texture(uTex, uvp).rgb;
  } else if (uFilterMode != 0) {
    vec3 filtered = rgb;
    if (uFilterMode == 1) filtered = box3(vUv);
    else if (uFilterMode == 2) filtered = embossEffect(vUv);
    else if (uFilterMode == 3) filtered = sobelSketch(vUv);
    else if (uFilterMode == 4) filtered = oilEffect(vUv);
    else if (uFilterMode == 6) filtered = 1.0 - rgb;
    else if (uFilterMode == 7) {
      float l = luminance(rgb);
      filtered = vec3(l * 1.07 + 0.05, l * 0.84, l * 0.55);
    } else if (uFilterMode == 8) filtered = lomoEffect(rgb, vUv);
    else if (uFilterMode == 9) {
      float l = luminance(rgb);
      filtered = mix(uDuotoneColor1, uDuotoneColor2, l);
    }
    rgb = mix(rgb, filtered, uFilterIntensity);
  }

  // ---- 色溫 / 色調 ----
  float t = uTemperature / 100.0;
  rgb.r += t * 0.12;
  rgb.b -= t * 0.12;
  float ti = uTint / 100.0;
  rgb.g -= ti * 0.10;
  rgb.r += ti * 0.05;
  rgb.b += ti * 0.05;

  // ---- 曝光 / 亮度 / 對比 ----
  rgb *= pow(2.0, uExposure / 100.0 * 2.0);
  rgb += uBrightness / 100.0 * 0.3;
  rgb = (rgb - 0.5) * (1.0 + uContrast / 100.0) + 0.5;

  // ---- 高光 / 陰影 / 白色 / 黑色 ----
  float lum = luminance(rgb);
  rgb += uHighlights / 100.0 * 0.3 * smoothstep(0.5, 1.0, lum) * (1.0 - lum);
  rgb += uShadows / 100.0 * 0.3 * smoothstep(0.5, 0.0, lum) * (lum + 0.15);
  rgb += uWhites / 100.0 * 0.25 * smoothstep(0.75, 1.0, lum);
  rgb += uBlacks / 100.0 * 0.25 * smoothstep(0.25, 0.0, lum);

  // ---- 清晰度（局部對比）/ 銳化 ----
  if (abs(uClarity) > 0.5 || uSharpen > 0.5) {
    vec3 blurred = box3(vUv);
    vec3 delta = rgb - blurred;
    rgb += delta * (uClarity / 100.0) * 1.4;
    rgb += delta * (uSharpen / 100.0) * 1.0;
  }

  // ---- 飽和度 / 自然飽和度 ----
  if (abs(uSaturation) > 0.5 || abs(uVibrance) > 0.5) {
    vec3 hsl = rgb2hsl(clamp(rgb, 0.0, 1.0));
    hsl.y = clamp(hsl.y * (1.0 + uSaturation / 100.0), 0.0, 1.0);
    float vib = uVibrance / 100.0;
    hsl.y = clamp(hsl.y + vib * (1.0 - hsl.y) * 0.9, 0.0, 1.0);
    rgb = hsl2rgb(hsl);
  }

  // ---- 分離色調 ----
  if (uSplitStrength > 0.5) {
    float l2 = luminance(clamp(rgb, 0.0, 1.0));
    float shadowAmt = (1.0 - smoothstep(0.0, 0.6, l2)) * (uSplitStrength / 100.0);
    float highAmt = smoothstep(0.4, 1.0, l2) * (uSplitStrength / 100.0);
    rgb += (uSplitShadowColor - 0.5) * shadowAmt * 0.7;
    rgb += (uSplitHighlightColor - 0.5) * highAmt * 0.7;
  }

  // ---- 褪色 ----
  if (uFade > 0.5) {
    float f = uFade / 100.0;
    rgb = mix(rgb, rgb * 0.82 + 0.12, f);
  }

  // ---- 暈影 ----
  if (uVignette > 0.5) {
    vec2 centered = (vUv - 0.5) * vec2(uAspect, 1.0);
    float d = length(centered);
    float vig = smoothstep(1.0, 0.3, d);
    rgb *= mix(1.0, vig, uVignette / 100.0);
  }

  // ---- 顆粒 ----
  if (uGrain > 0.5) {
    float n = hash(gl_FragCoord.xy) * 2.0 - 1.0;
    rgb += n * (uGrain / 100.0) * 0.12;
  }

  rgb = clamp(rgb, 0.0, 1.0);

  // ---- 一鍵換色 ----
  if (uColorReplaceEnabled == 1) {
    vec3 hsl = rgb2hsl(rgb);
    float diff = abs(mod(hsl.x - uSourceHue + 180.0, 360.0) - 180.0);
    float satMask = smoothstep(0.06, 0.22, hsl.y);
    float hueMask = 1.0 - smoothstep(uTolerance * 0.5, uTolerance, diff);
    float mask = clamp(hueMask * satMask, 0.0, 1.0);
    vec3 hslNew = hsl;
    hslNew.x = mod(uTargetHue, 360.0);
    if (uPreserveLightness == 0) {
      hslNew.y = uTargetSat;
      hslNew.z = uTargetLight;
    }
    vec3 recolored = hsl2rgb(hslNew);
    rgb = mix(rgb, recolored, mask);
  }

  rgb = clamp(mix(original, rgb, uIntensity / 100.0), 0.0, 1.0);
  outColor = vec4(rgb, alpha);
}`;

export const UNIFORM_NAMES = [
  'uTex', 'uTexel', 'uAspect',
  'uExposure', 'uBrightness', 'uContrast', 'uSaturation', 'uVibrance',
  'uTemperature', 'uTint',
  'uHighlights', 'uShadows', 'uWhites', 'uBlacks',
  'uClarity', 'uSharpen', 'uVignette', 'uGrain', 'uFade', 'uIntensity',
  'uSplitShadowColor', 'uSplitHighlightColor', 'uSplitStrength',
  'uFilterMode', 'uFilterIntensity', 'uDuotoneColor1', 'uDuotoneColor2', 'uPixelSize',
  'uColorReplaceEnabled', 'uSourceHue', 'uTargetHue', 'uTolerance',
  'uPreserveLightness', 'uTargetSat', 'uTargetLight',
];
