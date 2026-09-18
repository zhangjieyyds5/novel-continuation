/* 把本仓库的全部文件发布到 GitHub（纯 REST，只走 api.github.com）
 *
 * 为什么不用 git push / gh：
 *   在部分网络环境下 github.com:443 会被拦截（DNS 污染到不可达 IP），
 *   而 api.github.com 通常仍可正常访问。本脚本只用 REST API 完成
 *   建仓 → 上传 → 元信息 → Pages，完全绕开 github.com。
 *
 * 用法：
 *   1. 把 Personal Access Token（经典 token，勾选 repo）写到仓库根目录的
 *      .gh-token 或 .gh-token.txt（该文件已在 .gitignore 中，不会入库）。
 *      也可以用环境变量 GH_TOKEN。
 *   2. node tools/publish.mjs                 # 提交信息取本地 git HEAD 的主题
 *      node tools/publish.mjs -m "自定义提交信息"
 *
 * 该脚本是幂等的：仓库已存在则覆盖内容，Pages 已开启则更新。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILES = ['.gh-token', '.gh-token.txt'];

const REPO_NAME = process.env.REPO_NAME || 'novel-continuation';
const DESC = '单文件、零依赖的长篇小说 AI 续写工作台 —— 读懂原作文风与前情，带剧情罗盘、大纲审校与防停滞机制。本仓库代码均由 AI 生成，仅供学习交流。';
const TOPICS = ['novel', 'ai-writing', 'llm', 'writing-tool', 'single-file', 'vue3', 'tailwindcss', 'chinese', 'openai-compatible', 'ai-generated'];

/* 占位符回填：README / LICENSE / index.html 里的 __OWNER__ 会被换成真实用户名 */
const BACKFILL = ['README.md', 'LICENSE', 'index.html'];

/* ---------- token ---------- */
const tokenPath = TOKEN_FILES.map((n) => path.join(REPO_DIR, n)).find((f) => fs.existsSync(f));
const token = (process.env.GH_TOKEN || '').trim()
    || (tokenPath ? fs.readFileSync(tokenPath, 'utf8').trim() : '');
if (!token) {
    console.error('缺少 token。把 PAT 写到 ' + TOKEN_FILES.join(' 或 ') + '（仓库根目录），或设置 GH_TOKEN。');
    process.exit(1);
}

const API = 'https://api.github.com';
const call = async (method, url, body) => {
    const res = await fetch(url.startsWith('http') ? url : API + url, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'novel-continuation-publisher',
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
        const msg = data && data.message ? data.message : String(data).slice(0, 200);
        const err = new Error(`${method} ${url} → ${res.status} ${msg}`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
};

/* ---------- 提交信息 ---------- */
const argv = process.argv.slice(2);
const mi = argv.findIndex((a) => a === '-m' || a === '--message');
let commitMessage = mi >= 0 ? argv[mi + 1] : '';
if (!commitMessage) {
    try {
        commitMessage = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: REPO_DIR, encoding: 'utf8' }).trim();
    } catch { /* 没有本地 git 也不要紧 */ }
}
if (!commitMessage) commitMessage = 'sync: 更新仓库内容';

/* ---------- 0. 探路 ---------- */
const me = await call('GET', '/user');
const OWNER = me.login;
console.log(`✓ 已登录：${OWNER}`);

/* ---------- 1. 回填 __OWNER__ ---------- */
let touched = 0;
for (const rel of BACKFILL) {
    const f = path.join(REPO_DIR, rel);
    if (!fs.existsSync(f)) continue;
    const t = fs.readFileSync(f, 'utf8');
    if (!t.includes('__OWNER__')) continue;
    fs.writeFileSync(f, t.split('__OWNER__').join(OWNER), 'utf8');
    touched += 1;
}
console.log(`✓ 回填 __OWNER__ → ${OWNER}（${touched} 个文件）`);

/* ---------- 2. 建仓 ---------- */
try {
    await call('POST', '/user/repos', {
        name: REPO_NAME,
        description: DESC,
        homepage: `https://${OWNER}.github.io/${REPO_NAME}/`,
        private: false,
        has_issues: true,
        has_wiki: false,
        has_projects: false,
        auto_init: false
    });
    console.log(`✓ 仓库已创建：${OWNER}/${REPO_NAME}（公开）`);
} catch (error) {
    if (error.status === 422) {
        console.log(`· 仓库 ${OWNER}/${REPO_NAME} 已存在，覆盖内容`);
    } else if (error.status === 403) {
        console.error(`✗ 建仓被拒（403）：${error.data && error.data.message}`);
        console.error('  token 需要「创建仓库 + 读写仓库内容」权限，经典 token 请勾选 repo。');
        process.exit(1);
    } else throw error;
}

/* ---------- 3. 收集文件 ---------- */
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SKIP_FILES = new Set([...TOKEN_FILES, '.env']);
const SKIP_EXT = new Set(['.log']);
const files = [];
const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') && e.name !== '.gitignore') continue; // 隐藏文件一律不上传
        const full = path.join(dir, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, rel); continue; }
        if (SKIP_FILES.has(e.name) || SKIP_EXT.has(path.extname(e.name))) continue;
        files.push({ rel, full });
    }
};
walk(REPO_DIR, '');
files.sort((a, b) => a.rel.localeCompare(b.rel));
console.log(`✓ 待上传 ${files.length} 个文件`);

/* ---------- 4. 空仓库不能调 Git Data API：先用 Contents API 建出 main ---------- */
let parentSha = null;
try {
    const ref = await call('GET', `/repos/${OWNER}/${REPO_NAME}/git/ref/heads/main`);
    parentSha = ref.object.sha;
    console.log('· main 已存在，本次为覆盖更新');
} catch {
    console.log('· 仓库为空 → 先落种子提交（否则 blobs/trees 会 409 Git Repository is empty）');
    const seed = fs.readFileSync(path.join(REPO_DIR, '.gitignore'));
    await call('PUT', `/repos/${OWNER}/${REPO_NAME}/contents/.gitignore`, {
        message: 'chore: 初始化仓库',
        content: seed.toString('base64'),
        branch: 'main'
    });
    console.log('✓ main 分支已建立');
}

/* ---------- 5. blobs → tree → commit → ref ---------- */
const tree = [];
for (const f of files) {
    const blob = await call('POST', `/repos/${OWNER}/${REPO_NAME}/git/blobs`, {
        content: fs.readFileSync(f.full).toString('base64'),
        encoding: 'base64'
    });
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`  ↑ ${f.rel}`);
}

const newTree = await call('POST', `/repos/${OWNER}/${REPO_NAME}/git/trees`, { tree });
const commit = await call('POST', `/repos/${OWNER}/${REPO_NAME}/git/commits`, {
    message: commitMessage,
    tree: newTree.sha,
    parents: parentSha ? [parentSha] : []
});
/* 新仓库时 force 覆盖，让种子提交不可达，得到干净的单一提交历史 */
await call('PATCH', `/repos/${OWNER}/${REPO_NAME}/git/refs/heads/main`, { sha: commit.sha, force: true });
console.log(`✓ 已提交：${commit.sha.slice(0, 7)}`);

/* ---------- 6. 仓库元信息 ---------- */
await call('PATCH', `/repos/${OWNER}/${REPO_NAME}`, {
    description: DESC,
    homepage: `https://${OWNER}.github.io/${REPO_NAME}/`,
    has_issues: true,
    has_wiki: false
});
await call('PUT', `/repos/${OWNER}/${REPO_NAME}/topics`, { names: TOPICS });
console.log('✓ 简介 / 主页 / 话题已设置');

/* ---------- 7. GitHub Pages ---------- */
let pagesUrl = `https://${OWNER}.github.io/${REPO_NAME}/`;
try {
    try {
        await call('POST', `/repos/${OWNER}/${REPO_NAME}/pages`, { source: { branch: 'main', path: '/' } });
        console.log('✓ GitHub Pages 已开启');
    } catch (e) {
        if (e.status === 409) {
            await call('PUT', `/repos/${OWNER}/${REPO_NAME}/pages`, { source: { branch: 'main', path: '/' } });
            console.log('✓ GitHub Pages 已更新');
        } else if (e.status === 422) {
            console.log('· Pages 开启被拒（可能需在网页端首次确认），跳过');
        } else throw e;
    }
    const info = await call('GET', `/repos/${OWNER}/${REPO_NAME}/pages`);
    if (info && info.html_url) pagesUrl = info.html_url;
} catch (e) {
    console.log(`· Pages 未开启：${e.message}`);
}

console.log('\n===== 完成 =====');
console.log(`仓库：https://github.com/${OWNER}/${REPO_NAME}`);
console.log(`在线版：${pagesUrl}`);
