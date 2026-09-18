// 截图：新功能的界面效果
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    'docs', 'screenshots') + path.sep;
const PORT = 8791;
const CDP_PORT = 9342;
const PROFILE = path.join(os.tmpdir(), '_chrome_shot_' + Date.now());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chromePath = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p));

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

const main = async () => {
    const chrome = spawn(chromePath, [
        '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
        '--no-first-run', '--no-default-browser-check', '--disable-gpu',
        '--window-size=1600,1000', '--force-device-scale-factor=1', 'about:blank'
    ], { stdio: 'ignore' });

    let version = null;
    for (let i = 0; i < 80; i += 1) {
        try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; }
        catch (_) { await sleep(250); }
    }

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let nextId = 1;
    const pending = new Map();
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) {
            const { resolve, reject, timer } = pending.get(m.id);
            clearTimeout(timer); pending.delete(m.id);
            if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
        }
    };
    const cdp = (method, params = {}, sessionId, timeout = 60000) => new Promise((res, rej) => {
        const id = nextId++;
        const t = setTimeout(() => { pending.delete(id); rej(new Error('timeout ' + method)); }, timeout);
        pending.set(id, { resolve: res, reject: rej, timer: t });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.enable', {}, sessionId);
    await cdp('Page.enable', {}, sessionId);
    await cdp('Emulation.setDeviceMetricsOverride',
        { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

    const ev = (expr, awaitPromise = false) => cdp('Runtime.evaluate',
        { expression: expr, awaitPromise, returnByValue: true, userGesture: true }, sessionId)
        .then(r => {
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'err');
            return r.result?.value;
        });

    await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/continue/index.html` }, sessionId);
    for (let i = 0; i < 80; i += 1) {
        if (await ev('!!document.querySelector("#app")._vnode').catch(() => false)) break;
        await sleep(250);
    }
    const S = '(() => { const el = document.querySelector("#app");'
        + ' return (el._vnode && el._vnode.component).setupState; })()';

    await ev(`window.postMessage({ type:'SYNC_SETTINGS', settings:{
        apiUrl:'http://127.0.0.1:${PORT}', apiKey:'k', balancedModel:'m',
        qualityModel:'m', fastModel:'m', model:'m' }}, '*')`);
    await sleep(300);

    await ev(`${S}.pasteText = ${JSON.stringify(NOVEL)}; ${S}.applyPaste(); 1`);
    await sleep(300);

    const shot = async (name) => {
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
        fs.writeFileSync(OUT + name, Buffer.from(data, 'base64'));
        console.log('saved ' + name);
    };

    // 1) 续写设置：页数区间 + 审校大纲开关
    await ev(`(() => {
        const pane = document.querySelector('.col-right .pane-scroll');
        const secs = [...document.querySelectorAll('.col-right details.panel-sec')];
        const save = secs.find(s => s.querySelector('summary').textContent.includes('续写设置'));
        if (save) save.open = true;
        const others = secs.filter(s => s !== save);
        others.forEach(s => { if (!s.querySelector('summary').textContent.includes('前情维护')) s.open = false; });
        pane.scrollTop = save ? save.offsetTop - 12 : 0;
        return 1;
    })()`);
    await sleep(400);
    await shot('new-1-settings.png');

    // 2) 自动写作：剧情弧 + 大纲审校开关
    await ev(`(() => {
        const pane = document.querySelector('.col-right .pane-scroll');
        const secs = [...document.querySelectorAll('.col-right details.panel-sec')];
        secs.forEach(s => { s.open = false; });
        const auto = secs.find(s => s.querySelector('summary').textContent.includes('自动写作'));
        if (auto) { auto.open = true; pane.scrollTop = auto.offsetTop - 12; }
        return 1;
    })()`);
    await sleep(400);
    await shot('new-2-auto.png');

    // 3) 剧情罗盘：先建一次前情
    await ev(`${S}.rebuildState()`, true);
    await sleep(600);
    await ev(`(() => {
        const pane = document.querySelector('.col-right .pane-scroll');
        const secs = [...document.querySelectorAll('.col-right details.panel-sec')];
        secs.forEach(s => { s.open = false; });
        const c = secs.find(s => s.querySelector('summary').textContent.includes('剧情罗盘'));
        if (c) { c.open = true; pane.scrollTop = c.offsetTop - 12; }
        return 1;
    })()`);
    await sleep(400);
    await shot('new-3-compass.png');

    // 4) 大纲审校的意见面板
    await ev(`${S}.runPlan()`, true);
    await sleep(400);
    await ev(`${S}.runOutlineReview()`, true);
    await sleep(500);
    await ev(`(() => {
        const pane = document.querySelector('.col-right .pane-scroll');
        const secs = [...document.querySelectorAll('.col-right details.panel-sec')];
        secs.forEach(s => { s.open = false; });
        const o = secs.find(s => s.querySelector('summary').textContent.includes('本章大纲'));
        if (o) { o.open = true; pane.scrollTop = o.offsetTop - 12; }
        return 1;
    })()`);
    await sleep(400);
    await shot('new-4-review.png');

    ws.close();
    chrome.kill();
    await sleep(300);
    const ps = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '
        + "'" + '*_chrome_shot_' + PROFILE.split('_chrome_shot_')[1] + "*'"
        + ' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    await sleep(700);
    for (let i = 0; i < 6; i += 1) {
        try { fs.rmSync(PROFILE, { recursive: true, force: true }); break; } catch (_) { await sleep(500); }
    }
    console.log('done');
    process.exit(0);
};

main().catch((e) => { console.log('失败：' + e.message); process.exit(1); });
