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
    isAudioOnly: false,
    callRequestTimeout: null,
    statsInterval: null,

    isPipMode: false, // For Picture-in-Picture mode
    pipButton: null,
    dragInfo: { // For PiP dragging
        active: false,
        currentX: 0,
        currentY: 0,
        initialX: 0,
        initialY: 0,
        xOffset: 0,
        yOffset: 0,
        draggedElement: null
    },

    audioConstraints: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
    },

    codecPreferences: {
        audio: [
            {mimeType: 'audio/opus', clockRate: 48000, channels: 2, sdpFmtpLine: 'minptime=10;useinbandfec=1;stereo=1;maxaveragebitrate=128000;dtx=0'}
        ],
        video: [ {mimeType: 'video/VP9'}, {mimeType: 'video/VP8'}, {mimeType: 'video/H264'} ]
    },

    init: function () {
        this.localVideo = document.getElementById('localVideo');
        this.remoteVideo = document.getElementById('remoteVideo');
        this.pipButton = document.getElementById('togglePipBtn'); // Get PiP button

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            Utils.log('Browser does not support media devices (getUserMedia). Call functions will be disabled.', Utils.logLevels.ERROR);
            return false;
        }

        if (this.pipButton) {
            this.pipButton.addEventListener('click', () => this.togglePipMode());
        }
        return true;
    },

    initiateAudioCall: function (peerId) {
        this.initiateCall(peerId, true);
    },

    initiateCall: async function (peerId, audioOnly = false) {
        // ... (no changes in this function regarding the new requirements)
        if (this.isCallActive || this.isCallPending) {
            UIManager.showNotification('A call is already active or pending.', 'warning');
            return;
        }
        if (!peerId) peerId = ChatManager.currentChatId;
        if (!peerId) {
            UIManager.showNotification('Please select a chat partner to call.', 'warning');
            return;
        }
        if (!ConnectionManager.isConnectedTo(peerId)) {
            UIManager.showNotification('Not connected to peer. Cannot initiate call.', 'error');
            return;
        }

        this.isAudioOnly = audioOnly;
        this.isVideoEnabled = !audioOnly;
        this.isAudioMuted = false;

        try {
            this.currentPeerId = peerId;
            this.isCaller = true;
            this.isCallPending = true;

            ConnectionManager.sendTo(peerId, {
                type: 'video-call-request',
                audioOnly: this.isAudioOnly,
                sender: UserManager.userId
            });
            UIManager.showNotification(`Calling ${UserManager.contacts[peerId]?.name || 'peer'} (${this.isAudioOnly ? 'Audio' : 'Video'})...`, 'info');

            this.callRequestTimeout = setTimeout(() => {
                if (this.isCallPending) {
                    ConnectionManager.sendTo(this.currentPeerId, { type: 'video-call-cancel', sender: UserManager.userId });
                    this.endCallCleanup();
                    UIManager.showNotification('Call request timed out.', 'warning');
                }
            }, 30000);
        } catch (error) {
            Utils.log(`Failed to initiate call: ${error.message}`, Utils.logLevels.ERROR);
            UIManager.showNotification('Failed to initiate call.', 'error');
            this.endCallCleanup();
        }
    },

    showCallRequest: function (peerId, audioOnly = false) {
        // ... (no changes)
        this.currentPeerId = peerId;
        this.isAudioOnly = audioOnly;
        this.isVideoEnabled = !audioOnly;
        this.isAudioMuted = false;

        const requestModal = document.getElementById('videoCallRequest');
        const requestTitle = requestModal.querySelector('h3');
        const requestDesc = requestModal.querySelector('p');
        const avatar = requestModal.querySelector('.video-call-avatar');

        const peerName = UserManager.contacts[peerId]?.name || `Peer ${peerId.substring(0,4)}`;
        if (avatar) avatar.textContent = UserManager.contacts[peerId]?.name?.charAt(0).toUpperCase() || 'P';
        if (requestTitle) requestTitle.textContent = `${this.isAudioOnly ? 'Audio' : 'Video'} Call Request`;
        if (requestDesc) requestDesc.textContent = `${peerName} is calling...`;
        requestModal.style.display = 'flex';
    },

    hideCallRequest: function () {
        // ... (no changes)
        const requestModal = document.getElementById('videoCallRequest');
        if(requestModal) requestModal.style.display = 'none';
    },

    acceptCall: async function () {
        // ... (no changes)
        this.hideCallRequest();
        if (!this.currentPeerId) {
            UIManager.showNotification('Invalid call request.', 'error');
            return;
        }
        try {
            await this.startLocalStreamAndSignal(false);
            ConnectionManager.sendTo(this.currentPeerId, {
                type: 'video-call-accepted',
                audioOnly: this.isAudioOnly,
                sender: UserManager.userId
            });
        } catch (error) {
            Utils.log(`Failed to accept call: ${error.message}`, Utils.logLevels.ERROR);
            UIManager.showNotification(`Accept call failed: ${error.message}`, 'error');
            ConnectionManager.sendTo(this.currentPeerId, {
                type: 'video-call-rejected',
                reason: 'device_error',
                sender: UserManager.userId
            });
            this.endCallCleanup();
        }
    },

    rejectCall: function () {
        // ... (no changes)
        this.hideCallRequest();
        if (!this.currentPeerId) return;
        ConnectionManager.sendTo(this.currentPeerId, {
            type: 'video-call-rejected',
            reason: 'user_rejected',
            sender: UserManager.userId
        });
        this.endCallCleanup();
        Utils.log('Rejected call request.', Utils.logLevels.INFO);
    },

    startLocalStreamAndSignal: async function(isOfferCreatorForMedia) {
        // ... (no major changes, logic for isVideoEnabled remains)
        let attemptLocalVideoSending = !this.isAudioOnly;

        try {
            if (attemptLocalVideoSending) {
                const devices = await navigator.mediaDevices.enumerateDevices();
                if (!devices.some(d => d.kind === 'videoinput')) {
                    if (!this.isAudioOnly) UIManager.showNotification('No camera detected. You will send audio only for this video call.', 'warning');
                    attemptLocalVideoSending = false;
                }
            }

            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: attemptLocalVideoSending,
                audio: this.audioConstraints
            });

            if (attemptLocalVideoSending && (this.localStream.getVideoTracks().length === 0 || this.localStream.getVideoTracks()[0].readyState === 'ended')) {
                this.isVideoEnabled = false;
                if (!this.isAudioOnly) UIManager.showNotification('Could not use camera. Sending audio only for this video call.', 'warning');
                if (this.localStream.getAudioTracks().length === 0) {
                    this.localStream.getTracks().forEach(t => t.stop());
                    this.localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: this.audioConstraints });
                }
            } else if (!attemptLocalVideoSending) {
                this.isVideoEnabled = false;
            } else {
                this.isVideoEnabled = true;
            }
        } catch (getUserMediaError) {
            Utils.log(`getUserMedia error: ${getUserMediaError.name} - ${getUserMediaError.message}`, Utils.logLevels.ERROR);
            this.isVideoEnabled = false;
            if (attemptLocalVideoSending && !this.isAudioOnly) {
                UIManager.showNotification(`Camera error: ${getUserMediaError.name}. Sending audio only for this video call.`, 'error');
            }
            try {
                if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
                this.localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: this.audioConstraints });
            } catch (audioError) {
                Utils.log(`Fallback audio getUserMedia error: ${audioError.name}`, Utils.logLevels.ERROR);
                throw audioError;
            }
        }

        if (this.localStream.getAudioTracks()[0]) {
            this.localStream.getAudioTracks()[0].enabled = !this.isAudioMuted;
        }
        if (this.localStream.getVideoTracks()[0]) {
            this.localStream.getVideoTracks()[0].enabled = this.isVideoEnabled;
        }

        this.localVideo.srcObject = this.localStream;
        this.isCallActive = true;
        this.isCallPending = false;

        this.updateUIForCallType();
        document.getElementById('videoCallContainer').style.display = 'flex';

        await this.setupPeerConnection(isOfferCreatorForMedia);

        if (this.statsInterval) clearInterval(this.statsInterval);
        this.statsInterval = setInterval(() => this.collectAndSendStats(), 5000);
    },

    setupPeerConnection: async function (isOfferCreatorForMedia) {
        // ... (ontrack is significantly changed)
        const conn = ConnectionManager.connections[this.currentPeerId];
        if (!conn || !conn.peerConnection) {
            Utils.log("setupPeerConnection: No PeerConnection found.", Utils.logLevels.ERROR);
            this.endCall();
            return;
        }
        const pc = conn.peerConnection;

        pc.getSenders().forEach(sender => {
            if (sender.track) { try { pc.removeTrack(sender); } catch(e){Utils.log("Error removing old track from sender: " + e, Utils.logLevels.WARN);} }
        });

        this.localStream.getTracks().forEach(track => {
            if (track.kind === 'audio') {
                pc.addTrack(track, this.localStream);
            } else if (track.kind === 'video' && this.isVideoEnabled) {
                pc.addTrack(track, this.localStream);
            }
        });

        this.setCodecPreferences(pc);

        pc.ontrack = (event) => {
            Utils.log(`ontrack event: track kind=${event.track.kind}, id=${event.track.id}, streams: ${event.streams.length}`, Utils.logLevels.DEBUG);

            const trackHandler = (track) => {
                if (!track._videoManagerListenersAttached) {
                    track.onunmute = () => {
                        Utils.log(`Remote track ${track.id} (${track.kind}) unmuted.`, Utils.logLevels.DEBUG);
                        this.updateUIForCallType();
                        if (track.kind === 'video' && this.remoteVideo.paused) {
                            this.remoteVideo.play().catch(e => Utils.log(`Error playing remote video on unmute: ${e}`, Utils.logLevels.WARN));
                        }
                    };
                    track.onmute = () => {
                        Utils.log(`Remote track ${track.id} (${track.kind}) muted.`, Utils.logLevels.DEBUG);
                        this.updateUIForCallType();
                    };
                    track.onended = () => {
                        Utils.log(`Remote track ${track.id} (${track.kind}) ended.`, Utils.logLevels.DEBUG);
                        if (this.remoteStream && this.remoteStream.getTrackById(track.id)) {
                            try { this.remoteStream.removeTrack(track); } catch(e) { /* ignore */ }
                        }
                        this.updateUIForCallType();
                    };
                    track._videoManagerListenersAttached = true;
                }
            };

            if (event.streams && event.streams[0]) {
                const newStream = event.streams[0];
                if (this.remoteVideo.srcObject !== newStream) {
                    this.remoteVideo.srcObject = newStream;
                    this.remoteStream = newStream;
                    Utils.log(`Assigned event.streams[0] (id: ${this.remoteStream.id}) to remoteVideo.srcObject.`, Utils.logLevels.DEBUG);
                    newStream.getTracks().forEach(trackHandler);
                }
            } else {
                // Fallback: manage tracks on a single remoteStream instance
                if (!this.remoteStream) {
                    this.remoteStream = new MediaStream();
                    this.remoteVideo.srcObject = this.remoteStream;
                }
                if (event.track && !this.remoteStream.getTrackById(event.track.id)) {
                    this.remoteStream.addTrack(event.track);
                    trackHandler(event.track);
                    Utils.log(`Added track ${event.track.id} (${event.track.kind}) to manually managed remoteStream.`, Utils.logLevels.DEBUG);
                }
            }
            this.updateUIForCallType(); // Initial UI update
        };

        this.setupConnectionMonitoring(pc);

        if (isOfferCreatorForMedia) {
            await this.createAndSendOffer();
        }
    },

    setupConnectionMonitoring: function(pc) { // ... (no changes)
        pc.oniceconnectionstatechange = () => {
            Utils.log(`Call ICE State: ${pc.iceConnectionState} for ${this.currentPeerId}`, Utils.logLevels.DEBUG);
            if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
                if (this.isCallActive) {
                    UIManager.showNotification('Call connection issue detected.', 'warning');
                    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
                        this.endCall();
                    }
                }
            }
        };
    },

    setCodecPreferences: function(pc) { // ... (no changes)
        if (typeof RTCRtpTransceiver === 'undefined' || !('setCodecPreferences' in RTCRtpTransceiver.prototype)) {
            Utils.log("setCodecPreferences not supported by this browser.", Utils.logLevels.WARN);
            return;
        }
        try {
            pc.getTransceivers().forEach(transceiver => {
                if (!transceiver.sender || !transceiver.sender.track) return;
                const kind = transceiver.sender.track.kind;

                if (kind === 'audio') {
                    const { codecs } = RTCRtpSender.getCapabilities('audio');
                    const preferredAudio = this.codecPreferences.audio
                        .map(pref => codecs.find(c => c.mimeType.toLowerCase() === pref.mimeType.toLowerCase() && (!pref.sdpFmtpLine || (c.sdpFmtpLine && c.sdpFmtpLine.includes(pref.sdpFmtpLine.split(';')[0])))))
                        .filter(c => c);
                    if (preferredAudio.length > 0) {
                        try { transceiver.setCodecPreferences(preferredAudio); } catch (e) { Utils.log(`Failed to set audio codec prefs for transceiver: ${e.message}`, Utils.logLevels.WARN); }
                    }
                } else if (kind === 'video' && !this.isAudioOnly) {
                    const { codecs } = RTCRtpSender.getCapabilities('video');
                    const preferredVideo = this.codecPreferences.video
                        .map(pref => codecs.find(c => c.mimeType.toLowerCase() === pref.mimeType.toLowerCase()))
                        .filter(c => c);
                    if (preferredVideo.length > 0) {
                        try { transceiver.setCodecPreferences(preferredVideo); } catch (e) { Utils.log(`Failed to set video codec prefs for transceiver: ${e.message}`, Utils.logLevels.WARN); }
                    }
                }
            });
        } catch (error) {
            Utils.log(`Error iterating transceivers for codec preferences: ${error.message}`, Utils.logLevels.WARN);
        }
    },

    modifySdpForOpus: function(sdp) { // ... (no changes)
        const opusRegex = /a=rtpmap:(\d+) opus\/48000\/2/gm;
        let match;
        let modifiedSdp = sdp;
        const opusTargetParams = this.codecPreferences.audio.find(p => p.mimeType === 'audio/opus')?.sdpFmtpLine || 'minptime=10;useinbandfec=1';

        while ((match = opusRegex.exec(sdp)) !== null) {
            const opusPayloadType = match[1];
            const rtpmapLineSignature = `a=rtpmap:${opusPayloadType} opus/48000/2`;
            const fmtpLineForPayload = `a=fmtp:${opusPayloadType} ${opusTargetParams}`;
            const existingFmtpRegex = new RegExp(`^a=fmtp:${opusPayloadType} .*(\\r\\n)?`, 'm');
            if (existingFmtpRegex.test(modifiedSdp)) {
                modifiedSdp = modifiedSdp.replace(existingFmtpRegex, fmtpLineForPayload + (RegExp.$2 || '\r\n'));
            } else {
                const rtpmapLineIndex = modifiedSdp.indexOf(rtpmapLineSignature);
                if (rtpmapLineIndex !== -1) {
                    const endOfRtpmapLine = modifiedSdp.indexOf('\n', rtpmapLineIndex);
                    const insertPosition = (endOfRtpmapLine !== -1) ? endOfRtpmapLine : modifiedSdp.length;
                    modifiedSdp = modifiedSdp.slice(0, insertPosition) + `\r\n${fmtpLineForPayload}` + modifiedSdp.slice(insertPosition);
                }
            }
        }
        return modifiedSdp;
    },

    createAndSendOffer: async function () { // ... (no changes)
        if (!this.currentPeerId || !this.isCallActive) return;
        const conn = ConnectionManager.connections[this.currentPeerId];
        if (!conn || !conn.peerConnection) { Utils.log("No PC to create offer",Utils.logLevels.ERROR); return; }
        try {
            const offerOptions = {
                offerToReceiveAudio: true,
                offerToReceiveVideo: !this.isAudioOnly,
            };
            const offer = await conn.peerConnection.createOffer(offerOptions);
            let sdp = this.modifySdpForOpus(offer.sdp);
            const modifiedOffer = new RTCSessionDescription({ type: 'offer', sdp: sdp });
            await conn.peerConnection.setLocalDescription(modifiedOffer);
            ConnectionManager.sendTo(this.currentPeerId, {
                type: 'video-call-offer',
                sdp: conn.peerConnection.localDescription,
                audioOnly: this.isAudioOnly,
                sender: UserManager.userId
            });
        } catch (e) { Utils.log("Error creating/sending offer: " + e, Utils.logLevels.ERROR); this.endCall(); }
    },

    handleOffer: async function (sdpOffer, peerId, remoteIsAudioOnly) { // ... (no changes)
        const conn = ConnectionManager.connections[peerId];
        if (!conn || !conn.peerConnection) { Utils.log("No PC to handle offer",Utils.logLevels.ERROR); return; }
        try {
            await conn.peerConnection.setRemoteDescription(new RTCSessionDescription(sdpOffer));

            if (!this.isCallActive) {
                this.currentPeerId = peerId;
                this.isAudioOnly = remoteIsAudioOnly;
                this.isCaller = false;
                await this.startLocalStreamAndSignal(false);
            }

            const answer = await conn.peerConnection.createAnswer();
            let sdp = this.modifySdpForOpus(answer.sdp);
            const modifiedAnswer = new RTCSessionDescription({ type: 'answer', sdp: sdp });
            await conn.peerConnection.setLocalDescription(modifiedAnswer);
            ConnectionManager.sendTo(peerId, {
                type: 'video-call-answer',
                sdp: conn.peerConnection.localDescription,
                audioOnly: this.isAudioOnly,
                sender: UserManager.userId
            });
        } catch (e) { Utils.log("Error handling offer: " + e, Utils.logLevels.ERROR); this.endCall(); }
    },

    handleAnswer: async function (sdpAnswer, peerId, remoteIsAudioOnly) { // ... (no changes)
        if (this.currentPeerId !== peerId || !this.isCallActive) return;
        const conn = ConnectionManager.connections[peerId];
        if (!conn || !conn.peerConnection) return;
        try {
            if (remoteIsAudioOnly !== this.isAudioOnly) {
                Utils.log(`Warning: Mismatch in audioOnly state from answer. Peer says ${remoteIsAudioOnly}, we are ${this.isAudioOnly}. Sticking to our state.`, Utils.logLevels.WARN);
            }
            await conn.peerConnection.setRemoteDescription(new RTCSessionDescription(sdpAnswer));
            Utils.log(`Answer from ${peerId} processed. Call should be established/updated.`, Utils.logLevels.INFO);
        } catch (e) { Utils.log("Error handling answer: " + e, Utils.logLevels.ERROR); this.endCall(); }
    },

    toggleCamera: function () { // ... (no changes)
        if (!this.isCallActive) return;
        if (this.isAudioOnly) {
            UIManager.showNotification("Camera is not available in an audio-only call.", "warning");
            return;
        }
        const videoTrack = this.localStream ? this.localStream.getVideoTracks()[0] : null;
        if (!videoTrack) {
            UIManager.showNotification('Local video stream is not available. Cannot toggle camera state.', 'warning');
            return;
        }
        this.isVideoEnabled = !this.isVideoEnabled;
        videoTrack.enabled = this.isVideoEnabled;
        this.updateUIForCallType();
    },

    toggleAudio: function () { // ... (no changes)
        if (!this.isCallActive || !this.localStream || !this.localStream.getAudioTracks()[0]) return;
        this.isAudioMuted = !this.isAudioMuted;
        this.localStream.getAudioTracks()[0].enabled = !this.isAudioMuted;
        this.updateUIForCallType();
    },

    toggleAudioOnly: async function () { // ... (no changes)
        if (this.isCallActive) {
            UIManager.showNotification("Cannot switch call mode (Audio/Video) while a call is active.", "warning");
            return;
        }
        Utils.log("toggleAudioOnly called when no call is active. Current isAudioOnly: " + this.isAudioOnly, Utils.logLevels.INFO);
    },

    updateUIForCallType: function () {
        const callContainer = document.getElementById('videoCallContainer');
        const localVideoEl = this.localVideo;
        const remoteVideoEl = this.remoteVideo;
        const audioOnlyBtn = document.getElementById('audioOnlyBtn'); // The "switch audio/video" button, now hidden in-call
        const cameraBtn = document.getElementById('toggleCameraBtn');
        const audioBtn = document.getElementById('toggleAudioBtn');
        const pipBtn = this.pipButton; // Actual PiP toggle button

        if (!callContainer) return;

        callContainer.classList.toggle('audio-only-mode', this.isAudioOnly);
        callContainer.classList.toggle('pip-mode', this.isPipMode && this.isCallActive);


        if (localVideoEl) {
            localVideoEl.style.display = (!this.isAudioOnly && this.isVideoEnabled) ? 'block' : 'none';
        }

        if (remoteVideoEl) {
            const currentRemoteStream = remoteVideoEl.srcObject;
            const hasRemoteVideoTrack = currentRemoteStream && currentRemoteStream instanceof MediaStream &&
                currentRemoteStream.getVideoTracks().some(t => t.readyState === "live" && !t.muted);

            if (this.isAudioOnly) {
                remoteVideoEl.style.display = 'none';
            } else {
                remoteVideoEl.style.display = hasRemoteVideoTrack ? 'block' : 'none';
                if (hasRemoteVideoTrack && remoteVideoEl.paused) {
                    remoteVideoEl.play().catch(e => Utils.log(`Error playing remote video: ${e.name} - ${e.message}`, Utils.logLevels.WARN));
                }
            }
        }

        if (audioOnlyBtn) { // The old mode switch button
            audioOnlyBtn.style.display = this.isCallActive ? 'none' : 'inline-block';
            if (!this.isCallActive) { // Pre-call state
                audioOnlyBtn.style.background = this.isAudioOnly ? 'var(--primary-color)' : '#fff';
                audioOnlyBtn.style.color = this.isAudioOnly ? 'white' : 'var(--text-color)';
                audioOnlyBtn.innerHTML = this.isAudioOnly ? '🎬' : '🔊';
                audioOnlyBtn.title = this.isAudioOnly ? 'Switch to Video Call' : 'Switch to Audio-Only Call';
            }
        }

        if (pipBtn) { // New PiP button
            pipBtn.style.display = this.isCallActive ? 'inline-block' : 'none'; // Only show PiP button during active call
            if (this.isCallActive) {
                pipBtn.innerHTML = this.isPipMode ? '📺' : '🖼️';
                pipBtn.title = this.isPipMode ? 'Maximize Video' : 'Minimize Video';
            }
        }

        if (cameraBtn) {
            cameraBtn.style.display = this.isAudioOnly ? 'none' : 'inline-block';
            if (!this.isAudioOnly) {
                cameraBtn.innerHTML = this.isVideoEnabled ? '📹' : '🚫';
                cameraBtn.style.background = this.isVideoEnabled ? '#fff' : '#666';
                cameraBtn.style.color = this.isVideoEnabled ? 'var(--text-color)' : 'white';
                cameraBtn.title = this.isVideoEnabled ? 'Turn Camera Off' : 'Turn Camera On';
            }
        }
        if (audioBtn) {
            audioBtn.innerHTML = this.isAudioMuted ? '🔇' : '🎤';
            audioBtn.style.background = this.isAudioMuted ? '#666' : '#fff';
            audioBtn.style.color = this.isAudioMuted ? 'white' : 'var(--text-color)';
            audioBtn.title = this.isAudioMuted ? 'Unmute Microphone' : 'Mute Microphone';
        }
    },

    // --- PiP Mode and Draggable Logic ---
    togglePipMode: function() {
        if (!this.isCallActive) return; // PiP only makes sense during an active call

        this.isPipMode = !this.isPipMode;
        const callContainer = document.getElementById('videoCallContainer');

        callContainer.classList.toggle('pip-mode', this.isPipMode);

        if (this.isPipMode) {
            // Entering PiP Mode
            this.initPipDraggable(callContainer);
            // Set initial PiP position (e.g., bottom right) or restore last known
            callContainer.style.left = callContainer.dataset.pipLeft || `${window.innerWidth - callContainer.offsetWidth - 20}px`;
            callContainer.style.top = callContainer.dataset.pipTop || `${window.innerHeight - callContainer.offsetHeight - 20}px`;
            callContainer.style.right = 'auto';
            callContainer.style.bottom = 'auto';
        } else {
            // Exiting PiP Mode
            this.removePipDraggable(callContainer);
            // Store last dragged position
            if (callContainer.style.left && callContainer.style.left !== 'auto') {
                callContainer.dataset.pipLeft = callContainer.style.left;
            }
            if (callContainer.style.top && callContainer.style.top !== 'auto') {
                callContainer.dataset.pipTop = callContainer.style.top;
            }
            // Clear inline styles to let CSS for full mode take over
            callContainer.style.left = '';
            callContainer.style.top = '';
            callContainer.style.right = '';
            callContainer.style.bottom = '';
        }
        this.updateUIForCallType(); // Update button icons
    },

    initPipDraggable: function(element) {
        element.addEventListener("mousedown", this._boundDragStart = this._boundDragStart || this.dragStart.bind(this));
        element.addEventListener("touchstart", this._boundDragStartTouch = this._boundDragStartTouch || this.dragStart.bind(this), { passive: false });
    },

    removePipDraggable: function(element) {
        element.removeEventListener("mousedown", this._boundDragStart);
        element.removeEventListener("touchstart", this._boundDragStartTouch);
        // Clean up global listeners if drag was interrupted
        document.removeEventListener("mousemove", this._boundDrag);
        document.removeEventListener("mouseup", this._boundDragEnd);
        document.removeEventListener("touchmove", this._boundDragTouch);
        document.removeEventListener("touchend", this._boundDragEndTouch);
    },

    dragStart: function (e) {
        if (e.target.classList.contains('video-call-button') || e.target.closest('.video-call-button')) {
            return; // Don't drag if clicking on a button
        }
        if (!this.isPipMode || !this.isCallActive) return;

        this.dragInfo.draggedElement = document.getElementById('videoCallContainer');
        this.dragInfo.active = true;
        this.dragInfo.draggedElement.style.cursor = 'grabbing';

        const rect = this.dragInfo.draggedElement.getBoundingClientRect();

        if (e.type === "touchstart") {
            this.dragInfo.initialX = e.touches[0].clientX - rect.left;
            this.dragInfo.initialY = e.touches[0].clientY - rect.top;
            document.addEventListener("touchmove", this._boundDragTouch = this._boundDragTouch || this.drag.bind(this), { passive: false });
            document.addEventListener("touchend", this._boundDragEndTouch = this._boundDragEndTouch || this.dragEnd.bind(this));
            e.preventDefault();
        } else {
            this.dragInfo.initialX = e.clientX - rect.left;
            this.dragInfo.initialY = e.clientY - rect.top;
            document.addEventListener("mousemove", this._boundDrag = this._boundDrag || this.drag.bind(this));
            document.addEventListener("mouseup", this._boundDragEnd = this._boundDragEnd || this.dragEnd.bind(this));
        }
    },

    drag: function (e) {
        if (!this.dragInfo.active) return;

        let currentX, currentY;
        if (e.type === "touchmove") {
            e.preventDefault();
            currentX = e.touches[0].clientX - this.dragInfo.initialX;
            currentY = e.touches[0].clientY - this.dragInfo.initialY;
        } else {
            currentX = e.clientX - this.dragInfo.initialX;
            currentY = e.clientY - this.dragInfo.initialY;
        }

        const container = this.dragInfo.draggedElement;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        currentX = Math.max(0, Math.min(currentX, viewportWidth - container.offsetWidth));
        currentY = Math.max(0, Math.min(currentY, viewportHeight - container.offsetHeight));

        container.style.left = currentX + "px";
        container.style.top = currentY + "px";
    },

    dragEnd: function () {
        if (!this.dragInfo.active) return;
        this.dragInfo.active = false;
        if (this.dragInfo.draggedElement) {
            this.dragInfo.draggedElement.style.cursor = 'grab';
            // Store final position for next PiP activation
            this.dragInfo.draggedElement.dataset.pipLeft = this.dragInfo.draggedElement.style.left;
            this.dragInfo.draggedElement.dataset.pipTop = this.dragInfo.draggedElement.style.top;
        }

        document.removeEventListener("mousemove", this._boundDrag);
        document.removeEventListener("mouseup", this._boundDragEnd);
        document.removeEventListener("touchmove", this._boundDragTouch);
        document.removeEventListener("touchend", this._boundDragEndTouch);
    },
    // --- End PiP ---

    endCall: function () {
        // ... (no changes)
        if (this.callRequestTimeout) clearTimeout(this.callRequestTimeout);
        this.callRequestTimeout = null;

        if ((this.isCallActive || this.isCallPending) && this.currentPeerId) {
            ConnectionManager.sendTo(this.currentPeerId, { type: 'video-call-end', sender: UserManager.userId });
        }
        this.endCallCleanup();
    },

    endCallCleanup: function() {
        if (this.statsInterval) clearInterval(this.statsInterval); this.statsInterval = null;
        this.releaseMediaResources();
        if (this.localVideo) this.localVideo.srcObject = null;
        if (this.remoteVideo) { this.remoteVideo.srcObject = null; this.remoteVideo.style.display = 'none'; }
        this.remoteStream = null;

        const callContainer = document.getElementById('videoCallContainer');
        if (this.isPipMode) { // Ensure PiP is exited cleanly
            this.isPipMode = false; // Force it, then updateUI will reflect
            // togglePipMode would normally handle this, but directly reset here.
            this.removePipDraggable(callContainer);
            callContainer.classList.remove('pip-mode');
            callContainer.style.left = ''; callContainer.style.top = '';
            callContainer.style.right = ''; callContainer.style.bottom = '';
        }

        if(callContainer) callContainer.style.display = 'none';
        this.hideCallRequest();

        const oldPeerId = this.currentPeerId;
        this.isCallActive = false; this.isCallPending = false; this.isCaller = false;
        this.isAudioMuted = false;
        this.isAudioOnly = false;
        this.isVideoEnabled = true;
        this.currentPeerId = null;
        // this.isPipMode is already set to false above

        if (oldPeerId && ConnectionManager.connections[oldPeerId]) {
            const pc = ConnectionManager.connections[oldPeerId].peerConnection;
            if (pc) {
                pc.getSenders().forEach(sender => {
                    if (sender.track && (sender.track.kind === 'audio' || sender.track.kind === 'video')) {
                        try { pc.removeTrack(sender); } catch (e) { Utils.log(`Error removing track from sender for ${oldPeerId}: ${e}`, Utils.logLevels.WARN); }
                    }
                });
                pc.ontrack = null;
            }
        }
        Utils.log('Call resources cleaned up.', Utils.logLevels.INFO);
        this.updateUIForCallType(); // Ensure UI is fully reset
    },

    releaseMediaResources: function () { // ... (no changes)
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
    },

    handleMessage: function (message, peerId) { // ... (no changes related to these requirements)
        switch (message.type) {
            case 'video-call-request':
                if (!this.isCallActive && !this.isCallPending) {
                    this.isCallPending = true;
                    this.showCallRequest(peerId, message.audioOnly || false);
                } else {
                    ConnectionManager.sendTo(peerId, { type: 'video-call-rejected', reason: 'busy', sender: UserManager.userId });
                }
                break;
            case 'video-call-accepted':
                if (this.isCallPending && this.isCaller && this.currentPeerId === peerId) {
                    if (this.callRequestTimeout) clearTimeout(this.callRequestTimeout); this.callRequestTimeout = null;
                    if (typeof message.audioOnly === 'boolean' && message.audioOnly !== this.isAudioOnly) {
                        Utils.log(`Warning: Peer accepted with audioOnly=${message.audioOnly}, but we initiated with audioOnly=${this.isAudioOnly}. Sticking to initiated mode.`, Utils.logLevels.WARN);
                    }
                    this.startLocalStreamAndSignal(true);
                }
                break;
            case 'video-call-rejected':
            case 'video-call-cancel':
                if (this.isCallPending && this.currentPeerId === peerId) {
                    if (this.callRequestTimeout) clearTimeout(this.callRequestTimeout); this.callRequestTimeout = null;
                    const reason = message.type === 'video-call-rejected' ? (message.reason || 'rejected') : 'cancelled';
                    UIManager.showNotification(`Call ${reason} by ${UserManager.contacts[peerId]?.name || 'peer'}.`, 'warning');
                    this.endCallCleanup();
                }
                break;
            case 'video-call-offer':
                const remoteIsAudioOnlyOffer = message.audioOnly || false;
                if (!this.isCallActive && !this.isCallPending) {
                    this.isCallPending = true;
                    this.isCaller = false;
                    this.handleOffer(message.sdp, peerId, remoteIsAudioOnlyOffer);
                } else if (this.isCallActive && this.currentPeerId === peerId) {
                    if (remoteIsAudioOnlyOffer !== this.isAudioOnly) {
                        Utils.log(`Warning: Received re-offer with different audioOnly mode (${remoteIsAudioOnlyOffer}) than current call (${this.isAudioOnly}). Ignoring mode change.`, Utils.logLevels.WARN);
                    }
                    this.handleOffer(message.sdp, peerId, this.isAudioOnly);
                }
                break;
            case 'video-call-answer':
                const remoteIsAudioOnlyAnswer = message.audioOnly || false;
                if (this.isCallActive && this.currentPeerId === peerId) {
                    this.handleAnswer(message.sdp, peerId, remoteIsAudioOnlyAnswer);
                }
                break;
            case 'video-call-mode-change':
                if (this.isCallActive && this.currentPeerId === peerId) {
                    Utils.log(`Received deprecated 'video-call-mode-change' from peer ${peerId} to audioOnly: ${message.audioOnly}. Current mode is audioOnly: ${this.isAudioOnly}. Ignoring remote change as mode switching is disabled.`, Utils.logLevels.WARN);
                }
                break;
            case 'video-call-end':
                if ((this.isCallActive || this.isCallPending) && this.currentPeerId === peerId) {
                    this.endCallCleanup();
                    UIManager.showNotification(`${UserManager.contacts[peerId]?.name || 'Peer'} ended the call.`, 'info');
                }
                break;
            case 'video-call-stats':
                if (this.isCallActive && this.currentPeerId === peerId) {
                    this.handleCallStats(message.stats);
                }
                break;
        }
    },
    handleCallStats: function(stats) { // ... (no changes)
        if (stats && typeof stats.rtt === 'number') {
            Utils.log(`Call RTT to ${this.currentPeerId}: ${stats.rtt}ms. Packets Lost: ${stats.packetsLost || 'N/A'}`, Utils.logLevels.DEBUG);
        }
    },
    collectAndSendStats: async function() { // ... (no changes)
        if (!this.isCallActive || !this.currentPeerId) return;
        const conn = ConnectionManager.connections[this.currentPeerId];
        if (!conn || !conn.peerConnection || typeof conn.peerConnection.getStats !== 'function') return;

        try {
            const reports = await conn.peerConnection.getStats(null);
            let relevantStats = { rtt: null, packetsLost: null, jitter: null, bytesSent: null, bytesReceived: null };
            reports.forEach(report => {
                if (report.type === 'remote-inbound-rtp' && report.kind === 'audio') {
                    if (report.roundTripTime !== undefined) relevantStats.rtt = Math.round(report.roundTripTime * 1000);
                    if (report.packetsLost !== undefined) relevantStats.packetsLost = report.packetsLost;
                    if (report.jitter !== undefined) relevantStats.jitter = report.jitter;
                }
                if (report.type === 'outbound-rtp' && report.kind === 'audio') {
                    if (report.bytesSent !== undefined) relevantStats.bytesSent = report.bytesSent;
                }
                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                    if (report.bytesReceived !== undefined) relevantStats.bytesReceived = report.bytesReceived;
                }
            });
            if (relevantStats.rtt !== null) {
                ConnectionManager.sendTo(this.currentPeerId, {
                    type: 'video-call-stats',
                    stats: relevantStats,
                    sender: UserManager.userId
                });
            }
        } catch (e) {
            Utils.log("Error collecting WebRTC stats: " + e, Utils.logLevels.WARN);
        }
    },
};