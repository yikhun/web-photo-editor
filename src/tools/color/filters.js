// 獨立濾鏡清單：id 對應 shader 的 uFilterMode。
export const FILTERS = [
  { mode: 0, id: 'none', label: '無' },
  { mode: 1, id: 'blur', label: '模糊' },
  { mode: 2, id: 'emboss', label: '浮雕' },
  { mode: 3, id: 'sketch', label: '素描' },
  { mode: 4, id: 'oil', label: '油畫感' },
  { mode: 5, id: 'pixelate', label: '像素化' },
  { mode: 6, id: 'invert', label: '反相' },
  { mode: 7, id: 'sepia', label: '懷舊棕' },
  { mode: 8, id: 'lomo', label: 'LOMO' },
  { mode: 9, id: 'duotone', label: '雙色調' },
];

export function findFilter(id) {
  return FILTERS.find((f) => f.id === id) || FILTERS[0];
}
