#!/usr/bin/env node
// 下載/準備 AI 模型檔到 public/models/，並把 onnxruntime-web 的 wasm 檔複製到 public/ort/。
// 已存在就跳過；_research/models/ 已有的檔案直接複製，不重下。
// 用法：npm run fetch-models
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'public', 'models');
const ORT_DIR = path.join(ROOT, 'public', 'ort');
const RESEARCH_DIR = path.join(ROOT, '_research', 'models');
const ORT_DIST_DIR = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');

// 需要準備好的模型檔：public 檔名 -> { url（直接下載來源）、researchFile（_research/models/ 底下已存在可直接複製的檔名）、size（bytes，僅供顯示） }
const MODEL_FILES = [
  {
    name: 'u2net.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx',
    researchFile: 'u2net.onnx',
    size: 175997641,
  },
  {
    name: 'u2netp.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
    researchFile: 'u2netp.onnx',
    size: 4574861,
  },
  {
    name: 'migan.onnx',
    url: 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
    researchFile: 'migan_pipeline_v2.onnx',
    size: 28079181,
  },
  {
    name: 'realesr-general-x4v3-static384.onnx',
    url: 'https://huggingface.co/Saimon8420/realesr-general-x4v3-web/resolve/main/realesr-general-x4v3-static384.onnx',
    researchFile: 'realesr-general-x4v3-static384.onnx',
    size: 4878946,
  },
];

// onnxruntime-web 1.30 的 wasm 執行檔：一般 wasm 版、webgpu 用的 jsep 版、
// 以及 webgpu 內部需要同步呼叫 JS 時用的 asyncify／jspi 版（實測 WebGPU EP 建立 session 會要求 asyncify 版）。
const ORT_WASM_FILES = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jspi.mjs',
  'ort-wasm-simd-threaded.jspi.wasm',
];

function fmtSize(bytes) {
  if (!bytes) return '未知大小';
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyFile(src, dest, label) {
  await fs.copyFile(src, dest);
  const stat = await fs.stat(dest);
  console.log(`[fetch-models] ${label}：已從本機複製 (${fmtSize(stat.size)}) -> ${path.relative(ROOT, dest)}`);
}

async function downloadFile(url, dest, label, attempt = 1) {
  const maxAttempts = 3;
  console.log(`[fetch-models] ${label}：下載中（第 ${attempt} 次）... ${url}`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(dest, buf);
    console.log(`[fetch-models] ${label}：下載完成 (${fmtSize(buf.length)}) -> ${path.relative(ROOT, dest)}`);
  } catch (err) {
    console.warn(`[fetch-models] ${label}：下載失敗（第 ${attempt} 次）：${err.message}`);
    if (attempt < maxAttempts) {
      await downloadFile(url, dest, label, attempt + 1);
    } else {
      throw new Error(`${label} 下載失敗，已重試 ${maxAttempts} 次：${err.message}`);
    }
  }
}

async function prepareModel(entry) {
  const destPath = path.join(MODELS_DIR, entry.name);
  if (existsSync(destPath)) {
    const stat = await fs.stat(destPath);
    console.log(`[fetch-models] ${entry.name}：已存在 (${fmtSize(stat.size)})，跳過`);
    return;
  }
  const researchPath = entry.researchFile ? path.join(RESEARCH_DIR, entry.researchFile) : null;
  if (researchPath && existsSync(researchPath)) {
    await copyFile(researchPath, destPath, entry.name);
    return;
  }
  await downloadFile(entry.url, destPath, entry.name);
}

async function prepareOrtWasm() {
  await ensureDir(ORT_DIR);
  for (const file of ORT_WASM_FILES) {
    const src = path.join(ORT_DIST_DIR, file);
    const dest = path.join(ORT_DIR, file);
    if (existsSync(dest)) {
      console.log(`[fetch-models] ort/${file}：已存在，跳過`);
      continue;
    }
    if (!existsSync(src)) {
      console.warn(`[fetch-models] 找不到 ${src}，略過（onnxruntime-web 版本可能不同，請手動確認）`);
      continue;
    }
    await copyFile(src, dest, `ort/${file}`);
  }
}

async function main() {
  await ensureDir(MODELS_DIR);
  await prepareOrtWasm();
  for (const entry of MODEL_FILES) {
    await prepareModel(entry);
  }
  console.log('[fetch-models] 全部完成。public/models/ 內容：');
  const files = await fs.readdir(MODELS_DIR);
  for (const f of files) {
    const stat = await fs.stat(path.join(MODELS_DIR, f));
    console.log(`  - ${f}（${fmtSize(stat.size)}）`);
  }
}

main().catch((err) => {
  console.error('[fetch-models] 失敗：', err);
  process.exit(1);
});
