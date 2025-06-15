/**
 * @file AppInitializer.js
 * @description 应用的入口点和初始化器。负责按正确顺序加载和初始化所有管理器和 UI 组件，并设置核心事件监听器。
 *              现在确保 ThemeLoader.init() 在 UserManager.init() 之前被 await 调用。
 *              优化了部分异步任务的并行执行。
 * @module AppInitializer
 * @exports {object} AppInitializer - 包含 init 方法，现在应由 DOMContentLoaded 事件触发。
 * @property {function} init - 应用程序的主初始化函数，是整个应用的启动点。
 * @dependencies DBManager, UserManager, ChatManager, GroupManager, ConnectionManager, MediaManager, VideoCallManager,
 *               LayoutManager, ModalManager, SettingsUIManager, ChatAreaUIManager, SidebarUIManager,
 *               DetailsPanelUIManager, VideoCallUIManager, MediaUIManager, NotificationManager, Utils, EventEmitter, PeopleLobbyManager, AiApiHandler, ThemeLoader
 * @dependents DOMContentLoaded (在 index.html 中通过新的方式调用)
 */
const AppInitializer = {

    /**
     * 应用程序的主初始化函数。
     * 按顺序执行以下操作：
     * 1.  设置日志级别和全局错误处理。
     * 2.  检查 WebRTC 支持。
     * 3.  初始化数据库 (DBManager)。
     * 4.  初始化 ThemeLoader (必须在 UserManager 之前)。
     * 5.  初始化核心数据管理器 (UserManager, ChatManager, GroupManager)。
     * 6.  初始化所有 UI 管理器。
     * 7.  初始化媒体和通话的核心逻辑。
     * 8.  设置全局事件监听器和网络监控。
     * 9.  并行执行 AI 服务健康检查、刷新网络 UI 和初始化 WebSocket 连接。
     * @returns {Promise<void>}
     */
    init: async function () {
        // --- 阶段 1: 关键的同步设置 ---
        Utils.setLogLevelFromConfig();
        this.initializeGlobalImageErrorHandler();
        if (!UIManager.checkWebRTCSupport()) return;

        try {
            // --- 阶段 2: 核心数据加载 (主要是顺序异步) ---
            await DBManager.init();
            Utils.log('数据库初始化成功', Utils.logLevels.INFO);

            if (typeof ThemeLoader !== 'undefined' && typeof ThemeLoader.init === 'function') {
                await ThemeLoader.init();
                Utils.log('ThemeLoader 初始化完成。', Utils.logLevels.INFO);
            } else {
                Utils.log('ThemeLoader 或其 init 方法未定义。主题系统可能无法正常工作。', Utils.logLevels.ERROR);
            }

            await UserManager.init();
            // ChatManager.init 和 GroupManager.init 可以考虑并行，但为简单和确保依赖，此处保持顺序
            await ChatManager.init();
            await GroupManager.init();

            // --- 阶段 3: UI 管理器初始化 (同步, 在核心数据加载后) ---
            ModalManager.init();
            SettingsUIManager.init(); // ThemeLoader 已完成，SettingsUIManager 可以安全初始化
            LayoutManager.init();
            ChatAreaUIManager.init();
            SidebarUIManager.init();
            DetailsPanelUIManager.init();
            VideoCallUIManager.init();
            MediaUIManager.init();
            PeopleLobbyManager.init();

            // --- 阶段 4: 其他同步设置 ---
            this.startNetworkMonitoring();      // 同步监听器设置
            MediaManager.initVoiceRecording();
            VideoCallManager.init();
            this.setupCoreEventListeners();     // 依赖管理器对象存在
            this.smartBackToChatList();

            // --- 阶段 5: 并行执行的异步操作 ---
            const asyncOperations = [];

            // 1. 刷新网络 UI (依赖 SettingsUIManager.init())
            asyncOperations.push(this.refreshNetworkStatusUI());

            // 2. AI 服务健康检查 (依赖 UserManager.init(), AiApiHandler, EventEmitter)
            const aiHealthCheckTask = async () => {
                try {
                    const isAiHealthy = await AiApiHandler.checkAiServiceHealth();
                    UserManager.updateAiServiceStatus(isAiHealthy);
                    EventEmitter.emit('aiServiceStatusUpdated', UserManager.isAiServiceHealthy);
                } catch (e) {
                    Utils.log("初始化期间 AI 健康检查出错: " + e.message, Utils.logLevels.ERROR);
                    UserManager.updateAiServiceStatus(false);
                    EventEmitter.emit('aiServiceStatusUpdated', false);
                }
            };
            asyncOperations.push(aiHealthCheckTask());

            // 3. 初始化 WebSocket 连接
            // ConnectionManager.initialize() 应该在内部处理好其异步性。
            // 如果 initialize 仅是触发器，而实际连接是 connectWebSocket() 返回 promise，则应推入后者。
            // 假设 ConnectionManager.initialize() 包含了连接逻辑或能正确返回连接的 Promise。
            // 为了安全，我们直接使用 connectWebSocket 的 Promise (如果尚未连接或正在连接)
            if (ConnectionManager.websocket === null || ConnectionManager.websocket.readyState === WebSocket.CLOSED) {
                asyncOperations.push(ConnectionManager.connectWebSocket());
            } else {
                // 如果已连接或正在连接，initialize 可能是注册用户等操作。
                // 如果这些操作也是异步的，并且我们想等待它们，也应该让 initialize 返回 promise。
                // 此处假设如果不是初次连接，initialize 的操作相对较快或不关键阻塞。
                ConnectionManager.initialize();
            }

            await Promise.all(asyncOperations);

            Utils.log('应用已初始化 (所有主要异步任务已启动或完成)', Utils.logLevels.INFO);

        } catch (error) {
            Utils.log(`应用初始化失败: ${error.stack || error}`, Utils.logLevels.ERROR);
            NotificationManager.showNotification('应用初始化失败，部分功能可能无法使用。', 'error');

            // --- 回退模式初始化 ---
            if (!UserManager.userId) {
                UserManager.userId = Utils.generateId(8);
                UserManager.userSettings.autoConnectEnabled = false; // 在回退模式下禁用自动连接
                const userIdEl = document.getElementById('modalUserIdValue');
                if(userIdEl) userIdEl.textContent = UserManager.userId;
            }
            // 即使在回退模式下，也尝试初始化 UI 管理器以保证界面可用
            ModalManager.init(); SettingsUIManager.init(); LayoutManager.init();
            ChatAreaUIManager.init(); SidebarUIManager.init(); DetailsPanelUIManager.init();
            VideoCallUIManager.init(); MediaUIManager.init(); PeopleLobbyManager.init();

            // 在回退模式下仍尝试设置网络监控和基础功能
            if (typeof this.refreshNetworkStatusUI === 'function') await this.refreshNetworkStatusUI();
            if (typeof this.startNetworkMonitoring === 'function') this.startNetworkMonitoring();
            if (typeof MediaManager !== 'undefined' && typeof MediaManager.initVoiceRecording === 'function') MediaManager.initVoiceRecording();
            if (typeof VideoCallManager !== 'undefined' && typeof VideoCallManager.init === 'function') VideoCallManager.init();
            if (typeof this.setupCoreEventListeners === 'function') this.setupCoreEventListeners();
            if (typeof this.smartBackToChatList === 'function') this.smartBackToChatList();

            // 隐藏加载覆盖层，并显示开源信息模态框
            const loadingOverlay = document.getElementById('loadingOverlay');
            if (loadingOverlay && loadingOverlay.style.display !== 'none') {
                loadingOverlay.style.display = 'none';
                ModalManager.showOpenSourceInfoModal();
            }
        }
    },

    /**
     * 初始化全局图片错误处理器。
     * 当 <img> 元素加载失败时，此处理器会捕获错误事件，
     * 并根据图片类型（如头像、文件预览）提供合适的备用内容。
     */
    initializeGlobalImageErrorHandler: function() {
        document.addEventListener('error', function(event) {
            const imgElement = event.target;
            if (imgElement && imgElement.tagName === 'IMG') {
                if (imgElement.classList.contains('image-load-error-processed')) return;
                imgElement.classList.add('image-load-error-processed');
                Utils.log(`图片加载失败: ${imgElement.src}。正在尝试使用备用方案。`, Utils.logLevels.WARN);
                if (imgElement.classList.contains('avatar-image')) {
                    const fallbackText = imgElement.dataset.fallbackText || imgElement.alt || '?';
                    const avatarContainer = imgElement.parentElement;
                    if (avatarContainer && (
                        avatarContainer.classList.contains('chat-list-avatar') ||
                        avatarContainer.classList.contains('chat-avatar-main') ||
                        avatarContainer.classList.contains('details-avatar') ||
                        avatarContainer.classList.contains('video-call-avatar')
                    )) {
                        avatarContainer.innerHTML = '';
                        avatarContainer.textContent = fallbackText;
                        avatarContainer.classList.add('avatar-fallback-active');
                    } else { imgElement.style.display = 'none'; }
                }
                else if (imgElement.classList.contains('file-preview-img')) {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'image-message-fallback';
                    placeholder.textContent = '[图片无法显示]';
                    if (imgElement.parentElement) {
                        try { imgElement.parentElement.replaceChild(placeholder, imgElement); } catch (e) { imgElement.style.display = 'none'; }
                    }
                    else { imgElement.style.display = 'none'; }
                }
                else { imgElement.classList.add('image-load-error'); }
            }
        }, true);
        Utils.log("全局图片错误处理器已初始化。", Utils.logLevels.INFO);
    },

    /**
     * 异步刷新设置模态框中的网络状态 UI。
     */
    refreshNetworkStatusUI: async function() {
        try {
            const networkType = await Utils.checkNetworkType();
            const wsStatus = ConnectionManager.isWebSocketConnected;
            if (typeof SettingsUIManager !== 'undefined' && SettingsUIManager.updateNetworkInfoDisplay) {
                SettingsUIManager.updateNetworkInfoDisplay(networkType, wsStatus);
            }
        } catch (error) {
            Utils.log(`refreshNetworkStatusUI 出错: ${error.message || error}`, Utils.logLevels.ERROR);
            if (typeof SettingsUIManager !== 'undefined' && SettingsUIManager.updateNetworkInfoDisplay) {
                SettingsUIManager.updateNetworkInfoDisplay({ error: "WebRTC 检查失败" }, ConnectionManager.isWebSocketConnected);
            }
        }
    },

    /**
     * 启动网络状态监控，监听 online 和 offline 事件。
     */
    startNetworkMonitoring: function () {
        window.addEventListener('online', this.handleNetworkChange.bind(this));
        window.addEventListener('offline', this.handleNetworkChange.bind(this));
    },

    /**
     * 处理网络状态变化事件。
     */
    handleNetworkChange: async function () {
        if (navigator.onLine) {
            LayoutManager.updateConnectionStatusIndicator('网络已重新连接。正在尝试恢复连接...');
            ConnectionManager.initialize(); // 尝试重新初始化连接
        } else {
            LayoutManager.updateConnectionStatusIndicator('网络已断开。');
        }
        await this.refreshNetworkStatusUI();
    },

    /**
     * 在移动端视图下，通过监听 popstate 事件智能处理返回按钮，
     * 实现从聊天界面返回到聊天列表，而不是退出页面。
     */
    smartBackToChatList: function (){
        history.pushState(null, null, location.href);
        window.addEventListener('popstate', function(event) {
            const btn = document.querySelector('.back-to-list-btn');
            if (btn && window.getComputedStyle(btn).getPropertyValue('display') === "block"){
                history.pushState(null, null, location.href);
                if (typeof LayoutManager !== 'undefined') LayoutManager.showChatListArea();
            }
        });
    },

    /**
     * 设置核心的、跨模块的事件监听器。
     * 这是实现模块间解耦通信的关键。
     */
    setupCoreEventListeners: function () {
        // --- ConnectionManager 相关事件 ---
        EventEmitter.on('connectionDisconnected', (peerId) => {
            if (typeof ChatAreaUIManager !== 'undefined') ChatAreaUIManager.setCallButtonsStateForPeer(peerId, false);
            if (typeof SidebarUIManager !== 'undefined') SidebarUIManager.updateChatListItemStatus(peerId, false);
        });
        EventEmitter.on('connectionEstablished', (peerId) => {
            if (typeof ChatAreaUIManager !== 'undefined') {
                const contact = UserManager.contacts[peerId];
                ChatAreaUIManager.setCallButtonsStateForPeer(peerId, !(contact && contact.isSpecial));
            }
            if (typeof SidebarUIManager !== 'undefined') SidebarUIManager.updateChatListItemStatus(peerId, true);
        });
        EventEmitter.on('connectionFailed', (peerId) => {
            if (typeof ChatAreaUIManager !== 'undefined') ChatAreaUIManager.setCallButtonsStateForPeer(peerId, false);
            if (typeof SidebarUIManager !== 'undefined') SidebarUIManager.updateChatListItemStatus(peerId, false);
        });
        EventEmitter.on('connectionClosed', (peerId) => {
            if (typeof ChatAreaUIManager !== 'undefined') ChatAreaUIManager.setCallButtonsStateForPeer(peerId, false);
            if (typeof SidebarUIManager !== 'undefined') SidebarUIManager.updateChatListItemStatus(peerId, false);
        });

        // --- WebSocket 状态更新事件 ---
        EventEmitter.on('websocketStatusUpdate', async () => {
            Utils.log('收到 WebSocket 状态更新事件，正在刷新网络 UI。', Utils.logLevels.DEBUG);
            await this.refreshNetworkStatusUI();
            if (typeof SettingsUIManager !== 'undefined' && SettingsUIManager.updateCheckNetworkButtonState) {
                SettingsUIManager.updateCheckNetworkButtonState();
            }
        });

        // --- AI 服务状态更新事件 ---
        EventEmitter.on('aiServiceStatusUpdated', function(isHealthy) {
            Utils.log(`AppInitializer: 收到 aiServiceStatusUpdated 事件, healthy: ${isHealthy}`, Utils.logLevels.DEBUG);
            if (typeof ChatAreaUIManager !== 'undefined' && ChatManager.currentChatId) {
                const currentContact = UserManager.contacts[ChatManager.currentChatId];
                if (currentContact && currentContact.isAI) {
                    ChatAreaUIManager.updateChatHeaderStatus(UserManager.getAiServiceStatusMessage());
                }
            }
        });

        // --- AI 配置变更事件 ---
        if (typeof AiApiHandler !== 'undefined' && typeof AiApiHandler.handleAiConfigChange === 'function') {
            EventEmitter.on('aiConfigChanged', AiApiHandler.handleAiConfigChange.bind(AiApiHandler));
        } else {
            Utils.log("AppInitializer: AiApiHandler 或其 handleAiConfigChange 方法未定义，无法监听 aiConfigChanged 事件。", Utils.logLevels.WARN);
        }

        // --- 全局事件处理器 ---
        const fileInput = document.getElementById('fileInput');
        if (fileInput) fileInput.addEventListener('change', MediaManager.handleFileSelect.bind(MediaManager));

        window.addEventListener('error', (event) => {
            const errorDetails = event.error ? (event.error.stack || event.error.message) : event.message;
            Utils.log(`全局 window 错误: ${errorDetails} 位于 ${event.filename}:${event.lineno}`, Utils.logLevels.ERROR);
            NotificationManager.showNotification('应用程序发生错误。请检查控制台以获取详细信息。', 'error');
        });
        window.addEventListener('unhandledrejection', function(event) {
            const reason = event.reason instanceof Error ? (event.reason.stack || event.reason.message) : event.reason;
            Utils.log(`未处理的 Promise rejection: ${reason}`, Utils.logLevels.ERROR);
            NotificationManager.showNotification('发生意外错误。请检查控制台。', 'error');
        });
        window.addEventListener('beforeunload', () => {
            MediaManager.releaseAudioResources();
            VideoCallManager.releaseMediaResources();
            for (const peerId in ConnectionManager.connections) {
                if (ConnectionManager.connections.hasOwnProperty(peerId)) {
                    ConnectionManager.close(peerId, true);
                }
            }
        });

        // --- 加载覆盖层观察器 ---
        const connectionStatusTextEl = document.getElementById('connectionStatusText');
        const loadingOverlay = document.getElementById('loadingOverlay');
        if (connectionStatusTextEl && loadingOverlay) {
            const observer = new MutationObserver(() => {
                const statusText = connectionStatusTextEl.textContent.toLowerCase();
                if (statusText.includes('用户注册成功') ||
                    statusText.includes('信令服务器已连接') ||
                    statusText.includes('已从本地加载') ||
                    statusText.includes('使用现有id') ||
                    statusText.includes('初始化完成，准备连接')
                ) {
                    setTimeout(() => {
                        if (loadingOverlay.style.display !== 'none') {
                            loadingOverlay.style.display = 'none';
                            ModalManager.showOpenSourceInfoModal();
                        }
                    }, 500);
                }
            });
            observer.observe(connectionStatusTextEl, { childList: true, characterData: true, subtree: true });
        }
    }
};