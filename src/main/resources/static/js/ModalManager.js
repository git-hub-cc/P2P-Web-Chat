/**
 * @file ModalManager.js
 * @description 模态框管理器，负责集中处理应用中所有模态框的显示、隐藏和相关逻辑。
 *              包括设置、新建联系人/群组、通话、确认对话框以及开源信息提示等。
 * @module ModalManager
 * @exports {object} ModalManager - 对外暴露的单例对象，包含所有模态框管理方法。
 * @property {function} init - 初始化模块，获取 DOM 元素并绑定事件。
 * @property {function} toggleModal - 通用的显示/隐藏模态框的方法。
 * @property {function} showConfirmationModal - 显示一个通用的确认对话框。
 * @property {function} showCallingModal - 显示“呼叫中”的模态框。
 * @property {function} showCallRequest - 显示来电请求的模态框。
 * @property {function} showOpenSourceInfoModal - 显示开源信息提示模态框。
 * @property {function} showAddContactModalWithId - 显示添加联系人模态框并预填用户ID。
 * @dependencies Utils, NotificationManager, UserManager, GroupManager, AppInitializer, VideoCallManager
 * @dependents AppInitializer (进行初始化), 各个模块在需要显示模态框时调用。
 */
const ModalManager = {
    // 开源信息模态框元素
    openSourceInfoModal: null,
    closeOpenSourceInfoModalBtn: null,
    permanentlyCloseOpenSourceInfoModalBtn: null,
    openSourceModalTimerSpan: null,
    openSourceModalAutoCloseTimer: null,
    openSourceModalCountdownInterval: null,

    // 其他模态框元素
    mainMenuModal: null,
    newContactGroupModal: null,
    callingModal: null,
    callingModalTitle: null,
    callingModalText: null,
    callingModalAvatar: null,
    callingModalCancelBtn: null,
    videoCallRequestModal: null,

    /**
     * 初始化模态框管理器，获取所有模态框的 DOM 引用并绑定其内部的通用事件。
     */
    init: function() {
        // --- 开源信息模态框 ---
        this.openSourceInfoModal = document.getElementById('openSourceInfoModal');
        this.closeOpenSourceInfoModalBtn = document.getElementById('closeOpenSourceInfoModalBtn');
        this.permanentlyCloseOpenSourceInfoModalBtn = document.getElementById('permanentlyCloseOpenSourceInfoModalBtn');
        this.openSourceModalTimerSpan = document.getElementById('openSourceModalTimer');
        this._bindOpenSourceInfoModalEvents();

        // --- 主菜单/设置模态框 ---
        this.mainMenuModal = document.getElementById('mainMenuModal');
        if (this.mainMenuModal) {
            const closeMainMenuBtn = this.mainMenuModal.querySelector('.close-modal-btn[data-modal-id="mainMenuModal"]');
            if (closeMainMenuBtn) {
                closeMainMenuBtn.addEventListener('click', () => this.toggleModal('mainMenuModal', false));
            }
            // 当点击模态框覆盖层（即非内容区域）时关闭模态框
            this.mainMenuModal.addEventListener('click', (event) => {
                if (event.target === this.mainMenuModal) {
                    this.toggleModal('mainMenuModal', false);
                }
            });
        }

        const mainMenuBtn = document.getElementById('mainMenuBtn');
        if (mainMenuBtn) {
            mainMenuBtn.addEventListener('click', () => {
                this.toggleModal('mainMenuModal', true);
                // 打开主菜单时刷新相关 UI 状态
                if (typeof AppInitializer !== 'undefined' && AppInitializer.refreshNetworkStatusUI) {
                    AppInitializer.refreshNetworkStatusUI();
                }
                if (typeof SettingsUIManager !== 'undefined') {
                    SettingsUIManager.updateMainMenuControlsState();
                }
            });
        }


        // --- 新建联系人/群组模态框 ---
        this.newContactGroupModal = document.getElementById('newContactGroupModal');
        if (this.newContactGroupModal) {
            const closeNewContactGroupModalBtn = this.newContactGroupModal.querySelector('.close-modal-btn[data-modal-id="newContactGroupModal"]');
            if (closeNewContactGroupModalBtn) {
                closeNewContactGroupModalBtn.addEventListener('click', () => this.toggleModal('newContactGroupModal', false));
            }
            // 当点击模态框覆盖层（即非内容区域）时关闭模态框
            this.newContactGroupModal.addEventListener('click', (event) => {
                if (event.target === this.newContactGroupModal) {
                    this.toggleModal('newContactGroupModal', false);
                }
            });
        }

        const newChatFab = document.getElementById('newChatFab');
        if (newChatFab) newChatFab.addEventListener('click', () => this.toggleModal('newContactGroupModal', true));
        // 添加新联系人
        const confirmNewContactBtn = document.getElementById('confirmNewContactBtn');
        if (confirmNewContactBtn) confirmNewContactBtn.addEventListener('click', () => {
            const peerIdInput = document.getElementById('newPeerIdInput'); // 保存引用以便清空
            const peerNameInput = document.getElementById('newPeerNameInput'); // 保存引用以便清空
            const peerId = peerIdInput.value.trim();
            const peerName = peerNameInput.value.trim();
            if (!peerId) {
                NotificationManager.showNotification('对方 ID 是必填项。', 'warning');
                return;
            }
            UserManager.addContact(peerId, peerName || `用户 ${peerId.substring(0, 4)}`);
            peerIdInput.value = ''; // 清空输入框
            peerNameInput.value = ''; // 清空输入框
            this.toggleModal('newContactGroupModal', false);
        });
        // 创建新群组
        const confirmNewGroupBtnModal = document.getElementById('confirmNewGroupBtnModal');
        if (confirmNewGroupBtnModal) confirmNewGroupBtnModal.addEventListener('click', () => {
            const groupNameInput = document.getElementById('newGroupNameInput'); // 保存引用以便清空
            const groupName = groupNameInput.value.trim();
            if (!groupName) {
                NotificationManager.showNotification('群组名称是必填项。', 'warning');
                return;
            }
            GroupManager.createGroup(groupName);
            groupNameInput.value = ''; // 清空输入框
            this.toggleModal('newContactGroupModal', false);
        });

        // --- 通话相关模态框 ---
        this.callingModal = document.getElementById('callingModal');
        this.callingModalTitle = document.getElementById('callingModalTitle');
        this.callingModalText = document.getElementById('callingModalText');
        this.callingModalAvatar = document.getElementById('callingModalAvatar');
        this.callingModalCancelBtn = document.getElementById('callingModalCancelBtn');
        this.videoCallRequestModal = document.getElementById('videoCallRequest');

        // 对于 videoCallRequestModal 和 callingModal，通常不希望点击外部关闭
        // 所以不为它们添加外部点击关闭的逻辑
    },

    /**
     * @private
     * 绑定开源信息模态框的内部事件。
     */
    _bindOpenSourceInfoModalEvents: function () {
        if (this.closeOpenSourceInfoModalBtn) {
            this.closeOpenSourceInfoModalBtn.addEventListener('click', () => this.hideOpenSourceInfoModal());
        }
        if (this.permanentlyCloseOpenSourceInfoModalBtn) {
            this.permanentlyCloseOpenSourceInfoModalBtn.addEventListener('click', () => {
                localStorage.setItem('hideOpenSourceModalPermanently', 'true');
                this.hideOpenSourceInfoModal();
            });
        }
        if (this.openSourceInfoModal) {
            this.openSourceInfoModal.addEventListener('click', (event) => {
                if (event.target === this.openSourceInfoModal) {
                    this.hideOpenSourceInfoModal();
                }
            });
        }
    },

    /**
     * 显示开源信息提示模态框，并启动自动关闭倒计时。
     * 如果用户已选择“不再显示”，则不执行任何操作。
     */
    showOpenSourceInfoModal: function () {
        if (localStorage.getItem('hideOpenSourceModalPermanently') === 'true') {
            return;
        }
        if (this.openSourceInfoModal && this.openSourceModalTimerSpan) {
            this.openSourceInfoModal.style.display = 'flex';
            let countdown = 8;
            this.openSourceModalTimerSpan.textContent = countdown;

            if (this.openSourceModalAutoCloseTimer) clearTimeout(this.openSourceModalAutoCloseTimer);
            if (this.openSourceModalCountdownInterval) clearInterval(this.openSourceModalCountdownInterval);

            this.openSourceModalCountdownInterval = setInterval(() => {
                countdown--;
                this.openSourceModalTimerSpan.textContent = countdown;
                if (countdown <= 0) {
                    clearInterval(this.openSourceModalCountdownInterval);
                }
            }, 1000);

            this.openSourceModalAutoCloseTimer = setTimeout(() => {
                this.hideOpenSourceInfoModal();
            }, 8000);
        } else {
            Utils.log("开源信息模态框元素未找到或未初始化。", Utils.logLevels.WARN);
        }
    },

    /**
     * 隐藏开源信息模态框，并清除相关的定时器。
     */
    hideOpenSourceInfoModal: function () {
        if (this.openSourceInfoModal) {
            this.openSourceInfoModal.style.display = 'none';
        }
        if (this.openSourceModalAutoCloseTimer) clearTimeout(this.openSourceModalAutoCloseTimer);
        if (this.openSourceModalCountdownInterval) clearInterval(this.openSourceModalCountdownInterval);
        this.openSourceModalAutoCloseTimer = null;
        this.openSourceModalCountdownInterval = null;
    },

    /**
     * 通用的显示或隐藏模态框的方法。
     * @param {string} modalId - 目标模态框的 DOM ID。
     * @param {boolean} show - true 为显示，false 为隐藏。
     */
    toggleModal: function (modalId, show) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.style.display = show ? 'flex' : 'none';
        } else {
            Utils.log(`未找到 ID 为 '${modalId}' 的模态框。`, Utils.logLevels.WARN);
        }
    },

    /**
     * 动态创建一个通用的确认对话框。
     * @param {string} message - 对话框中显示的消息文本。
     * @param {function} onConfirm - 用户点击确认按钮时执行的回调函数。
     * @param {function|null} [onCancel=null] - 用户点击取消按钮时执行的回调函数。
     * @param {object} [options={}] - 对话框的自定义选项。
     * @param {string} [options.title='确认操作'] - 对话框标题。
     * @param {string} [options.confirmText='确认'] - 确认按钮的文本。
     * @param {string} [options.cancelText='取消'] - 取消按钮的文本。
     * @param {string} [options.confirmClass='btn-danger'] - 确认按钮的 CSS 类。
     * @param {string} [options.cancelClass='btn-secondary'] - 取消按钮的 CSS 类。
     */
    showConfirmationModal: function (message, onConfirm, onCancel = null, options = {}) {
        const existingModal = document.getElementById('genericConfirmationModal');
        if (existingModal) {
            existingModal.remove();
        }

        const modalId = 'genericConfirmationModal';
        const modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'modal-like confirmation-modal';
        modal.style.display = 'flex';

        const modalContent = document.createElement('div');
        modalContent.className = 'modal-content';

        const modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';
        const titleElement = document.createElement('h2');
        titleElement.textContent = options.title || '确认操作';
        modalHeader.appendChild(titleElement);

        const modalBody = document.createElement('div');
        modalBody.className = 'modal-body';
        const messageParagraph = document.createElement('p');
        messageParagraph.innerHTML = Utils.escapeHtml(message).replace(/\n/g, '<br>');
        modalBody.appendChild(messageParagraph);

        const modalFooter = document.createElement('div');
        modalFooter.className = 'modal-footer';

        const confirmButton = document.createElement('button');
        confirmButton.textContent = options.confirmText || '确认';
        confirmButton.className = `btn ${options.confirmClass || 'btn-danger'}`;
        confirmButton.onclick = () => {
            if (onConfirm) onConfirm();
            modal.remove();
        };

        const cancelButton = document.createElement('button');
        cancelButton.textContent = options.cancelText || '取消';
        cancelButton.className = `btn ${options.cancelClass || 'btn-secondary'}`;
        cancelButton.onclick = () => {
            if (onCancel) onCancel();
            modal.remove();
        };

        modalFooter.appendChild(cancelButton);
        modalFooter.appendChild(confirmButton);
        modalContent.appendChild(modalHeader);
        modalContent.appendChild(modalBody);
        modalContent.appendChild(modalFooter);
        modal.appendChild(modalContent);

        // 点击模态框外部区域关闭
        modal.addEventListener('click', (event) => {
            if (event.target === modal) {
                if (onCancel) onCancel(); // 如果提供了取消回调，则执行
                modal.remove();
            }
        });

        document.body.appendChild(modal);
    },

    /**
     * 显示“呼叫中”的模态框。
     * @param {string} peerName - 对方的名称。
     * @param {function} onCancelCall - 用户点击取消呼叫按钮时执行的回调。
     * @param {function} onStopMusicOnly - （已废弃，但保留以兼容旧调用）用于停止音乐的回调。
     * @param {string} callType - 通话类型（如 "视频通话", "屏幕共享"）。
     */
    showCallingModal: function (peerName, onCancelCall, onStopMusicOnly, callType) {
        if (!this.callingModal || !this.callingModalTitle || !this.callingModalText || !this.callingModalAvatar || !this.callingModalCancelBtn) {
            Utils.log("呼叫中模态框元素未找到！", Utils.logLevels.ERROR);
            return;
        }

        this.callingModalTitle.textContent = `${callType}...`;
        this.callingModalText.textContent = `正在联系 ${Utils.escapeHtml(peerName)}...`;

        let avatarContentHtml;
        const peerContact = UserManager.contacts[VideoCallManager.currentPeerId];
        let fallbackText = (peerContact && peerContact.avatarText) ? Utils.escapeHtml(peerContact.avatarText) :
            (peerName && peerName.length > 0) ? Utils.escapeHtml(peerName.charAt(0).toUpperCase()) : '?';

        this.callingModalAvatar.className = 'video-call-avatar'; // 重置类名
        if (peerContact && peerContact.isSpecial) {
            this.callingModalAvatar.classList.add(peerContact.id);
        }

        if (peerContact && peerContact.avatarUrl) {
            avatarContentHtml = `<img src="${peerContact.avatarUrl}" alt="${fallbackText}" class="avatar-image" data-fallback-text="${fallbackText}" data-entity-id="${peerContact.id}">`;
        } else {
            avatarContentHtml = fallbackText;
        }
        this.callingModalAvatar.innerHTML = avatarContentHtml;
        this.callingModalCancelBtn.onclick = onCancelCall;
        this.callingModal.style.display = 'flex';
    },

    /**
     * 隐藏“呼叫中”的模态框。
     */
    hideCallingModal: function () {
        if (this.callingModal && this.callingModal.style.display !== 'none') {
            this.callingModal.style.display = 'none';
            if (this.callingModalCancelBtn) this.callingModalCancelBtn.onclick = null;
        }
    },

    /**
     * 显示来电请求的模态框。
     * @param {string} peerId - 来电方的 ID。
     * @param {boolean} [audioOnly=false] - 是否为纯音频通话。
     * @param {boolean} [isScreenShare=false] - 是否为屏幕共享请求。
     */
    showCallRequest: function (peerId, audioOnly = false, isScreenShare = false) {
        if (!this.videoCallRequestModal) return;

        const requestTitle = this.videoCallRequestModal.querySelector('h3');
        const requestDesc = this.videoCallRequestModal.querySelector('p');
        const avatarEl = this.videoCallRequestModal.querySelector('.video-call-avatar');
        const acceptBtn = this.videoCallRequestModal.querySelector('.accept-call');
        const rejectBtn = this.videoCallRequestModal.querySelector('.reject-call');

        const peerName = UserManager.contacts[peerId]?.name || `用户 ${peerId.substring(0, 4)}`;
        let avatarContentHtml = (UserManager.contacts[peerId]?.name?.charAt(0).toUpperCase() || 'P');

        const peerContact = UserManager.contacts[peerId];
        if (peerContact && peerContact.avatarUrl) {
            avatarContentHtml = `<img src="${peerContact.avatarUrl}" alt="${Utils.escapeHtml(peerName.charAt(0))}" class="avatar-image">`;
        } else {
            avatarContentHtml = Utils.escapeHtml(avatarContentHtml);
        }
        if (avatarEl) avatarEl.innerHTML = avatarContentHtml;

        let callTypeString = "视频通话";
        if (isScreenShare) callTypeString = "屏幕共享";
        else if (audioOnly) callTypeString = "语音通话";

        if (requestTitle) requestTitle.textContent = `${callTypeString}请求`;
        if (requestDesc) requestDesc.textContent = `${peerName} ${isScreenShare ? '想要共享屏幕' : '正在呼叫'}...`;

        if(acceptBtn) acceptBtn.onclick = () => VideoCallManager.acceptCall();
        if(rejectBtn) rejectBtn.onclick = () => VideoCallManager.rejectCall();

        this.videoCallRequestModal.style.display = 'flex';
    },

    /**
     * 隐藏来电请求的模态框。
     */
    hideCallRequest: function () {
        if (this.videoCallRequestModal) this.videoCallRequestModal.style.display = 'none';
    },

    /**
     * @description 显示添加新联系人模态框，并预填用户ID。
     * @param {string} userId - 要预填的用户ID。
     */
    showAddContactModalWithId: function(userId) {
        this.toggleModal('newContactGroupModal', true);
        const peerIdInput = document.getElementById('newPeerIdInput');
        const peerNameInput = document.getElementById('newPeerNameInput');
        if (peerIdInput) {
            peerIdInput.value = userId;
        }
        if (peerNameInput) {
            peerNameInput.value = ''; // 清空昵称，让用户填写
            peerNameInput.focus();
        }
    }
};