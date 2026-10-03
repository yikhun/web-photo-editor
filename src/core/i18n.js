// 介面語系：以繁中原文當 key，英文字典分區註冊；切換時 emit 'lang:change' 讓各區重畫
import enCore from '../i18n/en-core.js';
import enTools from '../i18n/en-tools.js';
import enVideo from '../i18n/en-video.js';

const STORAGE_KEY = 'pe-lang';
const dicts = { en: { ...enCore, ...enTools, ...enVideo } };
const listeners = new Set();

let lang = readSaved();

function readSaved() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'en' || v === 'zh-TW') return v;
  } catch { /* 無痕或封鎖儲存時用預設 */ }
  return 'zh-TW';
}

export function getLang() {
  return lang;
}

export function setLang(next) {
  if (next !== 'en' && next !== 'zh-TW') return;
  if (next === lang) return;
  lang = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* 忽略 */ }
  document.documentElement.lang = next === 'en' ? 'en' : 'zh-Hant-TW';
  for (const fn of listeners) fn(lang);
}

// t('第 {n} / {total} 格', { n: 3, total: 72 })；查不到英文時回傳繁中原文
export function t(text, vars) {
  let s = text;
  if (lang !== 'zh-TW') {
    const hit = dicts[lang]?.[text];
    if (hit != null) s = hit;
  }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

// 註冊語系變更回呼，回傳解除函式
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant-TW';
