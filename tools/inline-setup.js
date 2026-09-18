                /* ---------- 独立版：接口设置存在本机浏览器 ---------- */
                // 嵌入 RP Hub 时仍以主应用同步过来的配置为准，同步失败则回退到这里保存的配置
                const standalone = !isEmbedded;
                const API_STORE_KEY = 'RPHubContinueStandaloneApi';
                const apiSetupOpen = ref(false);
                const apiKeyVisible = ref(false);
                const testingApi = ref(false);
                const apiTestResult = ref('');
                const apiDraft = reactive({ url: '', key: '', quality: '', balanced: '', fast: '' });

                const apiHostLabel = computed(() => {
                    const raw = String(api.url || '').trim();
                    if (!raw) return '';
                    try { return new URL(raw).host; } catch (_) { return raw; }
                });

                const persistStandaloneApi = () => {
                    if (!standalone) return;
                    try {
                        window.localStorage.setItem(API_STORE_KEY, JSON.stringify({
                            url: api.url, key: api.key,
                            quality: models.quality, balanced: models.balanced, fast: models.fast,
                            active: activeModelType.value
                        }));
                    } catch (_) { /* 无痕模式下写不进去，不影响本次会话 */ }
                };

                const loadStandaloneApi = () => {
                    let saved = null;
                    try { saved = JSON.parse(window.localStorage.getItem(API_STORE_KEY) || 'null'); }
                    catch (_) { saved = null; }
                    if (!saved || typeof saved !== 'object') return false;
                    api.url = saved.url || '';
                    api.key = saved.key || '';
                    models.quality = saved.quality || '';
                    models.balanced = saved.balanced || '';
                    models.fast = saved.fast || '';
                    if (['quality', 'balanced', 'fast'].includes(saved.active)) activeModelType.value = saved.active;
                    return true;
                };

                const hasStandaloneConfig = loadStandaloneApi();

                const openApiSetup = () => {
                    apiDraft.url = api.url || '';
                    apiDraft.key = api.key || '';
                    apiDraft.quality = models.quality || '';
                    apiDraft.balanced = models.balanced || '';
                    apiDraft.fast = models.fast || '';
                    apiTestResult.value = '';
                    apiKeyVisible.value = false;
                    apiSetupOpen.value = true;
                };

                const saveApiSettings = () => {
                    api.url = String(apiDraft.url || '').trim();
                    api.key = String(apiDraft.key || '').trim();
                    models.quality = String(apiDraft.quality || '').trim();
                    models.balanced = String(apiDraft.balanced || '').trim();
                    models.fast = String(apiDraft.fast || '').trim();
                    // 当前选中的那一档没填时，自动切到第一个有值的档位
                    if (!models[activeModelType.value]) {
                        const first = ['balanced', 'quality', 'fast'].find(key => models[key]);
                        if (first) activeModelType.value = first;
                    }
                    persistStandaloneApi();
                    apiSetupOpen.value = false;
                    showToast(apiReady.value ? '接口设置已保存' : '已保存，但地址 / Key / 模型还没填完', apiReady.value ? 'success' : 'warning');
                };

                const clearApiSettings = () => {
                    api.url = '';
                    api.key = '';
                    models.quality = '';
                    models.balanced = '';
                    models.fast = '';
                    apiDraft.url = '';
                    apiDraft.key = '';
                    apiDraft.quality = '';
                    apiDraft.balanced = '';
                    apiDraft.fast = '';
                    apiTestResult.value = '';
                    try { window.localStorage.removeItem(API_STORE_KEY); } catch (_) { /* 忽略 */ }
                    showToast('已清除本机保存的接口设置', 'success');
                };

                // 下拉里点到还没填模型名的档位，直接引导去设置，而不是切到一个空模型
                const chooseModelSlot = key => {
                    if (!models[key] && standalone) {
                        openApiSetup();
                        showToast(`${modelSlots.find(slot => slot.key === key)?.label || ''}模型还没填`, 'warning');
                        return;
                    }
                    activeModelType.value = key;
                    persistStandaloneApi();
                };

                const testApiConnection = async () => {
                    const url = String(apiDraft.url || '').trim();
                    const key = String(apiDraft.key || '').trim();
                    const model = String(
                        apiDraft[activeModelType.value] || apiDraft.balanced || apiDraft.quality || apiDraft.fast || ''
                    ).trim();
                    if (!url || !key || !model) {
                        apiTestResult.value = '请先填好地址、Key 和至少一个模型名';
                        return;
                    }
                    testingApi.value = true;
                    apiTestResult.value = '';
                    try {
                        const reply = await window.RPHubApiClient.requestChatCompletion({
                            url: window.RPHubApiUtils.buildApiEndpoint(url, 'chat/completions'),
                            apiKey: key,
                            model,
                            messages: [{ role: 'user', content: '你好' }],
                            stream: false,
                            temperature: 0,
                            timeoutMs: 60000
                        });
                        apiTestResult.value = `连接成功（${model}）：${String(reply.content || '').trim().slice(0, 30)}`;
                    } catch (error) {
                        apiTestResult.value = `连接失败：${error.message}`;
                    } finally {
                        testingApi.value = false;
                    }
                };
