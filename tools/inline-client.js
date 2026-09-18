    /* ================= 内置 API 客户端（独立版） =================
       原工程这里从 ../assets/js/api-utils.js 加载 window.RPHubApiUtils /
       window.RPHubApiClient。独立版把本页真正用到的两件事内置实现：
       拼接 OpenAI 兼容端点 + 请求 chat/completions（支持真流式）。
       不再依赖 RP Hub 主项目的任何文件。 */
    (function () {
        const buildApiEndpoint = (baseUrl, path) => {
            const root = String(baseUrl || '').trim().replace(/\/+$/, '');
            if (!root) return '';
            // 已经带 /v1 的地址不再重复拼接
            const apiRoot = /\/v1$/i.test(root) ? root : `${root}/v1`;
            return `${apiRoot}/${String(path || '').replace(/^\/+/, '')}`;
        };

        const STATUS_HINT = {
            400: '请求格式有误',
            401: 'API Key 无效或未授权',
            403: '没有访问权限（可能是地区限制或余额问题）',
            404: '接口地址不存在，检查是否漏了 /v1',
            408: '服务端超时',
            413: '请求体过大',
            422: '参数不被接受（可能是模型名不对）',
            429: '请求过于频繁或额度不足',
            500: '服务端内部错误',
            502: '网关错误',
            503: '服务暂不可用',
            504: '网关超时'
        };

        const messageFromPayload = (payload, status) => {
            let detail = '';
            if (payload) {
                const error = payload.error;
                if (typeof error === 'string') detail = error;
                else if (error && typeof error === 'object') detail = error.message || error.detail || '';
                if (!detail) detail = payload.message || payload.detail || '';
            }
            detail = String(detail || '').trim();
            const hint = STATUS_HINT[status] || '';
            const parts = [];
            if (status) parts.push(`HTTP ${status}${hint ? ` ${hint}` : ''}`);
            if (detail) parts.push(detail);
            return parts.join('：') || '接口返回了无法识别的响应';
        };

        // 有的服务把 content 给成数组（多模态分段），这里统一取纯文本
        const readContent = value => {
            if (Array.isArray(value)) {
                return value.map(part => typeof part === 'string' ? part : (part?.text || '')).join('');
            }
            return typeof value === 'string' ? value : '';
        };

        const readReasoning = message => {
            const raw = message?.reasoning_content ?? message?.reasoning;
            if (typeof raw === 'string') return raw;
            return readContent(raw);
        };

        const requestChatCompletion = async (options = {}) => {
            const { url, apiKey, model, messages, temperature, signal, onDelta } = options;
            const wantsStream = !!options.stream;
            const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10 * 60 * 1000;

            const controller = new AbortController();
            const abort = () => controller.abort();
            if (signal) {
                if (signal.aborted) controller.abort();
                else signal.addEventListener('abort', abort, { once: true });
            }
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

            const cleanup = () => {
                clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', abort);
            };

            const body = { model, messages, stream: wantsStream };
            if (Number.isFinite(temperature)) body.temperature = temperature;
            if (Number.isFinite(options.maxTokens)) body.max_tokens = options.maxTokens;

            let response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: Object.assign(
                        { 'Content-Type': 'application/json' },
                        apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
                    ),
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
            } catch (error) {
                cleanup();
                if (error.name === 'AbortError') {
                    if (timedOut) throw new Error(`接口 ${Math.round(timeoutMs / 60000)} 分钟没有响应，已中断`);
                    throw error;
                }
                throw new Error(`连不上接口（${url}）。检查地址是否写对、服务是否可用、以及是否被浏览器跨域策略拦截。`);
            }

            if (!response.ok) {
                const rawText = await response.text().catch(() => '');
                cleanup();
                let payload = null;
                try { payload = JSON.parse(rawText); } catch (_) { /* 错误体可能不是 JSON */ }
                throw new Error(messageFromPayload(payload, response.status));
            }

            let content = '';
            let reasoning = '';
            let finishReason = null;
            const contentType = response.headers.get('content-type') || '';
            const isEventStream = contentType.includes('text/event-stream');

            if (wantsStream && isEventStream && response.body && typeof response.body.getReader === 'function') {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                const handleLine = line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith(':')) return;          // 心跳 / 注释
                    if (!trimmed.startsWith('data:')) return;
                    const data = trimmed.slice(5).trim();
                    if (!data || data === '[DONE]') return;
                    let payload = null;
                    try { payload = JSON.parse(data); } catch (_) { return; }
                    const choice = payload.choices?.[0];
                    if (!choice) return;
                    const delta = choice.delta || choice.message || {};
                    const think = readReasoning(delta);
                    if (think) reasoning += think;
                    const piece = readContent(delta.content);
                    if (piece) {
                        content += piece;
                        onDelta?.({ content: piece, reasoning: think });
                    }
                    if (choice.finish_reason) finishReason = choice.finish_reason;
                };

                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split(/\r\n|\n|\r/);
                        buffer = lines.pop() ?? '';
                        for (const line of lines) handleLine(line);
                    }
                    buffer += decoder.decode();
                    if (buffer) handleLine(buffer);
                } finally {
                    try { reader.releaseLock(); } catch (_) { /* 已释放 */ }
                    cleanup();
                }
            } else {
                // 非流式，或服务忽略了 stream 参数直接返回整包 JSON
                const rawText = await response.text().catch(() => '');
                cleanup();
                let payload = null;
                try { payload = JSON.parse(rawText); } catch (_) {
                    throw new Error('接口返回的不是合法 JSON，确认地址指向 OpenAI 兼容的 /v1/chat/completions');
                }
                if (payload.error) throw new Error(messageFromPayload(payload, response.status));
                const choice = payload.choices?.[0];
                if (!choice) throw new Error('接口没有返回任何回复内容');
                const message = choice.message || choice.delta || {};
                content = readContent(message.content) || readContent(choice.text);
                reasoning = readReasoning(message);
                finishReason = choice.finish_reason || null;
            }

            if (!content.trim()) {
                throw new Error('接口没有返回正文内容（可能是模型名写错、触发了内容过滤，或额度已用尽）');
            }
            return { content, reasoning, finishReason, isStream: wantsStream };
        };

        window.RPHubApiUtils = Object.freeze({ buildApiEndpoint });
        window.RPHubApiClient = Object.freeze({ requestChatCompletion });
    })();
