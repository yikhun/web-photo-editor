// MI-GAN 影像修補：inpaint(imageCanvas, maskCanvas, {signal, onProgress}) -> Promise<HTMLCanvasElement>
// maskCanvas 同尺寸，白色(alpha>0)=要補的區域。內部自動裁 ROI（洞的外接框 + 上下文邊界）
// → 貼著 ROI 原生尺寸推論（太大縮小、太小放大，見下方 computeModelSize）→ 貼回並羽化。
// I/O：image=uint8 CHW RGB 0-255（不正規化，已用合成測試驗證通道序與排列正確）。
// mask=uint8 單通道，**實測語意為 0=hole(要補)／255=keep(保留原圖)**——這與 _research/models/models.md
// §2.2、本檔舊版註解依 lxfater/inpaint-web 原始碼推斷的「255=hole/0=keep」相反。2026-10-03 用
// onnxruntime 對 public/models/migan.onnx 直接跑合成實驗推翻了舊假設（見 _research/migan-debug/
// experiment.py 與其輸出）：全 0 遮罩（="全部都是 hole"）大幅改動整張圖、全 255 遮罩（="全部保留"）
// 輸出幾乎等於輸入 0 差異；對半張合成的白色粗體字+漸層背景，用「0=hole」遮罩可讓 MAE 從 106.557
// （誤判時，字幾乎沒被移除、白色殘留比例 78.6%）降到 2.933（白色殘留 0%）。舊假設先前讓模型把
// 「要修補的洞」誤當成「已知、要保留」的區域，只有我們自己羽化貼回的邊緣有變化，完全對應回報症狀。
// 輸出=uint8 CHW，已內建合成（mask=255 處直接等於輸入、mask=0 處才是生成內容，中間用模型自己的
// 高斯模糊遮罩做羽化，無需我們自己再做 alpha 合成——但 JS 這層仍疊加一次羽化以修飾 ROI resize 邊界，
// 見下方 feather 邏輯，且已改成「不侵入洞內」避免細筆畫/細線被羽化稀釋回原圖）。
import { getSession, getOrt } from './ort.js';
import { createCanvas, cloneCanvas } from '../core/canvasUtil.js';
import { checkAborted, makeAbortError, blurGrayFloat } from './util.js';
import { t } from '../core/i18n.js';

// 模型輸入其實是動態尺寸（見 _research/models/models.md §2.2：graph 顯示 H/W 皆為動態維度，
// 不要求固定 512×512；之前版本把每個 ROI 都強制縮成 512×512 正方形，結果對「大範圍、低對比」的
// 洞（例如一整行文字）效果很差：ROI 往往比 512 大很多，硬縮小等於把洞周圍真正的背景紋理
// 一起壓扁、揉進洞裡，模型等於看不到足夠的背景可以參考，傾向直接複製洞附近看到的顏色
// （對白色文字來說就是「複製白色」，而不是補成背景漸層）。
// 改用「貼著 ROI 原生尺寸跑，只在太大時等比例縮小」：洞在輸入影像裡占的比例跟原圖一致，
// 模型才看得到足夠的背景脈絡。MAX_DIM 是效能／顯存上限，DIM_MULTIPLE 是常見 UNet 下取樣深度
// 要求的尺寸倍數（避免 conv/pool 整數除不盡報錯）。
const MAX_DIM = 1024;
// MI-GAN 核心網路（StyleGAN 式 synthesis，實讀 graph 確認到 b512 為止）內部固定在 512 解析度訓練，
// ROI 長邊太小時直接送進去，等於把小尺寸硬塞給習慣看 512 畫面的網路，上下文被稀釋，
// 與 MAX_DIM 的下取樣同理但方向相反：長邊 < MIN_DIM 時先等比例放大再推論，推論後再縮回 ROI 尺寸。
const MIN_DIM = 256;
const DIM_MULTIPLE = 8;

// 算模型實際要吃的尺寸：ROI 原生尺寸，長邊超過 MAX_DIM 才縮小、小於 MIN_DIM 才放大，兩邊都取整到 DIM_MULTIPLE 的倍數。
function computeModelSize(roiW, roiH) {
  let scale = 1;
  const longSide = Math.max(roiW, roiH);
  if (longSide > MAX_DIM) scale = MAX_DIM / longSide;
  else if (longSide < MIN_DIM) scale = MIN_DIM / longSide;
  const mw = Math.max(DIM_MULTIPLE, Math.round((roiW * scale) / DIM_MULTIPLE) * DIM_MULTIPLE);
  const mh = Math.max(DIM_MULTIPLE, Math.round((roiH * scale) / DIM_MULTIPLE) * DIM_MULTIPLE);
  return { mw, mh };
}

// 找 maskCanvas 中「有效」像素（alpha>0 且顏色偏亮，對應白色塗抹）的外接框
function findMaskBBox(maskCanvas) {
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const data = maskCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const value = (data[i] / 255) * (data[i + 3] / 255);
      if (value > 0.03) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0 || y1 < y0) return null;
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

// ROI：洞的外接框再加一圈上下文邊界。太小的洞（例如細筆畫文字、細線水印）若只用自身尺寸的
// 比例外擴，上下文會不夠，模型看不到足夠背景可參考；外擴量改成「每邊至少 48px，或洞短邊的 1
// 倍」兩者取大，且四邊用同一個 pad（不分寬高），確保小洞也有充足、對稱的背景脈絡。
function computeRoi(bbox, imgW, imgH) {
  const bw = bbox.x1 - bbox.x0;
  const bh = bbox.y1 - bbox.y0;
  const cx = (bbox.x0 + bbox.x1) / 2;
  const cy = (bbox.y0 + bbox.y1) / 2;
  const shortSide = Math.min(bw, bh);
  const pad = Math.max(48, shortSide);
  const roiW = Math.min(imgW, Math.round(bw + pad * 2));
  const roiH = Math.min(imgH, Math.round(bh + pad * 2));
  let x = Math.round(cx - roiW / 2);
  let y = Math.round(cy - roiH / 2);
  x = Math.max(0, Math.min(x, imgW - roiW));
  y = Math.max(0, Math.min(y, imgH - roiH));
  return { x, y, w: roiW, h: roiH };
}

function canvasToUint8CHW(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const n = w * h;
  const out = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = data[i * 4];
    out[n + i] = data[i * 4 + 1];
    out[2 * n + i] = data[i * 4 + 2];
  }
  return out;
}

// mask canvas -> uint8 單通道，送進模型的語意是 0=hole（alpha>0 視為白色塗抹、要修補）/ 255=keep。
// （2026-10-03 實測更正：模型實際語意與直覺相反，見檔頭註解與 _research/migan-debug/experiment.py）
function maskCanvasToUint8(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const n = w * h;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const value = (data[i * 4] / 255) * (data[i * 4 + 3] / 255);
    // 門檻刻意壓低（而非 0.5）：縮到模型尺寸的雙線性縮放會讓細筆畫（文字筆畫、智慧偵測遮罩）
    // 的邊緣像素變成局部平均值，0.5 門檻容易把整條細線判成「非洞」（模型完全不會去修補）。
    out[i] = value > 0.12 ? 0 : 255;
  }
  return out;
}

export async function inpaint(imageCanvas, maskCanvas, { signal, onProgress } = {}) {
  const w = imageCanvas.width;
  const h = imageCanvas.height;

  const bbox = findMaskBBox(maskCanvas);
  if (!bbox) {
    // 沒有要修補的區域，原圖原樣回傳
    onProgress && onProgress(1, t('沒有遮罩，略過'));
    return cloneCanvas(imageCanvas);
  }

  onProgress && onProgress(0, t('準備模型'));
  const session = await getSession('migan', {
    signal,
    onProgress: (p, text) => onProgress && onProgress(p * 0.4, text),
  });
  checkAborted(signal);
  const ort = await getOrt();

  const roi = computeRoi(bbox, w, h);
  const { mw, mh } = computeModelSize(roi.w, roi.h);

  // ---------- 裁切 ROI，縮放到模型實際要吃的尺寸（通常接近 ROI 原生尺寸，只有太大才縮小）----------
  const roiImage = createCanvas(roi.w, roi.h);
  roiImage.getContext('2d').drawImage(imageCanvas, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
  const roiMask = createCanvas(roi.w, roi.h);
  roiMask.getContext('2d').drawImage(maskCanvas, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);

  const modelImage = createCanvas(mw, mh);
  {
    const c = modelImage.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(roiImage, 0, 0, mw, mh);
  }
  const modelMask = createCanvas(mw, mh);
  {
    const c = modelMask.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.drawImage(roiMask, 0, 0, mw, mh);
  }

  const imageData8 = canvasToUint8CHW(modelImage);
  const maskData8 = maskCanvasToUint8(modelMask);

  checkAborted(signal);
  onProgress && onProgress(0.45, t('推論中'));

  const imageTensor = new ort.Tensor('uint8', imageData8, [1, 3, mh, mw]);
  const maskTensor = new ort.Tensor('uint8', maskData8, [1, 1, mh, mw]);
  const feeds = {
    [session.inputNames[0]]: imageTensor,
    [session.inputNames[1]]: maskTensor,
  };

  let outputs;
  try {
    outputs = await session.run(feeds);
  } catch (err) {
    if (signal && signal.aborted) throw makeAbortError();
    throw err;
  }
  checkAborted(signal);
  onProgress && onProgress(0.8, t('後處理中'));

  const outName = session.outputNames[0];
  const outTensor = outputs[outName];
  const outData = outTensor.data; // uint8，CHW [1,3,mh,mw]
  const resultCanvas = createCanvas(mw, mh);
  {
    const rctx = resultCanvas.getContext('2d');
    const id = rctx.createImageData(mw, mh);
    const n = mw * mh;
    for (let i = 0; i < n; i++) {
      id.data[i * 4] = outData[i];
      id.data[i * 4 + 1] = outData[n + i];
      id.data[i * 4 + 2] = outData[2 * n + i];
      id.data[i * 4 + 3] = 255;
    }
    rctx.putImageData(id, 0, 0);
  }

  // ---------- 放大回 ROI 尺寸，羽化後貼回原圖 ----------
  const resultRoi = createCanvas(roi.w, roi.h);
  {
    const c = resultRoi.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(resultCanvas, 0, 0, roi.w, roi.h);
  }

  // 羽化：洞內一律用模型輸出（權重=1，不可被稀釋，否則細筆畫/細線水印會殘留原內容——
  // 這正是回報症狀之一：影片去水印只改到 25~30% 像素、多半在羽化邊緣，因為洞本身很細，
  // 模糊半徑一攤開，「洞內」早就被模糊進了外側的原圖值）。只在洞邊界外側 2~3px 做羽化過渡。
  // 做法：先算原始（未模糊）的洞 alpha，模糊後再跟原始值取 max——模糊會讓邊界附近的值同時
  // 往內外擴散，但取 max(blurred, raw) 後，洞內 raw=1 恆蓋過模糊值，等於把「往內擴散」的部分
  // 蓋回 1；洞外 raw=0，只剩「往外擴散」的部分，形成只朝外側的羽化帶。
  const maskData = roiMask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, roi.w, roi.h).data;
  const rawAlpha = new Float32Array(roi.w * roi.h);
  for (let i = 0; i < rawAlpha.length; i++) {
    rawAlpha[i] = (maskData[i * 4] / 255) * (maskData[i * 4 + 3] / 255);
  }
  const blurredAlpha = blurGrayFloat(rawAlpha, roi.w, roi.h, 3);
  const featherAlpha = new Float32Array(roi.w * roi.h);
  for (let i = 0; i < featherAlpha.length; i++) {
    featherAlpha[i] = Math.max(blurredAlpha[i], rawAlpha[i]);
  }

  const origRoiData = roiImage.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, roi.w, roi.h);
  const resultRoiData = resultRoi.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, roi.w, roi.h);
  const blended = roiImage.getContext('2d').createImageData(roi.w, roi.h);
  for (let i = 0; i < roi.w * roi.h; i++) {
    const a = featherAlpha[i];
    const o = i * 4;
    blended.data[o] = Math.round(origRoiData.data[o] * (1 - a) + resultRoiData.data[o] * a);
    blended.data[o + 1] = Math.round(origRoiData.data[o + 1] * (1 - a) + resultRoiData.data[o + 1] * a);
    blended.data[o + 2] = Math.round(origRoiData.data[o + 2] * (1 - a) + resultRoiData.data[o + 2] * a);
    blended.data[o + 3] = 255;
  }
  const blendedCanvas = createCanvas(roi.w, roi.h);
  blendedCanvas.getContext('2d').putImageData(blended, 0, 0);

  const out = cloneCanvas(imageCanvas);
  out.getContext('2d').drawImage(blendedCanvas, roi.x, roi.y);

  onProgress && onProgress(1, t('完成'));
  return out;
}
