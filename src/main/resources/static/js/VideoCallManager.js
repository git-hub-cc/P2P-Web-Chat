const VideoCallManager = {
    localStream: null,
    remoteStream: null,
    localVideo: null,
    remoteVideo: null,
    currentPeerId: null,
    isCallActive: false,
    isCaller: false,
    isCallPending: false,
    isAudioMuted: false,
    isVideoEnabled: true,
    callRequestTimeout: null,

    // Audio processing constraints
    audioConstraints: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000,
        sampleSize: 16
    },

    // Preferred codec settings
    codecPreferences: {
        audio: [
            {mimeType: 'audio/opus', clockRate: 48000, channels: 2,
                parameters: {minptime: 10, useinbandfec: 1, stereo: 1, maxaveragebitrate: 128000}}
        ],
        video: [
            {mimeType: 'video/VP9'},
            {mimeType: 'video/VP8'},
            {mimeType: 'video/H264'}
        ]
    },

    // 初始化
    init: function () {
        this.localVideo = document.getElementById('localVideo');
        this.remoteVideo = document.getElementById('remoteVideo');

        // 检查浏览器支持
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            Utils.log('浏览器不支持音视频通话功能', Utils.logLevels.ERROR);
            document.getElementById('videoCallButton').disabled = true;
            document.getElementById('videoCallButton').title = '您的浏览器不支持音视频通话';
            return false;
        }

        // 监听视频通话消息
        EventEmitter.on('dataChannelOpen', (peerId) => {
            if (ChatManager.currentChatId === peerId) {
                document.getElementById('videoCallButton').disabled = false;
                document.getElementById('videoCallButton').onclick = () => this.initiateCall(peerId);
            }
        });

        return true;
    },

    // 初始化语音通话
    initiateAudioCall: function (peerId) {
        // 调用通用的initiateCall方法，设置audioOnly为true
        this.initiateCall(peerId, true);
    },

    // 发起通话
    initiateCall: async function (peerId, audioOnly = false) {
        if (this.isCallActive || this.isCallPending) return;

        // 如果没有指定peerId，使用当前聊天对象
        if (!peerId) {
            peerId = ChatManager.currentChatId;
        }

        if (!peerId) {
            UIManager.showNotification('请先选择聊天对象', 'warning');
            return;
        }

        if (!ConnectionManager.isConnectedTo(peerId)) {
            UIManager.showNotification('连接未建立，无法发起通话', 'error');
            return;
        }

        try {
            // 检查设备支持情况
            if (!audioOnly) {
                // 检查视频设备是否可用
                const devices = await navigator.mediaDevices.enumerateDevices();
                const hasVideoDevice = devices.some(device => device.kind === 'videoinput');

                if (!hasVideoDevice) {
                    UIManager.showNotification('未检测到摄像头设备，将使用语音通话模式', 'warning');
                    audioOnly = true;
                } else {
                    // 尝试获取视频权限
                    try {
                        const testStream = await navigator.mediaDevices.getUserMedia({video: true});
                        // 成功获取后立即释放
                        testStream.getTracks().forEach(track => track.stop());
                    } catch (error) {
                        UIManager.showNotification('无法访问摄像头，将使用语音通话模式', 'warning');
                        Utils.log(`视频权限检查失败: ${error.message}`, Utils.logLevels.WARN);
                        audioOnly = true;
                    }
                }
            }

            // 检查音频设备
            try {
                const testAudioStream = await navigator.mediaDevices.getUserMedia({audio: true});
                // 成功获取后立即释放
                testAudioStream.getTracks().forEach(track => track.stop());
            } catch (error) {
                UIManager.showNotification('无法访问麦克风，通话功能不可用', 'error');
                Utils.log(`音频权限检查失败: ${error.message}`, Utils.logLevels.ERROR);
                return;
            }

            this.currentPeerId = peerId;
            this.isCaller = true;
            this.isCallPending = true;
            this.isAudioOnly = audioOnly;

            // 告知对方请求通话
            const callRequest = {
                type: 'video-call-request',
                audioOnly: audioOnly,
                timestamp: Date.now(),
                sender: UserManager.userId
            };

            ConnectionManager.sendTo(peerId, callRequest);

            UIManager.showNotification(`等待对方接受${audioOnly ? '语音' : '视频'}通话...`, 'info');
            Utils.log(`已发送${audioOnly ? '语音' : '视频'}通话请求`, Utils.logLevels.INFO);

            // 30秒超时
            this.callRequestTimeout = setTimeout(() => {
                if (this.isCallPending) {
                    this.isCallPending = false;
                    this.isCaller = false;
                    this.currentPeerId = null;
                    UIManager.showNotification('对方未应答，通话请求已取消', 'warning');

                    // 发送取消消息
                    const cancelRequest = {
                        type: 'video-call-cancel',
                        timestamp: Date.now(),
                        sender: UserManager.userId
                    };
                    ConnectionManager.sendTo(peerId, cancelRequest);
                }
            }, 30000);
        } catch (error) {
            Utils.log(`发起通话失败: ${error.message}`, Utils.logLevels.ERROR);
            UIManager.showNotification('发起通话失败', 'error');
            this.isCallPending = false;
            this.isCaller = false;
            this.currentPeerId = null;
        }
    },

    // 显示通话请求
    showCallRequest: function (peerId, audioOnly = false) {
        this.currentPeerId = peerId;
        this.isAudioOnly = audioOnly;

        // 修改通话请求界面，显示是语音还是视频通话请求
        const requestTitle = document.querySelector('#videoCallRequest h3');
        const requestDesc = document.querySelector('#videoCallRequest p');
        if (requestTitle && requestDesc) {
            requestTitle.textContent = audioOnly ? '语音通话请求' : '视频通话请求';
            requestDesc.textContent = `对方请求与您进行${audioOnly ? '语音' : '视频'}通话`;
        }

        document.getElementById('videoCallRequest').style.display = 'flex';
    },

    // 隐藏通话请求
    hideCallRequest: function () {
        document.getElementById('videoCallRequest').style.display = 'none';
    },

    // 接受通话
    acceptCall: async function () {
        this.hideCallRequest();

        if (!this.currentPeerId) {
            UIManager.showNotification('通话请求无效', 'error');
            return;
        }

        try {
            // 显示获取媒体设备权限的提示
            UIManager.showNotification('正在请求媒体设备权限...', 'info');

            // 检查设备支持情况
            if (!this.isAudioOnly) {
                // 检查视频设备是否可用
                const devices = await navigator.mediaDevices.enumerateDevices();
                const hasVideoDevice = devices.some(device => device.kind === 'videoinput');

                if (!hasVideoDevice) {
                    UIManager.showNotification('未检测到摄像头设备，将使用语音通话模式', 'warning');
                    this.isAudioOnly = true;
                } else {
                    // 尝试获取视频权限
                    try {
                        const testStream = await navigator.mediaDevices.getUserMedia({video: true});
                        // 成功获取后立即释放
                        testStream.getTracks().forEach(track => track.stop());
                    } catch (error) {
                        UIManager.showNotification('无法访问摄像头，将使用语音通话模式', 'warning');
                        Utils.log(`视频权限检查失败: ${error.message}`, Utils.logLevels.WARN);
                        this.isAudioOnly = true;
                    }
                }
            }

            // 获取媒体权限，添加高质量音频约束
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: !this.isAudioOnly,
                audio: this.audioConstraints
            });

            // 显示本地视频（如果是视频通话）
            this.localVideo.srcObject = this.localStream;

            // 如果是纯语音通话，隐藏本地视频区域
            this.localVideo.style.display = this.isAudioOnly ? 'none' : 'block';

            // 设置音频专用按钮状态
            const audioOnlyBtn = document.getElementById('audioOnlyBtn');
            if (audioOnlyBtn) {
                audioOnlyBtn.style.background = this.isAudioOnly ? '#4CAF50' : '#fff';
                audioOnlyBtn.title = this.isAudioOnly ? '切换到视频通话' : '切换到纯语音通话';
            }

            // 使用现有的连接
            this.setupPeerConnection();

            // 显示视频通话界面
            document.getElementById('videoCallContainer').style.display = 'flex';

            // 发送接受信号
            const acceptMessage = {
                type: 'video-call-accepted',
                audioOnly: this.isAudioOnly,
                timestamp: Date.now(),
                sender: UserManager.userId
            };
            ConnectionManager.sendTo(this.currentPeerId, acceptMessage);

            this.isCallActive = true;
            this.isCallPending = false;

            Utils.log(`已接受${this.isAudioOnly ? '语音' : '视频'}通话`, Utils.logLevels.INFO);
        } catch (error) {
            Utils.log(`接受通话失败: ${error.message}`, Utils.logLevels.ERROR);
            UIManager.showNotification('无法访问媒体设备', 'error');

            // 发送拒绝消息，标明原因是设备问题
            const rejectMessage = {
                type: 'video-call-rejected',
                reason: 'device_error',
                timestamp: Date.now(),
                sender: UserManager.userId
            };
            ConnectionManager.sendTo(this.currentPeerId, rejectMessage);

            this.currentPeerId = null;
        }
    },

    // 拒绝通话
    rejectCall: function () {
        this.hideCallRequest();

        if (!this.currentPeerId) return;

        // 发送拒绝消息
        const rejectMessage = {
            type: 'video-call-rejected',
            reason: 'user_rejected',
            timestamp: Date.now(),
            sender: UserManager.userId
        };
        ConnectionManager.sendTo(this.currentPeerId, rejectMessage);

        // 重置状态
        this.isCallPending = false;
        this.isCallActive = false;
        this.isCaller = false;
        this.currentPeerId = null;
        this.isAudioOnly = false;

        Utils.log('已拒绝通话请求', Utils.logLevels.INFO);
    },

    // 设置对等连接
    setupPeerConnection: function () {
        // 使用已有的连接传递信令
        if (!this.currentPeerId || !ConnectionManager.connections[this.currentPeerId]) {
            Utils.log('无法创建通话连接: 没有基础连接', Utils.logLevels.ERROR);
            return;
        }

        const conn = ConnectionManager.connections[this.currentPeerId];

        // 设置编解码器首选项
        this.setCodecPreferences(conn.peerConnection);

        // 添加本地流
        this.localStream.getTracks().forEach(track => {
            conn.peerConnection.addTrack(track, this.localStream);
        });

        // 处理远程流
        conn.peerConnection.ontrack = (event) => {
            if (event.streams && event.streams[0]) {
                this.remoteVideo.srcObject = event.streams[0];
                this.remoteStream = event.streams[0];

                // 检查是否有视频轨道，如果只有音频则隐藏远程视频
                const hasVideoTrack = event.streams[0].getVideoTracks().length > 0;
                this.remoteVideo.style.display = hasVideoTrack ? 'block' : 'none';

                Utils.log(`收到远程${hasVideoTrack ? '视频' : '音频'}流`, Utils.logLevels.INFO);

                // 设置音频输出设备（如果支持）
                if (typeof this.remoteVideo.setSinkId === 'function') {
                    // 使用默认音频输出设备
                    this.remoteVideo.setSinkId('default').catch(error => {
                        Utils.log(`无法设置音频输出设备: ${error.message}`, Utils.logLevels.WARN);
                    });
                }
            }
        };

        // 设置带宽估计和拥塞控制
        this.setupBandwidthConstraints(conn.peerConnection);

        // 如果是呼叫方，创建并发送offer
        if (this.isCaller) {
            this.createAndSendOffer();
        }

        // 设置连接状态监控
        this.setupConnectionMonitoring(conn.peerConnection);
    },

    // 设置编解码器首选项
    setCodecPreferences: function(peerConnection) {
        try {
            const transceivers = peerConnection.getTransceivers();

            transceivers.forEach(transceiver => {
                if (transceiver.sender && transceiver.sender.track) {
                    const kind = transceiver.sender.track.kind;
                    if (kind === 'audio' && this.codecPreferences.audio) {
                        // 尝试设置音频编解码器首选项
                        if (RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('audio')) {
                            const capabilities = RTCRtpSender.getCapabilities('audio');
                            const preferredCodecs = this.filterSupportedCodecs(capabilities.codecs, this.codecPreferences.audio);
                            if (preferredCodecs.length > 0) {
                                transceiver.setCodecPreferences(preferredCodecs);
                                Utils.log('已设置音频编解码器首选项: Opus', Utils.logLevels.DEBUG);
                            }
                        }
                    } else if (kind === 'video' && this.codecPreferences.video && !this.isAudioOnly) {
                        // 尝试设置视频编解码器首选项
                        if (RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video')) {
                            const capabilities = RTCRtpSender.getCapabilities('video');
                            const preferredCodecs = this.filterSupportedCodecs(capabilities.codecs, this.codecPreferences.video);
                            if (preferredCodecs.length > 0) {
                                transceiver.setCodecPreferences(preferredCodecs);
                                Utils.log(`已设置视频编解码器首选项: ${preferredCodecs[0].mimeType}`, Utils.logLevels.DEBUG);
                            }
                        }
                    }
                }
            });
        } catch (error) {
            Utils.log(`设置编解码器首选项失败: ${error.message}`, Utils.logLevels.WARN);
        }
    },

    // 过滤支持的编解码器
    filterSupportedCodecs: function(availableCodecs, preferredCodecs) {
        if (!availableCodecs || !preferredCodecs) return [];

        const result = [];

        // 按照首选项顺序查找支持的编解码器
        for (const preferred of preferredCodecs) {
            for (const available of availableCodecs) {
                if (available.mimeType.toLowerCase() === preferred.mimeType.toLowerCase()) {
                    // 创建编解码器副本并应用首选参数
                    const codec = {...available};
                    if (preferred.parameters) {
                        codec.parameters = {...(codec.parameters || {}), ...preferred.parameters};
                    }
                    result.push(codec);
                    break;
                }
            }
        }

        // 如果没有找到首选编解码器，返回所有可用的编解码器
        return result.length > 0 ? result : availableCodecs;
    },

    // 设置带宽约束
    setupBandwidthConstraints: function(peerConnection) {
        try {
            // 设置SDP带宽参数
            peerConnection.addEventListener('negotiationneeded', async () => {
                try {
                    const offer = await peerConnection.createOffer();

                    // 修改SDP以设置音频比特率
                    let sdp = offer.sdp;
                    const audioRate = this.isAudioOnly ? 64 : 32; // 纯语音模式下使用更高的音频比特率

                    // 为音频设置比特率
                    sdp = sdp.replace(/(m=audio.*\r\n)/g, `$1b=AS:${audioRate}\r\n`);

                    // 为视频设置比特率（如果不是纯语音模式）
                    if (!this.isAudioOnly) {
                        sdp = sdp.replace(/(m=video.*\r\n)/g, `$1b=AS:800\r\n`);
                    }

                    const modifiedOffer = new RTCSessionDescription({
                        type: 'offer',
                        sdp: sdp
                    });

                    await peerConnection.setLocalDescription(modifiedOffer);
                } catch (error) {
                    Utils.log(`设置带宽约束失败: ${error.message}`, Utils.logLevels.WARN);
                }
            });
        } catch (error) {
            Utils.log(`设置带宽约束失败: ${error.message}`, Utils.logLevels.WARN);
        }
    },

    // 设置连接状态监控
    setupConnectionMonitoring: function(peerConnection) {
        // 监控ICE连接状态
        peerConnection.oniceconnectionstatechange = () => {
            Utils.log(`ICE连接状态: ${peerConnection.iceConnectionState}`, Utils.logLevels.DEBUG);

            if (peerConnection.iceConnectionState === 'failed' ||
                peerConnection.iceConnectionState === 'disconnected') {
                // 尝试重新协商
                Utils.log('检测到连接问题，尝试重新协商...', Utils.logLevels.WARN);
                this.tryReconnect();
            }
        };

        // 监控连接状态
        peerConnection.onconnectionstatechange = () => {
            Utils.log(`连接状态: ${peerConnection.connectionState}`, Utils.logLevels.DEBUG);

            if (peerConnection.connectionState === 'failed') {
                UIManager.showNotification('通话连接已断开', 'error');
                this.endCall();
            }
        };
    },

    // 尝试重新连接
    tryReconnect: function() {
        if (!this.isCallActive || !this.currentPeerId) return;

        const conn = ConnectionManager.connections[this.currentPeerId];
        if (!conn || !conn.peerConnection) return;

        // 如果是呼叫方，尝试重新创建offer
        if (this.isCaller) {
            this.createAndSendOffer();
        }
    },

    // 处理收到的answer
    handleAnswer: async function (answer, peerId, audioOnly) {
        try {
            if (this.currentPeerId !== peerId) return;

            // 更新通话类型
            this.isAudioOnly = audioOnly;

            // 更新UI显示
            this.updateUIForCallType();

            const conn = ConnectionManager.connections[peerId];
            if (!conn || !conn.peerConnection) return;

            await conn.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            Utils.log('已设置远程描述', Utils.logLevels.DEBUG);

            // 通话建立后，设置抖动缓冲区
            this.setupJitterBuffer();
        } catch (error) {
            Utils.log(`处理answer失败: ${error.message}`, Utils.logLevels.ERROR);
            this.endCall();
        }
    },

    // 设置抖动缓冲区
    setupJitterBuffer: function() {
        if (!this.remoteVideo || !this.remoteVideo.srcObject) return;

        try {
            // 设置音频缓冲策略
            if (this.remoteVideo.audioTracks && this.remoteVideo.audioTracks[0]) {
                const audioTrack = this.remoteVideo.audioTracks[0];

                // 尝试设置音频缓冲模式（如果浏览器支持）
                if (typeof audioTrack.setJitterBufferMode === 'function') {
                    // 设置为自适应模式
                    audioTrack.setJitterBufferMode('adaptive');
                    Utils.log('已设置自适应抖动缓冲模式', Utils.logLevels.DEBUG);
                }
            }

            // 设置播放缓冲策略
            if (typeof this.remoteVideo.playsInline !== 'undefined') {
                this.remoteVideo.playsInline = true;
            }

            // 设置低延迟模式（如果浏览器支持）
            if (typeof this.remoteVideo.setLatencyHint === 'function') {
                this.remoteVideo.setLatencyHint('interactive');
            }
        } catch (error) {
            Utils.log(`设置抖动缓冲区失败: ${error.message}`, Utils.logLevels.WARN);
        }
    },

    // 切换摄像头
    toggleCamera: function () {
        if (!this.localStream) return;

        // 如果是纯语音模式，切换到视频模式
        if (this.isAudioOnly) {
            this.toggleAudioOnly();
            return;
        }

        const videoTrack = this.localStream.getVideoTracks()[0];
        if (videoTrack) {
            this.isVideoEnabled = !this.isVideoEnabled;
            videoTrack.enabled = this.isVideoEnabled;

            const button = document.getElementById('toggleCameraBtn');
            button.innerHTML = this.isVideoEnabled ? '📹' : '🚫';
            button.style.background = this.isVideoEnabled ? '#fff' : '#666';

            Utils.log(`摄像头已${this.isVideoEnabled ? '开启' : '关闭'}`, Utils.logLevels.DEBUG);
        } else {
            // 没有视频轨道，可能是设备不支持或权限问题
            UIManager.showNotification('无法访问摄像头', 'warning');
        }
    },

    // 切换麦克风
    toggleAudio: function () {
        if (!this.localStream) return;

        const audioTrack = this.localStream.getAudioTracks()[0];
        if (audioTrack) {
            this.isAudioMuted = !this.isAudioMuted;
            audioTrack.enabled = !this.isAudioMuted;

            const button = document.getElementById('toggleAudioBtn');
            button.innerHTML = this.isAudioMuted ? '🔇' : '🎤';
            button.style.background = this.isAudioMuted ? '#666' : '#fff';

            Utils.log(`麦克风已${this.isAudioMuted ? '静音' : '开启'}`, Utils.logLevels.DEBUG);
        }
    },

    // 切换纯语音模式
    toggleAudioOnly: async function () {
        if (!this.isCallActive) return;

        try {
            // 如果要切换到视频模式，先检查是否支持视频
            if (this.isAudioOnly) {
                // 检查视频设备是否可用
                const devices = await navigator.mediaDevices.enumerateDevices();
                const hasVideoDevice = devices.some(device => device.kind === 'videoinput');

                if (!hasVideoDevice) {
                    UIManager.showNotification('未检测到摄像头设备，无法切换到视频模式', 'warning');
                    return;
                }

                // 尝试获取视频权限
                try {
                    const testStream = await navigator.mediaDevices.getUserMedia({video: true});
                    // 成功获取后立即释放
                    testStream.getTracks().forEach(track => track.stop());
                } catch (error) {
                    UIManager.showNotification('无法访问摄像头，无法切换到视频模式', 'error');
                    Utils.log(`视频权限检查失败: ${error.message}`, Utils.logLevels.ERROR);
                    return;
                }
            }

            this.isAudioOnly = !this.isAudioOnly;

            // 更新UI
            this.updateUIForCallType();

            // 停止当前媒体流
            if (this.localStream) {
                this.localStream.getTracks().forEach(track => track.stop());
            }

            // 重新获取媒体权限，使用优化的音频约束
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: !this.isAudioOnly,
                audio: this.audioConstraints
            });

            // 更新本地视频
            this.localVideo.srcObject = this.localStream;

            const conn = ConnectionManager.connections[this.currentPeerId];
            if (!conn || !conn.peerConnection) return;

            // 替换所有轨道
            const senders = conn.peerConnection.getSenders();
            const tracks = this.localStream.getTracks();

            // 查找已有的音频和视频发送器
            const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');

            // 获取新的音频和视频轨道
            const audioTrack = tracks.find(t => t.kind === 'audio');
            const videoTrack = tracks.find(t => t.kind === 'video');

            // 替换音频轨道
            if (audioSender && audioTrack) {
                audioSender.replaceTrack(audioTrack);

                // 设置音频编码参数
                if (audioSender.getParameters) {
                    try {
                        const params = audioSender.getParameters();
                        // 设置更高的音频优先级和比特率
                        if (params.encodings && params.encodings.length > 0) {
                            params.encodings[0].priority = 'high';
                            params.encodings[0].maxBitrate = this.isAudioOnly ? 64000 : 32000;
                            audioSender.setParameters(params);
                        }
                    } catch (e) {
                        Utils.log(`设置音频参数失败: ${e.message}`, Utils.logLevels.WARN);
                    }
                }
            } else if (audioTrack) {
                conn.peerConnection.addTrack(audioTrack, this.localStream);
            }

            // 处理视频轨道
            if (this.isAudioOnly) {
                // 在纯语音模式下，如果有视频发送器，将其移除
                if (videoSender) {
                    try {
                        conn.peerConnection.removeTrack(videoSender);
                    } catch (e) {
                        Utils.log(`移除视频轨道失败: ${e.message}`, Utils.logLevels.ERROR);
                    }
                }
            } else {
                // 在视频模式下，替换或添加视频轨道
                if (videoSender && videoTrack) {
                    videoSender.replaceTrack(videoTrack);
                } else if (videoTrack) {
                    conn.peerConnection.addTrack(videoTrack, this.localStream);
                }
            }

            // 重新设置编解码器首选项
            this.setCodecPreferences(conn.peerConnection);

            // 通知对方模式已更改
            const modeChangeMsg = {
                type: 'video-call-mode-change',
                audioOnly: this.isAudioOnly,
                timestamp: Date.now(),
                sender: UserManager.userId
            };
            ConnectionManager.sendTo(this.currentPeerId, modeChangeMsg);

            // 重新协商连接
            this.createAndSendOffer();

            Utils.log(`已切换到${this.isAudioOnly ? '纯语音' : '视频'}通话模式`, Utils.logLevels.INFO);
        } catch (error) {
            Utils.log(`切换通话模式失败: ${error.message}`, Utils.logLevels.ERROR);
            UIManager.showNotification('切换通话模式失败', 'error');
        }
    },

    // 更新UI以匹配当前通话类型
    updateUIForCallType: function () {
        // 设置本地视频显示
        if (this.localVideo) {
            this.localVideo.style.display = this.isAudioOnly ? 'none' : 'block';
        }

        // 更新音频模式按钮
        const audioOnlyBtn = document.getElementById('audioOnlyBtn');
        if (audioOnlyBtn) {
            audioOnlyBtn.style.background = this.isAudioOnly ? '#4CAF50' : '#fff';
            audioOnlyBtn.title = this.isAudioOnly ? '切换到视频通话' : '切换到纯语音通话';
        }

        // 更新摄像头按钮状态
        const cameraBtn = document.getElementById('toggleCameraBtn');
        if (cameraBtn) {
            cameraBtn.style.display = this.isAudioOnly ? 'none' : 'inline-block';
        }

        // 调整视频容器的布局
        const videoContainer = document.getElementById('videoCallContainer');
        if (videoContainer) {
            videoContainer.classList.toggle('audio-only-mode', this.isAudioOnly);
        }
    },

    // 结束通话
    endCall: function () {
        // 清除超时定时器
        if (this.callRequestTimeout) {
            clearTimeout(this.callRequestTimeout);
            this.callRequestTimeout = null;
        }

        // 发送结束通话信号
        if ((this.isCallActive || this.isCallPending) && this.currentPeerId) {
            const endCallMessage = {
                type: 'video-call-end',
                timestamp: Date.now(),
                sender: UserManager.userId
            };
            try {
                ConnectionManager.sendTo(this.currentPeerId, endCallMessage);
            } catch (error) {
                Utils.log(`发送结束通话消息失败: ${error.message}`, Utils.logLevels.ERROR);
            }
        }

        // 彻底关闭并停止所有媒体轨道
        this.releaseMediaResources();

        // 重置视频元素
        if (this.localVideo) this.localVideo.srcObject = null;
        if (this.remoteVideo) this.remoteVideo.srcObject = null;
        this.remoteStream = null;

        // 隐藏视频通话界面
        document.getElementById('videoCallContainer').style.display = 'none';
        this.hideCallRequest();

        // 重置状态
        this.isCallActive = false;
        this.isCallPending = false;
        this.isCaller = false;
        this.isAudioMuted = false;
        this.isVideoEnabled = true;
        this.isAudioOnly = false;
        this.currentPeerId = null;

        // 重置连接按钮状态
        UIManager.resetConnectionControls();

        Utils.log('通话已结束，所有资源已释放', Utils.logLevels.INFO);
    },

    // 释放媒体资源
    releaseMediaResources: function () {
        // 关闭本地视频/音频轨道
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                track.stop();
                Utils.log(`已停止${track.kind}轨道`, Utils.logLevels.DEBUG);
            });
            this.localStream = null;
        }

        // 如果有远程流，也可以考虑清理
        if (this.remoteStream) {
            // 我们不需要停止远程轨道，但可以清除引用
            this.remoteStream = null;
        }
    },

    // 处理消息
    handleMessage: function (message, peerId) {
        switch (message.type) {
            case 'video-call-request':
                if (!this.isCallActive && !this.isCallPending) {
                    this.isCallPending = true;
                    // 注意新增的audioOnly参数
                    this.showCallRequest(peerId, message.audioOnly || false);
                    Utils.log(`收到${message.audioOnly ? '语音' : '视频'}通话请求`, Utils.logLevels.INFO);
                } else {
                    // 已在通话中，自动拒绝
                    const busyMessage = {
                        type: 'video-call-rejected',
                        reason: 'busy',
                        timestamp: Date.now(),
                        sender: UserManager.userId
                    };
                    ConnectionManager.sendTo(peerId, busyMessage);
                }
                break;

            case 'video-call-accepted':
                if (this.isCallPending && this.isCaller && this.currentPeerId === peerId) {
                    clearTimeout(this.callRequestTimeout);
                    this.callRequestTimeout = null;

                    // 更新通话类型（接收方可能改变了通话类型）
                    if (typeof message.audioOnly !== 'undefined') {
                        this.isAudioOnly = message.audioOnly;
                    }

                    // 对方已接受，开始通话
                    this.startLocalStream();
                }
                break;

            case 'video-call-rejected':
                if (this.isCallPending && this.currentPeerId === peerId) {
                    clearTimeout(this.callRequestTimeout);
                    this.callRequestTimeout = null;
                    this.isCallPending = false;
                    this.isCaller = false;
                    this.currentPeerId = null;
                    this.isAudioOnly = false;

                    // 释放已申请的任何媒体资源
                    this.releaseMediaResources();

                    let reason = '对方拒绝了通话';
                    if (message.reason === 'busy') {
                        reason = '对方正忙';
                    } else if (message.reason === 'device_error') {
                        reason = '对方无法访问麦克风或摄像头';
                    }

                    UIManager.showNotification(reason, 'warning');
                    Utils.log(`通话被拒绝: ${message.reason}`, Utils.logLevels.INFO);
                }
                break;

            case 'video-call-cancel':
                if (this.isCallPending && !this.isCaller && this.currentPeerId === peerId) {
                    this.isCallPending = false;
                    this.hideCallRequest();
                    this.currentPeerId = null;
                    this.isAudioOnly = false;

                    // 释放已申请的任何媒体资源
                    this.releaseMediaResources();

                    Utils.log('对方取消了通话请求', Utils.logLevels.INFO);
                }
                break;

            case 'video-call-offer':
                if (this.isCallActive && !this.isCaller && this.currentPeerId === peerId) {
                    // 注意新增的audioOnly参数
                    this.handleOffer(message.sdp, peerId, message.audioOnly || false);
                }
                break;

            case 'video-call-answer':
                if (this.isCallActive && this.isCaller && this.currentPeerId === peerId) {
                    // 注意新增的audioOnly参数
                    this.handleAnswer(message.sdp, peerId, message.audioOnly || false);
                }
                break;

            case 'video-call-mode-change':
                if (this.isCallActive && this.currentPeerId === peerId) {
                    // 对方更改了通话模式
                    this.isAudioOnly = message.audioOnly;
                    this.updateUIForCallType();
                    Utils.log(`对方已切换到${this.isAudioOnly ? '纯语音' : '视频'}通话模式`, Utils.logLevels.INFO);
                }
                break;

            case 'video-call-end':
                if ((this.isCallActive || this.isCallPending) && this.currentPeerId === peerId) {
                    this.endCall();
                    UIManager.showNotification('对方结束了通话', 'info');
                }
                break;

            case 'video-call-stats':
                // 处理网络质量统计信息
                if (this.isCallActive && this.currentPeerId === peerId) {
                    this.handleCallStats(message.stats);
                }
                break;
        }
    },

    // 处理通话统计信息
    handleCallStats: function(stats) {
        if (!stats) return;

        // 根据网络状况调整UI提示
        if (stats.packetLoss > 10) {
            // 高丢包率
            UIManager.showNotification('网络连接不稳定，可能会影响通话质量', 'warning');
        }

        // 记录统计信息
        Utils.log(`通话统计: 丢包率=${stats.packetLoss}%, 延迟=${stats.rtt}ms`, Utils.logLevels.DEBUG);
    },

    // 收集并发送统计信息
    collectAndSendStats: async function() {
        if (!this.isCallActive || !this.currentPeerId) return;

        const conn = ConnectionManager.connections[this.currentPeerId];
        if (!conn || !conn.peerConnection) return;

        try {
            const stats = await conn.peerConnection.getStats();
            let packetLoss = 0;
            let rtt = 0;
            let audioLevel = 0;

            stats.forEach(report => {
                if (report.type === 'outbound-rtp' && report.kind === 'audio') {
                    if (report.packetsSent && report.packetsLost) {
                        packetLoss = (report.packetsLost / report.packetsSent) * 100;
                    }
                }

                if (report.type === 'remote-inbound-rtp' && report.kind === 'audio') {
                    if (report.roundTripTime) {
                        rtt = report.roundTripTime * 1000; // 转换为毫秒
                    }
                }

                if (report.type === 'media-source' && report.kind === 'audio') {
                    if (report.audioLevel) {
                        audioLevel = report.audioLevel;
                    }
                }
            });

            // 发送统计信息到对方
            const statsMessage = {
                type: 'video-call-stats',
                stats: {
                    packetLoss,
                    rtt,
                    audioLevel,
                    timestamp: Date.now()
                },
                sender: UserManager.userId
            };

            ConnectionManager.sendTo(this.currentPeerId, statsMessage);

            // 根据统计信息调整本地设置
            this.adjustCallQuality(packetLoss, rtt);

        } catch (error) {
            Utils.log(`收集统计信息失败: ${error.message}`, Utils.logLevels.WARN);
        }
    },

    // 根据网络状况调整通话质量
    adjustCallQuality: function(packetLoss, rtt) {
        if (!this.isCallActive || !this.currentPeerId) return;

        const conn = ConnectionManager.connections[this.currentPeerId];
        if (!conn || !conn.peerConnection) return;

        try {
            // 获取所有发送器
            const senders = conn.peerConnection.getSenders();

            // 根据网络状况调整编码参数
            senders.forEach(sender => {
                if (sender.track && sender.track.kind === 'audio' && sender.getParameters) {
                    const params = sender.getParameters();

                    if (params.encodings && params.encodings.length > 0) {
                        // 在高丢包或高延迟情况下降低比特率
                        if (packetLoss > 5 || rtt > 300) {
                            params.encodings[0].maxBitrate = this.isAudioOnly ? 32000 : 24000;
                            sender.setParameters(params);
                            Utils.log('网络状况不佳，已降低音频比特率', Utils.logLevels.DEBUG);
                        }
                        // 在网络状况良好时恢复正常比特率
                        else if (packetLoss < 2 && rtt < 150) {
                            params.encodings[0].maxBitrate = this.isAudioOnly ? 64000 : 32000;
                            sender.setParameters(params);
                        }
                    }
                }

                // 对视频也进行类似的调整
                if (!this.isAudioOnly && sender.track && sender.track.kind === 'video' && sender.getParameters) {
                    const params = sender.getParameters();

                    if (params.encodings && params.encodings.length > 0) {
                        if (packetLoss > 5 || rtt > 300) {
                            params.encodings[0].maxBitrate = 250000; // 降低视频比特率
                            params.encodings[0].scaleResolutionDownBy = 2.0; // 降低分辨率
                            sender.setParameters(params);
                            Utils.log('网络状况不佳，已降低视频质量', Utils.logLevels.DEBUG);
                        } else if (packetLoss < 2 && rtt < 150) {
                            params.encodings[0].maxBitrate = 800000;
                            params.encodings[0].scaleResolutionDownBy = 1.0;
                            sender.setParameters(params);
                        }
                    }
                }
            });
        } catch (error) {
            Utils.log(`调整通话质量失败: ${error.message}`, Utils.logLevels.WARN);
        }
    },

    // 开始本地流
    startLocalStream: async function () {
        try {
            // 只有在还没有本地流时才请求权限
            if (!this.localStream) {
                // 显示获取媒体设备权限的提示
                UIManager.showNotification('正在请求媒体设备权限...', 'info');

                // 获取权限，使用优化的音频约束
                this.localStream = await navigator.mediaDevices.getUserMedia({
                    video: !this.isAudioOnly,
                    audio: this.audioConstraints
                });

                // 显示本地视频（如果不是纯语音通话）
                this.localVideo.srcObject = this.localStream;
                this.localVideo.style.display = this.isAudioOnly ? 'none' : 'block';
            }

            // 创建WebRTC连接
            this.setupPeerConnection();

            // 显示视频通话界面
            document.getElementById('videoCallContainer').style.display = 'flex';

            // 更新UI以匹配当前通话类型
            this.updateUIForCallType();

            this.isCallActive = true;
            this.isCallPending = false;

            // 启动定期收集统计信息的任务
            this.statsInterval = setInterval(() => this.collectAndSendStats(), 5000);

            Utils.log(`${this.isAudioOnly ? '语音' : '视频'}通话已开始`, Utils.logLevels.INFO);
        } catch (error) {
            Utils.log(`启动通话失败: ${error.message}`, Utils.logLevels.ERROR);
            UIManager.showNotification('无法访问媒体设备', 'error');
            this.endCall();
        }
    },

    // 创建并发送offer
    createAndSendOffer: async function () {
        try {
            if (!this.currentPeerId) return;

            const conn = ConnectionManager.connections[this.currentPeerId];
            if (!conn || !conn.peerConnection) return;

            // 设置优化的offer选项
            const offerOptions = {
                offerToReceiveAudio: true,
                offerToReceiveVideo: !this.isAudioOnly,
                voiceActivityDetection: true,
                iceRestart: true  // 支持ICE重启以处理网络变化
            };

            const offer = await conn.peerConnection.createOffer(offerOptions);

            // 修改SDP以优化音频质量 - 使用更安全的方式
            let sdp = offer.sdp;

            // 找到Opus编解码器的有效载荷类型
            const opusRegex = /a=rtpmap:(\d+) opus\/48000\/2/;
            const opusMatch = sdp.match(opusRegex);

            if (opusMatch && opusMatch[1]) {
                const opusPayloadType = opusMatch[1];

                // 检查是否已经有fmtp行
                const fmtpRegex = new RegExp(`a=fmtp:${opusPayloadType} (.*)`, 'g');
                const fmtpMatch = fmtpRegex.exec(sdp);

                if (fmtpMatch) {
                    // 已经存在fmtp行，确保它包含我们想要的参数
                    const currentParams = fmtpMatch[1];
                    const newParams = 'minptime=10;useinbandfec=1;stereo=1;maxaveragebitrate=128000;dtx=1';

                    // 只添加缺少的参数
                    const updatedParams = this.mergeCodecParams(currentParams, newParams);
                    sdp = sdp.replace(fmtpMatch[0], `a=fmtp:${opusPayloadType} ${updatedParams}`);
                } else {
                    // 不存在fmtp行，添加一个新行
                    const opusLine = `a=rtpmap:${opusPayloadType} opus/48000/2`;
                    const newFmtpLine = `a=fmtp:${opusPayloadType} minptime=10;useinbandfec=1;stereo=1;maxaveragebitrate=128000;dtx=1`;
                    sdp = sdp.replace(opusLine, `${opusLine}\r\n${newFmtpLine}`);
                }
            }

            // 创建修改后的offer
            const modifiedOffer = new RTCSessionDescription({
                type: 'offer',
                sdp: sdp
            });

            await conn.peerConnection.setLocalDescription(modifiedOffer);

            // 发送offer给对方
            const offerMessage = {
                type: 'video-call-offer',
                sdp: conn.peerConnection.localDescription,
                audioOnly: this.isAudioOnly,
                sender: UserManager.userId
            };
            ConnectionManager.sendTo(this.currentPeerId, offerMessage);

            Utils.log(`已发送${this.isAudioOnly ? '语音' : '视频'}通话offer`, Utils.logLevels.DEBUG);
        } catch (error) {
            Utils.log(`创建offer失败: ${error.message}`, Utils.logLevels.ERROR);
            this.endCall();
        }
    },

// 处理收到的offer
    handleOffer: async function (offer, peerId, audioOnly) {
        try {
            this.currentPeerId = peerId;
            this.isAudioOnly = audioOnly;

            const conn = ConnectionManager.connections[peerId];
            if (!conn || !conn.peerConnection) return;

            await conn.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

            // 创建answer
            const answerOptions = {
                voiceActivityDetection: true
            };

            const answer = await conn.peerConnection.createAnswer(answerOptions);

            // 修改SDP以优化音频质量 - 使用更安全的方式
            let sdp = answer.sdp;

            // 找到Opus编解码器的有效载荷类型
            const opusRegex = /a=rtpmap:(\d+) opus\/48000\/2/;
            const opusMatch = sdp.match(opusRegex);

            if (opusMatch && opusMatch[1]) {
                const opusPayloadType = opusMatch[1];

                // 检查是否已经有fmtp行
                const fmtpRegex = new RegExp(`a=fmtp:${opusPayloadType} (.*)`, 'g');
                const fmtpMatch = fmtpRegex.exec(sdp);

                if (fmtpMatch) {
                    // 已经存在fmtp行，确保它包含我们想要的参数
                    const currentParams = fmtpMatch[1];
                    const newParams = 'minptime=10;useinbandfec=1;stereo=1;maxaveragebitrate=128000;dtx=1';

                    // 只添加缺少的参数
                    const updatedParams = this.mergeCodecParams(currentParams, newParams);
                    sdp = sdp.replace(fmtpMatch[0], `a=fmtp:${opusPayloadType} ${updatedParams}`);
                } else {
                    // 不存在fmtp行，添加一个新行
                    const opusLine = `a=rtpmap:${opusPayloadType} opus/48000/2`;
                    const newFmtpLine = `a=fmtp:${opusPayloadType} minptime=10;useinbandfec=1;stereo=1;maxaveragebitrate=128000;dtx=1`;
                    sdp = sdp.replace(opusLine, `${opusLine}\r\n${newFmtpLine}`);
                }
            }

            // 创建修改后的answer
            const modifiedAnswer = new RTCSessionDescription({
                type: 'answer',
                sdp: sdp
            });

            await conn.peerConnection.setLocalDescription(modifiedAnswer);

            // 发送answer给对方
            const answerMessage = {
                type: 'video-call-answer',
                sdp: conn.peerConnection.localDescription,
                audioOnly: this.isAudioOnly,
                sender: UserManager.userId
            };
            ConnectionManager.sendTo(peerId, answerMessage);

            Utils.log(`已回复${this.isAudioOnly ? '语音' : '视频'}通话answer`, Utils.logLevels.DEBUG);
        } catch (error) {
            Utils.log(`处理offer失败: ${error.message}`, Utils.logLevels.ERROR);
            this.endCall();
        }
    },

// 合并编解码器参数
    mergeCodecParams: function(currentParams, newParams) {
        const currentMap = {};
        const current = currentParams.split(';');
        const newParamsArray = newParams.split(';');

        // 解析当前参数
        current.forEach(param => {
            if (param) {
                const parts = param.split('=');
                if (parts.length === 2) {
                    currentMap[parts[0]] = parts[1];
                }
            }
        });

        // 添加或更新参数
        newParamsArray.forEach(param => {
            if (param) {
                const parts = param.split('=');
                if (parts.length === 2) {
                    currentMap[parts[0]] = parts[1];
                }
            }
        });

        // 重建参数字符串
        return Object.entries(currentMap)
            .map(([key, value]) => `${key}=${value}`)
            .join(';');
    },
};