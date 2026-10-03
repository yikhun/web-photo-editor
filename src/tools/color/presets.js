// 調色預設：一組滑桿數值 + 可選分離色調（陰影/高光色＋強度）。id='original' 代表原圖（全部歸零）。
import { hexToRgb01 } from './colorUtil.js';

function split(shadowHex, highlightHex, strength) {
  return {
    splitShadowColor: hexToRgb01(shadowHex),
    splitHighlightColor: hexToRgb01(highlightHex),
    splitStrength: strength,
  };
}

export const PRESETS = [
  { id: 'original', label: '原圖', values: {} },
  {
    id: 'vivid',
    label: '鮮明',
    values: { contrast: 20, saturation: 28, vibrance: 20, clarity: 15 },
  },
  {
    id: 'warm',
    label: '暖陽',
    values: { temperature: 28, exposure: 6, highlights: -8, vibrance: 12 },
  },
  {
    id: 'cool',
    label: '冷調',
    values: { temperature: -26, tint: 4, contrast: 6, shadows: 6 },
  },
  {
    id: 'japanese',
    label: '日系清新',
    values: { exposure: 16, contrast: -16, saturation: -10, whites: 10, fade: 10 },
  },
  {
    id: 'cinematic',
    label: '電影感',
    values: { contrast: 10, saturation: -6, shadows: 4, ...split('#1b5e6b', '#e8935a', 55) },
  },
  {
    id: 'vintage',
    label: '復古膠片',
    values: { fade: 26, grain: 22, vignette: 22, saturation: -16, temperature: 10 },
  },
  {
    id: 'bw',
    label: '黑白',
    values: { saturation: -100, contrast: 6 },
  },
  {
    id: 'bw-contrast',
    label: '高對比黑白',
    values: { saturation: -100, contrast: 42, blacks: -20, whites: 20 },
  },
  {
    id: 'faded',
    label: '褪色',
    values: { fade: 36, contrast: -20, blacks: 12 },
  },
  {
    id: 'sunset',
    label: '夕陽',
    values: { temperature: 36, tint: -5, highlights: -14, shadows: 10, vibrance: 16 },
  },
  {
    id: 'forest',
    label: '森林綠',
    values: { saturation: 10, temperature: -10, tint: 10, ...split('#355e3b', '#cfead1', 35) },
  },
  {
    id: 'pastel',
    label: '粉嫩',
    values: { exposure: 10, contrast: -16, saturation: -10, fade: 12, ...split('#f6c6d9', '#fff2f6', 32) },
  },
  {
    id: 'night',
    label: '夜景',
    values: { exposure: -10, contrast: 16, shadows: -16, blacks: -10, temperature: -16, vignette: 18 },
  },
];

export function findPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}
