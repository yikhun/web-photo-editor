// 匯出 PNG/JPG/WebP：頂部「匯出」下拉，JPG/WebP 可調品質，檔名 <原檔名>-edited.<ext>。
// 匯出前 emit 'export:before'（emitAsync，讓文字工具合併文字層）。
import { canvasToBlob } from './canvasUtil.js';
import { t, onLangChange } from './i18n.js';

const FORMATS = [
  { id: 'png', label: 'PNG', mime: 'image/png', quality: false },
  { id: 'jpg', label: 'JPG', mime: 'image/jpeg', quality: true },
  { id: 'webp', label: 'WebP', mime: 'image/webp', quality: true },
];

function stripExt(name) {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

export function createExportMenu({ doc, bus, toast }) {
  let format = 'png';
  let quality = 0.92;
  let open = false;

  const root = document.createElement('div');
  root.className = 'export-dropdown';
  root.innerHTML = `
    <button type="button" class="ui-button primary export-toggle"></button>
    <div class="export-menu" style="display:none">
      <div class="ui-row" style="margin-bottom:10px;">
        <span class="ui-label export-format-label"></span>
        <select class="export-format">
          ${FORMATS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')}
        </select>
      </div>
      <div class="ui-slider-row export-quality-row">
        <div class="ui-slider-head"><span class="export-quality-label"></span><span class="export-quality-value">92%</span></div>
        <input type="range" class="export-quality" min="1" max="100" step="1" value="92" />
      </div>
      <button type="button" class="ui-button primary block export-confirm"></button>
    </div>
  `;

  const toggleBtn = root.querySelector('.export-toggle');
  const menuEl = root.querySelector('.export-menu');
  const formatLabelEl = root.querySelector('.export-format-label');
  const formatSelect = root.querySelector('.export-format');
  const qualityRow = root.querySelector('.export-quality-row');
  const qualityLabelEl = root.querySelector('.export-quality-label');
  const qualitySlider = root.querySelector('.export-quality');
  const qualityValue = root.querySelector('.export-quality-value');
  const confirmBtn = root.querySelector('.export-confirm');

  function refreshTexts() {
    toggleBtn.textContent = `${t('匯出')} ▾`;
    formatLabelEl.textContent = t('格式');
    qualityLabelEl.textContent = t('品質');
    confirmBtn.textContent = t('下載');
  }
  refreshTexts();
  onLangChange(refreshTexts);

  function updateQualityVisibility() {
    const def = FORMATS.find((f) => f.id === format);
    qualityRow.style.display = def && def.quality ? '' : 'none';
  }

  function setOpen(v) {
    open = v;
    menuEl.style.display = open ? '' : 'none';
  }

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!open);
  });
  document.addEventListener('click', (e) => {
    if (open && !root.contains(e.target)) setOpen(false);
  });

  formatSelect.addEventListener('change', () => {
    format = formatSelect.value;
    updateQualityVisibility();
  });

  qualitySlider.addEventListener('input', () => {
    quality = Number(qualitySlider.value) / 100;
    qualityValue.textContent = `${qualitySlider.value}%`;
  });

  confirmBtn.addEventListener('click', async () => {
    if (!doc.hasImage()) {
      toast(t('尚無圖片可匯出'), 'error');
      return;
    }
    confirmBtn.disabled = true;
    try {
      await bus.emitAsync('export:before');
      const def = FORMATS.find((f) => f.id === format) || FORMATS[0];
      const canvas = doc.getImage();
      const blob = await canvasToBlob(canvas, def.mime, def.quality ? quality : undefined);
      if (!blob) {
        toast(t('匯出失敗'), 'error');
        return;
      }
      const baseName = stripExt(doc.getName() || t('未命名'));
      const fileName = `${baseName}-edited.${def.id}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast(t('已匯出 {name}', { name: fileName }), 'success');
      setOpen(false);
    } catch (err) {
      console.error('[export] 匯出失敗', err);
      toast(t('匯出失敗：{msg}', { msg: err && err.message ? err.message : err }), 'error');
    } finally {
      confirmBtn.disabled = false;
    }
  });

  updateQualityVisibility();

  return { el: root };
}
