// 影片摳圖工具：與「影片工具」分頁的去背模式共用 src/video/workspace.js 同一份程式碼與管線。
// 設定項目留在中間 300px 面板（panelEl）；預覽畫面/時間軸/結果對比改掛進右側畫布區
// #stage-wrap（蓋在圖片 viewport 的 canvas 之上），這樣影片預覽才有足夠空間。
// workspace 實例用模組層級變數保留（只建立一次）：切出此工具時只是把覆蓋層這塊 DOM 從
// #stage-wrap 移除（圖片畫布就恢復可見），不 destroy，切回來不用重新上傳影片；
// panelEl 的內容每次切回來都要重畫，因為 main.js 在呼叫 mount 前會把 #panel 清空
// （workspace 的 renderModePanel 本來就是每次全清重畫，直接重呼叫即可，不會遺失 state）。
import '../styles/video.css';
import { createVideoWorkspace } from '../video/workspace.js';

const icon = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="5" width="14" height="14" rx="2" stroke-width="2"/>
  <path d="M17 9l4-2v10l-4-2" stroke-width="2" stroke-linejoin="round"/>
</svg>`;

let workspaceHandle = null;
// panelBodyEl / overlayEl 是跨切換保留的穩定節點：main.js 每次切工具都會把 #panel
// innerHTML 清空（只是把這兩個節點從父層拿掉，節點自身的子內容不會被清掉），所以只要
// 把同一個節點重新掛回去，之前畫好的設定面板／預覽畫面就原封不動地回來，不必重建。
let panelBodyEl = null;
let overlayEl = null;

function getStageWrap() {
  return document.getElementById('stage-wrap');
}

export default {
  id: 'videoMatting',
  name: '影片摳圖',
  icon,
  needsImage: false,
  mount(panelEl, ctx) {
    panelEl.appendChild(ctx.ui.el('div', 'ui-empty-hint', '影片摳圖：與「影片工具」分頁的去背模式共用同一份程式碼，處理全程在瀏覽器端完成，影片不會上傳。'));
    if (!panelBodyEl) {
      panelBodyEl = ctx.ui.el('div');
    }
    panelEl.appendChild(panelBodyEl);

    if (!overlayEl) {
      overlayEl = ctx.ui.el('div');
    }
    const stageWrap = getStageWrap();
    if (stageWrap && overlayEl.parentElement !== stageWrap) {
      stageWrap.appendChild(overlayEl);
    }

    if (!workspaceHandle) {
      workspaceHandle = createVideoWorkspace(null, {
        mode: 'matting',
        allowModeSwitch: false,
        ctx,
        panelEl: panelBodyEl,
        stageEl: overlayEl,
      });
    } else {
      // panelBodyEl 節點本身沒被清空，但保險起見重畫一次，確保內容與目前 state 一致。
      workspaceHandle.refreshPanel();
    }
  },
  activate() {},
  deactivate() {
    if (overlayEl && overlayEl.parentElement) {
      overlayEl.parentElement.removeChild(overlayEl);
    }
  },
};
