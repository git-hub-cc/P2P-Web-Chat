// VideoCallUIManager.js (已翻译)
// 职责:
// - 管理视频通话的 UI 元素（本地/远程视频、通话控制）。
// - 处理画中画 (PiP) 模式的 UI 和拖动功能。
const VideoCallUIManager = {
    localVideo: null,
    remoteVideo: null,
    pipButton: null,
    callContainer: null,
    audioOnlyBtn: null,
    cameraBtn: null,
    audioBtn: null,
    endCallBtn: null,

    isPipMode: false,
    dragInfo: {
        active: false, currentX: 0, currentY: 0,
        initialX: 0, initialY: 0, xOffset: 0, yOffset: 0,
        draggedElement: null
    },
    _boundDragStart: null,
    _boundDragStartTouch: null,
    _boundDrag: null,
    _boundDragTouch: null,
    _boundDragEnd: null,
    _boundDragEndTouch: null,

    init: function() {
        this.localVideo = document.getElementById('localVideo');
        this.remoteVideo = document.getElementById('remoteVideo');
        this.pipButton = document.getElementById('togglePipBtn');
        this.callContainer = document.getElementById('videoCallContainer');
        this.audioOnlyBtn = document.getElementById('audioOnlyBtn');
        this.cameraBtn = document.getElementById('toggleCameraBtn');
        this.audioBtn = document.getElementById('toggleAudioBtn');
        this.endCallBtn = this.callContainer ? this.callContainer.querySelector('.end-call') : null;

        this._boundDragStart = this.dragStart.bind(this);
        this._boundDragStartTouch = this.dragStart.bind(this);
        this._boundDrag = this.drag.bind(this);
        this._boundDragTouch = this.drag.bind(this);
        this._boundDragEnd = this.dragEnd.bind(this);
        this._boundDragEndTouch = this.dragEnd.bind(this);

        this.bindEvents();
    },

    bindEvents: function() {
        if (this.pipButton) this.pipButton.addEventListener('click', () => this.togglePipMode());
        if (this.cameraBtn) this.cameraBtn.onclick = () => VideoCallManager.toggleCamera();
        if (this.audioBtn) this.audioBtn.onclick = () => VideoCallManager.toggleAudio();
        if (this.audioOnlyBtn) this.audioOnlyBtn.onclick = () => VideoCallManager.toggleAudioOnly();
        if (this.endCallBtn) this.endCallBtn.onclick = () => VideoCallManager.hangUpMedia();
    },

    showCallContainer: function(display = true) {
        if (this.callContainer) {
            this.callContainer.style.display = display ? 'flex' : 'none';
            if (!display) { // 如果隐藏，确保 PiP 模式的视觉效果也被重置
                this.resetPipVisuals();
            }
        }
    },

    updateUIForCallState: function(callState) {
        if (!this.callContainer || !this.localVideo || !this.remoteVideo || !this.audioOnlyBtn || !this.cameraBtn || !this.audioBtn || !this.pipButton) {
            Utils.log("VideoCallUIManager: 未找到所有 UI 元素，无法更新。", Utils.logLevels.WARN);
            return;
        }

        if (callState.isCallActive) {
            this.showCallContainer(true); // 如果通话激活，确保容器可见
        } else {
            this.showCallContainer(false); // 如果没有通话，则隐藏
            return; // 如果通话未激活，则无需进一步的 UI 更新
        }

        if (callState.isScreenSharing) {
            this.callContainer.classList.add('screen-sharing-mode');
            this.callContainer.classList.remove('audio-only-mode');
        } else {
            this.callContainer.classList.remove('screen-sharing-mode');
            this.callContainer.classList.toggle('audio-only-mode', callState.isAudioOnly);
        }
        this.callContainer.classList.toggle('pip-mode', this.isPipMode && callState.isCallActive);

        // 本地视频显示逻辑
        const showLocalVideo = VideoCallManager.localStream && !callState.isAudioOnly && callState.isVideoEnabled;
        if (callState.isScreenSharing) {
            if (VideoCallManager.isCaller) { // 当前用户正在共享屏幕
                this.localVideo.style.display = 'none';
                this.localVideo.srcObject = null;
            } else { // 对方正在共享屏幕
                this.localVideo.style.display = showLocalVideo ? 'block' : 'none';
                if(showLocalVideo) this.localVideo.srcObject = VideoCallManager.localStream;
                else this.localVideo.srcObject = null;
            }
        } else { // 常规视频/音频通话
            this.localVideo.style.display = showLocalVideo ? 'block' : 'none';
            if(showLocalVideo) this.localVideo.srcObject = VideoCallManager.localStream;
            else this.localVideo.srcObject = null;
        }

        // 远程视频显示逻辑
        const currentRemoteStream = this.remoteVideo.srcObject;
        const hasRemoteVideoTrack = currentRemoteStream && currentRemoteStream instanceof MediaStream &&
            currentRemoteStream.getVideoTracks().some(t => t.readyState === "live" && !t.muted);

        if ((callState.isScreenSharing && hasRemoteVideoTrack) || (!callState.isAudioOnly && hasRemoteVideoTrack)) {
            this.remoteVideo.style.display = 'block';
            if (this.remoteVideo.paused) {
                this.remoteVideo.play().catch(e => Utils.log(`播放远程视频时出错: ${e.name} - ${e.message}`, Utils.logLevels.WARN));
            }
        } else {
            this.remoteVideo.style.display = 'none';
        }

        // 更新按钮状态和外观
        this.audioOnlyBtn.style.display = callState.isCallActive ? 'none' : 'inline-block'; // 仅在通话前显示
        if (!callState.isCallActive) {
            this.audioOnlyBtn.style.background = callState.isAudioOnly ? 'var(--primary-color)' : '#fff';
            this.audioOnlyBtn.style.color = callState.isAudioOnly ? 'white' : 'var(--text-color)';
            this.audioOnlyBtn.innerHTML = callState.isAudioOnly ? '🎬' : '🔊';
            this.audioOnlyBtn.title = callState.isAudioOnly ? '切换到视频通话' : '切换到纯音频通话';
        }

        this.pipButton.style.display = callState.isCallActive ? 'inline-block' : 'none';
        if (callState.isCallActive) {
            this.pipButton.innerHTML = this.isPipMode ? '📺' : '🖼️';
            this.pipButton.title = this.isPipMode ? '最大化视频' : '最小化视频 (画中画)';
        }

        // 如果是纯音频或用户正在共享屏幕，则禁用摄像头切换
        const disableCameraToggle = callState.isAudioOnly || (callState.isScreenSharing && VideoCallManager.isCaller);
        this.cameraBtn.style.display = disableCameraToggle ? 'none' : 'inline-block';
        if (!disableCameraToggle) {
            this.cameraBtn.innerHTML = callState.isVideoEnabled ? '📹' : '🚫';
            this.cameraBtn.style.background = callState.isVideoEnabled ? '#fff' : '#666';
            this.cameraBtn.style.color = callState.isVideoEnabled ? 'var(--text-color)' : 'white';
            this.cameraBtn.title = callState.isVideoEnabled ? '关闭摄像头' : '打开摄像头';
        }

        this.audioBtn.innerHTML = callState.isAudioMuted ? '🔇' : '🎤';
        this.audioBtn.style.background = callState.isAudioMuted ? '#666' : '#fff';
        this.audioBtn.style.color = callState.isAudioMuted ? 'white' : 'var(--text-color)';
        this.audioBtn.title = callState.isAudioMuted ? '取消静音' : '静音';
    },

    setLocalStream: function(stream) {
        if (this.localVideo) {
            this.localVideo.srcObject = stream;
            if (stream && this.localVideo.paused) { // 如果设置了流，则自动播放
                this.localVideo.play().catch(e => Utils.log(`播放本地视频时出错: ${e.name}`, Utils.logLevels.WARN));
            }
        }
    },

    setRemoteStream: function(stream) {
        if (this.remoteVideo) {
            this.remoteVideo.srcObject = stream;
            if (stream && this.remoteVideo.paused) { // 如果设置了流，则自动播放
                this.remoteVideo.play().catch(e => Utils.log(`播放远程视频时出错: ${e.name}`, Utils.logLevels.WARN));
            }
        }
    },

    togglePipMode: function () {
        if (!VideoCallManager.isCallActive || !this.callContainer) return;
        this.isPipMode = !this.isPipMode;

        this.callContainer.classList.toggle('pip-mode', this.isPipMode);

        if (this.isPipMode) {
            this.initPipDraggable(this.callContainer);
            const lastLeft = this.callContainer.dataset.pipLeft;
            const lastTop = this.callContainer.dataset.pipTop;
            const containerWidth = this.callContainer.offsetWidth || 320; // 备用宽度
            const containerHeight = this.callContainer.offsetHeight || 180; // 备用高度
            const defaultLeft = `${window.innerWidth - containerWidth - 20}px`;
            const defaultTop = `${window.innerHeight - containerHeight - 20}px`;

            this.callContainer.style.left = lastLeft || defaultLeft;
            this.callContainer.style.top = lastTop || defaultTop;
            this.callContainer.style.right = 'auto';
            this.callContainer.style.bottom = 'auto';
        } else {
            this.removePipDraggable(this.callContainer);
            if (this.callContainer.style.left && this.callContainer.style.left !== 'auto') {
                this.callContainer.dataset.pipLeft = this.callContainer.style.left;
            }
            if (this.callContainer.style.top && this.callContainer.style.top !== 'auto') {
                this.callContainer.dataset.pipTop = this.callContainer.style.top;
            }
            this.callContainer.style.left = ''; this.callContainer.style.top = '';
            this.callContainer.style.right = ''; this.callContainer.style.bottom = '';
        }
        VideoCallManager.updateCurrentCallUIState();
    },

    initPipDraggable: function (element) {
        if (!element) return;
        element.addEventListener("mousedown", this._boundDragStart);
        element.addEventListener("touchstart", this._boundDragStartTouch, {passive: false});
    },

    removePipDraggable: function (element) {
        if (!element) return;
        element.removeEventListener("mousedown", this._boundDragStart);
        element.removeEventListener("touchstart", this._boundDragStartTouch);
        document.removeEventListener("mousemove", this._boundDrag);
        document.removeEventListener("mouseup", this._boundDragEnd);
        document.removeEventListener("touchmove", this._boundDragTouch);
        document.removeEventListener("touchend", this._boundDragEndTouch);
    },

    dragStart: function (e) {
        if (e.target.classList.contains('video-call-button') || e.target.closest('.video-call-button')) return;
        if (!this.isPipMode || !VideoCallManager.isCallActive || !this.callContainer) return;

        this.dragInfo.draggedElement = this.callContainer;
        this.dragInfo.active = true;
        this.dragInfo.draggedElement.style.cursor = 'grabbing';
        const rect = this.dragInfo.draggedElement.getBoundingClientRect();

        if (e.type === "touchstart") {
            this.dragInfo.initialX = e.touches[0].clientX - rect.left;
            this.dragInfo.initialY = e.touches[0].clientY - rect.top;
            document.addEventListener("touchmove", this._boundDragTouch, {passive: false});
            document.addEventListener("touchend", this._boundDragEndTouch);
            e.preventDefault();
        } else {
            this.dragInfo.initialX = e.clientX - rect.left;
            this.dragInfo.initialY = e.clientY - rect.top;
            document.addEventListener("mousemove", this._boundDrag);
            document.addEventListener("mouseup", this._boundDragEnd);
        }
    },

    drag: function (e) {
        if (!this.dragInfo.active || !this.dragInfo.draggedElement) return;
        let currentX, currentY;
        if (e.type === "touchmove") {
            e.preventDefault();
            currentX = e.touches[0].clientX - this.dragInfo.initialX;
            currentY = e.touches[0].clientY - this.dragInfo.initialY;
        } else {
            currentX = e.clientX - this.dragInfo.initialX;
            currentY = e.clientY - this.dragInfo.initialY;
        }
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        currentX = Math.max(0, Math.min(currentX, viewportWidth - this.dragInfo.draggedElement.offsetWidth));
        currentY = Math.max(0, Math.min(currentY, viewportHeight - this.dragInfo.draggedElement.offsetHeight));
        this.dragInfo.draggedElement.style.left = currentX + "px";
        this.dragInfo.draggedElement.style.top = currentY + "px";
    },

    dragEnd: function () {
        if (!this.dragInfo.active) return;
        this.dragInfo.active = false;
        if (this.dragInfo.draggedElement) {
            this.dragInfo.draggedElement.style.cursor = 'grab';
            this.dragInfo.draggedElement.dataset.pipLeft = this.dragInfo.draggedElement.style.left;
            this.dragInfo.draggedElement.dataset.pipTop = this.dragInfo.draggedElement.style.top;
        }
        document.removeEventListener("mousemove", this._boundDrag);
        document.removeEventListener("mouseup", this._boundDragEnd);
        document.removeEventListener("touchmove", this._boundDragTouch);
        document.removeEventListener("touchend", this._boundDragEndTouch);
    },

    resetPipVisuals: function() { // 从 resetPipOnEndCall 重命名，更通用
        this.isPipMode = false; // 确保 PiP 状态为 false
        if (this.callContainer) {
            this.removePipDraggable(this.callContainer);
            this.callContainer.classList.remove('pip-mode');
            this.callContainer.style.left = ''; this.callContainer.style.top = '';
            this.callContainer.style.right = ''; this.callContainer.style.bottom = '';
            // delete this.callContainer.dataset.pipLeft; // 可选：重置保存的位置
            // delete this.callContainer.dataset.pipTop;
        }
    }
};