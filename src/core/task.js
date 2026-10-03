// 長任務：全畫面半透明遮罩（只蓋畫布區）＋「生成中」文字、進度條與百分比、說明文字、取消按鈕。
// ctx.runTask({ title, run }), run: async ({ signal, progress }) => result
// 取消 -> signal.abort()，回傳 null，畫面不變；例外 -> 顯示錯誤 toast 並回傳 null。
// 執行中重複呼叫要拒絕並提示。
export function createTask({ stageWrapEl, toast }) {
  let busy = false;

  const overlay = document.createElement('div');
  overlay.id = 'task-overlay';
  overlay.innerHTML = `
    <div class="task-title"></div>
    <div class="task-bar-track"><div class="task-bar-fill"></div></div>
    <div class="task-percent">0%</div>
    <div class="task-desc"></div>
    <button class="ui-button" type="button">取消</button>
  `;
  stageWrapEl.appendChild(overlay);

  const titleEl = overlay.querySelector('.task-title');
  const barFillEl = overlay.querySelector('.task-bar-fill');
  const percentEl = overlay.querySelector('.task-percent');
  const descEl = overlay.querySelector('.task-desc');
  const cancelBtn = overlay.querySelector('button');

  async function run({ title = '生成中', run: runFn }) {
    if (busy) {
      toast('已有任務執行中，請稍候', 'error');
      return null;
    }
    busy = true;
    const controller = new AbortController();
    titleEl.textContent = title;
    barFillEl.style.width = '0%';
    percentEl.textContent = '0%';
    descEl.textContent = '';
    overlay.classList.add('show');

    const onCancelClick = () => controller.abort();
    cancelBtn.addEventListener('click', onCancelClick);

    function progress(p, text = '') {
      const pct = Math.round(Math.min(1, Math.max(0, p)) * 100);
      barFillEl.style.width = `${pct}%`;
      percentEl.textContent = `${pct}%`;
      if (text) descEl.textContent = text;
    }

    let result = null;
    try {
      result = await runFn({ signal: controller.signal, progress });
      if (controller.signal.aborted) {
        result = null;
      }
    } catch (err) {
      if (controller.signal.aborted || (err && err.name === 'AbortError')) {
        result = null;
      } else {
        console.error('[task] 執行失敗', err);
        toast(`執行失敗：${err && err.message ? err.message : err}`, 'error');
        result = null;
      }
    } finally {
      cancelBtn.removeEventListener('click', onCancelClick);
      overlay.classList.remove('show');
      busy = false;
    }
    return result;
  }

  function isBusy() {
    return busy;
  }

  return { run, isBusy };
}
