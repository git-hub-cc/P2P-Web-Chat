/**
 * @file ConnectionManager.js
 * @description 核心连接管理器，负责处理 WebRTC 对等连接和与信令服务器的 WebSocket 通信。
 *              实现了心跳机制以保持 WebSocket 活跃，以及指数退避的自动重连策略。
 *              新增：处理消息撤回的P2P信令。自动连接逻辑现在会优先尝试连接在线的好友。
 * @module ConnectionManager
 * @exports {object} ConnectionManager - 对外暴露的单例对象，包含所有连接管理功能。
 * @property {function} initialize - 初始化并连接到 WebSocket 信令服务器。
 * @property {function} createOffer - 创建并发送一个 WebRTC 连接提议给对等端。
 * @property {function} handleRemoteOffer - 处理远端发送的连接提议并创建应答。
 * @property {function} handleRemoteAnswer - 处理远端发送的应答。
 * @property {function} sendTo - 通过已建立的数据通道向指定对等端发送消息。
 * @property {function} close - 关闭与指定对等端的连接。
 * @property {function} resetAllConnections - 重置所有连接和 WebSocket。
 * @property {boolean} isWebSocketConnected - 指示当前是否已连接到 WebSocket 服务器。
 * @dependencies UserManager, ChatManager, Config, Utils, NotificationManager, EventEmitter, LayoutManager, VideoCallManager, ModalManager, MessageManager, PeopleLobbyManager
 * @dependents AppInitializer (初始化), UserManager (自动连接), GroupManager (广播), VideoCallManager (建立媒体流)
 */
const ConnectionManager = {
    connections: {},
    iceCandidates: {},
    connectionTimeouts: {},
    reconnectAttempts: {},
    iceTimers: {},
    iceGatheringStartTimes: {},
    websocket: null,
    isWebSocketConnected: false,
    signalingServerUrl: Config.server.signalingServerUrl,
    pendingSentChunks: {},
    pendingReceivedChunks: {},
    heartbeatInterval: null,
    wsReconnectAttempts: 0,
    MANUAL_PLACEHOLDER_PEER_ID: '_manual_placeholder_peer_id_',

    initialize: function() {
        if (!this.isWebSocketConnected && (!this.websocket || this.websocket.readyState === WebSocket.CLOSED)) {
            this.connectWebSocket();
        }
    },

    connectWebSocket: function() {
        if (this.websocket && (this.websocket.readyState === WebSocket.OPEN || this.websocket.readyState === WebSocket.CONNECTING)) {
            return Promise.resolve();
        }
        LayoutManager.updateConnectionStatusIndicator('正在连接信令服务器...');
        Utils.log('ConnectionManager: 尝试连接到 WebSocket: ' + this.signalingServerUrl, Utils.logLevels.INFO);
        return new Promise((resolve, reject) => {
            try {
                this.websocket = new WebSocket(this.signalingServerUrl);

                this.websocket.onopen = () => {
                    this.isWebSocketConnected = true; this.wsReconnectAttempts = 0;
                    LayoutManager.updateConnectionStatusIndicator('信令服务器已连接。');
                    Utils.log('ConnectionManager: WebSocket 连接已建立。', Utils.logLevels.INFO);
                    this.registerUser(); this.startHeartbeat();
                    EventEmitter.emit('websocketStatusUpdate'); resolve();
                };
                this.websocket.onmessage = (event) => {
                    try {
                        const message = JSON.parse(event.data);
                        if (message.type === 'PONG') { Utils.log('ConnectionManager: 收到 WebSocket 心跳回复 (PONG)', Utils.logLevels.DEBUG); return; }
                        this.handleSignalingMessage(message);
                    } catch (e) { Utils.log('ConnectionManager: 解析信令消息时出错: ' + e, Utils.logLevels.ERROR); }
                };
                this.websocket.onclose = () => {
                    const oldStatus = this.isWebSocketConnected; this.isWebSocketConnected = false; this.stopHeartbeat();
                    this.wsReconnectAttempts++; Utils.log(`ConnectionManager: WebSocket 连接已关闭。正在进行第 ${this.wsReconnectAttempts} 次重连尝试...`, Utils.logLevels.WARN);
                    if (this.wsReconnectAttempts <= 10) {
                        const delay = Math.min(30000, 1000 * Math.pow(2, this.wsReconnectAttempts));
                        LayoutManager.updateConnectionStatusIndicator(`信令服务器已断开。${delay / 1000}秒后尝试重连...`);
                        Utils.log(`ConnectionManager: 下一次重连将在 ${delay / 1000} 秒后。`, Utils.logLevels.WARN);
                        if (oldStatus) EventEmitter.emit('websocketStatusUpdate');
                        setTimeout(() => this.connectWebSocket(), delay);
                    } else {
                        LayoutManager.updateConnectionStatusIndicator('信令服务器连接失败。自动重连已停止。');
                        NotificationManager.showNotification('无法连接到信令服务器。请检查您的网络并手动刷新或重新连接。', 'error');
                        Utils.log('ConnectionManager: 已达到最大重连次数 (10)，停止自动重连。', Utils.logLevels.ERROR);
                        if (oldStatus) EventEmitter.emit('websocketStatusUpdate');
                    }
                };
                this.websocket.onerror = (error) => {
                    Utils.log('ConnectionManager: WebSocket 错误: ' + JSON.stringify(error), Utils.logLevels.ERROR);
                    LayoutManager.updateConnectionStatusIndicator('信令服务器连接错误。');
                    const oldStatus = this.isWebSocketConnected; this.isWebSocketConnected = false;
                    if (oldStatus) EventEmitter.emit('websocketStatusUpdate');
                };
            } catch (error) {
                Utils.log('ConnectionManager: 创建 WebSocket 连接失败: ' + error, Utils.logLevels.ERROR);
                LayoutManager.updateConnectionStatusIndicator('连接信令服务器失败。');
                const oldStatus = this.isWebSocketConnected; this.isWebSocketConnected = false;
                if (oldStatus) EventEmitter.emit('websocketStatusUpdate'); reject(error);
            }
        });
    },

    /**
     * 启动 WebSocket 心跳机制，以保持连接活跃并检测断线。
     */
    startHeartbeat: function() {
        this.stopHeartbeat(); // 确保只有一个心跳定时器在运行
        this.heartbeatInterval = setInterval(() => {
            if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                this.websocket.send(JSON.stringify({ type: 'PING' }));
                Utils.log('ConnectionManager: 发送 WebSocket 心跳 (PING)', Utils.logLevels.DEBUG);
            }
        }, 25000);
    },

    /**
     * 停止 WebSocket 心跳定时器。
     */
    stopHeartbeat: function() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
            Utils.log('ConnectionManager: 已停止 WebSocket 心跳', Utils.logLevels.DEBUG);
        }
    },

    /**
     * 向信令服务器注册当前用户。
     */
    registerUser: function() {
        if (!UserManager.userId) { Utils.log('ConnectionManager: 用户 ID 未设置，无法注册。', Utils.logLevels.ERROR); return; }
        const message = { type: 'REGISTER', userId: UserManager.userId };
        this.sendSignalingMessage(message, false);
    },

    /**
     * 通过 WebSocket 发送信令消息。
     * @param {object} message - 要发送的消息对象。
     * @param {boolean} [isInternalSilentFlag=false] - 是否为内部静默操作，用于控制错误通知的显示。
     */
    sendSignalingMessage: function(message, isInternalSilentFlag = false) {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            const messageString = JSON.stringify(message);
            this.websocket.send(messageString);
            Utils.log(`ConnectionManager: 已发送 WS: ${message.type} 至 ${message.targetUserId || '服务器'} (来自 ${message.userId || 'N/A'}) ${message.sdp ? '[SDP]' : ''} ${message.candidate ? '[ICE]' : ''}`, Utils.logLevels.DEBUG);
        } else {
            Utils.log('ConnectionManager: WebSocket 未连接，无法发送信令消息。', Utils.logLevels.ERROR);
            if (!isInternalSilentFlag) {
                if (window.location.protocol === 'file:') NotificationManager.showNotification('正从本地文件系统运行。信令服务器可能不可用。消息未发送。', 'warning');
                else NotificationManager.showNotification('未连接到信令服务器。消息未发送。', 'error');
            }
        }
    },

    /**
     * 处理从信令服务器接收到的消息。
     * @param {object} message - 从 WebSocket 收到的消息对象。
     */
    handleSignalingMessage: function(message) {
        Utils.log(`ConnectionManager: 已收到 WS: ${message.type} 来自 ${message.fromUserId || '服务器'} ${message.sdp ? '[SDP]' : ''} ${message.candidate ? '[ICE]' : ''}`, Utils.logLevels.DEBUG);
        const fromUserId = message.fromUserId;
        switch (message.type) {
            case 'SUCCESS':
                LayoutManager.updateConnectionStatusIndicator(`用户注册成功: ${UserManager.userId.substring(0,8)}...`);
                this.autoConnectToAllContacts(); break;
            case 'ERROR':
                if (!message.message.includes('不在线')) NotificationManager.showNotification(`信令错误: ${message.message}`, 'error');
                Utils.log(`ConnectionManager: 信令服务器错误: ${message.message}`, Utils.logLevels.ERROR); break;
            case 'OFFER': this.handleRemoteOffer(fromUserId, message.sdp, message.candidates, message.isVideoCall, message.isAudioOnly, message.isScreenShare, message.sdpType); break;
            case 'ANSWER': this.handleRemoteAnswer(fromUserId, message.sdp, message.candidates, message.isVideoCall, message.isAudioOnly, message.isScreenShare, message.sdpType); break;
            case 'ICE_CANDIDATE': this.handleRemoteIceCandidate(fromUserId, message.candidate); break;
            case 'USER_NOT_FOUND':
                const connDetails = this.connections[message.targetUserId]; const wasSilentAttempt = connDetails?.wasInitiatedSilently || false;
                if (!wasSilentAttempt) NotificationManager.showNotification(`用户 ${UserManager.contacts[message.targetUserId]?.name || message.targetUserId.substring(0,8) + '...'} 未找到或离线。`, 'warning');
                Utils.log(`ConnectionManager: 用户 ${message.targetUserId} 未找到。(静默尝试: ${wasSilentAttempt})`, Utils.logLevels.WARN);
                if(ChatManager.currentChatId === message.targetUserId && !wasSilentAttempt && typeof ChatAreaUIManager !== 'undefined') ChatAreaUIManager.updateChatHeaderStatus(`用户未找到或离线`);
                if (this.connections[message.targetUserId]) this.close(message.targetUserId, false); break;
            default: Utils.log('ConnectionManager: 未知的信令消息类型: ' + message.type, Utils.logLevels.WARN);
        }
    },

    /**
     * 初始化或重新初始化与指定对等端的 RTCPeerConnection。
     * @param {string} peerId - 对方的 ID。
     * @param {boolean} [isVideoCall=false] - 这是否是一个视频通话连接。
     * @returns {RTCPeerConnection|null} - 新创建的或 null（如果失败）。
     */
    initConnection: function(peerId, isVideoCall = false) {
        Utils.log(`ConnectionManager: 尝试初始化与 ${peerId} 的连接。视频通话: ${isVideoCall}`, Utils.logLevels.DEBUG);
        const existingConnDetails = this.connections[peerId];
        if (existingConnDetails && existingConnDetails.peerConnection) {
            const pc = existingConnDetails.peerConnection; const pcSignalingState = pc.signalingState;
            if (pcSignalingState === 'have-local-offer' || pcSignalingState === 'have-remote-offer') {
                Utils.log(`ConnectionManager: initConnection: 与 ${peerId} 的连接正在协商中 (信令状态: ${pcSignalingState})。正在复用。`, Utils.logLevels.WARN);
                existingConnDetails.isVideoCall = isVideoCall; if (!isVideoCall && !pc.ondatachannel) pc.ondatachannel = (e) => this.setupDataChannel(e.channel, peerId);
                return pc;
            }
            Utils.log(`ConnectionManager: initConnection: 存在 ${peerId} 的 PC (信令状态: ${pcSignalingState}, 连接状态: ${pc.connectionState})。正在关闭并重新初始化。`, Utils.logLevels.INFO);
            this.close(peerId, false);
        }
        if (peerId === this.MANUAL_PLACEHOLDER_PEER_ID && this.connections[this.MANUAL_PLACEHOLDER_PEER_ID]) {
            Utils.log(`ConnectionManager: 在新的手动初始化之前，明确关闭 ${this.MANUAL_PLACEHOLDER_PEER_ID} 的现有 PC。`, Utils.logLevels.WARN);
            this.close(this.MANUAL_PLACEHOLDER_PEER_ID, false);
        }
        delete this.connections[peerId]; delete this.iceCandidates[peerId]; delete this.reconnectAttempts[peerId];
        if (this.iceTimers[peerId]) clearTimeout(this.iceTimers[peerId]); delete this.iceTimers[peerId]; delete this.iceGatheringStartTimes[peerId];
        Utils.log(`ConnectionManager: 为 ${peerId} 初始化新的 RTCPeerConnection。视频通话: ${isVideoCall}`, Utils.logLevels.INFO);
        try {
            const rtcConfig = Config.peerConnectionConfig;
            Utils.log(`ConnectionManager: 使用配置为 ${peerId} 初始化 RTCPeerConnection: ${JSON.stringify(rtcConfig)}`, Utils.logLevels.DEBUG);
            const newPc = new RTCPeerConnection(rtcConfig);
            this.connections[peerId] = { peerConnection: newPc, dataChannel: null, isVideoCall: isVideoCall, isAudioOnly: false, isScreenShare: false, wasInitiatedSilently: false };
            this.iceCandidates[peerId] = []; this.reconnectAttempts[peerId] = 0;
            newPc.onicecandidate = (e) => this.handleIceCandidate(e, peerId);
            newPc.onicegatheringstatechange = () => this.handleIceGatheringStateChange(peerId);
            newPc.oniceconnectionstatechange = () => this.handleIceConnectionStateChange(peerId);
            newPc.onconnectionstatechange = () => this.handleRtcConnectionStateChange(peerId);
            if (!isVideoCall) newPc.ondatachannel = (e) => this.setupDataChannel(e.channel, peerId);
            return newPc;
        } catch (error) {
            Utils.log(`ConnectionManager: 严重错误: 初始化 ${peerId} 的 PC 失败: ${error.message}\n堆栈: ${error.stack}`, Utils.logLevels.ERROR);
            NotificationManager.showNotification(`为 ${peerId} 设置连接时出错: ${error.message}`, 'error');
            delete this.connections[peerId]; return null;
        }
    },

    /**
     * 创建一个 WebRTC 提议 (offer) 并通过信令服务器发送给对方。
     * @param {string|null} targetPeerId - 目标对方的 ID。如果为 null，会尝试使用当前聊天 ID 或提示输入。
     * @param {object} [options={}] - 连接选项。
     * @param {boolean} [options.isVideoCall=false] - 是否为视频通话。
     * @param {boolean} [options.isAudioOnly=false] - 是否为纯音频通话。
     * @param {boolean} [options.isSilent=false] - 是否为静默操作（不显示通知）。
     * @param {boolean} [options.isManual=false] - 是否为手动连接流程。
     * @returns {Promise<void>}
     */
    createOffer: async function(targetPeerId = null, options = {}) {
        const { isVideoCall = false, isAudioOnly = false, isSilent = false, isManual = false } = options; let promptedForId = false;
        if (isManual) { Utils.log("ConnectionManager: 手动创建提议。", Utils.logLevels.INFO); targetPeerId = this.MANUAL_PLACEHOLDER_PEER_ID; }
        else {
            if (UserManager.isSpecialContact(targetPeerId) && UserManager.contacts[targetPeerId]?.isAI) {
                if (!isSilent) NotificationManager.showNotification(`无法与 ${UserManager.contacts[targetPeerId]?.name || "AI"} 进行 P2P 连接。`, "info");
                else Utils.log(`ConnectionManager: 已跳过向 AI ${UserManager.contacts[targetPeerId]?.name} 发送 P2P 提议。`, Utils.logLevels.DEBUG); return;
            }
            if (!targetPeerId && ChatManager.currentChatId && ChatManager.currentChatId !== UserManager.userId && !ChatManager.currentChatId.startsWith('group_')) targetPeerId = ChatManager.currentChatId;
            if (!targetPeerId && !isSilent) { targetPeerId = prompt('请输入对方 ID:'); promptedForId = true; if (!targetPeerId) { NotificationManager.showNotification("已取消: 未提供对方 ID。", "info"); return; } }
            else if (!targetPeerId && isSilent) { Utils.log("ConnectionManager: 静默创建提议时缺少目标 ID。正在中止。", Utils.logLevels.WARN); return; }
            if (targetPeerId === UserManager.userId) {
                if (!isSilent) NotificationManager.showNotification("无法连接到自己。", "warning"); else Utils.log("ConnectionManager: 已跳过向自己发送提议。", Utils.logLevels.DEBUG);
                if (promptedForId && document.getElementById('modalSdpText')) document.getElementById('modalSdpText').value = "无法连接到自己。"; return;
            }
            if (!UserManager.userId) { if (!isSilent) NotificationManager.showNotification("您的用户 ID 不可用。", "error"); return; }
            if (!this.isWebSocketConnected) {
                try { if (!isSilent) NotificationManager.showNotification("信令服务器未连接。正在尝试...", "info"); await this.connectWebSocket(); }
                catch (e) { if (!isSilent) NotificationManager.showNotification("信令服务器连接失败。无法创建提议。", "error"); return; }
            }
        }
        Utils.log(`ConnectionManager: 正在为 ${targetPeerId} 创建提议，来自: ${UserManager.userId}, 视频: ${isVideoCall}, 纯音频: ${isAudioOnly}, 静默: ${isSilent}, 手动: ${isManual}`, Utils.logLevels.DEBUG);
        const pc = this.initConnection(targetPeerId, isVideoCall);
        if (!pc) { if (!isSilent || isManual) NotificationManager.showNotification("初始化连接以创建提议失败。", "error"); Utils.log(`ConnectionManager: createOffer: initConnection 为 ${targetPeerId} 返回 null。正在中止。`, Utils.logLevels.ERROR); return; }
        if (pc.signalingState === 'have-local-offer') { if (!isSilent) NotificationManager.showNotification(`已向 ${UserManager.contacts[targetPeerId]?.name || targetPeerId.substring(0,6)} 发送过提议。`, "info"); return; }
        if (pc.signalingState === 'have-remote-offer') { if (!isSilent) NotificationManager.showNotification(`已收到对方的提议。无法创建新提议。`, "info"); return; }
        if (this.connections[targetPeerId]) { this.connections[targetPeerId].isVideoCall = isVideoCall; this.connections[targetPeerId].isAudioOnly = isAudioOnly; this.connections[targetPeerId].isScreenShare = options.isScreenShare || false; this.connections[targetPeerId].wasInitiatedSilently = isSilent && !isManual; }
        else if (targetPeerId !== this.MANUAL_PLACEHOLDER_PEER_ID) { this.connections[targetPeerId] = { peerConnection: pc, dataChannel: null, isVideoCall, isAudioOnly, isScreenShare: options.isScreenShare||false, wasInitiatedSilently: isSilent&&!isManual }; }
        if (pc.signalingState === 'stable' || pc.signalingState === 'new') {
            if (!isVideoCall) {
                const connEntry = this.connections[targetPeerId];
                if (!connEntry || !connEntry.dataChannel || connEntry.dataChannel.readyState === 'closed') { const dataChannel = pc.createDataChannel('chatChannel', { reliable: true }); this.setupDataChannel(dataChannel, targetPeerId); }
            } else {
                if (VideoCallManager.localStream) {
                    pc.getSenders().forEach(sender => { if(sender.track) try{pc.removeTrack(sender);}catch(e){Utils.log(`ConnectionManager: 移除旧轨道时出错: ${e}`,Utils.logLevels.WARN);}});
                    VideoCallManager.localStream.getTracks().forEach(track => { if ((track.kind === 'video' && !isAudioOnly) || track.kind === 'audio') pc.addTrack(track, VideoCallManager.localStream); });
                } else Utils.log("ConnectionManager: 视频通话提议时本地流不可用。", Utils.logLevels.WARN);
            }
        }
        try {
            const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: isVideoCall && !isAudioOnly });
            await pc.setLocalDescription(offer);
            Utils.log(`ConnectionManager: 为 ${targetPeerId} 创建提议成功。状态: ${pc.signalingState}。(手动: ${isManual})`, Utils.logLevels.INFO);
            if (!pc.localDescription) { if (!isSilent || isManual) NotificationManager.showNotification("错误: 无法确定本地详情。", "error"); this.close(targetPeerId); return; }
            if (isManual) { this.waitForIceGatheringComplete(targetPeerId, () => { this.updateSdpTextInModal(targetPeerId); NotificationManager.showNotification("提议已创建。请复制信息并发送。", "info"); }); }
            else {
                if (!isSilent && ChatManager.currentChatId === targetPeerId && typeof ChatAreaUIManager !== 'undefined') ChatAreaUIManager.updateChatHeaderStatus(`正在连接到 ${UserManager.contacts[targetPeerId]?.name || targetPeerId.substring(0,8)}...`);
                const offerMessagePayload = { type: 'OFFER', userId: UserManager.userId, targetUserId: targetPeerId, sdp: pc.localDescription.sdp, sdpType: pc.localDescription.type, isVideoCall, isAudioOnly, isScreenShare: options.isScreenShare || false };
                this.sendSignalingMessage(offerMessagePayload, isSilent);
            }
        } catch (error) {
            Utils.log(`ConnectionManager: 为 ${targetPeerId} 创建提议时发生 WebRTC 错误: ${error.message}\n堆栈: ${error.stack}`, Utils.logLevels.ERROR);
            if (!isSilent || isManual) NotificationManager.showNotification(`连接提议错误: ${error.message}`, 'error'); this.close(targetPeerId);
        }
    },

    /**
     * 自动连接到所有非 AI、非自己、未连接且在线的联系人。
     * @returns {Promise<void>}
     */
    autoConnectToAllContacts: async function() {
        // if (!UserManager.userSettings || typeof UserManager.userSettings.autoConnectEnabled === 'undefined') return;
        // if (!UserManager.userSettings.autoConnectEnabled) {
        //     Utils.log("ConnectionManager: 自动连接已禁用。", Utils.logLevels.INFO);
        //     return;
        // }
        Utils.log("ConnectionManager: 尝试自动连接到联系人...", Utils.logLevels.INFO);

        if (typeof PeopleLobbyManager === 'undefined' || typeof PeopleLobbyManager.fetchOnlineUsers !== 'function') {
            Utils.log("ConnectionManager: PeopleLobbyManager 或其 fetchOnlineUsers 方法未定义。无法执行基于在线状态的自动连接。", Utils.logLevels.WARN);
            return;
        }

        const fetchSuccess = await PeopleLobbyManager.fetchOnlineUsers();
        if (!fetchSuccess) {
            Utils.log("ConnectionManager: 获取在线用户列表失败。将不执行基于在线状态的自动连接。", Utils.logLevels.WARN);
            return;
        }

        const onlineUserIdsFromLobby = new Set(PeopleLobbyManager.onlineUserIds || []);
        if (onlineUserIdsFromLobby.size === 0) {
            Utils.log("ConnectionManager: 大厅中没有其他在线用户。无需自动连接。", Utils.logLevels.INFO);
            return;
        }

        if (!UserManager.contacts || Object.keys(UserManager.contacts).length === 0) {
            Utils.log("ConnectionManager: 没有可自动连接的联系人。", Utils.logLevels.INFO);
            return;
        }

        let offerDelay = 0;
        const contactsToPotentiallyConnect = [];

        for (const contactId of Object.keys(UserManager.contacts)) {
            if (contactId === UserManager.userId) continue;

            const contact = UserManager.contacts[contactId];
            if (contact && contact.isAI) continue;

            if (this.isConnectedTo(contactId)) continue;

            const existingConn = this.connections[contactId];
            if (existingConn?.peerConnection &&
                (existingConn.peerConnection.signalingState === 'have-local-offer' ||
                    existingConn.peerConnection.signalingState === 'have-remote-offer' ||
                    existingConn.peerConnection.connectionState === 'connecting' ||
                    existingConn.dataChannel?.readyState === 'connecting')) {
                continue;
            }
            contactsToPotentiallyConnect.push(contactId);
        }

        const contactsToConnect = contactsToPotentiallyConnect.filter(id => onlineUserIdsFromLobby.has(id));

        if (contactsToConnect.length === 0) {
            Utils.log("ConnectionManager: 没有符合自动连接条件的在线联系人。", Utils.logLevels.INFO);
            return;
        }

        Utils.log(`ConnectionManager: 找到 ${contactsToConnect.length} 个符合条件的在线联系人进行自动连接: ${contactsToConnect.join(', ')}`, Utils.logLevels.INFO);

        for (const idToConnect of contactsToConnect) {
            ((id, delay) => {
                setTimeout(async () => {
                    try {
                        Utils.log(`ConnectionManager: 自动连接尝试 -> ${id}`, Utils.logLevels.DEBUG);
                        await this.createOffer(id, { isSilent: true });
                    } catch (error) {
                        Utils.log(`ConnectionManager: 自动连接到 ${id} 时出错: ${error.message}`, Utils.logLevels.WARN);
                    }
                }, delay);
            })(idToConnect, offerDelay);
            offerDelay += 300; // 稍微增加延迟以避免瞬间大量请求
        }
    },

    /**
     * 手动处理粘贴的应答 (answer) 信息。
     * @param {object} [options={}] - 选项。
     * @param {boolean} [options.isManual=false] - 必须为 true。
     * @returns {Promise<void>}
     */
    handleAnswer: async function(options = {}) {
        const { isManual = false } = options; if (!isManual) return;
        const sdpTextEl = document.getElementById('modalSdpText');
        if (!sdpTextEl || !sdpTextEl.value) { NotificationManager.showNotification("请先粘贴应答信息。", "warning"); return; }
        try {
            const answerData = JSON.parse(sdpTextEl.value); sdpTextEl.value = '';
            if (!answerData.sdp?.sdp || answerData.sdp.type !== 'answer' || !answerData.userId) { NotificationManager.showNotification("无效的应答数据格式。", "error"); return; }
            if (answerData.userId === UserManager.userId) { NotificationManager.showNotification("无法处理来自自己的应答。", "warning"); return; }
            const fromUserId = answerData.userId;
            const placeholderConn = this.connections[this.MANUAL_PLACEHOLDER_PEER_ID];
            if (!placeholderConn?.peerConnection) { NotificationManager.showNotification(`错误: 未找到待处理的手动提议。`, "error"); return; }
            this.connections[fromUserId] = placeholderConn; delete this.connections[this.MANUAL_PLACEHOLDER_PEER_ID];
            ['iceCandidates', 'reconnectAttempts', 'iceTimers', 'iceGatheringStartTimes', 'connectionTimeouts'].forEach(storeKey => { if (this[storeKey]?.[this.MANUAL_PLACEHOLDER_PEER_ID]) { this[storeKey][fromUserId] = this[storeKey][this.MANUAL_PLACEHOLDER_PEER_ID]; delete this[storeKey][this.MANUAL_PLACEHOLDER_PEER_ID]; }});
            const pc = placeholderConn.peerConnection;
            if (pc.signalingState !== 'have-local-offer') {
                if (pc.signalingState === 'stable' && this.isConnectedTo(fromUserId)) NotificationManager.showNotification(`已连接到 ${fromUserId}。`, "info");
                else NotificationManager.showNotification(`错误: 与 ${fromUserId} 的连接处于意外状态 (${pc.signalingState})。`, "error");
                ModalManager.toggleModal('mainMenuModal', false); return;
            }
            await this.handleRemoteAnswer(fromUserId, answerData.sdp.sdp, answerData.candidates, placeholderConn.isVideoCall, placeholderConn.isAudioOnly, placeholderConn.isScreenShare, 'answer');
            if (fromUserId !== UserManager.userId && !UserManager.contacts[fromUserId]) await UserManager.addContact(fromUserId, `用户 ${fromUserId.substring(0,4)}`);
            NotificationManager.showNotification(`正在处理来自 ${UserManager.contacts[fromUserId]?.name || fromUserId.substring(0,6)} 的应答...`, "info");
            ModalManager.toggleModal('mainMenuModal', false);
        } catch (e) { NotificationManager.showNotification("处理应答时出错: " + e.message, "error"); Utils.log("ConnectionManager.handleAnswer (手动) 出错: " + e, Utils.logLevels.ERROR); }
    },

    /**
     * 处理远程应答 (answer)。
     * @param {string} fromUserId - 发送方的 ID。
     * @param {string} sdpString - SDP 字符串。
     * @param {RTCIceCandidate[]} candidates - 对方的 ICE 候选者。
     * @param {boolean} isVideoCallFlag - 是否为视频通话。
     * @param {boolean} isAudioOnlyFlag - 是否为纯音频通话。
     * @param {boolean} isScreenShareFlag - 是否为屏幕共享。
     * @param {string} sdpType - SDP 类型 (应为 'answer')。
     * @returns {Promise<void>}
     */
    handleRemoteAnswer: async function(fromUserId, sdpString, candidates, isVideoCallFlag, isAudioOnlyFlag, isScreenShareFlag, sdpType) {
        const conn = this.connections[fromUserId];
        if (!conn?.peerConnection) { Utils.log(`ConnectionManager: handleRemoteAnswer: 没有 ${fromUserId} 的活动连接。`, Utils.logLevels.WARN); return; }
        const pc = conn.peerConnection; const wasSilentContext = conn.wasInitiatedSilently || false;
        if (sdpType !== 'answer') { if (!wasSilentContext) NotificationManager.showNotification(`协议错误: 应为 answer 类型的 SDP。`, 'error'); this.close(fromUserId); return; }
        if (pc.signalingState !== 'have-local-offer') {
            if (!wasSilentContext) {
                if (pc.signalingState === 'stable' && this.isConnectedTo(fromUserId)) Utils.log(`ConnectionManager: 与 ${fromUserId} 的连接已稳定。应答可能延迟到达。`, Utils.logLevels.INFO);
                else NotificationManager.showNotification(`处理 ${fromUserId} 的应答时连接状态错误。状态: ${pc.signalingState}。`, 'error');
            } return;
        }
        try {
            if (typeof sdpString !== 'string') { this.close(fromUserId); return; }
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: sdpString }));
            if (candidates && Array.isArray(candidates)) {
                for (const candidate of candidates) {
                    if (candidate && typeof candidate === 'object' && pc.remoteDescription && pc.signalingState !== 'closed') {
                        await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => Utils.log(`ConnectionManager: 为 ${fromUserId} 添加来自应答的远程 ICE 时出错: ${e}`, Utils.logLevels.WARN));
                    }
                }
            }
        } catch (error) {
            Utils.log(`ConnectionManager: 为 ${fromUserId} 设置远程应答/ICE 失败: ${error.message} (状态: ${pc.signalingState})`, Utils.logLevels.ERROR);
            if (!wasSilentContext) NotificationManager.showNotification(`处理应答时出错: ${error.message}`, 'error'); this.close(fromUserId);
        }
    },

    /**
     * 手动创建应答 (answer)。
     * @param {object} [options={}] - 选项。
     * @param {boolean} [options.isManual=false] - 必须为 true。
     * @returns {Promise<void>}
     */
    createAnswer: async function(options = {}) {
        const { isManual = false } = options; if (!isManual) return;
        const sdpTextEl = document.getElementById('modalSdpText');
        if (!sdpTextEl || !sdpTextEl.value) { NotificationManager.showNotification("请先粘贴提议信息。", "warning"); return; }
        try {
            const offerData = JSON.parse(sdpTextEl.value);
            if (!offerData.sdp?.sdp || offerData.sdp.type !== 'offer' || !offerData.userId) { NotificationManager.showNotification("无效的提议数据格式。", "error"); return; }
            if (offerData.userId === UserManager.userId) { NotificationManager.showNotification("无法处理来自自己的提议。", "warning"); return; }
            const fromUserId = offerData.userId; sdpTextEl.value = '正在生成应答...';
            const pc = this.initConnection(fromUserId, offerData.isVideoCall || false);
            if (!pc) { NotificationManager.showNotification("初始化连接以创建应答失败。", "error"); sdpTextEl.value = '错误: 初始化连接失败。'; return; }
            if(this.connections[fromUserId]){ this.connections[fromUserId].wasInitiatedSilently = false; this.connections[fromUserId].isVideoCall = offerData.isVideoCall||false; this.connections[fromUserId].isAudioOnly = offerData.isAudioOnly||false; this.connections[fromUserId].isScreenShare = offerData.isScreenShare||false; }
            await this.handleRemoteOffer(fromUserId, offerData.sdp.sdp, offerData.candidates, offerData.isVideoCall, offerData.isAudioOnly, offerData.isScreenShare, 'offer', true);
            NotificationManager.showNotification("已开始生成应答。模态框内容将会更新。", "info");
        } catch (e) { NotificationManager.showNotification("创建应答时出错: " + e.message, "error"); Utils.log("ConnectionManager.createAnswer (手动) 出错: " + e, Utils.logLevels.ERROR); if(sdpTextEl) sdpTextEl.value = `错误: ${e.message}`; }
    },

    /**
     * 处理远程提议 (offer)。
     * @param {string} fromUserId - 发送方的 ID。
     * @param {string} sdpString - SDP 字符串。
     * @param {RTCIceCandidate[]} candidates - 对方的 ICE 候选者。
     * @param {boolean} isVideoCall - 是否为视频通话。
     * @param {boolean} isAudioOnly - 是否为纯音频通话。
     * @param {boolean} isScreenShare - 是否为屏幕共享。
     * @param {string} sdpType - SDP 类型 (应为 'offer')。
     * @param {boolean} [isManualFlow=false] - 是否为手动流程。
     * @returns {Promise<void>}
     */
    handleRemoteOffer: async function(fromUserId, sdpString, candidates, isVideoCall, isAudioOnly, isScreenShare, sdpType, isManualFlow = false) {
        if (isManualFlow && fromUserId !== UserManager.userId && !UserManager.contacts[fromUserId]) await UserManager.addContact(fromUserId, `用户 ${fromUserId.substring(0,4)}`);
        let pc = this.connections[fromUserId]?.peerConnection;
        if (!pc || (!isManualFlow && pc.signalingState !== 'stable' && pc.signalingState !== 'new')) pc = this.initConnection(fromUserId, isVideoCall);
        if (!pc) { NotificationManager.showNotification("初始化连接以处理提议失败。", "error"); return; }
        if(this.connections[fromUserId]){ this.connections[fromUserId].wasInitiatedSilently = this.connections[fromUserId].wasInitiatedSilently && !isManualFlow; this.connections[fromUserId].isVideoCall = isVideoCall; this.connections[fromUserId].isAudioOnly = isAudioOnly; this.connections[fromUserId].isScreenShare = isScreenShare||false; }
        try {
            if (typeof sdpString !== 'string' || sdpType !== 'offer') { this.close(fromUserId); return; }
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sdpString }));
            if (candidates && Array.isArray(candidates)) {
                for (const candidate of candidates) { if (candidate && typeof candidate === 'object' && pc.remoteDescription && pc.signalingState !== 'closed') await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => Utils.log(`ConnectionManager: 为 ${fromUserId} 添加来自提议的远程 ICE 时出错: ${e}`, Utils.logLevels.WARN)); }
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            if (!pc.localDescription) { this.close(fromUserId); return; }
            if (isManualFlow) { this.waitForIceGatheringComplete(fromUserId, () => { this.updateSdpTextInModal(fromUserId); NotificationManager.showNotification("应答已创建。请复制信息并发送。", "info"); }); }
            else {
                const answerPayload = { type: 'ANSWER', userId: UserManager.userId, targetUserId: fromUserId, sdp: pc.localDescription.sdp, sdpType: pc.localDescription.type, isVideoCall: this.connections[fromUserId]?.isVideoCall||false, isAudioOnly: this.connections[fromUserId]?.isAudioOnly||false, isScreenShare: this.connections[fromUserId]?.isScreenShare||false };
                this.sendSignalingMessage(answerPayload, false);
            }
        } catch (error) { Utils.log(`ConnectionManager: 处理来自 ${fromUserId} 的远程提议失败: ${error.message}\n堆栈: ${error.stack}`, Utils.logLevels.ERROR); NotificationManager.showNotification(`处理提议时出错: ${error.message}`, 'error'); this.close(fromUserId); }
    },

    /**
     * 处理远程 ICE 候选者。
     * @param {string} fromUserId - 发送方的 ID。
     * @param {RTCIceCandidate} candidate - ICE 候选者对象。
     * @returns {Promise<void>}
     */
    handleRemoteIceCandidate: async function(fromUserId, candidate) {
        const conn = this.connections[fromUserId];
        if (conn?.peerConnection?.remoteDescription && conn.peerConnection.signalingState !== 'closed') {
            try { if (candidate && typeof candidate === 'object' && (candidate.candidate || candidate.sdpMid || candidate.sdpMLineIndex !== undefined)) await conn.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); }
            catch (error) { Utils.log(`ConnectionManager: 添加来自 ${fromUserId} 的远程 ICE 时出错 (状态: ${conn.peerConnection.signalingState}): ${error}`, Utils.logLevels.WARN); }
        }
    },

    /**
     * RTCPeerConnection 的 onicecandidate 事件处理器。
     * @param {RTCPeerConnectionIceEvent} event - 事件对象。
     * @param {string} peerId - 相关的对方 ID。
     */
    handleIceCandidate: function(event, peerId) {
        if (event.candidate) {
            if (!this.iceCandidates[peerId]) this.iceCandidates[peerId] = [];
            this.iceCandidates[peerId].push(event.candidate.toJSON());
            const connData = this.connections[peerId];
            const isManualContext = peerId === this.MANUAL_PLACEHOLDER_PEER_ID || (connData && connData.wasInitiatedSilently === false && (document.getElementById('modalCreateOfferBtn')?.disabled || document.getElementById('modalCreateAnswerBtn')?.disabled));
            if (!isManualContext && peerId !== this.MANUAL_PLACEHOLDER_PEER_ID) {
                const sendSilently = connData?.wasInitiatedSilently || false;
                this.sendSignalingMessage({ type: 'ICE_CANDIDATE', userId: UserManager.userId, targetUserId: peerId, candidate: event.candidate.toJSON() }, sendSilently);
            }
        }
    },

    /**
     * 等待 ICE 收集完成或超时。
     * @param {string} peerId - 相关的对方 ID。
     * @param {function} callback - 完成或超时后执行的回调。
     */
    waitForIceGatheringComplete: function(peerId, callback) {
        const pc = this.connections[peerId]?.peerConnection; if (!pc) { if (typeof callback === 'function') callback(); return; }
        if (this.iceTimers[peerId]) { clearTimeout(this.iceTimers[peerId]); delete this.iceTimers[peerId]; }
        if (pc.iceGatheringState === 'complete') { if (typeof callback === 'function') callback(); }
        else {
            this.iceGatheringStartTimes[peerId] = Date.now(); let checkInterval;
            const onDone = () => { if(checkInterval) clearInterval(checkInterval); checkInterval=null; const timerExists = !!this.iceTimers[peerId]; if (this.iceTimers[peerId]) { clearTimeout(this.iceTimers[peerId]); delete this.iceTimers[peerId]; } if (typeof callback === 'function' && timerExists) callback(); };
            this.iceTimers[peerId] = setTimeout(() => { Utils.log(`ConnectionManager: 为 ${peerId} 的 ICE 收集超时。继续执行。状态: ${pc.iceGatheringState}`, Utils.logLevels.WARN); onDone(); }, Config.timeouts.iceGathering);
            checkInterval = setInterval(() => { if (!this.connections[peerId]?.peerConnection) { if(checkInterval) clearInterval(checkInterval); if (this.iceTimers[peerId]) clearTimeout(this.iceTimers[peerId]); delete this.iceTimers[peerId]; return; } if (this.connections[peerId].peerConnection.iceGatheringState === 'complete') onDone(); }, 200);
        }
    },

    /**
     * 设置数据通道的事件处理器。
     * @param {RTCDataChannel} channel - 数据通道对象。
     * @param {string} peerIdArg - 相关的对方 ID。
     */
    setupDataChannel: function(channel, peerIdArg) {
        let currentContextPeerId = peerIdArg;
        if (currentContextPeerId === this.MANUAL_PLACEHOLDER_PEER_ID) channel._isManualPlaceholderChannel = true;
        if (!this.connections[currentContextPeerId]) { try { channel.close(); } catch(e){ /*忽略*/ } return; }
        if (this.connections[currentContextPeerId].dataChannel && this.connections[currentContextPeerId].dataChannel !== channel && this.connections[currentContextPeerId].dataChannel.readyState === 'open') { try { channel.close(); } catch(e) {} return; }
        if (this.connections[currentContextPeerId].dataChannel === channel && channel._listenersAttached) return;
        this.connections[currentContextPeerId].dataChannel = channel; channel._listenersAttached = true;
        const wasSilentContext = this.connections[currentContextPeerId]?.wasInitiatedSilently || false;

        channel.onopen = async () => {
            let finalPeerId = currentContextPeerId;
            if (channel._isManualPlaceholderChannel) { for (const actualIdInMap in this.connections) if (this.connections[actualIdInMap]?.dataChannel === channel) { finalPeerId = actualIdInMap; break; } }
            Utils.log(`ConnectionManager: 与 ${finalPeerId} 的数据通道 ("${channel.label}") 已打开。(静默: ${this.connections[finalPeerId]?.wasInitiatedSilently || false})`, Utils.logLevels.INFO);
            const contactName = UserManager.contacts[finalPeerId]?.name || finalPeerId.substring(0,8) + '...';
            if ((!this.connections[finalPeerId]?.wasInitiatedSilently || ChatManager.currentChatId === finalPeerId) && typeof ChatAreaUIManager !== 'undefined') ChatAreaUIManager.updateChatHeaderStatus(`已连接到 ${contactName}`);
            if (finalPeerId !== UserManager.userId && finalPeerId !== this.MANUAL_PLACEHOLDER_PEER_ID && !UserManager.contacts[finalPeerId]) await UserManager.addContact(finalPeerId, `用户 ${finalPeerId.substring(0,4)}`);
            else if (channel._isManualPlaceholderChannel && finalPeerId !== UserManager.userId && finalPeerId !== this.MANUAL_PLACEHOLDER_PEER_ID && (ChatManager.currentChatId === null || ChatManager.currentChatId === this.MANUAL_PLACEHOLDER_PEER_ID || ChatManager.currentChatId === currentContextPeerId)) ChatManager.openChat(finalPeerId, 'contact');
            EventEmitter.emit('connectionEstablished', finalPeerId);
            if (ChatManager.currentChatId === finalPeerId && this.connections[finalPeerId] && !this.connections[finalPeerId].isVideoCall && typeof ChatAreaUIManager !== 'undefined') ChatAreaUIManager.setCallButtonsState(true, finalPeerId);
            if (this.reconnectAttempts[finalPeerId] !== undefined) this.reconnectAttempts[finalPeerId] = 0;
        };
        channel.onclose = () => {
            let finalPeerId = currentContextPeerId; if (channel._isManualPlaceholderChannel) for (const actualId in this.connections) if(this.connections[actualId]?.dataChannel === channel) {finalPeerId=actualId;break;}
            const pcState = this.connections[finalPeerId]?.peerConnection?.connectionState;
            if (pcState !== 'closed' && pcState !== 'failed') EventEmitter.emit('connectionDisconnected', finalPeerId);
            if (ChatManager.currentChatId === finalPeerId && typeof ChatAreaUIManager !== 'undefined') { ChatAreaUIManager.setCallButtonsState(false); if (!this.connections[finalPeerId]?.wasInitiatedSilently) ChatAreaUIManager.updateChatHeaderStatus(`已断开连接`); }
            if (this.connections[finalPeerId]?.dataChannel === channel) this.connections[finalPeerId].dataChannel = null; channel._listenersAttached = false;
        };
        channel.onerror = (error) => { let finalPeerId=currentContextPeerId; if(channel._isManualPlaceholderChannel)for(const id in this.connections)if(this.connections[id]?.dataChannel===channel){finalPeerId=id;break;} Utils.log(`ConnectionManager: 与 ${finalPeerId} 的数据通道 ("${channel.label}") 发生错误: ${JSON.stringify(error)}`, Utils.logLevels.ERROR);};

        channel.onmessage = (event) => {
            let finalPeerId = currentContextPeerId;
            if (channel._isManualPlaceholderChannel) {
                let resolved = false;
                for (const actualId in this.connections) {
                    if (this.connections[actualId]?.dataChannel === channel) {
                        finalPeerId = actualId; resolved = true; break;
                    }
                }
                if (!resolved) {
                    Utils.log(`ConnectionManager: DataChannel onmessage: 无法解析手动占位符通道的 finalPeerId。`, Utils.logLevels.WARN);
                    return;
                }
            }

            try {
                const rawMessage = event.data;
                let messageObjectToProcess;
                let parsedJson;

                if (typeof rawMessage === 'string') {
                    try { parsedJson = JSON.parse(rawMessage); } catch (e) {
                        messageObjectToProcess = { type: 'text', content: rawMessage, sender: finalPeerId, timestamp: new Date().toISOString(), id: `text_${Date.now()}_${Utils.generateId(3)}` };
                    }
                } else {
                    Utils.log(`ConnectionManager: 收到来自 ${finalPeerId} 的非字符串数据类型，当前不支持。`, Utils.logLevels.WARN);
                    return;
                }

                if (parsedJson) {
                    if (parsedJson.type === 'chunk-meta' || parsedJson.type === 'chunk-data') {
                        const reassembledData = Utils.reassembleChunk(parsedJson, finalPeerId);
                        if (reassembledData) {
                            messageObjectToProcess = reassembledData;
                            // 再次检查重组后的数据类型
                            if (messageObjectToProcess.type === 'retract-message-request') {
                                Utils.log(`ConnectionManager: (重组后) 收到来自 ${finalPeerId} 的消息撤回请求: ${JSON.stringify(messageObjectToProcess)}`, Utils.logLevels.INFO);
                                const senderName = messageObjectToProcess.senderName || UserManager.contacts[messageObjectToProcess.sender]?.name || `用户 ${String(messageObjectToProcess.sender).substring(0,4)}`;
                                MessageManager._updateMessageToRetractedState(messageObjectToProcess.originalMessageId, messageObjectToProcess.sender, false, senderName);
                                ConnectionManager.sendTo(messageObjectToProcess.sender, { type: 'retract-message-confirm', originalMessageId: messageObjectToProcess.originalMessageId, sender: UserManager.userId });
                                return;
                            }
                        } else {
                            return; // 分片未完成
                        }
                    } else if (parsedJson.type === 'retract-message-request') {
                        Utils.log(`ConnectionManager: 收到来自 ${finalPeerId} 的消息撤回请求: ${JSON.stringify(parsedJson)}`, Utils.logLevels.INFO);
                        const senderName = parsedJson.senderName || UserManager.contacts[parsedJson.sender]?.name || `用户 ${String(parsedJson.sender).substring(0,4)}`;
                        MessageManager._updateMessageToRetractedState(parsedJson.originalMessageId, parsedJson.sender, false, senderName);
                        ConnectionManager.sendTo(parsedJson.sender, { type: 'retract-message-confirm', originalMessageId: parsedJson.originalMessageId, sender: UserManager.userId });
                        return;
                    } else if (parsedJson.type === 'retract-message-confirm') {
                        Utils.log(`ConnectionManager: 收到来自 ${finalPeerId} 的消息撤回确认 (ID: ${parsedJson.originalMessageId})。本地UI已乐观更新。`, Utils.logLevels.INFO);
                        // EventEmitter.emit(`retractConfirmed_${parsedJson.originalMessageId}`); // 如果实现了超时确认，则在此处触发
                        return;
                    } else {
                        messageObjectToProcess = parsedJson;
                    }
                }

                if (!messageObjectToProcess) {
                    Utils.log(`ConnectionManager: 来自 ${finalPeerId} 的数据通道 onmessage：无法确定消息对象。原始数据: ${String(rawMessage).substring(0,100)}`, Utils.logLevels.WARN);
                    return;
                }

                messageObjectToProcess.sender = messageObjectToProcess.sender || finalPeerId;
                if (!messageObjectToProcess.id) messageObjectToProcess.id = `msg_${Date.now()}_${Utils.generateId(4)}`;

                if (messageObjectToProcess.type?.startsWith('video-call-')) {
                    VideoCallManager.handleMessage(messageObjectToProcess, finalPeerId);
                } else if (messageObjectToProcess.groupId || messageObjectToProcess.type?.startsWith('group-')) {
                    GroupManager.handleGroupMessage(messageObjectToProcess);
                } else {
                    ChatManager.addMessage(finalPeerId, messageObjectToProcess); // 注意: P2P chatId 是 finalPeerId
                }
            } catch (e) {
                Utils.log(`ConnectionManager: 来自 ${finalPeerId} 的数据通道 onmessage 严重错误: ${e.message}. 数据: ${String(event.data).substring(0,100)} 堆栈: ${e.stack}`, Utils.logLevels.ERROR);
            }
        };
    },

    /**
     * 处理 iceConnectionState 变化。
     * @param {string} peerId - 相关的对方 ID。
     */
    handleIceConnectionStateChange: function(peerId) {
        const conn = this.connections[peerId]; if (!conn?.peerConnection) return; const pc = conn.peerConnection; const wasSilentContext = conn.wasInitiatedSilently || false;
        switch (pc.iceConnectionState) {
            case 'connected': case 'completed': if (this.reconnectAttempts[peerId] !== undefined) this.reconnectAttempts[peerId] = 0; break;
            case 'disconnected': EventEmitter.emit('connectionDisconnected', peerId); if (!conn.isVideoCall) this.attemptReconnect(peerId); break;
            case 'failed': if (!wasSilentContext) NotificationManager.showNotification(`与 ${UserManager.contacts[peerId]?.name || peerId.substring(0,8)} 的连接失败。`, 'error'); EventEmitter.emit('connectionFailed', peerId); this.close(peerId, false); break;
            case 'closed': if (this.connections[peerId]) this.close(peerId, false); break;
        }
    },

    /**
     * 处理 connectionState 变化 (更新的 API)。
     * @param {string} peerId - 相关的对方 ID。
     */
    handleRtcConnectionStateChange: function(peerId) {
        const conn = this.connections[peerId]; if(!conn?.peerConnection) return; const pc = conn.peerConnection; const wasSilentContext = conn.wasInitiatedSilently || false;
        switch (pc.connectionState) {
            case "connected": if (this.reconnectAttempts[peerId] !== undefined) this.reconnectAttempts[peerId] = 0; if ((conn.isVideoCall || (conn.dataChannel?.readyState === 'open')) && !conn._emittedEstablished) { EventEmitter.emit('connectionEstablished', peerId); conn._emittedEstablished = true; } break;
            case "disconnected": EventEmitter.emit('connectionDisconnected', peerId); if (!conn.isVideoCall) this.attemptReconnect(peerId); conn._emittedEstablished = false; break;
            case "failed": if (!wasSilentContext) NotificationManager.showNotification(`与 ${UserManager.contacts[peerId]?.name || peerId.substring(0,8)} 的连接严重失败。`, 'error'); EventEmitter.emit('connectionFailed', peerId); this.close(peerId, false); conn._emittedEstablished = false; break;
            case "closed": conn._emittedEstablished = false; break;
        }
    },

    /**
     * 尝试重新连接断开的对等端。
     * @param {string} peerId - 要重连的对方 ID。
     */
    attemptReconnect: function(peerId) {
        const conn = this.connections[peerId]; if (!conn || conn.isVideoCall || this.isConnectedTo(peerId) || conn.peerConnection?.connectionState === 'connecting') return;
        this.reconnectAttempts[peerId] = (this.reconnectAttempts[peerId] || 0) + 1;
        if (this.reconnectAttempts[peerId] <= Config.reconnect.maxAttempts) {
            const delay = Config.reconnect.delay * Math.pow(Config.reconnect.backoffFactor, this.reconnectAttempts[peerId] -1);
            if (this.connectionTimeouts[peerId]) clearTimeout(this.connectionTimeouts[peerId]);
            this.connectionTimeouts[peerId] = setTimeout(async () => {
                delete this.connectionTimeouts[peerId]; const currentConn = this.connections[peerId];
                if (currentConn && !this.isConnectedTo(peerId) && currentConn.peerConnection && currentConn.peerConnection.connectionState !== 'connecting' && currentConn.peerConnection.signalingState !== 'have-local-offer' && currentConn.peerConnection.signalingState !== 'have-remote-offer' ) {
                    if (['failed','closed','disconnected'].includes(currentConn.peerConnection.connectionState)) this.close(peerId,false);
                    await this.createOffer(peerId, {isSilent: true});
                } else if (this.isConnectedTo(peerId)) if (this.reconnectAttempts[peerId] !== undefined) this.reconnectAttempts[peerId] = 0;
            }, delay);
        } else this.close(peerId, false);
    },

    /**
     * 通过数据通道向指定对等端发送消息，并处理分片逻辑。
     * @param {string} peerId - 接收方的 ID。
     * @param {object} messageObject - 要发送的消息对象。
     * @returns {boolean} - 消息是否成功（排入）发送。
     */
    sendTo: function(peerId, messageObject) {
        const conn = this.connections[peerId];
        if (conn?.dataChannel?.readyState === 'open') {
            try {
                messageObject.sender = messageObject.sender || UserManager.userId; messageObject.timestamp = messageObject.timestamp || new Date().toISOString();
                const messageString = JSON.stringify(messageObject);
                if (messageString.length > Config.chunkSize) Utils.sendInChunks(messageString, (chunk) => conn.dataChannel.send(chunk), peerId, (messageObject.type === 'file' || messageObject.type === 'audio') ? (messageObject.fileId || messageObject.fileName || `blob-${Date.now()}`) : undefined );
                else conn.dataChannel.send(messageString); return true;
            } catch (error) { Utils.log(`ConnectionManager: 通过数据通道向 ${peerId} 发送时出错: ${error}`, Utils.logLevels.ERROR); return false; }
        } else { Utils.log(`ConnectionManager: 无法发送到 ${peerId}: 数据通道未打开/不存在。DC: ${conn?.dataChannel?.readyState}, PC: ${conn?.peerConnection?.connectionState}`, Utils.logLevels.WARN); return false; }
    },

    /**
     * 检查是否与指定对等端建立了有效连接。
     * @param {string} peerId - 要检查的对方 ID。
     * @returns {boolean} - 是否已连接。
     */
    isConnectedTo: function(peerId) {
        if (UserManager.isSpecialContact(peerId) && UserManager.contacts[peerId]?.isAI) return true;
        const conn = this.connections[peerId]; if (!conn?.peerConnection) return false;
        const pcOverallState = conn.peerConnection.connectionState;
        if (pcOverallState === 'connected') { if (conn.isVideoCall || (conn.dataChannel?.readyState === 'open')) return true; }
        return false;
    },

    /**
     * 关闭与指定对等端的连接。
     * @param {string} peerId - 要关闭连接的对方 ID。
     * @param {boolean} [notifyPeer=true] - 是否通知对方连接已关闭（当前未使用）。
     */
    close: function(peerId, notifyPeer = true) {
        const conn = this.connections[peerId];
        if (conn) {
            if (this.connectionTimeouts[peerId]) { clearTimeout(this.connectionTimeouts[peerId]); delete this.connectionTimeouts[peerId]; }
            if (this.iceTimers[peerId]) { clearTimeout(this.iceTimers[peerId]); delete this.iceTimers[peerId]; }
            if (conn.dataChannel) { try { conn.dataChannel.onopen=null; conn.dataChannel.onmessage=null; conn.dataChannel.onerror=null; const co=conn.dataChannel.onclose; conn.dataChannel.onclose=()=>{if(typeof co==='function')co();}; if(conn.dataChannel.readyState!=='closed')conn.dataChannel.close(); } catch (e) {} }
            if (conn.peerConnection) { try { conn.peerConnection.onicecandidate=null; conn.peerConnection.onicegatheringstatechange=null; conn.peerConnection.oniceconnectionstatechange=null; conn.peerConnection.onconnectionstatechange=null; conn.peerConnection.ondatachannel=null; conn.peerConnection.ontrack=null; if(conn.peerConnection.signalingState!=='closed')conn.peerConnection.close(); } catch (e) {} }
            delete this.connections[peerId]; delete this.iceCandidates[peerId]; delete this.reconnectAttempts[peerId]; delete this.iceGatheringStartTimes[peerId];
            if (ChatManager.currentChatId === peerId && typeof ChatAreaUIManager !== 'undefined') {
                ChatAreaUIManager.updateChatHeaderStatus(`已与 ${UserManager.contacts[peerId]?.name || peerId.substring(0,8)}... 断开连接`);
                ChatAreaUIManager.setCallButtonsState(false);
            }
            EventEmitter.emit('connectionClosed', peerId);
        }
    },

    /**
     * 重置所有连接，包括 WebSocket。
     */
    resetAllConnections: function() {
        ModalManager.showConfirmationModal( "您确定要重置所有连接吗？", () => {
            Object.keys(this.connections).forEach(peerId => this.close(peerId, false));
            this.connections = {}; this.iceCandidates = {}; this.reconnectAttempts = {}; this.iceGatheringStartTimes = {};
            Object.keys(this.connectionTimeouts).forEach(id=>clearTimeout(this.connectionTimeouts[id]));this.connectionTimeouts={};
            Object.keys(this.iceTimers).forEach(id=>clearTimeout(this.iceTimers[id]));this.iceTimers={};
            if (this.websocket?.readyState === WebSocket.OPEN || this.websocket?.readyState === WebSocket.CONNECTING) {
                this.websocket.onclose = null; this.websocket.close();
            }
            this.stopHeartbeat(); this.websocket = null; this.isWebSocketConnected = false; this.wsReconnectAttempts = 0;
            EventEmitter.emit('websocketStatusUpdate'); setTimeout(() => this.initialize(), 1000);
            NotificationManager.showNotification("所有连接已重置。", "info");
            if (ChatManager.currentChatId && !ChatManager.currentChatId.startsWith("group_") && !UserManager.isSpecialContact(ChatManager.currentChatId) && typeof ChatAreaUIManager !== 'undefined') {
                ChatAreaUIManager.updateChatHeaderStatus("已断开 - 连接已重置"); ChatAreaUIManager.setCallButtonsState(false);
            }
            ChatManager.renderChatList();
        });
    },

    /**
     * 在模态框中更新手动连接的 SDP 文本。
     * @param {string} peerIdToGetSdpFrom - 要获取 SDP 的对方 ID。
     */
    updateSdpTextInModal: function(peerIdToGetSdpFrom) {
        const sdpTextEl = document.getElementById('modalSdpText'); if (!sdpTextEl) return;
        const conn = this.connections[peerIdToGetSdpFrom]; const pc = conn?.peerConnection;
        if (pc?.localDescription) {
            const sdpType = pc.localDescription.type;
            const connectionInfo = { sdp: { type: sdpType, sdp: pc.localDescription.sdp }, candidates: this.iceCandidates[peerIdToGetSdpFrom] || [], userId: UserManager.userId, isVideoCall: conn?.isVideoCall||false, isAudioOnly: conn?.isAudioOnly||false, isScreenShare: conn?.isScreenShare||false };
            sdpTextEl.value = JSON.stringify(connectionInfo, null, 2);
        } else sdpTextEl.value = `正在为 ${peerIdToGetSdpFrom} 生成 ${pc?.localDescription ? pc.localDescription.type : '信息'}... (ICE状态: ${pc?.iceGatheringState})`;
        if (typeof SettingsUIManager !== 'undefined') SettingsUIManager.copySdpTextFromModal = () => {
            if (sdpTextEl.value) navigator.clipboard.writeText(sdpTextEl.value).then(()=>NotificationManager.showNotification('连接信息已复制！', 'success')).catch(()=>NotificationManager.showNotification('复制失败。', 'error'));
            else NotificationManager.showNotification('没有可复制的信息。', 'warning');
        };
    },

    /**
     * 处理 iceGatheringState 变化。
     * @param {string} peerId - 相关的对方 ID。
     */
    handleIceGatheringStateChange: function(peerId) {
        const pc = this.connections[peerId]?.peerConnection; if (!pc) return;
        if (pc.iceGatheringState === 'gathering' && !this.iceGatheringStartTimes[peerId]) this.iceGatheringStartTimes[peerId] = Date.now();
        else if (pc.iceGatheringState === 'complete') { Utils.log(`ConnectionManager: 为 ${peerId} 的 ICE 收集完成，耗时 ${(Date.now()-(this.iceGatheringStartTimes[peerId]||Date.now()))/1000}秒。候选者数量: ${this.iceCandidates[peerId]?.length||0}`, Utils.logLevels.DEBUG); delete this.iceGatheringStartTimes[peerId]; }
    },
};