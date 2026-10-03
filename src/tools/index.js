// 工具註冊清單（依合約順序）。之後各 agent 只覆寫自己的檔案，不需改這裡。
import add from './add.js';
import adjust from './adjust.js';
import text from './text.js';
import erase from './erase.js';
import matting from './matting.js';
import enhance from './enhance.js';
import color from './color.js';
import videoMatting from './videoMatting.js';

export default [add, adjust, text, erase, matting, enhance, color, videoMatting];
