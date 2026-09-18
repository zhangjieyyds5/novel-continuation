/* 一条命令重建独立版：抽取 -> 内联依赖 -> 结构自检
   用法：node tools/build.mjs
   改完上游页面之后跑这个即可，产物直接覆盖仓库根目录的单文件。 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));  // tools/
const ROOT = path.resolve(HERE, '..');                      // 仓库根
const OUT = path.join(ROOT, 'novel-continue-standalone.html');

const steps = [
    [path.join(HERE, 'extract.mjs'), [], '从上游页面抽取 + 植入独立运行能力'],
    [path.join(HERE, 'offline.mjs'), [], '内联 Vue / Tailwind / daisyUI，变成零外部依赖'],
    [path.resolve(HERE, '../tests/syntax-check.mjs'), [OUT], '语法与结构自检']
];

for (const [file, args, label] of steps) {
    console.log(`\n=== ${label}（${path.basename(file)}） ===`);
    const r = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
    if (r.status !== 0) {
        console.error(`\n${path.basename(file)} 失败，已中断`);
        process.exit(1);
    }
}

console.log(`\n独立版已重建：${OUT}`);
