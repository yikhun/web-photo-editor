// 新增工具：上傳圖片（按鈕／拖曳／貼上）、或產生範例測試圖。
// 載入後自動 doc.load、fit 畫面、切到「調整」工具。拖曳與貼上由 main.js 全域監聽，呼叫 handleIncomingFiles。
import { loadImageFromFile, createCanvas } from '../core/canvasUtil.js';

const icon = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 5v14M5 12h14" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export async function handleIncomingFiles(fileOrFiles, ctx) {
  const files = fileOrFiles.length != null ? Array.from(fileOrFiles) : [fileOrFiles];
  const file = files.find((f) => f.type && f.type.startsWith('image/')) || files[0];
  if (!file) return;
  try {
    const canvas = await loadImageFromFile(file);
    ctx.doc.load(canvas, file.name || '未命名.png');
    ctx.viewport.requestRender();
    ctx.setTool('adjust');
    ctx.toast('圖片已載入', 'success');
  } catch (err) {
    console.error('[add] 載入圖片失敗', err);
    ctx.toast('載入圖片失敗', 'error');
  }
}

function makeSampleImage() {
  const w = 1200;
  const h = 800;
  const canvas = createCanvas(w, h);
  const g = canvas.getContext('2d');

  // 漸層背景
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#4f8cff');
  grad.addColorStop(0.5, '#8a5cf5');
  grad.addColorStop(1, '#f55c9c');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // 幾何圖形
  g.save();
  g.globalAlpha = 0.85;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(260, 240, 140, 0, Math.PI * 2);
  g.fill();

  g.fillStyle = '#ffd166';
  g.beginPath();
  g.moveTo(760, 120);
  g.lineTo(980, 120);
  g.lineTo(870, 320);
  g.closePath();
  g.fill();

  g.strokeStyle = '#06d6a0';
  g.lineWidth = 18;
  g.strokeRect(880, 420, 260, 220);

  g.fillStyle = 'rgba(255,255,255,0.4)';
  g.beginPath();
  g.ellipse(420, 600, 180, 90, Math.PI / 8, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // 文字
  g.fillStyle = '#ffffff';
  g.font = 'bold 64px sans-serif';
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 8;
  g.fillText('範例測試圖 1200×800', w / 2, h - 90);

  return canvas;
}

export default {
  id: 'add',
  name: '新增',
  icon,
  needsImage: false,
  mount(panelEl, ctx) {
    panelEl.innerHTML = '';

    const uploadBtn = ctx.ui.button(
      '上傳圖片',
      () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', () => {
          if (input.files && input.files[0]) handleIncomingFiles(input.files[0], ctx);
        });
        input.click();
      },
      { primary: true, block: true },
    );

    const dropzone = ctx.ui.el(
      'div',
      'ui-dropzone',
      '將圖片拖曳到此處\n也可直接 Ctrl+V 貼上圖片',
    );
    dropzone.style.whiteSpace = 'pre-line';
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        handleIncomingFiles(e.dataTransfer.files, ctx);
      }
    });

    const sampleBtn = ctx.ui.button(
      '範例圖片',
      () => {
        const canvas = makeSampleImage();
        ctx.doc.load(canvas, '範例圖片.png');
        ctx.viewport.requestRender();
        ctx.setTool('adjust');
        ctx.toast('已載入範例圖片', 'success');
      },
      { block: true },
    );

    panelEl.appendChild(
      ctx.ui.section('新增圖片', [uploadBtn, dropzone]),
    );
    panelEl.appendChild(
      ctx.ui.section('測試用', [sampleBtn]),
    );
  },
  activate() {},
  deactivate() {},
};
