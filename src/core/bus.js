// 事件匯流排：on/off/emit（同步）＋ emitAsync（依序 await 所有監聽器，供匯出前合併文字層等用途）
export function createBus() {
  const listeners = new Map(); // event -> Set<fn>

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    const set = listeners.get(event);
    if (set) set.delete(fn);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] listener for "${event}" threw`, err);
      }
    }
  }

  async function emitAsync(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        await fn(payload);
      } catch (err) {
        console.error(`[bus] async listener for "${event}" threw`, err);
      }
    }
  }

  return { on, off, emit, emitAsync };
}
