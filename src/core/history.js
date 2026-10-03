// 復原/重做/重置：固定上限 30 筆，超過丟最舊。每筆存一個 canvas 快照 + label。
// 重置本身也會 push 一筆（回到原圖），可再被復原。
const MAX_HISTORY = 30;

export function createHistory({ onChange } = {}) {
  let stack = []; // [{canvas, label}]
  let cursor = -1; // 指向 stack 中目前顯示的項目

  function notify() {
    if (onChange) onChange({ canUndo: canUndo(), canRedo: canRedo(), length: stack.length });
  }

  function canUndo() {
    return cursor > 0;
  }

  function canRedo() {
    return cursor >= 0 && cursor < stack.length - 1;
  }

  // 清空並以 canvas 作為第一筆（新圖載入時用）
  function init(canvas, label = '開啟') {
    stack = [{ canvas, label }];
    cursor = 0;
    notify();
  }

  // 寫入新的一筆；若目前游標不在最後，丟棄其後的「重做」分支
  function push(canvas, label = '編輯') {
    stack = stack.slice(0, cursor + 1);
    stack.push({ canvas, label });
    if (stack.length > MAX_HISTORY) {
      stack.shift();
    } else {
      cursor++;
    }
    cursor = stack.length - 1;
    notify();
  }

  function undo() {
    if (!canUndo()) return null;
    cursor--;
    notify();
    return stack[cursor].canvas;
  }

  function redo() {
    if (!canRedo()) return null;
    cursor++;
    notify();
    return stack[cursor].canvas;
  }

  function current() {
    return cursor >= 0 ? stack[cursor].canvas : null;
  }

  function clear(canvas, label) {
    init(canvas, label);
  }

  return { init, push, undo, redo, current, clear, canUndo, canRedo };
}
