#!/usr/bin/env node
// build:pages 用：vite build（--mode pages，publicDir 已關閉）之後執行，
// 把實際有接線的模型從 public/models/ 複製進 dist/models/，>90MB 的檔案切段（GitHub 單檔上限 100MB），
// 並產生 dist/models/manifest.json（src/ai/models.js 讀這份清單決定要不要分段下載）。
// 同時補 .nojekyll（避免 Pages 忽略底線開頭的檔案）與 404.html（SPA fallback）。
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_MODELS_DIR = path.join(ROOT, 'public', 'models');
const DIST_DIR = path.join(ROOT, 'dist');
const DIST_MODELS_DIR = path.join(DIST_DIR, 'models');

// 只部署 models.js 註冊表實際用到的檔名（動態版 upscayl-*-4x.onnx 不部署，見 ARCHITECTURE.md）
const DEPLOY_MODELS = [
  'u2net.onnx',
  'u2netp.onnx',
  'migan.onnx',
  'realesr-general-x4v3-static384.onnx',
  'upscayl-standard-4x-128.onnx',
  'upscayl-digital-art-4x-128.onnx',
];

// 每段上限：留一點餘裕給 GitHub 的 100MB 硬限制與任務要求的 90MB 上限
const CHUNK_SIZE = 85 * 1024 * 1024; // 85MB
const SPLIT_THRESHOLD = 90 * 1024 * 1024; // 90MB

function fmtSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function removeIfExists(p) {
  if (existsSync(p)) {
    await fs.rm(p, { recursive: true, force: true });
  }
}

async function splitFile(srcPath, destBaseName) {
  const data = await fs.readFile(srcPath);
  const parts = [];
  let offset = 0;
  let idx = 0;
  while (offset < data.length) {
    const end = Math.min(offset + CHUNK_SIZE, data.length);
    const chunk = data.subarray(offset, end);
    const suffix = `part${idx}`;
    const destName = `${destBaseName}.${suffix}`;
    await fs.writeFile(path.join(DIST_MODELS_DIR, destName), chunk);
    parts.push({ suffix, size: chunk.length });
    console.log(`[prepare-pages-models] ${destBaseName}：寫出 ${destName}（${fmtSize(chunk.length)}）`);
    offset = end;
    idx += 1;
  }
  return parts;
}

async function main() {
  if (!existsSync(DIST_DIR)) {
    throw new Error(`找不到 ${DIST_DIR}，請先跑 vite build --mode pages`);
  }
  await removeIfExists(DIST_MODELS_DIR);
  await ensureDir(DIST_MODELS_DIR);

  const manifest = {};

  for (const name of DEPLOY_MODELS) {
    const srcPath = path.join(PUBLIC_MODELS_DIR, name);
    if (!existsSync(srcPath)) {
      console.warn(`[prepare-pages-models] 找不到 ${srcPath}，跳過（請先跑 npm run fetch-models）`);
      continue;
    }
    const stat = await fs.stat(srcPath);
    if (stat.size > SPLIT_THRESHOLD) {
      const parts = await splitFile(srcPath, name);
      manifest[name] = { size: stat.size, parts };
    } else {
      await fs.copyFile(srcPath, path.join(DIST_MODELS_DIR, name));
      console.log(`[prepare-pages-models] ${name}：整檔複製（${fmtSize(stat.size)}）`);
      manifest[name] = { size: stat.size, parts: [] };
    }
  }

  await fs.writeFile(path.join(DIST_MODELS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('[prepare-pages-models] 已寫出 dist/models/manifest.json');

  // .nojekyll：避免 GitHub Pages 用 Jekyll 處理，忽略底線開頭的檔案
  await fs.writeFile(path.join(DIST_DIR, '.nojekyll'), '');

  // 404.html = index.html 複本，SPA 子路徑整頁重新整理時的保險
  const indexPath = path.join(DIST_DIR, 'index.html');
  if (existsSync(indexPath)) {
    await fs.copyFile(indexPath, path.join(DIST_DIR, '404.html'));
    console.log('[prepare-pages-models] 已複製 404.html');
  } else {
    console.warn('[prepare-pages-models] 找不到 dist/index.html，略過 404.html');
  }

  // 檢查沒有任何檔案超過 100MB（GitHub 硬限制）
  const files = await fs.readdir(DIST_MODELS_DIR);
  let totalSize = 0;
  const oversized = [];
  for (const f of files) {
    const st = await fs.stat(path.join(DIST_MODELS_DIR, f));
    totalSize += st.size;
    if (st.size >= 100 * 1024 * 1024) oversized.push(`${f}（${fmtSize(st.size)}）`);
  }
  console.log(`[prepare-pages-models] dist/models 共 ${files.length} 個檔案，合計 ${fmtSize(totalSize)}`);
  if (oversized.length > 0) {
    throw new Error(`以下檔案 >= 100MB，GitHub 會拒絕：${oversized.join(', ')}`);
  }
}

main().catch((err) => {
  console.error('[prepare-pages-models] 失敗：', err);
  process.exit(1);
});
