// Mock OpenAI 兼容 API + 静态服务器
// 静态根：先找独立版所在的产出目录，再回落到 RP-Hub 项目根（照旧能取 ../assets/js/*.js）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOTS = [
    // 仓库根：独立版单文件就在这，standalone 测试走它
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    // 上游项目根：跑上游回归测试时需要，用 UPSTREAM_ROOT 覆盖
    process.env.UPSTREAM_ROOT || 'E:/claude/RP-Hub-1.8.9 - 副本'
];
const PORT = 8791;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8'
};

/* ---------------- 可控场景 ---------------- */
const DEFAULTS = {
    // 罗盘：停滞风险 与 最近推进
    stateRisk: '低',
    stateEvents: ['主角在渡口拿到半枚玉佩', '与船老大起了争执'],
    stateMotif: '查清父亲当年的死因',
    // 输出中文逗号 + 尾逗号的脏 JSON，验证解析容错
    sloppyJson: false,
    // 写作：每章正文完全一样 -> 触发「文本高度重合」兜底；lastWrite 常量也可单独控制
    repeatWrite: false,
    writeParagraphs: 14,
    chunkSize: 40,
    chunkDelay: 6
};
const config = { ...DEFAULTS };
let writeCount = 0;
const calls = [];

const compassBlockText = () => {
    const compass = {
        '主线目标': config.stateMotif,
        '当前阶段': '初入江湖，线索刚露头',
        '最近推进': config.stateEvents,
        '已用过的场景': ['渡口夜谈', '客栈争执', '雨夜赶路'],
        '未回收伏笔': ['半枚玉佩的来历（埋于 第1章）', '父亲旧友的口信（埋于 第2章）'],
        '人物设定': ['沈砚｜主角｜寡言执拗｜短句、少用语气词｜武艺平平，怕水',
            '老周｜船老大｜圆滑热心｜爱说笑，称呼主角「小沈」｜熟悉水路，不会武功'],
        '下章必须推进': ['让主角拿到玉佩的另一半的去向', '把时间推进到次日，离开渡口'],
        '停滞风险': config.stateRisk,
        '停滞说明': config.stateRisk === '高' ? '本章只是在渡口反复争执，没有任何新信息' : '无'
    };
    let raw = JSON.stringify(compass);
    if (config.sloppyJson) {
        // 模拟模型常见的手抖：中文逗号当分隔符、结尾多一个逗号
        raw = raw.replace(/"\s*,\s*"/g, '"，"')
            .replace(/\]\s*,\s*"/g, ']，"')
            .replace(/}\]/, ']，}')
            .replace(/\}$/, ',}');
    }
    return '===剧情罗盘===\n' + raw + '\n===剧情罗盘结束===\n';
};

const STATE_BODY = `## 一、故事进度
主线走到主角刚离开家乡、在渡口落脚。

## 二、主要人物现状
沈砚：主角，正在渡口等船；目标是查清父亲死因。
老周：船老大，与主角同船，知道一些旧事。

## 三、当前场景
深夜，渡口茶棚，沈砚与老周对坐。

## 四、未解决的冲突与悬念
半枚玉佩的来历无人肯说。

## 五、待回收伏笔
半枚玉佩；父亲旧友的口信。

## 六、世界规则与设定要点
民国初年，水路货运，江湖规矩森严。

## 七、下一步最自然的发展方向
1. 主角上船，沿水路北上。
2. 有人主动找上门透露旧事。`;

// 每章从互不重叠的句池里取，保证「章节之间」文本重合率低
// （repeatWrite=true 时才返回同一段文字，专门用来验证重合检测）
const POOL = [
    '天刚蒙蒙亮，河面上还浮着一层薄雾，对岸的灯火被水汽泡开，成了一团模糊的红。',
    '船板被踩得咯吱响，一块木条翘起来，险些绊倒刚上船的行脚商人。',
    '老周把缆绳在木桩上绕了三圈，手腕一翻，打了个漂亮的活结。',
    '沈砚蹲在船舷边洗脸，水凉得刺骨，他打了个寒噤，把水珠甩进河里。',
    '远处传来一阵铃铛声，是卖豆腐的老汉推着独轮车经过堤岸。',
    '船舱里堆着半舱的麻袋，散出一股陈年的霉味和咸鱼味道。',
    '有人在后舱低声说话，声音压得很实，听不清字句，只能听出是两个人在争执。',
    '一只白鹭从芦苇丛里惊起来，扑棱着翅膀贴着水面飞远了。',
    '太阳爬到桅杆顶上的时候，水面开始发亮，像撒了一层碎银子。',
    '沈砚把那半枚玉佩捏在掌心，指腹顺着缺口来回摩梭，玉面被摸得发烫。',
    '船过了一道浅滩，船底刮着河泥，发出沉闷的摩擦声。',
    '老周从灶上端了一碗热汤过来，汤面上漂着几片葱花，热气糊了沈砚一脸。',
    '对面来船上的汉子朝这边拱了拱手，老周也拱手还了，两人谁都没说话。',
    '风转了个方向，帆布鼓起来，船身向右侧倾了一下，桌上的碗滑出去半寸。',
    '沈砚问了一句关于旧年的事，老周的手停在半空，随即又若无其事地放下。',
    '岸边有人在烧纸，青烟直直往上升，被风一扯，散成一缕一缕。',
    '一只猫从麻袋堆上跳下来，落地时悄没声息，绿眼睛在暗处亮了一下。',
    '船头的浪把水花溅上来，打湿了沈砚半截袖子，他没有挪地方。',
    '有人在唱一支小调，调子走了形，唱到一半自己笑了，索性不唱了。',
    '日头偏西，河面从银白变成金红，两岸的树影被拉得又细又长。',
    '沈砚数了数包袱里的干粮，还剩三块饼，够吃到下一个码头。',
    '老周蹲在船尾补一处破洞，针脚又密又匀，看得出做惯了这种活。',
    '水面漂过来一截断桨，打着旋儿，撞在船舷上，又被水带走了。',
    '有个孩子在岸上追着船跑，跑出十几步就停下了，冲这边挥了挥手。',
    '船靠在一处荒渡，岸上只有一间塌了半边的土地庙，香炉里插着三根熄了的香。',
    '沈砚下船去庙里看了看，供桌上落满灰，只有一只碗是干净的。',
    '老周说这庙三年前就没人管了，说话时眼神往别处飘。',
    '重新上船的时候，沈砚发现自己的包袱被人动过，绳结换了方向。',
    '他没有声张，把包袱重新系好，坐到原来的位置上，闭上了眼睛。',
    '夜色沉下来，河面黑得像一块铁，只有船头挂的灯照出一小圈黄。',
    '远处有船点起了灯，一盏两盏，像是有人在河上撒了一把星子。',
    '沈砚睁开眼，盯着那几盏灯看了很久，直到它们一盏一盏全都灭了。',
    '夜里起了风，浪拍在船板上，一声接着一声，听得人心里发紧。',
    '老周把灯芯剪短了些，屋里一下子暗下来，只剩两点火光。',
    '有人在梦里说了句什么，含混不清，随即翻了个身，木板响了一声。',
    '天快亮时下了雾，比昨天更浓，船舷贴着船舷都看不清人影。',
    '雾里传来橹声，一下一下，很慢，是从上游来的方向。',
    '沈砚站起来，扶着桅杆往声音那边看，除了白茫茫什么都看不见。',
    '那橹声在离船很近的地方停了，停了很久，久到让人心里发毛。',
    '老周的手按在篙上，指节发白，嘴里却还在哼那支不成调的小曲。',
    '雾散的时候，那条船已经不见了，水面上只留下一道正在合拢的波纹。',
    '沈砚问那是什么船，老周说不知道，说完就去灶上生火，背对着他。',
    '早饭是一碗稀粥，沈砚没吃几口就放下了，胃里堵得慌。',
    '他把玉佩掏出来对着光看，缺口的边缘有一道极细的刻痕，昨天没有注意到。',
    '那道刻痕像是一个字的一半，剩下的部分留在另外半枚上。',
    '午饭过后，船拐进一条支流，水面窄了一半，两岸的树把天遮住了大半。',
    '支流的水很静，船走过去，船尾的波纹一直荡到岸边的水草里。',
    '沈砚忽然明白过来，老周昨天夜里没有睡，一直坐在船头。'
];

const chapterText = (n) => {
    if (config.repeatWrite) {
        return [
            '雨还在下。沈砚把斗笠往下压了压，站在渡口的木板上，一动不动。',
            '老周从茶棚里探出头来，喊他进去躲雨。他没有动。',
            '「你到底等什么？」老周问。他还是没有动，只是看着河面。',
            '河面上一片漆黑，只有远处一盏灯，晃了晃，又灭了。',
            '老周叹了口气，转身回屋，把门带上了。木板发出一声轻响。',
            '沈砚站了很久。雨顺着斗笠的边沿滴下来，落在他脚边的木板上。',
            '他摸了摸怀里的那半枚玉佩，凉的。他什么也没想。',
            '直到天快亮的时候，他才转身，走进了茶棚。'
        ].join('\n\n');
    }
    const count = config.writeParagraphs;
    const parts = [];
    for (let i = 0; i < count; i += 1) {
        // 按全局写入序号取句，章节之间完全不重叠
        const idx = ((n - 1) * count + i) % POOL.length;
        parts.push(POOL[idx]);
    }
    return parts.join('\n\n');
};

const route = (systemText) => {
    const table = [
        ['style', '资深中文小说编辑与文体分析师'],
        ['state-update', '下面给你一份【已有前情档案】'],
        ['state-full', '产出一份供'],
        ['arc', '也是自己的责编'],
        ['outline-review', '负责在作者动笔之前审掉一份章纲'],
        ['outline', '正在给自己即将写的一章打腹稿'],
        ['write', '正在继续写你自己的书'],
        ['verify', '你是最挑剔的文学编辑'],
        ['summarize', '请把给定的小说片段压缩成客观的剧情提要']
    ];
    for (const [kind, marker] of table) {
        if (systemText.includes(marker)) return kind;
    }
    return 'unknown';
};

const replyFor = (kind, userText) => {
    switch (kind) {
        case 'style':
            return '## 一、叙事视角与叙述距离\n第三人称限知视角，紧贴主角，不进入他人内心。\n\n## 二、语言基调与语体\n偏书面，短句为主。';
        case 'state-full':
            return STATE_BODY + '\n\n' + compassBlockText();
        case 'state-update':
            return STATE_BODY.replace('深夜，渡口茶棚', '清晨，渡口茶棚') + '\n\n' + compassBlockText();
        case 'summarize':
            return '这里是分段摘要。';
        case 'outline':
            return '【原始大纲】章节功能：推进主线。出场人物：沈砚、老周。\n事件节拍：1) 上船 2) 遇到盘查 3) 解决 4) 收束';
        case 'outline-review':
            return '## 判定\n需修改\n\n## 问题\n- 问题一：与前一章的时间线冲突\n- 问题二：老周的说话方式不符合人物设定\n- 问题三：事件量撑不住 6 页\n\n'
                + '## 优化后的大纲\n【优化后的大纲正文】章节功能：把主角从渡口推出去。出场人物：沈砚、老周、船上的陌生客。\n'
                + '事件节拍：1) 清晨上船 2) 陌生客搭话并露出玉佩的另半边 3) 沈砚追问被挡住 4) 靠岸前陌生客消失 5) 收束在沈砚握紧玉佩';
        case 'arc':
            return '## 弧线总览\n从渡口出发，到主角确认玉佩的另半边存在为止，中途的转折放在第 2 章，铺垫在第 1 章。\n\n'
                + '## 分章节拍\n第 1 章 · 起 · 本章必须推进：上船并遇到陌生客 · 章末应达到的状态：主角意识到有人认得玉佩\n'
                + '第 2 章 · 承 · 本章必须推进：陌生客露出另半边玉佩 · 章末应达到的状态：转折发生，主角决定改道\n'
                + '第 3 章 · 合 · 本章必须推进：主角改道北上 · 章末应达到的状态：主线进入新阶段\n\n'
                + '===剧情弧===\n'
                + JSON.stringify([
                    { '章': 1, '定位': '起', '必须推进': '上船并遇到陌生客', '收尾状态': '主角意识到有人认得玉佩' },
                    { '章': 2, '定位': '承', '必须推进': '陌生客露出另半边玉佩', '收尾状态': '转折发生，主角决定改道' },
                    { '章': 3, '定位': '合', '必须推进': '主角改道北上', '收尾状态': '主线进入新阶段' }
                ]) + '\n===剧情弧结束===\n';
        case 'verify': {
            const at = userText.indexOf('【待审查的续写稿】');
            let draft = '';
            if (at > -1) {
                draft = userText.slice(at + '【待审查的续写稿】'.length);
                draft = draft.replace(/\n\n请审查并给出结果。\s*$/, '').trim();
            }
            return '## 总体贴合度\n95%，整体贴合原作节奏。\n\n## 严重问题\n无\n\n## 轻微偏差\n无\n\n## 修正稿\n' + draft;
        }
        case 'write': {
            writeCount += 1;
            return { stream: chapterText(writeCount) };
        }
        default:
            return '（mock 未识别的调用）';
    }
};

/* ---------------- HTTP ---------------- */
const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(raw));
});

const cors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    cors(res);

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    /* --- 测试控制面 --- */
    if (parsed.pathname === '/__config') {
        if (parsed.query.set) {
            try { Object.assign(config, JSON.parse(parsed.query.set)); } catch (_) { }
        }
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify(config));
        return;
    }
    if (parsed.pathname === '/__calls') {
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify(calls));
        return;
    }
    if (parsed.pathname === '/__reset') {
        calls.length = 0;
        writeCount = 0;
        // 连同 config 一起复位，否则上一轮改过的参数会残留，同一测试两次跑出不同结果
        Object.assign(config, DEFAULTS);
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end('{"ok":true}');
        return;
    }

    /* --- Mock chat completions --- */
    if (parsed.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const raw = await readBody(req);
        if (config.forceStatus) {
            res.writeHead(config.forceStatus, { 'Content-Type': MIME['.json'] });
            res.end(JSON.stringify({ error: { message: config.forceMessage || 'mock 注入的错误' } }));
            return;
        }
        const body = JSON.parse(raw || '{}');
        const messages = body.messages || [];
        const systemText = messages.filter(m => m.role === 'system').map(m => m.content || '').join('\n');
        const userText = messages.filter(m => m.role === 'user').map(m => m.content || '').join('\n');
        const kind = route(systemText);
        calls.push({
            kind,
            stream: !!body.stream,
            system: systemText.slice(0, 120),
            user: userText
        });

        const reply = replyFor(kind, userText);

        if (reply && typeof reply === 'object' && reply.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            const text = reply.stream;
            for (let i = 0; i < text.length; i += config.chunkSize) {
                const piece = text.slice(i, i + config.chunkSize);
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
                await new Promise(r => setTimeout(r, config.chunkDelay));
            }
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        const payload = {
            id: 'mock-' + Date.now(),
            object: 'chat.completion',
            model: body.model || 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: String(reply || '') }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        };
        await new Promise(r => setTimeout(r, 40));
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify(payload));
        return;
    }

    /* --- 静态文件 --- */
    const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '') || 'index.html';
    let served = null;
    for (const root of ROOTS) {
        const target = path.join(root, rel);
        const resolved = path.resolve(target);
        if (!resolved.startsWith(path.resolve(root))) continue;
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) { served = resolved; break; }
    }
    if (!served) { res.writeHead(404); res.end('not found'); return; }
    fs.readFile(served, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(served).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`mock+static on http://127.0.0.1:${PORT}`);
});
