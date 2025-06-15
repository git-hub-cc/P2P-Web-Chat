/**
 * @file ChatAreaUIManager.js
 * @description 管理主聊天区域的 UI 元素和交互，包括聊天头部、消息框、输入区以及通话和截图按钮。
 *              支持消息的右键/双击上下文菜单，用于删除或撤回消息，菜单在无操作3秒后自动消失。
 * @module ChatAreaUIManager
 * @exports {object} ChatAreaUIManager - 对外暴露的单例对象，包含管理聊天区域 UI 的所有方法。
 * @property {function} init - 初始化模块，获取 DOM 元素并绑定事件。
 * @property {function} showChatArea - 显示聊天区域并隐藏“未选择聊天”的占位屏幕。
 * @property {function} updateChatHeader - 更新聊天头部的标题、状态和头像。
 * @property {function} enableChatInterface - 启用或禁用聊天输入框和相关按钮。
 * @property {function} setCallButtonsState - 根据连接状态设置通话按钮的可用性。
 * @property {function} showReconnectPrompt - 当与对方断开连接时，在聊天框中显示重连提示。
 * @dependencies LayoutManager, MessageManager, VideoCallManager, ChatManager, ConnectionManager, UserManager, DetailsPanelUIManager, NotificationManager, Utils, MediaManager, PeopleLobbyManager, EventEmitter, UIManager
 * @dependents AppInitializer (进行初始化)
 */
const ChatAreaUIManager = {
    // 缓存的 DOM 元素引用
    chatAreaEl: null,
    chatHeaderTitleEl: null,
    chatHeaderStatusEl: null,
    chatHeaderAvatarEl: null,
    chatHeaderMainEl: null,
    chatBoxEl: null,
    noChatSelectedScreenEl: null,
    messageInputEl: null,
    sendButtonEl: null,
    attachButtonEl: null,
    voiceButtonEl: null,
    videoCallButtonEl: null,
    audioCallButtonEl: null,
    screenShareButtonEl: null,
    chatDetailsButtonEl: null,
    peopleLobbyButtonEl: null,
    screenshotMainBtnEl: null,

    // 自定义上下文菜单相关属性
    contextMenuEl: null,
    activeContextMenuMessageElement: null,
    contextMenuAutoHideTimer: null, // 用于菜单自动隐藏

    // 常量
    MESSAGE_RETRACTION_WINDOW: 5 * 60 * 1000, // 5 minutes in ms
    CONTEXT_MENU_AUTOHIDE_DURATION: 3000, // 3 seconds in ms for auto-hiding menu

    /**
     * 初始化模块，获取所有需要的 DOM 元素引用并绑定核心事件。
     */
    init: function() {
        this.chatAreaEl = document.getElementById('chatArea');
        this.chatHeaderTitleEl = document.getElementById('currentChatTitleMain');
        this.chatHeaderStatusEl = document.getElementById('currentChatStatusMain');
        this.chatHeaderAvatarEl = document.getElementById('currentChatAvatarMain');
        this.chatHeaderMainEl = document.querySelector('.chat-header-main');
        this.chatBoxEl = document.getElementById('chatBox');
        this.noChatSelectedScreenEl = document.getElementById('noChatSelectedScreen');
        this.messageInputEl = document.getElementById('messageInput');
        this.sendButtonEl = document.getElementById('sendButtonMain');
        this.attachButtonEl = document.getElementById('attachBtnMain');
        this.voiceButtonEl = document.getElementById('voiceButtonMain');
        this.videoCallButtonEl = document.getElementById('videoCallButtonMain');
        this.audioCallButtonEl = document.getElementById('audioCallButtonMain');
        this.screenShareButtonEl = document.getElementById('screenShareButtonMain');
        this.chatDetailsButtonEl = document.getElementById('chatDetailsBtnMain');
        this.peopleLobbyButtonEl = document.getElementById('peopleLobbyButtonMain');
        this.screenshotMainBtnEl = document.getElementById('screenshotMainBtn');

        this._initContextMenu();
        this.bindEvents();
    },

    /**
     * @private
     * 初始化自定义上下文菜单的 DOM 结构。
     */
    _initContextMenu: function() {
        this.contextMenuEl = document.createElement('div');
        this.contextMenuEl.id = 'customMessageContextMenu';
        this.contextMenuEl.className = 'custom-context-menu';
        this.contextMenuEl.style.display = 'none';
        document.body.appendChild(this.contextMenuEl);

        document.addEventListener('click', function(event) {
            if (this.contextMenuEl && this.contextMenuEl.style.display === 'block') {
                if (!this.contextMenuEl.contains(event.target)) {
                    this._hideContextMenu();
                }
            }
        }.bind(this));
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape' && this.contextMenuEl && this.contextMenuEl.style.display === 'block') {
                this._hideContextMenu();
            }
        }.bind(this));
    },

    /**
     * 绑定聊天区域内的所有 UI 事件监听器。
     */
    bindEvents: function() {
        // 绑定消息输入框的 Enter 键发送事件
        if (this.messageInputEl) {
            this.messageInputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
                    e.preventDefault();
                    MessageManager.sendMessage();
                }
            });
        }
        // 绑定发送按钮的点击事件
        if (this.sendButtonEl) this.sendButtonEl.addEventListener('click', MessageManager.sendMessage);

        // 绑定附件按钮的点击事件，触发隐藏的文件输入框
        if (this.attachButtonEl) this.attachButtonEl.addEventListener('click', () => {
            const fileInput = document.getElementById('fileInput');
            if (fileInput) fileInput.click();
        });
        if (this.voiceButtonEl) {
            if ('ontouchstart' in window) {
                this.voiceButtonEl.addEventListener('touchstart', (e) => {
                    e.preventDefault();
                    if (!this.voiceButtonEl.disabled) MediaManager.startRecording();
                });
                this.voiceButtonEl.addEventListener('touchend', (e) => {
                    e.preventDefault();
                    if (!this.voiceButtonEl.disabled) MediaManager.stopRecording();
                });
            } else {
                this.voiceButtonEl.addEventListener('mousedown', () => {
                    if (!this.voiceButtonEl.disabled) MediaManager.startRecording();
                });
                this.voiceButtonEl.addEventListener('mouseup', () => {
                    if (!this.voiceButtonEl.disabled) MediaManager.stopRecording();
                });
                // 处理鼠标按下后移出按钮区域的情况
                this.voiceButtonEl.addEventListener('mouseleave', () => {
                    if (!this.voiceButtonEl.disabled && MediaManager.mediaRecorder && MediaManager.mediaRecorder.state === 'recording') {
                        MediaManager.stopRecording();
                    }
                });
            }
        }

        // 绑定截图按钮事件
        if (this.screenshotMainBtnEl) {
            this.screenshotMainBtnEl.addEventListener('click', () => {
                MediaManager.captureScreen();
            });
        }

        // 绑定通话相关按钮的点击事件
        if (this.videoCallButtonEl) this.videoCallButtonEl.onclick = () => {
            if(!this.videoCallButtonEl.disabled) VideoCallManager.initiateCall(ChatManager.currentChatId);
        };
        if (this.audioCallButtonEl) this.audioCallButtonEl.onclick = () => {
            if(!this.audioCallButtonEl.disabled) VideoCallManager.initiateAudioCall(ChatManager.currentChatId);
        };
        if (this.screenShareButtonEl) this.screenShareButtonEl.onclick = () => {
            if(!this.screenShareButtonEl.disabled) VideoCallManager.initiateScreenShare(ChatManager.currentChatId);
        };

        // 绑定聊天详情按钮的点击事件
        if (this.chatDetailsButtonEl) {
            this.chatDetailsButtonEl.addEventListener('click', () => {
                if (typeof DetailsPanelUIManager !== 'undefined') {
                    DetailsPanelUIManager.toggleChatDetailsView();
                }
            });
        }

        // 绑定人员大厅按钮的点击事件
        if (this.peopleLobbyButtonEl) {
            this.peopleLobbyButtonEl.addEventListener('click', () => {
                if (typeof DetailsPanelUIManager !== 'undefined') {
                    DetailsPanelUIManager.togglePeopleLobbyView();
                }
            });
        }


        // 绑定拖放事件监听器，用于文件发送
        if (this.chatAreaEl) {
            let dragCounter = 0;
            this.chatAreaEl.addEventListener('dragenter', (e) => {
                e.preventDefault(); e.stopPropagation();
                if (ChatManager.currentChatId && e.dataTransfer && e.dataTransfer.types.includes('Files')) {
                    dragCounter++;
                    if (dragCounter === 1) this.chatAreaEl.classList.add('drag-over');
                }
            });
            this.chatAreaEl.addEventListener('dragover', (e) => {
                e.preventDefault(); e.stopPropagation();
                if (ChatManager.currentChatId && e.dataTransfer && e.dataTransfer.types.includes('Files')) e.dataTransfer.dropEffect = 'copy';
                else e.dataTransfer.dropEffect = 'none';
            });
            this.chatAreaEl.addEventListener('dragleave', (e) => {
                e.preventDefault(); e.stopPropagation();
                dragCounter--;
                if (dragCounter === 0) this.chatAreaEl.classList.remove('drag-over');
            });
            this.chatAreaEl.addEventListener('drop', (e) => {
                e.preventDefault(); e.stopPropagation(); dragCounter = 0;
                this.chatAreaEl.classList.remove('drag-over');
                if (!ChatManager.currentChatId) { NotificationManager.showNotification('发送文件前请先选择一个聊天。', 'warning'); return; }
                if (e.dataTransfer && e.dataTransfer.files.length > 0) {
                    const file = e.dataTransfer.files[0]; MediaManager.processFile(file);
                }
            });
        }

        if (this.chatBoxEl) {
            // Right-click for context menu
            this.chatBoxEl.addEventListener('contextmenu', function(event) {
                this._handleMessageInteraction(event);
            }.bind(this));

            // Double-click for context menu
            this.chatBoxEl.addEventListener('dblclick', function(event) {
                const messageElement = event.target.closest('.message:not(.system):not(.retracted)');
                if (messageElement) {
                    if (event.target.closest('a, button, input, textarea, select, .file-preview-img, .play-voice-btn, .download-btn, video[controls], audio[controls]')) {
                        return;
                    }
                    this._showContextMenu(event, messageElement);
                }
            }.bind(this));
        }
    },

    /**
     * @private
     * 处理消息元素的右键点击交互事件。
     * @param {MouseEvent} event - 交互事件对象.
     */
    _handleMessageInteraction: function(event) {
        const messageElement = event.target.closest('.message:not(.system):not(.retracted)');
        if (!messageElement) return;

        if (event.type === 'contextmenu') {
            event.preventDefault();
            this._showContextMenu(event, messageElement);
        }
    },

    /**
     * @private
     * 显示自定义上下文菜单。
     * @param {Event} event - 触发菜单的原始事件。
     * @param {HTMLElement} messageElement - 被交互的消息 DOM 元素。
     */
    _showContextMenu: function(event, messageElement) {
        if (!this.contextMenuEl || !messageElement) return;

        this._clearContextMenuAutoHideTimer(); // 清除上一个自动隐藏定时器

        const imageViewerModal = document.querySelector('.modal-like.image-viewer');
        if (imageViewerModal) {
            imageViewerModal.remove();
        }

        this.contextMenuEl.innerHTML = '';
        this.activeContextMenuMessageElement = messageElement;

        const messageId = messageElement.dataset.messageId;
        const messageTimestamp = parseInt(messageElement.dataset.timestamp, 10);
        const isMyMessage = messageElement.classList.contains('sent');

        if (!messageId) {
            Utils.log("无法显示上下文菜单：消息元素缺少 data-message-id", Utils.logLevels.WARN);
            this._hideContextMenu();
            return;
        }

        // 修改点: 允许删除所有消息 (自己的和对方的)
        // 原来的 if (isMyMessage) 条件被移除
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '删除';
        deleteBtn.className = 'context-menu-button';
        deleteBtn.onclick = function() {
            this._clearContextMenuAutoHideTimer();
            MessageManager.deleteMessageLocally(messageId); // This function deletes the message locally
            this._hideContextMenu();
        }.bind(this);
        this.contextMenuEl.appendChild(deleteBtn);

        // “撤回”功能仍然只对自己的消息在特定时间窗口内有效
        if (isMyMessage && !isNaN(messageTimestamp) && (Date.now() - messageTimestamp < this.MESSAGE_RETRACTION_WINDOW)) {
            const retractBtn = document.createElement('button');
            retractBtn.textContent = '撤回';
            retractBtn.className = 'context-menu-button';
            retractBtn.onclick = function() {
                this._clearContextMenuAutoHideTimer();
                MessageManager.requestRetractMessage(messageId);
                this._hideContextMenu();
            }.bind(this);
            this.contextMenuEl.appendChild(retractBtn);
        }

        if (this.contextMenuEl.children.length === 0) {
            this._hideContextMenu();
            return;
        }

        this.contextMenuEl.style.display = 'block';
        const menuRect = this.contextMenuEl.getBoundingClientRect();
        const menuWidth = menuRect.width;
        const menuHeight = menuRect.height;
        this.contextMenuEl.style.display = 'none';

        let x = event.clientX;
        let y = event.clientY;

        if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 5;
        if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 5;
        if (x < 0) x = 5;
        if (y < 0) y = 5;

        this.contextMenuEl.style.top = y + 'px';
        this.contextMenuEl.style.left = x + 'px';
        this.contextMenuEl.style.display = 'block';

        this.contextMenuAutoHideTimer = setTimeout(function() {
            this._hideContextMenu();
        }.bind(this), this.CONTEXT_MENU_AUTOHIDE_DURATION);
    },

    /**
     * @private
     * 隐藏自定义上下文菜单。
     */
    _hideContextMenu: function() {
        this._clearContextMenuAutoHideTimer();
        if (this.contextMenuEl) {
            this.contextMenuEl.style.display = 'none';
        }
        this.activeContextMenuMessageElement = null;
    },

    /**
     * @private
     * 清除上下文菜单的自动隐藏定时器。
     */
    _clearContextMenuAutoHideTimer: function() {
        if (this.contextMenuAutoHideTimer) {
            clearTimeout(this.contextMenuAutoHideTimer);
            this.contextMenuAutoHideTimer = null;
        }
    },

    /**
     * 显示聊天区域，并隐藏“未选择聊天”的占位屏幕。
     */
    showChatArea: function () {
        if (typeof LayoutManager !== 'undefined') LayoutManager.showChatAreaLayout();
        if (this.noChatSelectedScreenEl) this.noChatSelectedScreenEl.style.display = 'none';
        if (this.chatBoxEl) this.chatBoxEl.style.display = 'flex';
        this._hideContextMenu();
    },

    /**
     * 显示“未选择聊天”的占位屏幕，并重置聊天区域的 UI。
     */
    showNoChatSelected: function () {
        if (this.chatHeaderTitleEl) this.chatHeaderTitleEl.textContent = '选择一个聊天';
        if (this.chatHeaderStatusEl) this.chatHeaderStatusEl.textContent = '';
        if (this.chatHeaderAvatarEl) {
            this.chatHeaderAvatarEl.innerHTML = '';
            this.chatHeaderAvatarEl.className = 'chat-avatar-main';
        }
        if (this.chatHeaderMainEl) this.chatHeaderMainEl.className = 'chat-header-main';

        if (this.chatBoxEl) {
            this.chatBoxEl.innerHTML = '';
            this.chatBoxEl.style.display = 'none';
        }
        if (this.noChatSelectedScreenEl) this.noChatSelectedScreenEl.style.display = 'flex';

        this.enableChatInterface(false);
        if (typeof DetailsPanelUIManager !== 'undefined') DetailsPanelUIManager.hideSidePanel();
        if (typeof LayoutManager !== 'undefined') LayoutManager.showChatListArea();

        // 确保人员大厅按钮始终可见且启用
        if (this.peopleLobbyButtonEl) {
            this.peopleLobbyButtonEl.style.display = 'block';
            this.peopleLobbyButtonEl.disabled = false;
        }
        // 当没有聊天选中时，聊天详情按钮应该隐藏
        if (this.chatDetailsButtonEl) {
            this.chatDetailsButtonEl.style.display = 'none';
            this.chatDetailsButtonEl.disabled = true;
        }
        this._hideContextMenu();
    },

    /**
     * 更新聊天头部的标题、状态和头像。
     * @param {string} title - 聊天标题。
     * @param {string} status - 聊天状态文本（如在线、离线、AI服务状态）。
     * @param {string} avatarTextParam - 用于生成头像的文本（通常是名称首字母）。
     * @param {boolean} [isGroup=false] - 是否为群组聊天。
     */
    updateChatHeader: function (title, status, avatarTextParam, isGroup = false) {
        if (this.chatHeaderTitleEl) this.chatHeaderTitleEl.textContent = Utils.escapeHtml(title);
        if (this.chatHeaderStatusEl) this.chatHeaderStatusEl.textContent = Utils.escapeHtml(status);

        // 重置并应用主题/类型相关的类
        if (this.chatHeaderMainEl) this.chatHeaderMainEl.className = 'chat-header-main';
        if (this.chatHeaderAvatarEl) this.chatHeaderAvatarEl.className = 'chat-avatar-main';
        if (isGroup && this.chatHeaderAvatarEl) this.chatHeaderAvatarEl.classList.add('group');

        const currentContact = UserManager.contacts[ChatManager.currentChatId];
        let finalAvatarText = avatarTextParam ? Utils.escapeHtml(avatarTextParam) :
            (title && title.length > 0) ? Utils.escapeHtml(title.charAt(0).toUpperCase()) : '?';
        let avatarContentHtml;

        // 如果有头像 URL，则使用 <img>，否则使用文本
        if (currentContact && currentContact.avatarUrl) {
            let imgFallback = (currentContact.avatarText) ? Utils.escapeHtml(currentContact.avatarText) :
                (currentContact.name && currentContact.name.length > 0) ? Utils.escapeHtml(currentContact.name.charAt(0).toUpperCase()) : '?';
            avatarContentHtml = `<img src="${currentContact.avatarUrl}" alt="${imgFallback}" class="avatar-image" data-fallback-text="${imgFallback}" data-entity-id="${currentContact.id}">`;
            if (currentContact.isSpecial && this.chatHeaderAvatarEl) this.chatHeaderAvatarEl.classList.add('special-avatar', currentContact.id);
            if (currentContact.isSpecial && this.chatHeaderMainEl) this.chatHeaderMainEl.classList.add(`current-chat-${currentContact.id}`);
        } else {
            avatarContentHtml = finalAvatarText;
            if (currentContact && currentContact.isSpecial && this.chatHeaderAvatarEl) this.chatHeaderAvatarEl.classList.add('special-avatar', currentContact.id);
            if (currentContact && currentContact.isSpecial && this.chatHeaderMainEl) this.chatHeaderMainEl.classList.add(`current-chat-${currentContact.id}`);
        }
        if (this.chatHeaderAvatarEl) this.chatHeaderAvatarEl.innerHTML = avatarContentHtml;

        const chatSelected = !!ChatManager.currentChatId;
        if (this.chatDetailsButtonEl) {
            this.chatDetailsButtonEl.style.display = chatSelected ? 'block' : 'none';
            this.chatDetailsButtonEl.disabled = !chatSelected;
        }

        // 人员大厅按钮始终可见且启用
        if (this.peopleLobbyButtonEl) {
            this.peopleLobbyButtonEl.style.display = 'block'; // 始终显示
            this.peopleLobbyButtonEl.disabled = false;     // 始终启用
        }
    },

    /**
     * 仅更新聊天头部的状态文本。
     * @param {string} statusText - 新的状态文本。
     */
    updateChatHeaderStatus: function (statusText) {
        if (this.chatHeaderStatusEl) this.chatHeaderStatusEl.textContent = Utils.escapeHtml(statusText);
    },

    /**
     * 启用或禁用聊天输入接口（输入框、发送按钮等）。
     * @param {boolean} enabled - 是否启用。
     */
    enableChatInterface: function (enabled) {
        const elementsToToggle = [
            this.messageInputEl, this.sendButtonEl, this.attachButtonEl,
            this.voiceButtonEl, this.chatDetailsButtonEl, this.screenshotMainBtnEl
        ];
        elementsToToggle.forEach(el => { if (el) el.disabled = !enabled; });

        // 人员大厅按钮始终启用
        if (this.peopleLobbyButtonEl) {
            this.peopleLobbyButtonEl.disabled = false;
        }

        this.setCallButtonsState(enabled && ChatManager.currentChatId ? ConnectionManager.isConnectedTo(ChatManager.currentChatId) : false, ChatManager.currentChatId);

        // 启用时自动聚焦到输入框
        if (enabled && this.messageInputEl) {
            setTimeout(() => {
                if (this.messageInputEl) this.messageInputEl.focus();
            }, 100);
        }
    },

    /**
     * 根据连接状态设置通话按钮的可用性。
     * @param {boolean} enabled - 是否启用通话功能。
     * @param {string|null} peerIdContext - 当前聊天的对方 ID。
     */
    setCallButtonsState: function(enabled, peerIdContext = null) {
        const targetPeerForCall = peerIdContext || ChatManager.currentChatId;
        const isGroupChat = targetPeerForCall?.startsWith('group_');
        const currentContact = UserManager.contacts[targetPeerForCall];
        const isSpecialChat = currentContact && currentContact.isSpecial;
        const canShareScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
        // 最终的启用状态：对方已连接，且不是群聊或特殊联系人。
        const finalEnabledState = enabled && targetPeerForCall && !isGroupChat && !isSpecialChat;

        if (this.videoCallButtonEl) this.videoCallButtonEl.disabled = !finalEnabledState;
        if (this.audioCallButtonEl) this.audioCallButtonEl.disabled = !finalEnabledState;
        if (this.screenShareButtonEl) this.screenShareButtonEl.disabled = !finalEnabledState || !canShareScreen;

        // 更新 onclick 处理程序以确保它们使用正确的对方 ID
        if (finalEnabledState) {
            if (this.videoCallButtonEl) this.videoCallButtonEl.onclick = () => VideoCallManager.initiateCall(targetPeerForCall);
            if (this.audioCallButtonEl) this.audioCallButtonEl.onclick = () => VideoCallManager.initiateAudioCall(targetPeerForCall);
            if (this.screenShareButtonEl && canShareScreen) this.screenShareButtonEl.onclick = () => VideoCallManager.initiateScreenShare(targetPeerForCall);
        } else {
            // 如果禁用，则清除 onclick 以防止过时的调用
            if (this.videoCallButtonEl) this.videoCallButtonEl.onclick = null;
            if (this.audioCallButtonEl) this.audioCallButtonEl.onclick = null;
            if (this.screenShareButtonEl) this.screenShareButtonEl.onclick = null;
        }
    },

    /**
     * 专为 EventEmitter 调用而设计，当特定 peer 的连接状态改变时更新通话按钮。
     * @param {string} peerId - 连接状态发生变化的对方 ID。
     * @param {boolean} enabled - 新的连接状态。
     */
    setCallButtonsStateForPeer: function(peerId, enabled) {
        // 仅当事件针对当前活动的聊天时才更新 UI
        if (ChatManager.currentChatId === peerId) {
            this.setCallButtonsState(enabled, peerId);
        }
    },

    /**
     * 在聊天框中显示一个重连提示。
     * @param {string} peerId - 已断开连接的对方 ID。
     * @param {function} onReconnectSuccess - 重连成功后的回调函数。
     */
    showReconnectPrompt: function (peerId, onReconnectSuccess) {
        if (!this.chatBoxEl) return;
        let promptDiv = this.chatBoxEl.querySelector(`.system-message.reconnect-prompt[data-peer-id="${peerId}"]`);
        const peerName = UserManager.contacts[peerId]?.name || `用户 ${peerId.substring(0, 4)}`;

        // 如果提示已存在，则只更新文本和按钮状态
        if (promptDiv) {
            const textElement = promptDiv.querySelector('.reconnect-prompt-text');
            if (textElement) textElement.textContent = `与 ${Utils.escapeHtml(peerName)} 的连接已断开。`;
            const recBtn = promptDiv.querySelector('.message-inline-action-button:not(.secondary-action)');
            if (recBtn) recBtn.disabled = false;
            return;
        }

        // 创建新的提示元素
        promptDiv = document.createElement('div');
        promptDiv.className = 'system-message reconnect-prompt'; // 'system-message' 是必要的，'reconnect-prompt' 用于特定选择
        promptDiv.setAttribute('data-peer-id', peerId);
        promptDiv.innerHTML = `
<span class="reconnect-prompt-text">与 ${Utils.escapeHtml(peerName)} 的连接已断开。</span>
<button class="message-inline-action-button">重新连接</button>
<button class="message-inline-action-button secondary-action">忽略</button>
    `;
        this.chatBoxEl.appendChild(promptDiv);
        this.chatBoxEl.scrollTop = this.chatBoxEl.scrollHeight;

        const reconnectButton = promptDiv.querySelector('.message-inline-action-button:not(.secondary-action)');
        const cancelButton = promptDiv.querySelector('.message-inline-action-button.secondary-action');
        const textElement = promptDiv.querySelector('.reconnect-prompt-text');
        let successHandler, failHandler;

        // 清理函数，用于移除提示和事件监听器
        const cleanupPrompt = (removeImmediately = false) => {
            EventEmitter.off('connectionEstablished', successHandler);
            EventEmitter.off('connectionFailed', failHandler);
            if (promptDiv && promptDiv.parentNode) {
                if (removeImmediately) promptDiv.remove();
                else setTimeout(() => { if (promptDiv && promptDiv.parentNode) promptDiv.remove(); }, textElement.textContent.includes("失败") ? 5000 : 3000);
            }
        };

        // 定义成功和失败的处理器
        successHandler = (connectedPeerId) => {
            if (connectedPeerId === peerId) {
                if (textElement) textElement.textContent = `已重新连接到 ${Utils.escapeHtml(peerName)}。`;
                if (reconnectButton) reconnectButton.style.display = 'none';
                if (cancelButton) { cancelButton.textContent = '好的'; cancelButton.onclick = () => cleanupPrompt(true); }
                if (typeof onReconnectSuccess === 'function') onReconnectSuccess();
                cleanupPrompt();
            }
        };
        failHandler = (failedPeerId) => {
            if (failedPeerId === peerId) {
                if (textElement) textElement.textContent = `无法重新连接到 ${Utils.escapeHtml(peerName)}。请尝试手动连接或刷新页面。`;
                if (reconnectButton) { reconnectButton.style.display = 'initial'; reconnectButton.disabled = false; }
                if (cancelButton) cancelButton.textContent = '忽略';
            }
        };

        // 绑定事件
        EventEmitter.on('connectionEstablished', successHandler);
        EventEmitter.on('connectionFailed', failHandler);

        if (reconnectButton) {
            reconnectButton.onclick = async () => {
                if (textElement) textElement.textContent = `正在检查信令服务器连接...`;
                reconnectButton.disabled = true;

                let signalingServerNowConnected = false;
                if (ConnectionManager.isWebSocketConnected && ConnectionManager.websocket?.readyState === WebSocket.OPEN) {
                    signalingServerNowConnected = true;
                } else {
                    if (textElement) textElement.textContent = `信令服务器未连接。正在尝试连接...`;
                    try {
                        await ConnectionManager.connectWebSocket();
                        signalingServerNowConnected = ConnectionManager.isWebSocketConnected && ConnectionManager.websocket?.readyState === WebSocket.OPEN;
                    } catch (wsError) {
                        Utils.log(`showReconnectPrompt: 重新连接信令服务器失败: ${wsError.message || wsError}`, Utils.logLevels.ERROR);
                        signalingServerNowConnected = false;
                    }
                }

                if (signalingServerNowConnected) {
                    if (textElement) textElement.textContent = `信令服务器已连接。正在尝试重新连接到 ${Utils.escapeHtml(peerName)} 及其他在线联系人...`;
                    // 调用 autoConnectToAllContacts，它会尝试连接到所有在线的联系人
                    // 包括当前这个 peerId (如果它在线的话)
                    ConnectionManager.autoConnectToAllContacts();
                    // 注意：这里我们不直接 re-enable reconnectButton。
                    // successHandler 或 failHandler 会根据特定 peerId 的连接结果来更新或移除此提示。
                } else {
                    if (textElement) {
                        textElement.innerHTML = `无法连接到信令服务器。请检查您的网络，或尝试使用“菜单与设置”中的<br>“AI 与 API 配置 > 高级选项”进行手动连接。`;
                    }
                    NotificationManager.showNotification('尝试使用“菜单与设置”中的<“AI 与 API 配置 > 高级选项”进行手动连接。', 'error');
                    reconnectButton.disabled = false; // 允许用户再次尝试
                }
            };
        }
        if (cancelButton) {
            cancelButton.onclick = () => cleanupPrompt(true);
        }
    }
};