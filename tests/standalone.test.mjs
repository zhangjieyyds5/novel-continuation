// 独立版验证：CDP 驱动无头 Chrome，走「首次打开 -> 配置接口 -> 真实生成 -> 错误注入 -> file:// 直开」
// 关键：脚本自己把日志写盘（shell 重定向残留会导致误读上一轮结果）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');  // 仓库根
const LOG = path.join(HERE, 'tests', 'standalone.test.log');
const logStream = fs.createWriteStream(LOG, { flags: 'w' });
const rawLog = console.log.bind(console);
console.log = (...args) => { logStream.write(args.map(String).join(' ') + '\n'); rawLog(...args); };

const PORT = 8791;
const CDP_PORT = 9343;
const PROFILE = path.join(os.tmpdir(), '_chrome_solo_' + Date.now());
const URL_HTTP = `http://127.0.0.1:${PORT}/novel-continue-standalone.html`;
const URL_FILE = pathToFileURL(path.join(HERE, 'novel-continue-standalone.html')).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chromeCandidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
];
const chromePath = chromeCandidates.find(p => fs.existsSync(p));
if (!chromePath) { console.log('找不到 Chrome / Edge'); process.exit(1); }

const reset = () => fetch(`http://127.0.0.1:${PORT}/__reset`).then(r => r.json());
const setConfig = obj => fetch(`http://127.0.0.1:${PORT}/__config?set=${encodeURIComponent(JSON.stringify(obj))}`).then(r => r.json());
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
    console.log('===== 独立版验证（单文件脱离主项目） =====\n');

    const chrome = spawn(chromePath, [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE}`,
        '--no-first-run', '--no-default-browser-check', '--disable-gpu',
        // 系统代理会影响本地请求的失败时机（本地端口被绕到代理上，失败要等代理超时）
        '--no-proxy-server',
        '--window-size=1600,1000',
        'about:blank'
    ], { stdio: 'ignore' });

    let version = null;
    for (let i = 0; i < 80; i += 1) {
        try {
            version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
            break;
        } catch (_) { await sleep(250); }
    }
    if (!version) { console.log('Chrome 未就绪'); chrome.kill(); process.exit(1); }

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let nextId = 1;
    const pending = new Map();
    ws.onmessage = evt => {
        const msg = JSON.parse(evt.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject, timer } = pending.get(msg.id);
            clearTimeout(timer); pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        }
    };

    const cdp = (method, params = {}, sessionId, timeout = 60000) => new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }, timeout);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

    const consoleErrors = [];
    const netRequests = [];
    ws.addEventListener('message', evt => {
        const msg = JSON.parse(evt.data);
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
            consoleErrors.push((msg.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 300));
        }
        if (msg.method === 'Runtime.exceptionThrown') {
            consoleErrors.push('EXCEPTION: ' + String(msg.params?.exceptionDetails?.exception?.description || '').slice(0, 300));
        }
        if (msg.method === 'Network.requestWillBeSent') {
            netRequests.push(msg.params?.request?.url || '');
        }
    });

    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.enable', {}, sessionId);
    await cdp('Page.enable', {}, sessionId);
    await cdp('Network.enable', {}, sessionId);

    const evalIn = (expression, awaitPromise = false, timeout = 300000) => new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('evaluate 超时')); }, timeout);
        pending.set(id, {
            resolve: r => {
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

    const S = '(() => { const el = document.querySelector("#app");'
        + ' const inst = (el && el._vnode && el._vnode.component) || (el && el.__vue_app__ && el.__vue_app__._instance);'
        + ' return inst.setupState; })()';

    // 截图直接落到 docs/screenshots，跑一遍端到端就顺手把 README 的配图刷新了
    const SHOTS = path.join(HERE, 'docs', 'screenshots');
    fs.mkdirSync(SHOTS, { recursive: true });

    const shot = async name => {
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
        fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
    };

    const mounted = async () => {
        for (let i = 0; i < 100; i += 1) {
            try {
                if (await evalIn('(() => { const el = document.querySelector("#app");'
                    + ' return !!(el && el._vnode && el._vnode.component && el._vnode.component.setupState); })()')) return true;
            } catch (_) { /* 还没挂上 */ }
            await sleep(250);
        }
        return false;
    };

    /* ==================== 一、HTTP 通道：完整流程 ==================== */
    await reset();
    await cdp('Page.navigate', { url: URL_HTTP }, sessionId);
    if (!await mounted()) { console.log('页面未挂载'); ws.close(); chrome.kill(); process.exit(1); }
    console.log('  页面已挂载\n');

    console.log('— 脱依赖 —');
    check('页面挂载、setup 可访问', await evalIn(`!!(${S})`));
    check('内置端点工具就位（无 RPHubApiUtils 也应该能用）',
        await evalIn(`typeof window.RPHubApiUtils.buildApiEndpoint === 'function'`));
    check('内置 API 客户端就位',
        await evalIn(`typeof window.RPHubApiClient.requestChatCompletion === 'function'`));
    check('没有引用主项目任何脚本',
        await evalIn(`[...document.querySelectorAll('script[src]')].every(s => !/assets\\//.test(s.getAttribute('src')))`),
        await evalIn(`JSON.stringify([...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')))`));
    check('识别为独立运行', await evalIn(`${S}.standalone === true`));
    check('不再依赖上游工具对象',
        await evalIn(`typeof window.RPHubUtils === 'undefined' && typeof window.RPHubCardUtils === 'undefined'`));
    check('端点拼接：补 /v1', await evalIn(`window.RPHubApiUtils.buildApiEndpoint('http://a.com', 'chat/completions') === 'http://a.com/v1/chat/completions'`));
    check('端点拼接：已有 /v1 不重复',
        await evalIn(`window.RPHubApiUtils.buildApiEndpoint('http://a.com/v1/', 'chat/completions') === 'http://a.com/v1/chat/completions'`));

    console.log('\n— 首次打开引导 —');
    check('首次打开自动弹出接口设置', await evalIn(`${S}.apiSetupOpen === true`));
    check('顶栏 / 空状态提示未配置', await evalIn(`document.body.innerText.includes('还没配置接口')`));
    check('弹窗渲染出地址输入框',
        await evalIn(`!!document.querySelector('input[placeholder="https://api.openai.com/v1"]')`));
    check('弹窗渲染出 Key 输入框', await evalIn(`!!document.querySelector('input[placeholder="sk-..."]')`));
    check('弹窗渲染出三档模型输入', await evalIn(`document.querySelectorAll('input[placeholder="模型名"]').length === 3`));
    check('未填写时测试连接给出引导', await (async () => {
        await evalIn(`(() => { ${S}.testApiConnection(); return 1; })()`);
        await sleep(600);
        return await evalIn(`${S}.apiTestResult.includes('请先填好')`);
    })(), await evalIn(`${S}.apiTestResult`));
    await shot('01-api-setup.png');

    console.log('\n— 填写并测试连接 —');
    await evalIn(`(() => {
        const s = ${S};
        s.apiDraft.url = 'http://127.0.0.1:${PORT}';
        s.apiDraft.key = 'mock-key';
        s.apiDraft.balanced = 'mock-model';
        return 1;
    })()`);
    await evalIn(`${S}.testApiConnection()`, true);
    await sleep(300);
    check('测试连接真的打到了接口并成功',
        await evalIn(`${S}.apiTestResult.startsWith('连接成功')`),
        await evalIn(`${S}.apiTestResult`));
    check('测试连接带上了模型名', await evalIn(`${S}.apiTestResult.includes('mock-model')`));

    console.log('\n— 保存与持久化 —');
    await evalIn(`(() => { ${S}.saveApiSettings(); return 1; })()`);
    await sleep(300);
    check('保存后弹窗关闭', await evalIn(`${S}.apiSetupOpen === false`));
    check('接口就绪', await evalIn(`${S}.apiReady === true`));
    check('写入了本机浏览器存储', await evalIn(`(() => {
        const raw = window.localStorage.getItem('RPHubContinueStandaloneApi');
        if (!raw) return false;
        const v = JSON.parse(raw);
        return v.url === 'http://127.0.0.1:${PORT}' && v.key === 'mock-key' && v.balanced === 'mock-model';
    })()`));
    check('顶栏显示接口主机名', await evalIn(`document.body.innerText.includes('127.0.0.1:${PORT}')`));
    check('未配置提示消失', await evalIn(`!document.body.innerText.includes('还没配置接口')`));
    await shot('02-configured.png');

    console.log('\n— 刷新后仍然可用 —');
    await cdp('Page.navigate', { url: URL_HTTP }, sessionId);
    if (!await mounted()) { console.log('刷新后未挂载'); ws.close(); chrome.kill(); process.exit(1); }
    check('刷新后接口配置仍在', await evalIn(`${S}.apiReady === true`));
    check('刷新后不再弹设置', await evalIn(`${S}.apiSetupOpen === false`));
    check('刷新后模型名仍在', await evalIn(`${S}.models.balanced === 'mock-model'`));

    console.log('\n— 存档后端 —');
    const idbProbe = await evalIn(`(async () => {
        try {
            await new Promise((res, rej) => {
                const r = indexedDB.open('__probe_solo', 1);
                r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
            });
            return 'ok';
        } catch (e) { return 'fail: ' + e.message; }
    })()`, true);
    check('http 下 IndexedDB 可用（存档正常）', idbProbe === 'ok', idbProbe);

    /* ==================== 二、真实生成链路 ==================== */
    console.log('\n— 导入与生成 —');
    await reset();
    await setConfig({ chunkSize: 20, chunkDelay: 100 });
    await evalIn(`${S}.pasteText = ${JSON.stringify(NOVEL)}; ${S}.applyPaste(); 1`);
    await sleep(300);
    check('导入 3 章', await evalIn(`${S}.novel.chapters.length === 3`));

    console.log('\n— 存档（Vue Proxy 直接落盘会 DataCloneError） —');
    const readDb = () => evalIn(`(async () => {
        try {
            const db = await new Promise((res, rej) => {
                const r = indexedDB.open('RPHubContinueDB', 1);
                r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
            });
            const data = await new Promise((res, rej) => {
                const tx = db.transaction('store', 'readonly');
                const q = tx.objectStore('store').get('continue:current');
                q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
            });
            return data ? { chapters: (data.chapters || []).length, hasCompass: !!data.compass } : null;
        } catch (e) { return { error: e.message }; }
    })()`, true);
    await sleep(1600);
    const snap1 = await readDb();
    check('章节已写入 IndexedDB', snap1 && snap1.chapters === 3, JSON.stringify(snap1));

    await cdp('Page.navigate', { url: URL_HTTP }, sessionId);
    if (!await mounted()) { console.log('刷新后未挂载'); ws.close(); chrome.kill(); process.exit(1); }
    await sleep(800);
    check('刷新后从存档恢复出小说', await evalIn(`${S}.novel.chapters.length === 3`),
        '实际 ' + await evalIn(`String(${S}.novel.chapters.length)`));

    await reset();
    const stateOk = await evalIn(`${S}.runState()`, true);
    await sleep(300);
    check('全量重建前情成功（非流式走内置客户端）', stateOk === true && await evalIn(`${S}.storyState.length > 100`));
    check('前情档案带出剧情罗盘', await evalIn(`!!${S}.compassReady`));
    check('mock 收到 state-full 调用',
        (await getCalls()).some(c => c.kind === 'state-full'));
    await sleep(1600);
    const snap2 = await readDb();
    check('带罗盘的对象也能落盘（Proxy 修复生效）', snap2 && snap2.hasCompass === true, JSON.stringify(snap2));

    console.log('\n— 流式续写（验证是真流式） —');
    await reset();
    // __reset 会把 mock 参数一起还原，所以流式节奏必须放在最后一次复位之后设
    await setConfig({ chunkSize: 20, chunkDelay: 100 });
    await evalIn(`(() => { ${S}.runWrite(); return 1; })()`);
    await sleep(700);
    const len1 = await evalIn(`${S}.output.length`);
    await sleep(900);
    const len2 = await evalIn(`${S}.output.length`);
    check('正文在生成过程中持续增长（逐段落字）', len2 > len1 && len1 > 0, `${len1} → ${len2}`);
    await shot('03-writing.png');
    let waited = 0;
    while (await evalIn(`${S}.busy.write === true`) && waited < 90000) { await sleep(400); waited += 400; }
    await sleep(400);
    const finalLen = await evalIn(`${S}.output.length`);
    check('续写正常结束', await evalIn(`${S}.busy.write === false`), `等待 ${waited}ms`);
    check('正文完整（不短于流式过程中的长度）', finalLen >= len2, `最终 ${finalLen} 字`);
    const writeCalls = (await getCalls()).filter(c => c.kind === 'write');
    check('写作走的是流式接口', writeCalls.length > 0 && writeCalls.every(c => c.stream === true),
        `${writeCalls.length} 次调用`);
    check('写作提示词里带上了剧情罗盘', writeCalls.some(c => c.user.includes('查清父亲当年的死因')));
    await reset();

    console.log('\n— 正常流程无报错 —');
    check('控制台 0 报错', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

    /* ==================== 三、错误注入 ==================== */
    console.log('\n— 错误提示是否说人话 —');
    await evalIn(`(() => { ${S}.toasts.splice(0); ${S}.api.url = 'http://127.0.0.1:8799'; return 1; })()`);
    await evalIn(`(() => { ${S}.runState(); return 1; })()`);
    await sleep(2500);
    const netToast = await evalIn(`(${S}.toasts.map(t => t.message).join(' | '))`);
    check('连不上时提示浏览器能看懂的话', /连不上接口/.test(netToast || ''), netToast);

    await setConfig({ forceStatus: 401, forceMessage: 'Incorrect API key provided' });
    await evalIn(`(() => { ${S}.api.url = 'http://127.0.0.1:${PORT}'; ${S}.toasts.splice(0); return 1; })()`);
    await evalIn(`(() => { ${S}.runState(); return 1; })()`);
    await sleep(1500);
    const authToast = await evalIn(`(${S}.toasts.map(t => t.message).join(' | '))`);
    check('401 提示里带状态码和官方原因', /401/.test(authToast || '') && /Incorrect API key/.test(authToast || ''), authToast);

    await setConfig({ forceStatus: 404, forceMessage: 'Not Found' });
    await evalIn(`(() => { ${S}.toasts.splice(0); ${S}.runState(); return 1; })()`);
    await sleep(1500);
    const notFoundToast = await evalIn(`(${S}.toasts.map(t => t.message).join(' | '))`);
    check('404 提示顺带提醒 /v1', /404/.test(notFoundToast || '') && /v1/.test(notFoundToast || ''), notFoundToast);
    await setConfig({ forceStatus: 0, forceMessage: '' });

    /* ==================== 四、file:// 直开 ==================== */
    console.log('\n— file:// 双击直开 —');
    consoleErrors.length = 0;
    netRequests.length = 0;
    await cdp('Page.navigate', { url: URL_FILE }, sessionId);
    const fileMounted = await mounted();
    check('file:// 下能独立打开并挂载', fileMounted);
    if (fileMounted) {
        check('file:// 下内置客户端就位',
            await evalIn(`typeof window.RPHubApiClient.requestChatCompletion === 'function'`));
        check('file:// 下三栏渲染完整',
            await evalIn(`document.querySelectorAll('.col-left,.col-center,.col-right').length === 3`));
        check('file:// 下仍会引导配置接口', await evalIn(`${S}.apiSetupOpen === true`));
        check('file:// 下 localStorage 可写可读', await evalIn(`(() => {
            try {
                window.localStorage.setItem('__probe', 'yes');
                return window.localStorage.getItem('__probe') === 'yes';
            } catch (e) { return false; }
        })()`));
        const fileIdb = await evalIn(`(async () => {
            try {
                await new Promise((res, rej) => {
                    const r = indexedDB.open('__probe_file', 1);
                    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
                });
                return 'ok';
            } catch (e) { return 'fail: ' + e.message; }
        })()`, true);
        console.log(`  信息：file:// 下 IndexedDB = ${fileIdb}`);
        await sleep(800);
        const external = netRequests.filter(u => /^https?:/i.test(u));
        check('打开过程没有发出任何外部请求（真自包含）', external.length === 0,
            external.slice(0, 3).join(' | '));
        const fileExceptions = consoleErrors.filter(e => e.startsWith('EXCEPTION'));
        check('file:// 下没有未捕获异常', fileExceptions.length === 0, fileExceptions.join(' | ').slice(0, 200));
        console.log(`  信息：file:// 控制台消息 = ${consoleErrors.length ? consoleErrors.join(' | ').slice(0, 200) : '无'}`);
        await shot('10-file-open.png');
    }

    /* ==================== 汇总 ==================== */
    const pass = results.filter(r => r.pass).length;
    const bad = results.filter(r => !r.pass);
    console.log(`\n结果：${pass} / ${results.length} 通过`);
    if (bad.length) {
        console.log('失败项：');
        bad.forEach(r => console.log(`  - ${r.name}${r.detail ? '  → ' + r.detail : ''}`));
    }

    ws.close();
    chrome.kill();
    await sleep(800);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* 目录可能被占用 */ }
    process.exit(bad.length ? 1 : 0);
};

main().catch(err => {
    console.log('运行失败：' + err.message);
    process.exit(1);
});
