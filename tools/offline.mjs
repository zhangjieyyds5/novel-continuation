/* 把独立版里残留的三个 CDN 依赖（Vue / Tailwind / daisyUI）换成内联，
   变成真正零外部依赖的单文件——双击即用，不联网也能打开界面。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));  // tools/
const ROOT = path.resolve(HERE, '..');                      // 仓库根
const FILE = path.join(ROOT, 'novel-continue-standalone.html');
const VENDOR = path.join(HERE, 'vendor');

const read = p => fs.readFileSync(p, 'utf8');
const vendor = name => {
    const file = path.join(VENDOR, name);
    if (!fs.existsSync(file)) throw new Error(`缺少 ${file}，先下载依赖`);
    return read(file);
};

const vue = vendor('vue.js');
const daisyui = vendor('daisyui.css');
const tailwind = vendor('tailwind.js');

// 完整性校验：下到半截的文件会让页面直接白屏，早点发现
const guards = [
    ['vue.js', vue, 'var Vue=function', 'e.withScopeId'],
    ['daisyui.css', daisyui, 'daisyui', '--p:'],
    ['tailwind.js', tailwind, '(()=>{', 'tailwindcss']
];
for (const [name, text, head, tail] of guards) {
    if (!text.includes(head) || !text.includes(tail)) {
        throw new Error(`${name} 内容不完整（缺少「${head}」或「${tail}」）`);
    }
}

let text = read(FILE);
let failed = 0;
const log = [];

const replace = (name, oldStr, newStr) => {
    const hits = text.split(oldStr).length - 1;
    if (hits !== 1) { failed += 1; log.push(`✗ ${name}：期望 1 处，实际 ${hits} 处`); return; }
    text = text.split(oldStr).join(newStr);
    log.push(`✓ ${name}`);
};

// <script> / <style> 内部出现结束标签会提前截断块，必须转义
const forScript = code => code.split('</script').join('<\\/script');
const forStyle = code => code.split('</style').join('<\\/style');

const HEAD_BLOCK = `    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/daisyui@4.7.2/dist/full.min.css" rel="stylesheet" type="text/css" />
    <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>`;

const INLINE_BLOCK = `    <!-- 前端依赖已全部内联：本文件不引用任何外部资源，断网也能打开 -->
    <!-- Tailwind CSS（Play CDN 运行时） -->
    <script>
${forScript(tailwind)}    </script>
    <!-- daisyUI 4.7.2 主题样式 -->
    <style>
${forStyle(daisyui)}    </style>
    <!-- Vue 3 运行时 -->
    <script>
${forScript(vue)}    </script>`;

replace('内联 Tailwind / daisyUI / Vue，去掉 Google Fonts', HEAD_BLOCK, INLINE_BLOCK);

// 兜底自检：不该再有外部资源（只看真实标签引用，内联脚本里出现的域名字符串不算）
const leftovers = [];
if (/<script[^>]+src=["']https?:\/\//.test(text)) leftovers.push('<script src>');
if (/<link[^>]+href=["']https?:\/\//.test(text)) leftovers.push('<link href>');
if (leftovers.length) { failed += 1; log.push(`✗ 仍引用外部资源：${leftovers.join(' / ')}`); }

console.log(log.join('\n'));
console.log('');
if (failed) { console.error(`失败：${failed} 处，文件未写出`); process.exit(1); }
fs.writeFileSync(FILE, text, 'utf8');
console.log(`已写出 ${FILE}`);
console.log(`体积 ${(Buffer.byteLength(text, 'utf8') / 1024 / 1024).toFixed(2)} MB（自包含，零外部依赖）`);
