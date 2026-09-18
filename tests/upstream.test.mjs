// CDP 驱动：无头 Chrome + Node 内建 WebSocket
// 关键一：脚本自己把日志写盘（shell 重定向残留会导致误读上一轮结果）
// 关键二：通过 #app.__vue_app__._instance.setupState 直接驱动组件，绕开脆弱的 DOM 选择器
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOG = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), 'upstream.test.log');
const logStream = fs.createWriteStream(LOG, { flags: 'w' });
const rawLog = console.log.bind(console);
console.log = (...args) => { logStream.write(args.map(String).join(' ') + '\n'); rawLog(...args); };

const PORT = 8791;
const CDP_PORT = 9341;
const PROFILE = path.join(os.tmpdir(), '_chrome_cdp_' + Date.now());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- Chrome 定位 ---------------- */
const chromeCandidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
];
const chromePath = chromeCandidates.find(p => fs.existsSync(p));
if (!chromePath) { console.log('找不到 Chrome / Edge'); process.exit(1); }
const browserName = path.basename(chromePath).toLowerCase();

/* ---------------- 测试控制面 ---------------- */
const reset = () => fetch(`http://127.0.0.1:${PORT}/__reset`).then(r => r.json());
const setConfig = (obj) => fetch(`http://127.0.0.1:${PORT}/__config?set=${encodeURIComponent(JSON.stringify(obj))}`).then(r => r.json());
const getCalls = () => fetch(`http://127.0.0.1:${PORT}/__calls`).then(r => r.json());

const NOVEL = [
    '第一章 渡口',
    '天还没亮，沈砚就到了渡口。河面上浮着一层薄雾，把对岸的灯火遮得只剩一点红。',
    '他把包袱放在脚边，蹲下来，从里面摸出半枚玉佩。玉是暖的，缺口却整齐得反常。',
    '老周挑着灯笼过来，看了一眼，什么都没说，只把灯笼往他那边偏了偏。',
    '',
    '第二章 旧账',
    '船是晌午才来的。船老大老周把缆绳往桩上一绕，冲沈砚咧嘴一笑，露出一颗金牙。',
    '「小沈，你爹当年也是坐我这条船走的。」老周说这话的时候，眼睛看着水。',
    '沈砚把玉佩收进怀里，问他去哪。老周说，往北，一路往北。',
    '',
    '第三章 雾散',
    '雾散的时候，船已经离岸很远了。沈砚站在船尾，看着渡口缩成一个小点。',
    '老周在船头哼一支不成调的小曲，哼到一半忽然停了，回头看了他一眼。',
    '那一眼很短，但沈砚记住了——那不是看客人的眼神。'
].join('\n');

const results = [];
const check = (name, pass, detail = '') => {
    results.push({ name, pass, detail });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
};

const main = async () => {
    console.log('===== 续写增强功能验证 =====\n');

    const chrome = spawn(chromePath, [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE}`,
        '--no-first-run', '--no-default-browser-check', '--disable-gpu',
        '--window-size=1600,1000',
        'about:blank'
    ], { stdio: 'ignore' });

    let version = null;
    for (let i = 0; i < 80; i += 1) {
        try {
            const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
            version = await r.json();
            break;
        } catch (_) { await sleep(250); }
    }
    if (!version) { console.log('Chrome 未就绪'); chrome.kill(); process.exit(1); }

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let nextId = 1;
    const pending = new Map();
    ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject, timer } = pending.get(msg.id);
            clearTimeout(timer); pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        }
    };

    const cdp = (method, params = {}, sessionId, timeout = 30000) => new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }, timeout);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

    const consoleErrors = [];
    ws.addEventListener('message', (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
            consoleErrors.push((msg.params.args || []).map(a => a.value || a.description || '').join(' '));
        }
        if (msg.method === 'Runtime.exceptionThrown') {
            consoleErrors.push('EXCEPTION: ' + (msg.params?.exceptionDetails?.exception?.description || ''));
        }
    });

    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.enable', {}, sessionId);
    await cdp('Page.enable', {}, sessionId);

    const evalIn = (expression, awaitPromise = false, timeout = 300000) => new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('evaluate 超时')); }, timeout);
        pending.set(id, {
            resolve: (r) => {
                if (r.exceptionDetails) {
                    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '未知';
                    reject(new Error('页面异常：' + String(d).split('\n').slice(0, 4).join(' | ')));
                } else resolve(r.result?.value);
            },
            reject, timer
        });
        ws.send(JSON.stringify({
            id, method: 'Runtime.evaluate', sessionId,
            params: { expression, awaitPromise, returnByValue: true, userGesture: true }
        }));
    });

    // Vue 生产构建不会给 app._instance 赋值（只在 dev/devtools 下赋值），
    // 但 render() 一定会把根 vnode 挂在 container._vnode 上，从那里取组件实例最稳
    const S = '(() => { const el = document.querySelector("#app");'
        + ' const inst = (el && el._vnode && el._vnode.component) || (el && el.__vue_app__ && el.__vue_app__._instance);'
        + ' return inst.setupState; })()';

    /* ---------------- 打开页面 ---------------- */
    await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/continue/index.html` }, sessionId);
    let mounted = false;
    for (let i = 0; i < 80; i += 1) {
        try {
            if (await evalIn('(() => { const el = document.querySelector("#app");'
                + ' return !!(el && el._vnode && el._vnode.component && el._vnode.component.setupState); })()')) {
                mounted = true; break;
            }
        } catch (_) { }
        await sleep(250);
    }
    if (!mounted) { console.log('页面未挂载'); ws.close(); chrome.kill(); process.exit(1); }
    console.log('  页面已挂载\n');

    // 页面把自己当 iframe，postMessage 给自己即可通过 event.source === window.parent 校验
    await evalIn(`window.postMessage({ type:'SYNC_SETTINGS', settings:{
        apiUrl:'http://127.0.0.1:${PORT}', apiKey:'mock-key',
        balancedModel:'mock-model', qualityModel:'mock-model', fastModel:'mock-model', model:'mock-model'
    }}, '*')`);
    await sleep(300);

    /* ================= 1. 挂载与三栏 ================= */
    console.log('— 布局 —');
    check('页面挂载、setup 可访问', await evalIn(`!!(${S})`));
    check('三栏结构存在', await evalIn(`document.querySelectorAll('.col-left,.col-center,.col-right').length === 3`));
    check('API 就绪', await evalIn(`${S}.apiReady === true`));

    /* ================= 2. 篇幅页数区间 ================= */
    console.log('\n— 篇幅：页数区间 —');
    check('默认 4~8 页 = 2000~4000 字',
        await evalIn(`(${S}.lengthRange.lo === 4 && ${S}.lengthRange.hi === 8
            && ${S}.lengthRange.min === 2000 && ${S}.lengthRange.max === 4000)`),
        await evalIn(`JSON.stringify(${S}.lengthRange)`));

    await evalIn(`${S}.pagesMin = 3; ${S}.pagesMax = 6; ${S}.charsPerPage = 400; 1`);
    await sleep(150);
    check('改成 3~6 页 / 每页 400 = 1200~2400 字',
        await evalIn(`(${S}.lengthRange.min === 1200 && ${S}.lengthRange.max === 2400)`),
        await evalIn(`JSON.stringify(${S}.lengthRange)`));

    await evalIn(`${S}.pagesMin = 9; ${S}.pagesMax = 2; 1`);
    await sleep(150);
    check('下限大于上限时自动纠正顺序',
        await evalIn(`(${S}.lengthRange.lo === 2 && ${S}.lengthRange.hi === 9)`),
        await evalIn(`JSON.stringify(${S}.lengthRange)`));
    await evalIn(`${S}.pagesMin = 3; ${S}.pagesMax = 6; 1`);
    await sleep(120);
    check('面板显示换算后的字数', await evalIn(`document.body.innerText.includes('1200 – 2400 字')`));
    check('每页字数输入框存在', await evalIn(`!!document.querySelector('input[title*="每页折算"]')`));

    /* ================= 3. 导入小说 ================= */
    console.log('\n— 导入 —');
    await evalIn(`${S}.pasteText = ${JSON.stringify(NOVEL)}; ${S}.applyPaste(); 1`);
    await sleep(250);
    check('导入 3 章', await evalIn(`${S}.novel.chapters.length === 3`),
        '实际 ' + await evalIn(`String(${S}.novel.chapters.length)`));
    check('起点落在第 3 章', await evalIn(`${S}.startIndex === 2`));

    /* ================= 4. 剧情罗盘 ================= */
    console.log('\n— 剧情罗盘 —');
    await reset();
    await setConfig({ stateRisk: '低', stateEvents: ['主角在渡口拿到半枚玉佩', '与船老大起了争执'] });
    await evalIn(`${S}.rebuildState()`, true);
    await sleep(400);
    check('全量重建后罗盘已建立', await evalIn(`!!${S}.compassReady`));
    check('罗盘主线目标正确',
        await evalIn(`${S}.compassView['主线目标'] === '查清父亲当年的死因'`),
        await evalIn(`String(${S}.compassView['主线目标'])`));
    check('档案正文已剥离机读块', await evalIn(`!${S}.storyState.includes('===剧情罗盘===')`));
    check('罗盘记录覆盖到第 3 章', await evalIn(`${S}.compassChapter === 2`));
    check('人物设定卡解析出 2 人', await evalIn(`${S}.compassView['人物设定'].length === 2`),
        await evalIn(`String(${S}.compassView['人物设定'].length)`));
    check('未回收伏笔解析出 2 条', await evalIn(`${S}.compassView['未回收伏笔'].length === 2`),
        await evalIn(`String(${S}.compassView['未回收伏笔'].length)`));
    check('下章必须推进解析出 2 条', await evalIn(`${S}.compassView['下章必须推进'].length === 2`));
    // 折叠面板内的文字用 textContent 读：innerText 对隐藏元素返回空串
    check('罗盘面板渲染出主线目标',
        await evalIn(`document.querySelector("#app").textContent.includes('查清父亲当年的死因')`));
    check('罗盘面板渲染出人物设定',
        await evalIn(`document.querySelector("#app").textContent.includes('沈砚｜主角｜寡言执拗')`));
    check('罗盘面板显示伏笔条数', await evalIn(`document.querySelector("#app").textContent.includes('2 条')`));
    check('罗盘面板显示已用过的场景',
        await evalIn(`document.querySelector("#app").textContent.includes('渡口夜谈')`));
    check('罗盘面板显示推进正常',
        await evalIn(`document.querySelector("#app").textContent.includes('推进正常')`));

    /* ================= 4b. 脏 JSON 容错 ================= */
    console.log('\n— 脏 JSON 容错 —');
    await reset();
    await setConfig({ sloppyJson: true });
    await evalIn(`${S}.storyState = ''; ${S}.compass = null; ${S}.rebuildState()`, true);
    await sleep(400);
    check('中文逗号 + 尾逗号仍能解析出罗盘', await evalIn(`!!${S}.compassReady`));
    check('脏 JSON 下主线目标仍正确',
        await evalIn(`${S}.compassView['主线目标'] === '查清父亲当年的死因'`),
        await evalIn(`String(${S}.compassView['主线目标'])`));
    check('脏 JSON 下数组字段仍完整',
        await evalIn(`${S}.compassView['人物设定'].length === 2 && ${S}.compassView['未回收伏笔'].length === 2`));
    check('脏 JSON 下档案正文同样被剥离',
        await evalIn(`!${S}.storyState.includes('===剧情罗盘===')`));
    await setConfig({ sloppyJson: false });

    /* ================= 5. 大纲审校 ================= */
    console.log('\n— 大纲审校 —');
    await evalIn(`${S}.runPlan()`, true);
    await sleep(200);
    check('大纲已生成（原始稿）', await evalIn(`${S}.outline.includes('【原始大纲】')`));

    await reset();
    await evalIn(`${S}.runOutlineReview()`, true);
    await sleep(300);
    const reviewCalls = (await getCalls()).filter(c => c.kind === 'outline-review');
    check('审校调用发生（1 次）', reviewCalls.length === 1, '实际 ' + reviewCalls.length);
    check('审校提示词带上篇幅要求', (reviewCalls[0]?.user || '').includes('1200 – 2400 字'));
    check('审校提示词带上剧情罗盘', (reviewCalls[0]?.user || '').includes('【剧情罗盘】'));
    check('审校提示词带上前情档案', (reviewCalls[0]?.user || '').includes('渡口茶棚'));
    check('优化稿已替换大纲',
        await evalIn(`${S}.outline.includes('【优化后的大纲正文】')`),
        await evalIn(`${S}.outline.slice(0, 20)`));
    check('原大纲已备份可还原', await evalIn(`${S}.outlineBefore.includes('【原始大纲】')`));
    check('判定解析为「需修改」', await evalIn(`${S}.outlineVerdict === '需修改'`),
        await evalIn(`String(${S}.outlineVerdict)`));
    check('意见条数解析为 3', await evalIn(`${S}.outlineIssueCount === 3`),
        '实际 ' + await evalIn(`String(${S}.outlineIssueCount)`));
    check('审校意见面板可见', await evalIn(`document.querySelector("#app").textContent.includes('审校意见')`));

    await evalIn(`${S}.restoreOutline(); 1`);
    await sleep(150);
    check('还原能拿回原始大纲', await evalIn(`${S}.outline.includes('【原始大纲】')`));

    /* ================= 6. 正文提示词注入 ================= */
    console.log('\n— 正文提示词 —');
    await reset();
    await evalIn(`${S}.outline = '【测试大纲】上船'; 1`);
    await evalIn(`${S}.runWrite()`, true);
    await sleep(300);
    const wu = ((await getCalls()).find(c => c.kind === 'write') || {}).user || '';
    check('正文提示词注入【剧情罗盘】', wu.includes('【剧情罗盘】'));
    check('含「本章必须推进」硬性要求', wu.includes('本章必须推进（至少完成一项，硬性要求）'));
    check('含「已用过的场景（禁止重复）」', wu.includes('已用过的场景与桥段（禁止重复）'));
    check('含人物设定卡', wu.includes('沈砚｜主角｜寡言执拗'));
    check('篇幅写成区间并授权自决',
        wu.includes('约 1200 – 2400 字（3 – 6 页，按每页约 400 字计）')
        && wu.includes('这是一个区间，本章实际写多长由你根据内容判断'));
    check('不再出现固定字数的旧写法', !/约 2000 字。/.test(wu));
    check('正文已流式写入中栏', await evalIn(`${S}.output.length > 200`),
        '实际 ' + await evalIn(`String(${S}.output.length)`));

    /* ================= 7. 停滞检测（模型自评） ================= */
    console.log('\n— 停滞检测：模型自评 —');
    await reset();
    await evalIn(`${S}.stallStreak = 0; ${S}.stallNote = '';
        ${S}.planFirst = true; ${S}.outlineReview = false; ${S}.autoVerify = false; ${S}.autoCount = 3; 1`);
    await setConfig({ stateRisk: '高', stateEvents: [], writeParagraphs: 8, chunkDelay: 2 });
    await evalIn(`${S}.runAutoNovel()`, true);
    await sleep(300);
    check('模型自评停滞 → stallStreak 递增', await evalIn(`${S}.stallStreak >= 1`),
        'stallStreak=' + await evalIn(`String(${S}.stallStreak)`));
    check('停滞说明被记录下来', await evalIn(`!!${S}.stallNote`),
        await evalIn(`String(${S}.stallNote).slice(0, 36)`));
    check('停滞警告注入下一章大纲',
        (await getCalls()).filter(c => c.kind === 'outline')
            .some(c => c.user.includes('停滞警告') && c.user.includes('真正推出去')));
    check('未被判定停滞的前几章不带警告',
        (await getCalls()).filter(c => c.kind === 'outline')
            .filter(c => !c.user.includes('停滞警告')).length >= 1);

    /* ================= 8. 停滞兜底（文本重合） ================= */
    console.log('\n— 停滞检测：文本重合兜底 —');
    await reset();
    await evalIn(`${S}.stallStreak = 0; ${S}.stallNote = ''; ${S}.autoCount = 3; 1`);
    await setConfig({
        repeatWrite: true, stateRisk: '低',
        stateEvents: ['主角拿到了新的线索', '时间推进到第二天'],
        writeParagraphs: 8, chunkDelay: 2
    });
    await evalIn(`${S}.runAutoNovel()`, true);
    await sleep(300);
    check('内容重复时被文本重合抓到',
        await evalIn(`String(${S}.stallNote).includes('重合')`),
        await evalIn(`String(${S}.stallNote).slice(0, 50)`));
    check('连续重复时 streak 继续累加', await evalIn(`${S}.stallStreak >= 1`),
        'stallStreak=' + await evalIn(`String(${S}.stallStreak)`));
    check('重合兜底不依赖模型自评（风险为低也触发）',
        await evalIn(`${S}.compassView['停滞风险'] === '低'`));

    /* ================= 9. 剧情弧 + 全链路 ================= */
    console.log('\n— 剧情弧与全链路 —');
    await reset();
    await setConfig({
        repeatWrite: false, stateRisk: '低',
        stateEvents: ['主角拿到了新的线索', '时间推进到第二天'],
        writeParagraphs: 6, chunkDelay: 2
    });
    await evalIn(`${S}.clearArc(); ${S}.stallStreak = 0; ${S}.stallNote = '';
        ${S}.autoArcPlan = true; ${S}.planFirst = true; ${S}.outlineReview = true;
        ${S}.autoVerify = true; ${S}.autoCount = 3; 1`);
    await sleep(150);
    const chaptersBefore = await evalIn(`${S}.novel.chapters.length`);

    await evalIn(`${S}.runAutoNovel()`, true);
    await sleep(400);

    const calls = await getCalls();
    const kinds = calls.map(c => c.kind);
    check('自动写作前排了剧情弧（1 次）', kinds.filter(k => k === 'arc').length === 1,
        '实际 ' + kinds.filter(k => k === 'arc').length);
    check('弧解析出 3 个节拍', await evalIn(`${S}.arcBeats.length === 3`),
        '实际 ' + await evalIn(`String(${S}.arcBeats.length)`));
    check('弧已激活', await evalIn(`${S}.arcActive === true`));

    const outlineCalls = calls.filter(c => c.kind === 'outline');
    check('第 1 章大纲注入「第 1 / 3 章」节拍',
        outlineCalls.some(c => c.user.includes('本章在剧情弧中的位置】第 1 / 3 章')));
    check('第 3 章大纲注入「第 3 / 3 章」节拍',
        outlineCalls.some(c => c.user.includes('本章在剧情弧中的位置】第 3 / 3 章')));
    check('大纲带入本拍必须推进的内容',
        outlineCalls.some(c => c.user.includes('陌生客露出另半边玉佩')));
    check('大纲带入弧线终点约束',
        outlineCalls.some(c => c.user.includes('不要提前把整条弧的终点写完')));
    check('章节级大纲里带上本拍收尾状态',
        outlineCalls.some(c => c.user.includes('章末应达到的状态')));

    const seq = kinds.filter(k => ['arc', 'outline', 'outline-review', 'write', 'verify', 'state-update', 'state-full'].includes(k));
    check('每章走「大纲 → 审校 → 正文」',
        seq.join(',').includes('outline,outline-review,write'), seq.join(','));
    const firstWrite = seq.indexOf('write');
    check('审校在大纲之后、正文之前',
        seq.indexOf('outline-review') < firstWrite && firstWrite > -1);
    check('审校确实覆盖了每一章',
        kinds.filter(k => k === 'outline').length === 3 && kinds.filter(k => k === 'outline-review').length === 3,
        `outline=${kinds.filter(k => k === 'outline').length} review=${kinds.filter(k => k === 'outline-review').length}`);
    check('每章都维护了前情',
        kinds.filter(k => k === 'state-update' || k === 'state-full').length >= 3,
        '实际 ' + kinds.filter(k => k === 'state-update' || k === 'state-full').length);
    check('连写 3 章后章节数 +3',
        await evalIn(`${S}.novel.chapters.length === ${chaptersBefore + 3}`),
        `${chaptersBefore} → ` + await evalIn(`String(${S}.novel.chapters.length)`));

    const stallLog = await evalIn(`${S}.auto.log.filter(l => /停滞|推进正常|重合/.test(l.text))
        .map(l => l.text).join(' ｜ ')`);
    const compassRisk = await evalIn(`JSON.stringify({
        risk: ${S}.compassView['停滞风险'],
        events: ${S}.compassView['最近推进'],
        note: ${S}.stallNote
    })`);
    check('推进正常时没有误报停滞', await evalIn(`${S}.stallStreak === 0`),
        'stallStreak=' + await evalIn(`String(${S}.stallStreak)`)
        + ' ｜ 罗盘=' + compassRisk + ' ｜ 日志=' + stallLog);
    check('正常时大纲不带停滞警告',
        !outlineCalls.some(c => c.user.includes('停滞警告')),
        outlineCalls.map(c => (c.user.match(/停滞警告/) ? '有' : '无')).join(','));
    check('弧面板在非运行态显示节拍数',
        await evalIn(`document.querySelector("#app").textContent.includes('个节拍')`));

    /* ================= 10. 降级与持久化 ================= */
    console.log('\n— 降级与持久化 —');
    check('无罗盘时模板不炸（空壳兜底）', await evalIn(`(() => {
        const s = ${S}; const keep = s.compass; s.compass = null;
        let v; try { v = s.compassView['主线目标']; } catch (e) { v = 'ERR:' + e.message; }
        s.compass = keep; return v === '';
    })()`));
    check('无罗盘时 compassReady 为 false', await evalIn(`(() => {
        const s = ${S}; const keep = s.compass; s.compass = null;
        const r = s.compassReady === false; s.compass = keep; return r;
    })()`));

    // 真降级：没有罗盘时跑一次大纲，提示词里不该出现罗盘段
    await reset();
    await evalIn(`(() => { const s = ${S}; window.__keepCompass = s.compass; s.compass = null; return 1; })()`);
    await sleep(120);
    check('无罗盘时面板显示「未建立」', await evalIn(`document.querySelector("#app").textContent.includes('未建立')`));
    await evalIn(`${S}.runPlan()`, true);
    await sleep(200);
    const noCompassCall = (await getCalls()).find(c => c.kind === 'outline');
    check('无罗盘时大纲提示词不含罗盘段', !(noCompassCall?.user || '').includes('【剧情罗盘】'));
    check('无罗盘时大纲仍能正常生成', await evalIn(`${S}.outline.length > 20`));
    await evalIn(`(() => { const s = ${S}; s.compass = window.__keepCompass; return 1; })()`);
    await sleep(150);
    const diag = await evalIn(`JSON.stringify({
        cover: ${S}.stateCoverLabel,
        storyLen: ${S}.storyState.length,
        upTo: ${S}.stateUpToIndex,
        invalid: ${S}.stateInvalid,
        ready: ${S}.compassReady,
        streak: ${S}.stallStreak
    })`);
    check('恢复罗盘后不再显示未建立',
        await evalIn(`!document.querySelector("#app").textContent.includes('未建立')`), diag);

    check('篇幅设置已持久化到本地', await evalIn(`(() => {
        const raw = window.localStorage.getItem('RPHubContinueLength');
        if (!raw) return false;
        const v = JSON.parse(raw);
        return v.min === 3 && v.max === 6 && v.perPage === 400;
    })()`));
    check('审校与弧的开关已持久化', await evalIn(`(() => {
        const raw = window.localStorage.getItem('RPHubContinueAuto');
        if (!raw) return false;
        const v = JSON.parse(raw);
        return v.outlineReview === true && v.arcPlan === true;
    })()`));

    /* ================= 11. 控制台 ================= */
    console.log('\n— 控制台 —');
    await sleep(400);
    const errs = consoleErrors.filter(e => !/favicon|net::|ERR_/i.test(e));
    check('控制台 0 报错', errs.length === 0, errs.slice(0, 3).join(' || '));

    /* ---------------- 收尾 ---------------- */
    const pass = results.filter(r => r.pass).length;
    const fail = results.length - pass;
    console.log(`\n===== 结果：${pass} / ${results.length} 通过，${fail} 失败 =====`);
    if (fail) {
        console.log('\n失败项：');
        results.filter(r => !r.pass).forEach(r => console.log('  FAIL ' + r.name + (r.detail ? '  → ' + r.detail : '')));
    }

    ws.close();
    chrome.kill();
    await sleep(300);
    // 按「命令行里含本次专用 profile 目录」精确杀，绝不按进程名杀，避免误伤用户的浏览器
    const ps = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '
        + "'" + '*_chrome_cdp_' + PROFILE.split('_chrome_cdp_')[1] + "*'"
        + ' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    await sleep(700);
    for (let i = 0; i < 6; i += 1) {
        try { fs.rmSync(PROFILE, { recursive: true, force: true }); break; } catch (_) { await sleep(500); }
    }
    console.log('\n（浏览器进程与临时 profile 已清理）');
    void browserName;
    logStream.end();
    process.exit(fail ? 1 : 0);
};

main().catch((e) => {
    console.log('运行失败：' + e.message);
    console.log(e.stack);
    logStream.end();
    process.exit(1);
});
