// 影片工作區專用的長任務遮罩。
// 為什麼不用 ctx.runTask：core/task.js 的遮罩是掛在 #stage-wrap（屬於 #main-body），
// 而 #/video 路由會把 #main-body 整個 display:none，使用者在影片頁完全看不到那個遮罩。
// 因此另外做一份行為對等（進度、取消、例外 toast、busy 鎖）的遮罩，掛在影片工作區自己的容器內。
export function createVideoTask({ containerEl, toast }) {
  let busy = false;

  const overlay = document.createElement('div');
  overlay.className = 'vw-task-overlay';
  overlay.innerHTML = `
    <div class="vw-task-title"></div>
    <div class="vw-task-bar-track"><div class="vw-task-bar-fill"></div></div>
    <div class="vw-task-percent">0%</div>
    <div class="vw-task-desc"></div>
    <button class="ui-button" type="button">取消</button>
  `;
  containerEl.appendChild(overlay);

  const titleEl = overlay.querySelector('.vw-task-title');
  const barFillEl = overlay.querySelector('.vw-task-bar-fill');
  const percentEl = overlay.querySelector('.vw-task-percent');
  const descEl = overlay.querySelector('.vw-task-desc');
  const cancelBtn = overlay.querySelector('button');

  async function run({ title = '處理中', run: runFn }) {
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
      if (controller.signal.aborted) result = null;
    } catch (err) {
      if (controller.signal.aborted || (err && err.name === 'AbortError')) {
        result = null;
      } else {
        console.error('[video-task] 執行失敗', err);
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

  function destroy() {
    overlay.remove();
  }

  return { run, isBusy, destroy };
}
