// 共用 UI 小元件工廠：slider、buttonGroup、colorSwatches、section、button、toggle、select、fileButton、toast。
// 風格統一：全部吃 CSS 變數（main.css），回傳的都是純 DOM 元素，不依賴任何框架。

export function el(tag, className, children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (children) {
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return node;
}

export function section(title, content) {
  const wrap = el('div', 'ui-section');
  if (title) wrap.appendChild(el('div', 'ui-section-title', title));
  for (const c of [].concat(content || [])) {
    if (c) wrap.appendChild(c);
  }
  return wrap;
}

export function button(label, onClick, opts = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ui-button' + (opts.primary ? ' primary' : '') + (opts.block ? ' block' : '');
  btn.textContent = label;
  if (opts.disabled) btn.disabled = true;
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

export function slider(label, min, max, step, value, onInput) {
  const row = el('div', 'ui-slider-row');
  const head = el('div', 'ui-slider-head');
  const labelEl = el('span', null, label);
  const valueEl = el('span', 'ui-slider-value', String(value));
  head.appendChild(labelEl);
  head.appendChild(valueEl);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    valueEl.textContent = String(v);
    if (onInput) onInput(v);
  });
  row.appendChild(head);
  row.appendChild(input);
  row.setValue = (v) => {
    input.value = String(v);
    valueEl.textContent = String(v);
  };
  row.input = input;
  return row;
}

// options: [{id, label}]
export function buttonGroup(options, selectedId, onChange) {
  const wrap = el('div', 'ui-button-group');
  let current = selectedId;
  const buttons = options.map((opt) => {
    const btn = button(opt.label, () => {
      current = opt.id;
      refresh();
      if (onChange) onChange(opt.id);
    });
    btn.dataset.id = opt.id;
    wrap.appendChild(btn);
    return btn;
  });
  function refresh() {
    for (const btn of buttons) {
      btn.classList.toggle('selected', btn.dataset.id === current);
    }
  }
  refresh();
  wrap.setSelected = (id) => {
    current = id;
    refresh();
  };
  return wrap;
}

// colors: ['#fff', '#000', ...]
export function colorSwatches(colors, selectedColor, onChange) {
  const wrap = el('div', 'ui-swatches');
  let current = selectedColor;
  const nodes = colors.map((color) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'ui-swatch';
    sw.style.background = color;
    sw.addEventListener('click', () => {
      current = color;
      refresh();
      if (onChange) onChange(color);
    });
    wrap.appendChild(sw);
    return sw;
  });
  function refresh() {
    nodes.forEach((node, i) => node.classList.toggle('selected', colors[i] === current));
  }
  refresh();
  wrap.setSelected = (color) => {
    current = color;
    refresh();
  };
  return wrap;
}

export function toggle(label, checked, onChange) {
  const wrap = el('label', 'ui-toggle');
  const track = el('span', 'ui-toggle-track' + (checked ? ' on' : ''));
  track.appendChild(el('span', 'ui-toggle-thumb'));
  let state = checked;
  wrap.appendChild(track);
  if (label) wrap.appendChild(document.createTextNode(label));
  wrap.addEventListener('click', () => {
    state = !state;
    track.classList.toggle('on', state);
    if (onChange) onChange(state);
  });
  wrap.setChecked = (v) => {
    state = v;
    track.classList.toggle('on', state);
  };
  return wrap;
}

// options: [{value, label}]
export function select(options, value, onChange) {
  const sel = document.createElement('select');
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    sel.appendChild(o);
  }
  if (value != null) sel.value = value;
  sel.addEventListener('change', () => {
    if (onChange) onChange(sel.value);
  });
  return sel;
}

// onFile(file) — 單檔；opts.multiple 時 onFile(fileList)
export function fileButton(label, onFile, opts = {}) {
  const wrap = el('div');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = opts.accept || 'image/*';
  input.multiple = !!opts.multiple;
  input.style.display = 'none';
  const btn = button(label, () => input.click(), opts);
  input.addEventListener('change', () => {
    if (!input.files || input.files.length === 0) return;
    onFile(opts.multiple ? input.files : input.files[0]);
    input.value = '';
  });
  wrap.appendChild(btn);
  wrap.appendChild(input);
  return wrap;
}

// ---------- toast ----------
let toastRoot = null;

function ensureToastRoot() {
  if (!toastRoot) {
    toastRoot = document.getElementById('toast-root');
    if (!toastRoot) {
      toastRoot = el('div');
      toastRoot.id = 'toast-root';
      document.body.appendChild(toastRoot);
    }
  }
  return toastRoot;
}

export function toast(msg, type = 'info') {
  const root = ensureToastRoot();
  const node = el('div', `toast ${type}`, msg);
  root.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 250);
  }, 2600);
}
