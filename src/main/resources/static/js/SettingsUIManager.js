/**
 * @file SettingsUIManager.js
 * @description 设置 UI 管理器，负责处理主菜单/设置模态框内的所有 UI 元素和交互逻辑。
 *              AI 配置现在优先从 localStorage 加载。主题切换现在无刷新。
 *              修复了切换配色方案后，主题选择器点击事件处理不当的问题。
 * @module SettingsUIManager
 * @exports {object} SettingsUIManager - 对外暴露的单例对象，包含所有设置 UI 管理方法。
 * @property {function} init - 初始化模块，获取 DOM 元素、加载设置并绑定事件。
 * @property {function} loadAISettings - 从 localStorage 加载 AI 相关设置并填充到输入框。
 * @property {function} saveAISetting - 保存单个 AI 设置到 localStorage 并触发事件。
 * @property {function} initThemeSelectors - 初始化主题和配色方案的自定义下拉选择器。
 * @property {function} updateNetworkInfoDisplay - 更新模态框中的网络状态信息。
 * @dependencies UserManager, ConnectionManager, ChatManager, ThemeLoader, NotificationManager, Utils, AppInitializer, ModalManager, EventEmitter, Config
 * @dependents AppInitializer (进行初始化)
 */
const SettingsUIManager = {
    // 主题和配色方案选择器元素
    colorSchemeSelectedValueEl: null,
    colorSchemeOptionsContainerEl: null,
    themeSelectedValueEl: null,
    themeOptionsContainerEl: null,

    // AI 设置输入元素
    apiEndpointInput: null,
    apiKeyInput: null,
    apiModelInput: null,
    apiMaxTokensInput: null,
    ttsApiEndpointInput: null,

    autoConnectToggle: null,
    modalCopyIdBtn: null,
    checkNetworkBtnModal: null,
    modalUserIdValue: null,

    // 存储绑定的事件处理函数，以便正确移除
    _boundHandleThemeSelectorClick: null,
    _boundHandleColorSchemeSelectorClick: null,


    /**
     * 初始化设置 UI 管理器，获取元素、加载设置并绑定事件。
     */
    init: function() {
        // AI 和 TTS 配置输入元素
        this.apiEndpointInput = document.getElementById('apiEndpointInput');
        this.apiKeyInput = document.getElementById('apiKeyInput');
        this.apiModelInput = document.getElementById('apiModelInput');
        this.apiMaxTokensInput = document.getElementById('apiMaxTokensInput');
        this.ttsApiEndpointInput = document.getElementById('ttsApiEndpointInput');

        this.autoConnectToggle = document.getElementById('autoConnectToggle');
        this.modalCopyIdBtn = document.getElementById('modalCopyIdBtn');
        this.checkNetworkBtnModal = document.getElementById('checkNetworkBtnModal');
        this.modalUserIdValue = document.getElementById('modalUserIdValue');

        // 主题和配色方案选择器元素
        this.colorSchemeSelectedValueEl = document.getElementById('colorSchemeSelectedValue');
        this.colorSchemeOptionsContainerEl = document.getElementById('colorSchemeOptionsContainer');
        this.themeSelectedValueEl = document.getElementById('themeSelectedValue');
        this.themeOptionsContainerEl = document.getElementById('themeOptionsContainer');

        this.loadAISettings();
        this.bindEvents();
        this.initThemeSelectors();
    },

    /**
     * 绑定设置模态框内的所有 UI 事件监听器。
     */
    bindEvents: function() {
        if (this.apiEndpointInput) this.apiEndpointInput.addEventListener('blur', () => this.saveAISetting('apiEndpoint', this.apiEndpointInput.value));
        if (this.apiKeyInput) this.apiKeyInput.addEventListener('blur', () => this.saveAISetting('api_key', this.apiKeyInput.value));
        if (this.apiModelInput) this.apiModelInput.addEventListener('blur', () => this.saveAISetting('model', this.apiModelInput.value));
        if (this.apiMaxTokensInput) this.apiMaxTokensInput.addEventListener('blur', () => {
            const val = parseInt(this.apiMaxTokensInput.value, 10);
            const serverConfig = (typeof window.Config !== 'undefined' && window.Config && window.Config.server) ? window.Config.server : {};
            const configMaxTokens = serverConfig.max_tokens !== undefined ? serverConfig.max_tokens : 2048;
            this.saveAISetting('max_tokens', isNaN(val) ? configMaxTokens : val);
        });
        if (this.ttsApiEndpointInput) this.ttsApiEndpointInput.addEventListener('blur', () => this.saveAISetting('ttsApiEndpoint', this.ttsApiEndpointInput.value));

        // --- 偏好设置 ---
        // if (this.autoConnectToggle) {
        //     this.autoConnectToggle.addEventListener('change', (event) => {
        //         if (UserManager.userSettings) {
        //             UserManager.updateUserSetting('autoConnectEnabled', event.target.checked);
        //             if (event.target.checked) {
        //                 NotificationManager.showNotification('自动连接已启用。将在下次应用启动或成功连接信令服务器时尝试连接。', 'info');
        //                 if (ConnectionManager.isWebSocketConnected && ConnectionManager.websocket?.readyState === WebSocket.OPEN) {
        //                     ConnectionManager.autoConnectToAllContacts();
        //                 }
        //             } else {
        //                 NotificationManager.showNotification('自动连接已禁用。', 'info');
        //             }
        //         }
        //     });
        // }

        // --- 网络状态 ---
        if (this.checkNetworkBtnModal) this.checkNetworkBtnModal.addEventListener('click', async () => {
            if (this.checkNetworkBtnModal.disabled) {
                NotificationManager.showNotification('当前已连接到信令服务器。', 'info');
                return;
            }
            NotificationManager.showNotification('正在重新检查网络并尝试连接...', 'info');
            await AppInitializer.refreshNetworkStatusUI();
            if (!ConnectionManager.isWebSocketConnected) {
                ConnectionManager.connectWebSocket().catch(err => {
                    NotificationManager.showNotification('重新建立信令连接失败。', 'error');
                    Utils.log(`手动重新检查网络: connectWebSocket 失败: ${err.message || err}`, Utils.logLevels.ERROR);
                });
            }
        });

        // --- 用户 ID 和 SDP 复制 ---
        if (this.modalCopyIdBtn) this.modalCopyIdBtn.addEventListener('click', () => {
            if (this.modalCopyIdBtn.disabled) return;
            this.copyUserIdFromModal();
        });
        const modalCopySdpBtn = document.getElementById('modalCopySdpBtn');
        if(modalCopySdpBtn) modalCopySdpBtn.addEventListener('click', () => this.copySdpTextFromModal());

        // --- 操作区域 ---
        const modalResetAllConnectionsBtn = document.getElementById('modalResetAllConnectionsBtn');
        if (modalResetAllConnectionsBtn) modalResetAllConnectionsBtn.addEventListener('click', () => ConnectionManager.resetAllConnections());

        const modalClearContactsBtn = document.getElementById('modalClearContactsBtn');
        if (modalClearContactsBtn) modalClearContactsBtn.addEventListener('click', () => UserManager.clearAllContacts());

        const modalClearAllChatsBtn = document.getElementById('modalClearAllChatsBtn');
        if (modalClearAllChatsBtn) modalClearAllChatsBtn.addEventListener('click', () => ChatManager.clearAllChats());

        // --- 可折叠部分 ---
        const collapsibleHeaders = document.querySelectorAll('#mainMenuModal .settings-section .collapsible-header');
        collapsibleHeaders.forEach(header => {
            header.addEventListener('click', function() {
                this.classList.toggle('active');
                const content = this.nextElementSibling;
                const icon = this.querySelector('.collapse-icon');
                if (content && content.classList.contains('collapsible-content')) {
                    if (content.style.display === 'block' || content.style.display === '') {
                        content.style.display = 'none';
                        if (icon) icon.textContent = '▶';
                    } else {
                        content.style.display = 'block';
                        if (icon) icon.textContent = '▼';
                    }
                }
            });
            const content = header.nextElementSibling;
            const icon = header.querySelector('.collapse-icon');
            if (content && content.classList.contains('collapsible-content') && icon) {
                if (content.style.display === 'none') icon.textContent = '▶'; else icon.textContent = '▼';
            }
        });

        // --- 全局点击监听器，用于关闭自定义下拉菜单 ---
        document.addEventListener('click', (e) => {
            const themeCustomSelect = document.getElementById('themeCustomSelectContainer');
            if (this.themeOptionsContainerEl && themeCustomSelect && !themeCustomSelect.contains(e.target)) {
                this.themeOptionsContainerEl.style.display = 'none';
            }
            const colorSchemeCustomSelect = document.getElementById('colorSchemeCustomSelectContainer');
            if (this.colorSchemeOptionsContainerEl && colorSchemeCustomSelect && !colorSchemeCustomSelect.contains(e.target)) {
                this.colorSchemeOptionsContainerEl.style.display = 'none';
            }
        });
    },

    /**
     * @private
     * 处理主题选择器触发元素的点击事件，用于展开/折叠选项。
     * @param {Event} event - 点击事件对象。
     */
    _handleThemeSelectorClick: function(event) {
        event.stopPropagation();
        const currentDisplayState = this.themeOptionsContainerEl.style.display;
        // 关闭其他所有自定义下拉框
        document.querySelectorAll('.custom-select .options').forEach(opt => {
            if (opt !== this.themeOptionsContainerEl) opt.style.display = 'none';
        });
        this.themeOptionsContainerEl.style.display = currentDisplayState === 'block' ? 'none' : 'block';
    },

    /**
     * @private
     * 处理配色方案选择器触发元素的点击事件，用于展开/折叠选项。
     * @param {Event} event - 点击事件对象。
     */
    _handleColorSchemeSelectorClick: function(event) {
        event.stopPropagation();
        const currentDisplayState = this.colorSchemeOptionsContainerEl.style.display;
        // 关闭其他所有自定义下拉框
        document.querySelectorAll('.custom-select .options').forEach(opt => {
            if (opt !== this.colorSchemeOptionsContainerEl) opt.style.display = 'none';
        });
        this.colorSchemeOptionsContainerEl.style.display = currentDisplayState === 'block' ? 'none' : 'block';
    },


    /**
     * 初始化主题和配色方案的自定义下拉选择器。
     */
    initThemeSelectors: function() {
        this._populateColorSchemeSelector();
        this._populateThemeSelectorWithOptions();
    },

    /**
     * @private 填充配色方案选择器的选项。
     *          修改为调用 ThemeLoader.applyTheme() 无刷新切换。
     */
    _populateColorSchemeSelector: function() {
        if (!this.colorSchemeSelectedValueEl || !this.colorSchemeOptionsContainerEl || typeof ThemeLoader === 'undefined') return;

        const schemes = { 'auto': '自动 (浏览器)', 'light': '浅色模式', 'dark': '深色模式' };
        const currentPreferredScheme = localStorage.getItem(ThemeLoader.COLOR_SCHEME_KEY) || ThemeLoader.DEFAULT_COLOR_SCHEME;

        this.colorSchemeSelectedValueEl.textContent = schemes[currentPreferredScheme];
        this.colorSchemeOptionsContainerEl.innerHTML = '';

        for (const key in schemes) {
            const optionDiv = document.createElement('div');
            optionDiv.classList.add('option');
            optionDiv.textContent = schemes[key];
            optionDiv.dataset.schemeKey = key;

            optionDiv.addEventListener('click', async () => {
                const selectedSchemeKey = optionDiv.dataset.schemeKey;

                // 调用 ThemeLoader 来处理配色方案偏好的更新和主题应用
                await ThemeLoader.updateColorSchemePreference(selectedSchemeKey);

                // 更新此选择器的显示文本
                this.colorSchemeSelectedValueEl.textContent = schemes[selectedSchemeKey];
                // 配色方案更改后，主题选项列表需要重新填充以反映兼容的主题
                this._populateThemeSelectorWithOptions();

                this.colorSchemeOptionsContainerEl.style.display = 'none';
            });
            this.colorSchemeOptionsContainerEl.appendChild(optionDiv);
        }

        // 移除旧的监听器（如果存在），然后绑定新的
        if (this._boundHandleColorSchemeSelectorClick) {
            this.colorSchemeSelectedValueEl.removeEventListener('click', this._boundHandleColorSchemeSelectorClick);
        }
        this._boundHandleColorSchemeSelectorClick = this._handleColorSchemeSelectorClick.bind(this);
        this.colorSchemeSelectedValueEl.addEventListener('click', this._boundHandleColorSchemeSelectorClick);
    },

    /**
     * @private 根据当前生效的配色方案，填充主题选择器的选项。
     *          修改为调用 ThemeLoader.applyTheme() 无刷新切换。
     */
    _populateThemeSelectorWithOptions: function() {
        if (!this.themeSelectedValueEl || !this.themeOptionsContainerEl || typeof ThemeLoader === 'undefined') return;

        this.themeOptionsContainerEl.innerHTML = '';
        const currentEffectiveColorScheme = ThemeLoader.getCurrentEffectiveColorScheme();
        const filteredThemes = {};

        // 筛选出与当前配色方案兼容的主题
        for (const key in ThemeLoader.themes) {
            if (ThemeLoader._isThemeCompatible(key, currentEffectiveColorScheme)) {
                filteredThemes[key] = ThemeLoader.themes[key];
            }
        }

        let themeKeyForDisplay = ThemeLoader.getCurrentThemeKey();
        // 如果当前主题不兼容新配色方案，或当前主题未设置，则查找一个兼容的备用主题
        if (!themeKeyForDisplay || !filteredThemes[themeKeyForDisplay]) {
            themeKeyForDisplay = ThemeLoader._findFallbackThemeKeyForScheme(currentEffectiveColorScheme);
            // 如果回退导致主题键改变，确保 ThemeLoader 的内部状态也更新 (如果需要)
            // 通常 applyTheme 应该在 _findFallbackThemeKeyForScheme 之后被调用，如果它是从 scheme change 路径来的
            // 但这里只是更新UI，所以我们只确保显示正确
            if (themeKeyForDisplay !== ThemeLoader.getCurrentThemeKey() && ThemeLoader.themes[themeKeyForDisplay]) {
                // 这行可能不需要，因为改变配色方案时，applyTheme 已被调用
                // localStorage.setItem('selectedTheme', themeKeyForDisplay);
                // ThemeLoader._currentThemeKey = themeKeyForDisplay; // 避免直接修改内部状态
            }
        }

        const themeForDisplayObject = ThemeLoader.themes[themeKeyForDisplay];
        this.themeSelectedValueEl.textContent = themeForDisplayObject?.name ?? '选择主题';
        this.themeSelectedValueEl.dataset.currentThemeKey = themeKeyForDisplay || '';


        if (Object.keys(filteredThemes).length === 0) {
            this.themeSelectedValueEl.textContent = "无可用主题";
            const optionDiv = document.createElement('div');
            optionDiv.classList.add('option');
            optionDiv.textContent = `没有可用的 ${currentEffectiveColorScheme === 'light' ? '浅色' : '深色'} 主题`;
            optionDiv.style.pointerEvents = "none";
            optionDiv.style.opacity = "0.7";
            this.themeOptionsContainerEl.appendChild(optionDiv);
        } else {
            for (const key in filteredThemes) {
                const theme = filteredThemes[key];
                const optionDiv = document.createElement('div');
                optionDiv.classList.add('option');
                optionDiv.textContent = theme.name;
                optionDiv.dataset.themeKey = key;
                optionDiv.addEventListener('click', async () => {
                    const selectedKey = optionDiv.dataset.themeKey;
                    if (selectedKey !== ThemeLoader.getCurrentThemeKey()) {
                        // 调用 ThemeLoader.applyTheme 实现无刷新切换
                        await ThemeLoader.applyTheme(selectedKey);
                        // 更新UI显示，因为 applyTheme 不再刷新页面
                        this.themeSelectedValueEl.textContent = ThemeLoader.themes[selectedKey]?.name;
                        this.themeSelectedValueEl.dataset.currentThemeKey = selectedKey;
                    }
                    this.themeOptionsContainerEl.style.display = 'none';
                });
                this.themeOptionsContainerEl.appendChild(optionDiv);
            }
        }

        // 移除旧的监听器（如果存在），然后绑定新的
        if (this._boundHandleThemeSelectorClick) {
            this.themeSelectedValueEl.removeEventListener('click', this._boundHandleThemeSelectorClick);
        }
        this._boundHandleThemeSelectorClick = this._handleThemeSelectorClick.bind(this);
        this.themeSelectedValueEl.addEventListener('click', this._boundHandleThemeSelectorClick);
    },

    /**
     * 从 localStorage 加载 AI 相关设置，如果不存在则使用 Config.js 的默认值，并填充到输入框。
     * 此函数不再修改 window.Config.server。
     */
    loadAISettings: function() {
        // 确保 window.Config 和 window.Config.server 存在，否则使用空对象
        const serverConfig = (typeof window.Config !== 'undefined' && window.Config && typeof window.Config.server === 'object' && window.Config.server !== null)
            ? window.Config.server
            : {};

        const settingsToLoad = [
            { storageKey: 'apiEndpoint', input: this.apiEndpointInput, configKey: 'apiEndpoint', ultimateDefault: serverConfig.apiEndpoint },
            { storageKey: 'api_key', input: this.apiKeyInput, configKey: 'api_key', ultimateDefault: serverConfig.api_key },
            { storageKey: 'model', input: this.apiModelInput, configKey: 'model', ultimateDefault: serverConfig.model },
            { storageKey: 'max_tokens', input: this.apiMaxTokensInput, configKey: 'max_tokens', isNumber: true, ultimateDefault: serverConfig.max_tokens },
            { storageKey: 'ttsApiEndpoint', input: this.ttsApiEndpointInput, configKey: 'ttsApiEndpoint', ultimateDefault: serverConfig.ttsApiEndpoint }
        ];

        settingsToLoad.forEach(setting => {
            const savedValue = localStorage.getItem(`aiSetting_${setting.storageKey}`);
            let valueToSet;

            if (savedValue !== null) { // 优先使用 localStorage 的值
                valueToSet = savedValue;
            } else {
                valueToSet = serverConfig[setting.configKey];
            }

            if (setting.isNumber) {
                let numVal = parseInt(String(valueToSet), 10);
                if (isNaN(numVal)) {
                    numVal = serverConfig[setting.configKey] !== undefined && !isNaN(parseInt(String(serverConfig[setting.configKey]), 10))
                        ? parseInt(String(serverConfig[setting.configKey]), 10)
                        : setting.ultimateDefault;
                }
                valueToSet = numVal;
            } else {
                if (valueToSet === undefined) {
                    valueToSet = serverConfig[setting.configKey] ?? "";
                }
            }

            if (setting.input) {
                setting.input.value = String(valueToSet);
            }
        });
    },

    /**
     * 保存单个 AI 设置到 localStorage，并触发 'aiConfigChanged' 事件。
     * 不再修改 window.Config.server。
     * @param {string} storageKey - 在 localStorage 中使用的键名 (例如 'apiEndpoint', 'api_key')。
     * @param {string|number} value - 要保存的值。
     */
    saveAISetting: function(storageKey, value) {
        const serverConfig = (typeof window.Config !== 'undefined' && window.Config && typeof window.Config.server === 'object' && window.Config.server !== null)
            ? window.Config.server
            : {};

        if ((storageKey === 'apiEndpoint' || storageKey === 'ttsApiEndpoint') && value) {
            try { new URL(value); }
            catch (_) {
                NotificationManager.showNotification(`${storageKey.replace(/_/g, ' ')} 的 URL 无效。未保存。`, 'error');
                const inputEl = storageKey === 'apiEndpoint' ? this.apiEndpointInput : this.ttsApiEndpointInput;
                const storedVal = localStorage.getItem(`aiSetting_${storageKey}`);
                const configVal = serverConfig[storageKey] ?? "";
                if (inputEl) inputEl.value = storedVal ?? configVal;
                return;
            }
        }
        if (storageKey === 'max_tokens') {
            const numValue = parseInt(String(value), 10);
            const configMaxTokens = serverConfig.max_tokens !== undefined ? serverConfig.max_tokens : 2048;
            if (isNaN(numValue) || numValue <= 0) {
                NotificationManager.showNotification('最大令牌数必须为正数。未保存。', 'error');
                const storedVal = localStorage.getItem('aiSetting_max_tokens');
                if (this.apiMaxTokensInput) this.apiMaxTokensInput.value = storedVal ?? configMaxTokens;
                return;
            }
            value = numValue;
        }

        localStorage.setItem(`aiSetting_${storageKey}`, String(value));

        const friendlyName = storageKey.charAt(0).toUpperCase() + storageKey.slice(1).replace(/_/g, ' ');
        NotificationManager.showNotification(`${friendlyName} 设置已保存。`, 'success');

        // 触发配置变更事件
        if (typeof EventEmitter !== 'undefined') {
            EventEmitter.emit('aiConfigChanged');
        } else {
            Utils.log("SettingsUIManager: EventEmitter 未定义，无法触发 aiConfigChanged 事件。", Utils.logLevels.WARN);
        }
    },

    /**
     * 从模态框中复制用户 ID 到剪贴板。
     */
    copyUserIdFromModal: function () {
        const userId = this.modalUserIdValue?.textContent;
        if (userId && userId !== "生成中...") {
            navigator.clipboard.writeText(userId)
                .then(() => NotificationManager.showNotification('用户 ID 已复制！', 'success'))
                .catch(() => NotificationManager.showNotification('复制 ID 失败。', 'error'));
        }
    },

    /**
     * 从模态框中复制 SDP 连接信息到剪贴板。
     */
    copySdpTextFromModal: function () {
        const sdpTextEl = document.getElementById('modalSdpText');
        if (sdpTextEl && sdpTextEl.value) {
            navigator.clipboard.writeText(sdpTextEl.value)
                .then(() => NotificationManager.showNotification('连接信息已复制！', 'success'))
                .catch(() => NotificationManager.showNotification('复制信息失败。', 'error'));
        } else {
            NotificationManager.showNotification('没有可复制的连接信息。', 'warning');
        }
    },

    /**
     * 更新“复制 ID”按钮的启用/禁用状态。
     */
    updateCopyIdButtonState: function() {
        if (!this.modalUserIdValue || !this.modalCopyIdBtn) return;
        const userIdReady = this.modalUserIdValue.textContent !== '生成中...' && UserManager.userId;
        this.modalCopyIdBtn.disabled = !userIdReady;
        this.modalCopyIdBtn.title = userIdReady ? '复制用户 ID' : '用户 ID 尚未生成。';
        this.modalCopyIdBtn.classList.toggle('btn-action-themed', userIdReady);
        this.modalCopyIdBtn.classList.toggle('btn-secondary', !userIdReady);
    },

    /**
     * 更新“重新检查网络”按钮的启用/禁用状态。
     */
    updateCheckNetworkButtonState: function() {
        if (!this.checkNetworkBtnModal) return;
        const isConnected = ConnectionManager.isWebSocketConnected;
        this.checkNetworkBtnModal.disabled = isConnected;
        this.checkNetworkBtnModal.classList.toggle('btn-action-themed', !isConnected);
        this.checkNetworkBtnModal.classList.toggle('btn-secondary', isConnected);
    },

    /**
     * 更新主菜单/设置模态框中所有依赖于应用状态的控件。
     */
    updateMainMenuControlsState: function() {
        if (this.autoConnectToggle && UserManager.userSettings) {
            this.autoConnectToggle.checked = UserManager.userSettings.autoConnectEnabled;
        }
        this.updateCopyIdButtonState();
        this.updateCheckNetworkButtonState();
    },

    /**
     * 更新模态框中的网络状态信息显示。
     * @param {object} networkType - 从 Utils.checkNetworkType 返回的网络类型信息。
     * @param {boolean} webSocketStatus - WebSocket 的连接状态。
     */
    updateNetworkInfoDisplay: function (networkType, webSocketStatus) {
        const networkInfoEl = document.getElementById('modalNetworkInfo');
        const qualityIndicator = document.getElementById('modalQualityIndicator');
        const qualityText = document.getElementById('modalQualityText');
        if (!networkInfoEl || !qualityIndicator || !qualityText) return;
        let html = ''; let overallQuality = '未知'; let qualityClass = '';
        if (networkType && networkType.error === null) {
            html += `IPv4: ${networkType.ipv4?'✓':'✗'} | IPv6: ${networkType.ipv6?'✓':'✗'} <br>`;
            html += `UDP: ${networkType.udp?'✓':'✗'} | TCP: ${networkType.tcp?'✓':'✗'} | 中继: ${networkType.relay?'✓':'?'} <br>`;
        } else html += 'WebRTC 网络检测: ' + (networkType?.error || '失败/不支持') + '.<br>';
        html += `信令服务器: ${webSocketStatus ? '<span style="color: green;">已连接</span>' : '<span style="color: var(--danger-color, red);">已断开</span>'}`;
        networkInfoEl.innerHTML = html;
        if (!webSocketStatus) { overallQuality = '信令离线'; qualityClass = 'quality-poor'; }
        else if (networkType && networkType.error === null) {
            if (networkType.udp) { overallQuality = '良好'; qualityClass = 'quality-good'; }
            else if (networkType.tcp) { overallQuality = '受限 (TCP 回退)'; qualityClass = 'quality-medium'; }
            else if (networkType.relay) { overallQuality = '仅中继'; qualityClass = 'quality-medium'; }
            else { overallQuality = '差 (WebRTC P2P 失败)'; qualityClass = 'quality-poor'; }
        } else { overallQuality = 'WebRTC 检查失败'; qualityClass = 'quality-poor'; }
        qualityIndicator.className = `quality-indicator ${qualityClass}`;
        qualityText.textContent = overallQuality;
    },
};