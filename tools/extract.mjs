/* 从 RP Hub 的 continue/index.html 生成可独立运行的单文件版本。
   只做精确字符串替换，任何一处匹配失败都会报错退出，避免静默漏改。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));  // tools/
const ROOT = path.resolve(HERE, '..');                      // 仓库根

// 上游页面（被提取的那个页面）。换机器用 UPSTREAM_PAGE 环境变量覆盖。
const SRC = process.env.UPSTREAM_PAGE
    || 'E:/claude/RP-Hub-1.8.9 - 副本/continue/index.html';
const OUT = path.join(ROOT, 'novel-continue-standalone.html');

if (!fs.existsSync(SRC)) {
    console.error(`找不到上游页面：${SRC}\n` +
        '本步骤需要上游 RP Hub 项目的 continue/index.html。\n' +
        '用 UPSTREAM_PAGE=<路径> 指定，或直接跳过本步骤（仓库里的单文件已是成品）。');
    process.exit(1);
}

const read = p => fs.readFileSync(p, 'utf8');
const client = read(path.join(HERE, 'inline-client.js'));
const setup = read(path.join(HERE, 'inline-setup.js'));
const modal = read(path.join(HERE, 'inline-modal.html'));

let text = read(SRC);
const log = [];
let failed = 0;

const replace = (name, oldStr, newStr, { count = 1 } = {}) => {
    const parts = text.split(oldStr);
    const hits = parts.length - 1;
    if (hits === 0) {
        failed += 1;
        log.push(`✗ ${name}：没有匹配到目标文本`);
        return;
    }
    if (count > 0 && hits !== count) {
        failed += 1;
        log.push(`✗ ${name}：期望 ${count} 处，实际 ${hits} 处`);
        return;
    }
    text = parts.join(newStr);
    log.push(`✓ ${name}（${hits} 处）`);
};

/* 1. 去掉三个外部脚本，换成内置 API 客户端 */
replace(
    '内联 API 客户端（替换 ../assets/js/*.js）',
    `    <script src="../assets/js/built-in-content.js"></script>
    <script src="../assets/js/core-utils.js"></script>
    <script src="../assets/js/api-utils.js"></script>`,
    `    <script>
${client}    </script>`
);

/* 2. 标题 */
replace('页面标题', '<title>小说续写</title>', '<title>小说续写 · 独立版</title>');

/* 3. 顶栏未配置提示 -> 可点击打开设置 */
replace(
    '顶栏配置提示',
    `                <span v-if="!apiReady" class="badge badge-warning badge-sm gap-1 shrink-0 hidden md:inline-flex">
                    未同步 API 设置
                </span>`,
    `                <button v-if="!apiReady" type="button" @click="openApiSetup"
                    class="badge badge-warning badge-sm gap-1 shrink-0 hidden md:inline-flex cursor-pointer"
                    title="点击填写接口地址、Key 与模型">还没配置接口</button>
                <span v-else-if="standalone" class="badge badge-ghost badge-sm shrink-0 hidden xl:inline-flex font-mono"
                    :title="'接口设置保存在本机浏览器：' + apiHostLabel">{{ apiHostLabel }}</span>`
);

/* 4. 模型下拉：未填写的档位点开设置 */
replace(
    '模型下拉点击逻辑',
    `                            <a onclick="this.closest('details').removeAttribute('open')"
                                @click="activeModelType = slot.key"
                                :class="{ 'bg-base-200/80 font-bold': activeModelType === slot.key }"
                                class="py-3 px-4">
                                <span class="font-mono text-xs w-full truncate">{{ models[slot.key] || '未设置' }}</span>
                            </a>`,
    `                            <a onclick="this.closest('details').removeAttribute('open')"
                                @click="chooseModelSlot(slot.key)"
                                :class="{ 'bg-base-200/80 font-bold': activeModelType === slot.key }"
                                class="py-3 px-4">
                                <span class="font-mono text-xs w-full truncate">{{ models[slot.key] || '点此填写模型名' }}</span>
                            </a>`
);

/* 5. 顶栏齿轮入口（仅独立版显示） */
replace(
    '顶栏齿轮按钮',
    `                <button class="btn btn-ghost btn-sm h-10 gap-1.5" @click="triggerImport" :disabled="anyBusy">`,
    `                <button v-if="standalone" class="btn btn-ghost btn-sm h-10 w-10 p-0 relative"
                    @click="openApiSetup" :title="apiReady ? '接口设置' : '还没配置接口，点这里设置'"
                    :aria-label="apiReady ? '接口设置' : '还没配置接口，点这里设置'">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="3"></circle>
                        <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008.9 19a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 8.9a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"></path>
                    </svg>
                    <span v-if="!apiReady" class="absolute top-1 right-1 w-2 h-2 rounded-full bg-warning"></span>
                </button>
                <button class="btn btn-ghost btn-sm h-10 gap-1.5" @click="triggerImport" :disabled="anyBusy">`
);

/* 6. 空状态里的首次引导 */
replace(
    '空状态接口引导',
    `                        <div class="mt-5 flex items-center justify-center gap-2">
                            <span class="btn btn-primary btn-sm text-white pointer-events-none">选择 txt 文件</span>`,
    `                        <button v-if="standalone && !apiReady" type="button" @click.stop="openApiSetup"
                            class="mt-4 badge badge-warning badge-sm gap-1 cursor-pointer">
                            还没配置接口 —— 点这里填地址 / Key / 模型
                        </button>
                        <div class="mt-5 flex items-center justify-center gap-2">
                            <span class="btn btn-primary btn-sm text-white pointer-events-none">选择 txt 文件</span>`
);

/* 7. 设置弹窗 */
replace(
    '接口设置弹窗',
    `        <!-- 粘贴文本弹窗 -->`,
    `${modal}
        <!-- 粘贴文本弹窗 -->`
);

/* 8. setup 内的独立版状态与逻辑 */
replace(
    '独立版 setup 逻辑',
    `                if (isEmbedded) window.parent.postMessage({ type: 'WORKSHOP_READY' }, '*');`,
    `                if (isEmbedded) window.parent.postMessage({ type: 'WORKSHOP_READY' }, '*');

${setup}`
);

/* 9. 报错文案 */
replace(
    '报错文案：地址',
    `if (!String(api.url || '').trim()) throw new Error('请先在 RP Hub 主界面填写当前 API 预设的地址');`,
    `if (!String(api.url || '').trim()) throw new Error(standalone ? '还没配置接口，点右上角齿轮填写 API 地址' : '请先在 RP Hub 主界面填写当前 API 预设的地址');`
);
replace(
    '报错文案：Key',
    `if (!String(api.key || '').trim()) throw new Error('请先在 RP Hub 主界面填写当前 API 预设的 Key');`,
    `if (!String(api.key || '').trim()) throw new Error(standalone ? '还没配置接口，点右上角齿轮填写 API Key' : '请先在 RP Hub 主界面填写当前 API 预设的 Key');`
);
replace(
    '报错文案：模型',
    `if (!String(activeModel.value || '').trim()) throw new Error('请先在 RP Hub 主界面选择模型');`,
    `if (!String(activeModel.value || '').trim()) throw new Error(standalone ? '还没配置接口，点右上角齿轮填写模型名' : '请先在 RP Hub 主界面选择模型');`
);

/* 10. 三处「请先在主界面同步 API 设置」改为直接引导配置 */
replace(
    'API 未就绪提示',
    `if (!apiReady.value) { showToast('请先在主界面同步 API 设置', 'warning'); return; }`,
    `if (!apiReady.value) {
                        if (standalone) { openApiSetup(); showToast('先配置接口：地址 / Key / 模型', 'warning'); }
                        else showToast('请先在主界面同步 API 设置', 'warning');
                        return;
                    }`,
    { count: 3 }
);

/* 11. Esc 关闭设置弹窗 */
replace(
    'Esc 关闭设置弹窗',
    `                const handleKeydown = (event) => {
                    if (event.key !== 'Escape') return;
                    if (previewId.value) { closePreview(); return; }
                    if (pasteOpen.value) pasteOpen.value = false;
                };`,
    `                const handleKeydown = (event) => {
                    if (event.key !== 'Escape') return;
                    if (apiSetupOpen.value) { apiSetupOpen.value = false; return; }
                    if (previewId.value) { closePreview(); return; }
                    if (pasteOpen.value) pasteOpen.value = false;
                };`
);

/* 12. 首次打开且从未配置过接口时，自动弹出设置 */
replace(
    '首次打开引导弹窗',
    `                onMounted(() => {
                    document.documentElement.setAttribute('data-app-font', 'serif');
                    window.addEventListener('keydown', handleKeydown);
                    restore();
                });`,
    `                onMounted(() => {
                    document.documentElement.setAttribute('data-app-font', 'serif');
                    window.addEventListener('keydown', handleKeydown);
                    restore();
                    // 独立版第一次打开：一份配置都没有，直接把设置面板摆出来
                    if (standalone && !hasStandaloneConfig && !apiReady.value) apiSetupOpen.value = true;
                });`
);

/* 13. 导出到模板 */
replace(
    '模板导出独立版绑定',
    `                    api, models, modelSlots, activeModelType, activeModel, apiReady,`,
    `                    api, models, modelSlots, activeModelType, activeModel, apiReady, standalone, apiHostLabel,
                    apiSetupOpen, apiDraft, apiKeyVisible, testingApi, apiTestResult,
                    openApiSetup, saveApiSettings, clearApiSettings, chooseModelSlot, testApiConnection,`
);

/* 14. 结果自检：不该再有主项目引用 */
const leftovers = [
    'src="../assets/js/',
    '未同步 API 设置',
    'RPHubBuiltinContent'
].filter(token => text.includes(token));
if (leftovers.length) {
    failed += 1;
    log.push(`✗ 残留主项目引用：${leftovers.join(' / ')}`);
}

console.log(log.join('\n'));
console.log('');
if (failed) {
    console.error(`转换失败：${failed} 处问题，未写出文件`);
    process.exit(1);
}
fs.writeFileSync(OUT, text, 'utf8');
const lines = text.split('\n').length;
console.log(`已写出 ${OUT}`);
console.log(`行数 ${lines}，体积 ${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)} KB`);
