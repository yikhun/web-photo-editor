// 文字工具：花字樣式定義與文字物件量測/繪製（overlay 預覽與套用到圖片共用同一份繪製邏輯）。

export const FONT_OPTIONS = [
  { id: 'noto', label: 'Noto Sans TC', family: "'Noto Sans TC','Microsoft JhengHei','PingFang TC',sans-serif" },
  { id: 'jhenghei', label: '微軟正黑體', family: "'Microsoft JhengHei','PingFang TC',sans-serif" },
  { id: 'pingfang', label: '蘋方', family: "'PingFang TC','Microsoft JhengHei',sans-serif" },
  { id: 'kai', label: '標楷體', family: "'DFKai-SB','標楷體',serif" },
  { id: 'serif', label: 'Serif 襯線', family: 'serif' },
  { id: 'cursive', label: '手寫 Cursive', family: 'cursive' },
];

function fontString(obj) {
  return `${obj.weight || 400} ${obj.fontSize}px ${obj.fontFamily}`;
}

function setLetterSpacing(g, obj) {
  try {
    g.letterSpacing = `${obj.letterSpacing || 0}px`;
  } catch {
    /* 舊瀏覽器無此屬性則忽略 */
  }
}

function roundRectPath(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ---------- 花字樣式：每個 draw(g, line, x, y, obj) 以目前 textAlign/textBaseline 繪製單行 ----------
export const STYLES = {
  plain: {
    label: '一般',
    draw(g, line, x, y, obj) {
      g.fillStyle = obj.color || '#ffffff';
      g.fillText(line, x, y);
    },
  },
  outline: {
    label: '描邊白字',
    draw(g, line, x, y, obj) {
      g.lineJoin = 'round';
      g.lineWidth = Math.max(1, obj.fontSize * 0.08);
      g.strokeStyle = '#000000';
      g.strokeText(line, x, y);
      g.fillStyle = '#ffffff';
      g.fillText(line, x, y);
    },
  },
  blackyellow: {
    label: '黑框黃字',
    draw(g, line, x, y, obj) {
      g.lineJoin = 'round';
      g.lineWidth = Math.max(1, obj.fontSize * 0.12);
      g.strokeStyle = '#000000';
      g.strokeText(line, x, y);
      g.fillStyle = '#ffd500';
      g.fillText(line, x, y);
    },
  },
  metal: {
    label: '漸層金屬',
    draw(g, line, x, y, obj) {
      const grad = g.createLinearGradient(0, y - obj.fontSize / 2, 0, y + obj.fontSize / 2);
      grad.addColorStop(0, '#fdfdfd');
      grad.addColorStop(0.5, '#9aa0a6');
      grad.addColorStop(1, '#5f646b');
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.lineWidth = Math.max(1, obj.fontSize * 0.02);
      g.strokeText(line, x, y);
      g.fillStyle = grad;
      g.fillText(line, x, y);
    },
  },
  neon: {
    label: '霓虹發光',
    draw(g, line, x, y, obj) {
      const color = obj.color || '#4ef0ff';
      g.save();
      g.shadowColor = color;
      g.shadowBlur = obj.fontSize * 0.6;
      g.fillStyle = color;
      g.fillText(line, x, y);
      g.fillText(line, x, y);
      g.shadowBlur = obj.fontSize * 0.2;
      g.fillStyle = '#ffffff';
      g.fillText(line, x, y);
      g.restore();
    },
  },
  shadow3d: {
    label: '立體陰影',
    draw(g, line, x, y, obj) {
      const steps = Math.max(4, Math.round(obj.fontSize * 0.12));
      g.fillStyle = 'rgba(25,25,25,0.9)';
      for (let i = steps; i > 0; i--) {
        g.fillText(line, x + i * 0.6, y + i * 0.6);
      }
      g.fillStyle = obj.color || '#ffffff';
      g.fillText(line, x, y);
    },
  },
  rainbow: {
    label: '彩虹漸層',
    draw(g, line, x, y, obj) {
      const w = g.measureText(line).width || 1;
      let gx0;
      if (g.textAlign === 'center') gx0 = x - w / 2;
      else if (g.textAlign === 'right') gx0 = x - w;
      else gx0 = x;
      const grad = g.createLinearGradient(gx0, 0, gx0 + w, 0);
      const colors = ['#ff4d4d', '#ffd24d', '#4dff88', '#4dc3ff', '#a64dff'];
      colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1), c));
      g.fillStyle = grad;
      g.fillText(line, x, y);
      void obj;
    },
  },
  doubleline: {
    label: '外框雙描邊',
    draw(g, line, x, y, obj) {
      g.lineJoin = 'round';
      g.strokeStyle = '#ffffff';
      g.lineWidth = Math.max(1, obj.fontSize * 0.18);
      g.strokeText(line, x, y);
      g.strokeStyle = '#000000';
      g.lineWidth = Math.max(1, obj.fontSize * 0.08);
      g.strokeText(line, x, y);
      g.fillStyle = obj.color || '#ff5a8a';
      g.fillText(line, x, y);
    },
  },
  handwrite: {
    label: '手寫感',
    draw(g, line, x, y, obj) {
      g.save();
      g.font = `${obj.weight || 400} ${obj.fontSize}px 'Segoe Script', cursive`;
      g.fillStyle = obj.color || '#ffffff';
      g.fillText(line, x, y);
      g.restore();
    },
  },
  retro: {
    label: '復古投影',
    draw(g, line, x, y, obj) {
      const off = Math.max(2, obj.fontSize * 0.05);
      g.fillStyle = '#7a2b12';
      for (let i = 6; i >= 1; i--) {
        g.fillText(line, x + i * off, y + i * off);
      }
      g.fillStyle = obj.color || '#ffe08a';
      g.fillText(line, x, y);
    },
  },
  bar: {
    label: '半透明底條',
    draw(g, line, x, y, obj) {
      const w = g.measureText(line).width || 1;
      const padX = obj.fontSize * 0.3;
      const padY = obj.fontSize * 0.18;
      let bx;
      if (g.textAlign === 'center') bx = x - w / 2 - padX;
      else if (g.textAlign === 'right') bx = x - w - padX * 2;
      else bx = x - padX;
      const bw = w + padX * 2;
      const bh = obj.fontSize + padY * 2;
      const by = y - obj.fontSize / 2 - padY;
      g.save();
      g.fillStyle = 'rgba(0,0,0,0.55)';
      roundRectPath(g, bx, by, bw, bh, bh * 0.2);
      g.fill();
      g.restore();
      g.fillStyle = obj.color || '#ffffff';
      g.fillText(line, x, y);
    },
  },
  bubble: {
    label: '泡泡字',
    draw(g, line, x, y, obj) {
      g.lineJoin = 'round';
      g.strokeStyle = '#1c6fa8';
      g.lineWidth = Math.max(1, obj.fontSize * 0.22);
      g.strokeText(line, x, y);
      g.fillStyle = obj.color || '#bfe6ff';
      g.fillText(line, x, y);
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.lineWidth = Math.max(1, obj.fontSize * 0.05);
      g.strokeText(line, x, y - obj.fontSize * 0.05);
    },
  },
};

export const STYLE_OPTIONS = Object.keys(STYLES)
  .filter((id) => id !== 'plain')
  .map((id) => ({ id, label: STYLES[id].label }));

// 以獨立 scratch context 量測（不受畫面變換影響）。
let scratchCtx = null;
function getScratchCtx() {
  if (!scratchCtx) scratchCtx = document.createElement('canvas').getContext('2d');
  return scratchCtx;
}

export function measureTextObject(obj) {
  const g = getScratchCtx();
  g.font = fontString(obj);
  setLetterSpacing(g, obj);
  const lines = (obj.text || '').split('\n');
  let maxW = 0;
  for (const line of lines) {
    const w = g.measureText(line).width;
    if (w > maxW) maxW = w;
  }
  const lineHeight = obj.fontSize * (obj.lineHeight || 1.2);
  const height = lineHeight * lines.length;
  return { width: maxW, height, lineHeight, lines };
}

// 在給定 2D context 上繪製文字物件（g 的變換矩陣決定座標系：
// 呼叫端需自行 translate/scale 到物件所在座標系，這裡只負責物件內部排版）。
export function renderTextObject(g, obj) {
  const { lines, lineHeight, width, height } = measureTextObject(obj);
  g.save();
  g.translate(obj.x, obj.y);
  g.rotate(obj.rotation || 0);
  g.globalAlpha = obj.opacity != null ? obj.opacity : 1;
  g.textAlign = obj.align || 'center';
  g.textBaseline = 'middle';
  g.font = fontString(obj);
  setLetterSpacing(g, obj);
  const style = STYLES[obj.style] || STYLES.plain;
  const totalH = lineHeight * (lines.length - 1);
  lines.forEach((line, i) => {
    const ly = -totalH / 2 + i * lineHeight;
    style.draw(g, line, 0, ly, obj);
  });
  g.restore();
  return { width, height };
}
