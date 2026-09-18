// 语法与结构自检：抽出 <script> 检查 JS 语法，并统计 Vue 模板标签闭合
// 用法：node tests/syntax-check.mjs [目标 html 路径]
// 不传参时默认检查仓库根的独立版单文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = process.argv[2] || path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'novel-continue-standalone.html');
const standalone = /standalone/.test(FILE);
const html = fs.readFileSync(FILE, 'utf8');
const fail = [];
const ok = [];

// ---- 1. 内联 script 块的 JS 语法 ----
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) {
    fail.push('没有找到内联 script 块');
} else {
    scripts.forEach((block, i) => {
        const code = block[1];
        try {
            new Function(code);
            ok.push(`内联 script #${i + 1} 语法通过（${code.length} 字符）`);
        } catch (e) {
            fail.push(`内联 script #${i + 1} 语法错误：${e.message}`);
        }
    });
}

// ---- 2. Vue 模板里的标签闭合（只看 #app 容器内部）----
const appStart = html.indexOf('<div id="app"');
const appEnd = html.indexOf('<script', appStart);
if (appStart < 0 || appEnd < 0) {
    fail.push('找不到 #app 容器范围');
} else {
    const tpl = html.slice(appStart, appEnd);
    const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'source', 'path', 'circle',
        'rect', 'line', 'polyline', 'polygon', 'use', 'area', 'base', 'col', 'embed', 'track', 'wbr']);
    const stack = [];
    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    let m;
    while ((m = tagRe.exec(tpl))) {
        const closing = m[1] === '/';
        const name = m[2].toLowerCase();
        const selfClose = m[4] === '/';
        if (VOID.has(name) || selfClose) continue;
        if (!closing) {
            stack.push({ name, at: m.index });
        } else {
            const top = stack.pop();
            if (!top) {
                fail.push(`多余的闭合标签 </${name}>，位置 ${m.index}`);
                break;
            }
            if (top.name !== name) {
                const line = tpl.slice(0, top.at).split('\n').length;
                fail.push(`标签不匹配：<${top.name}>（第 ${line} 行）被 </${name}> 关闭`);
                break;
            }
        }
    }
    if (stack.length) {
        const top = stack[stack.length - 1];
        const line = tpl.slice(0, top.at).split('\n').length;
        fail.push(`未闭合的标签 <${top.name}>，起始第 ${line} 行（栈深 ${stack.length}）`);
    } else {
        ok.push('Vue 模板标签闭合通过');
    }
}

// ---- 3. 功能实现是否都在 ----
const musts = [
    ['文本内不留旧字段', /targetLength/, false],
    ['页数区间', /pagesMin/, true],
    ['每页字数', /charsPerPage/, true],
    ['篇幅区间说明', /这是一个区间，本章实际写多长由你根据内容判断/, true],
    ['大纲审校提示词', /OUTLINE_REVIEW_SYSTEM_PROMPT/, true],
    ['大纲审校函数', /const runOutlineReview/, true],
    ['剧情弧提示词', /ARC_PLAN_SYSTEM_PROMPT/, true],
    ['剧情弧函数', /const runArcPlan/, true],
    ['罗盘解析', /const parseCompass/, true],
    ['罗盘吸收', /const absorbState/, true],
    ['停滞检测', /const detectStall/, true],
    ['停滞警告', /stallWarningText/, true],
    ['文本重合兜底', /const overlapRatio/, true],
    ['罗盘机读标记', /===剧情罗盘===/, true],
    ['弧机读标记', /===剧情弧===/, true],
    ['防突兀铁律', /任何剧情转折都必须有前文支撑/, true],
    ['动机链铁律', /人物行为必须有动机链/, true],
    ['禁止原地打转', /禁止原地打转/, true],
];

const standaloneMusts = [
    ['不再引用 ../assets/js/ 脚本', /src="\.\.\/assets\//, false],
    ['不再引用任何外部资源（自包含）', /(?:<script[^>]+src=["']https?:|<link[^>]+href=["']https?:)/, false],
    ['不再引用内置内容库', /RPHubBuiltinContent/, false],
    ['内置端点拼接', /const buildApiEndpoint = \(baseUrl, path\)/, true],
    ['内置 API 客户端', /window\.RPHubApiClient = Object\.freeze\(\{ requestChatCompletion \}\)/, true],
    ['客户端真流式（reader）', /response\.body\.getReader\(\)/, true],
    ['区分超时与主动中止', /timedOut/, true],
    ['独立版标记', /const standalone = !isEmbedded;/, true],
    ['本地配置键', /RPHubContinueStandaloneApi/, true],
    ['本地配置载入', /const loadStandaloneApi/, true],
    ['配置持久化', /const persistStandaloneApi/, true],
    ['接口设置弹窗状态', /const apiSetupOpen = ref\(false\)/, true],
    ['保存设置', /const saveApiSettings/, true],
    ['清除设置', /const clearApiSettings/, true],
    ['档位选择引导', /const chooseModelSlot/, true],
    ['连接测试', /const testApiConnection/, true],
    ['弹窗模板', /v-if="apiSetupOpen"/, true],
    ['顶栏齿轮入口', /@click="openApiSetup"[\s\S]{0,200}?接口设置/, true],
    ['首次打开自动引导', /!hasStandaloneConfig && !apiReady\.value/, true],
    ['面板绑定已导出', /openApiSetup, saveApiSettings, clearApiSettings, chooseModelSlot, testApiConnection,/, true],
    ['独立版未配置时引导打开设置', /先配置接口：地址 \/ Key \/ 模型/, true],
    ['未就绪提示已按模式分流', /if \(standalone\) \{ openApiSetup\(\)/, true],
];

const list = standalone ? musts.concat(standaloneMusts) : musts;
list.forEach(([label, re, want]) => {
    const hit = re.test(html);
    if (hit === want) ok.push(`结构检查：${label} ✓`);
    else fail.push(`结构检查失败：${label}（期望 ${want ? '存在' : '不存在'}）`);
});

console.log(`===== 语法与结构自检：${FILE} =====`);
ok.forEach(t => console.log('  OK   ' + t));
fail.forEach(t => console.log('  FAIL ' + t));
console.log(`\n结果：${ok.length} 通过 / ${fail.length} 失败`);
process.exit(fail.length ? 1 : 0);
