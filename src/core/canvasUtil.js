// Canvas 工具函式：建立、複製、從檔案/Blob 載入影像

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function cloneCanvas(src) {
  const out = createCanvas(src.width, src.height);
  out.getContext('2d').drawImage(src, 0, 0);
  return out;
}

export function canvasFromImage(img) {
  const canvas = createCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas;
}

export function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(canvasFromImage(img));
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

export function loadImageFromFile(file) {
  return loadImageFromBlob(file);
}

export function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(canvasFromImage(img));
    img.onerror = reject;
    img.src = url;
  });
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

// 畫灰白棋盤格（透明區域示意），size 為單格邊長（CSS px）
export function drawCheckerboard(ctx2d, x, y, w, h, size = 10) {
  ctx2d.save();
  ctx2d.beginPath();
  ctx2d.rect(x, y, w, h);
  ctx2d.clip();
  const colorA = '#3a3b3e';
  const colorB = '#2c2d30';
  for (let row = 0; row * size < h; row++) {
    for (let col = 0; col * size < w; col++) {
      ctx2d.fillStyle = (row + col) % 2 === 0 ? colorA : colorB;
      ctx2d.fillRect(x + col * size, y + row * size, size, size);
    }
  }
  ctx2d.restore();
}
