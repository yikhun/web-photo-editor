// 文件狀態：目前影像、原圖、歷史（復原/重做/重置）。供 ctx.doc 與 ctx.commit 使用。
import { createHistory } from './history.js';
import { cloneCanvas } from './canvasUtil.js';

export function createDoc({ bus }) {
  let original = null; // HTMLCanvasElement，最初載入的原圖（不可變動）
  let name = '未命名';
  const history = createHistory({
    onChange: (state) => bus.emit('history:change', state),
  });

  function hasImage() {
    return history.current() != null;
  }

  function getImage() {
    return history.current();
  }

  function getOriginal() {
    return original;
  }

  function getName() {
    return name;
  }

  // 新圖：清空歷史、設為原圖
  function load(canvas, fileName = '未命名') {
    original = cloneCanvas(canvas);
    name = fileName;
    history.init(canvas, '開啟');
    bus.emit('doc:load', { canvas, name });
    bus.emit('doc:change', { canvas, label: '開啟' });
  }

  // 寫入歷史並成為目前影像
  function commit(canvas, label = '編輯') {
    history.push(canvas, label);
    bus.emit('doc:change', { canvas, label });
  }

  function undo() {
    const canvas = history.undo();
    if (canvas) bus.emit('doc:change', { canvas, label: '復原' });
    return canvas;
  }

  function redo() {
    const canvas = history.redo();
    if (canvas) bus.emit('doc:change', { canvas, label: '重做' });
    return canvas;
  }

  // 重置 = 回到原圖，本身也是一筆歷史（可再復原）
  function reset() {
    if (!original) return null;
    const canvas = cloneCanvas(original);
    history.push(canvas, '重置');
    bus.emit('doc:change', { canvas, label: '重置' });
    return canvas;
  }

  function canUndo() {
    return history.canUndo();
  }

  function canRedo() {
    return history.canRedo();
  }

  return {
    hasImage,
    getImage,
    getOriginal,
    getName,
    load,
    commit,
    undo,
    redo,
    reset,
    canUndo,
    canRedo,
  };
}
