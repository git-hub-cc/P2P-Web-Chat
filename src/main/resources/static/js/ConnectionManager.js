const ConnectionManager = {
    connections: {},
    iceCandidates: {},
    connectionTimeouts: {},
    reconnectAttempts: {},
    iceTimers: {},
    iceGatheringStartTimes: {},
    websocket: null,
    isWebSocketConnected: false,
    signalingServerUrl: 'ws://localhost:8080/signaling',

    initialize: function() {
        if (!this.isWebSocketConnected && (!this.websocket || this.websocket.readyState === WebSocket.CLOSED)) {
            this.connectWebSocket();
        }
    },

    connectWebSocket: function() {
        if (this.websocket && (this.websocket.readyState === WebSocket.OPEN || this.websocket.readyState === WebSocket.CONNECTING)) {
            return Promise.resolve();
        }

        UIManager.updateConnectionStatusIndicator('Connecting to signaling server...');
        Utils.log('Attempting to connect to WebSocket: ' + this.signalingServerUrl, Utils.logLevels.INFO);

        return new Promise((resolve, reject) => {
            try {
                this.websocket = new WebSocket(this.signalingServerUrl);

                this.websocket.onopen = () => {
                    this.isWebSocketConnected = true;
                    UIManager.updateConnectionStatusIndicator('Signaling server connected.');
                    Utils.log('WebSocket connection established.', Utils.logLevels.INFO);
                    this.registerUser();
                    EventEmitter.emit('websocketStatusUpdate');
                    resolve();
                };

                this.websocket.onmessage = (event) => {
                    try {
                        const message = JSON.parse(event.data);
                        this.handleSignalingMessage(message);
                    } catch (e) {
                        Utils.log('Error parsing signaling message: ' + e, Utils.logLevels.ERROR);
                    }
                };

                this.websocket.onclose = () => {
                    const oldStatus = this.isWebSocketConnected;
                    this.isWebSocketConnected = false;
                    UIManager.updateConnectionStatusIndicator('Signaling server disconnected. Attempting to reconnect...');
                    Utils.log('WebSocket connection closed. Reconnecting in 3s...', Utils.logLevels.WARN);
                    if (oldStatus) EventEmitter.emit('websocketStatusUpdate');
                    setTimeout(() => this.connectWebSocket(), 3000);
                };

                this.websocket.onerror = (error) => {
                    Utils.log('WebSocket error: ' + JSON.stringify(error), Utils.logLevels.ERROR);
                    UIManager.updateConnectionStatusIndicator('Signaling server connection error.');
                    const oldStatus = this.isWebSocketConnected;
                    this.isWebSocketConnected = false;
                    if (oldStatus) EventEmitter.emit('websocketStatusUpdate');
                    reject(error);
                };
            } catch (error) {
                Utils.log('Failed to create WebSocket connection: ' + error, Utils.logLevels.ERROR);
                UIManager.updateConnectionStatusIndicator('Failed to connect to signaling server.');
                const oldStatus = this.isWebSocketConnected;
                this.isWebSocketConnected = false;
                if (oldStatus) EventEmitter.emit('websocketStatusUpdate');
                reject(error);
            }
        });
    },

    registerUser: function() {
        if (!UserManager.userId) {
            Utils.log('User ID not set, cannot register.', Utils.logLevels.ERROR);
            return;
        }
        const message = { type: 'REGISTER', userId: UserManager.userId };
        this.sendSignalingMessage(message, false);
    },

    sendSignalingMessage: function(message, isInternalSilentFlag = false) {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            const messageString = JSON.stringify(message);
            this.websocket.send(messageString);
            Utils.log(`Sent WS: ${message.type} to ${message.targetUserId || 'server'} (from ${message.userId || 'N/A'})`, Utils.logLevels.DEBUG);
        } else {
            Utils.log('WebSocket not connected, cannot send signaling message.', Utils.logLevels.ERROR);
            if (!isInternalSilentFlag) {
                UIManager.showNotification('Not connected to signaling server. Message not sent.', 'error');
            }
        }
    },

    handleSignalingMessage: function(message) {
        Utils.log(`Received WS: ${message.type} from ${message.fromUserId || 'server'}`, Utils.logLevels.DEBUG);
        const fromUserId = message.fromUserId;

        switch (message.type) {
            case 'SUCCESS':
                UIManager.updateConnectionStatusIndicator(`User registration successful: ${UserManager.userId.substring(0,8)}...`);
                this.autoConnectToAllContacts();
                break;
            case 'ERROR':
                break;
            case 'OFFER':
                this.handleRemoteOffer(fromUserId, message.sdp, message.candidates, message.isVideoCall, message.isAudioOnly, message.sdpType);
                break;
            case 'ANSWER':
                this.handleRemoteAnswer(fromUserId, message.sdp, message.candidates, message.isVideoCall, message.isAudioOnly, message.sdpType);
                break;
            case 'ICE_CANDIDATE':
                this.handleRemoteIceCandidate(fromUserId, message.candidate);
                break;
            case 'USER_NOT_FOUND':
                const connDetails = this.connections[message.targetUserId];
                const wasSilentAttempt = connDetails?.wasInitiatedSilently || false;

                if (!wasSilentAttempt) {
                    UIManager.showNotification(`User ${message.targetUserId} not found or offline.`, 'warning');
                }
                Utils.log(`User ${message.targetUserId} not found. (Silent Attempt: ${wasSilentAttempt})`, Utils.logLevels.WARN);

                if(ChatManager.currentChatId === message.targetUserId && !wasSilentAttempt) {
                    UIManager.updateChatHeaderStatus(`User not found or offline`);
                }
                if (this.connections[message.targetUserId]) {
                    this.close(message.targetUserId, false);
                }
                break;
            default:
                Utils.log('Unknown signaling message type: ' + message.type, Utils.logLevels.WARN);
        }
    },

    initConnection: function(peerId, isVideoCall = false) {
        Utils.log(`Attempting to initialize connection with ${peerId}. Current connection object: ${this.connections[peerId] ? 'exists' : 'null'}`, Utils.logLevels.DEBUG);

        if (this.connections[peerId]) {
            Utils.log(`Explicitly closing and deleting existing RTCPeerConnection for ${peerId} before new init.`, Utils.logLevels.WARN);
            this.close(peerId, false);
        }
        delete this.connections[peerId];
        delete this.iceCandidates[peerId];
        delete this.reconnectAttempts[peerId];
        if (this.iceTimers[peerId]) clearTimeout(this.iceTimers[peerId]);
        delete this.iceTimers[peerId];
        delete this.iceGatheringStartTimes[peerId];

        Utils.log(`Initializing new RTCPeerConnection for ${peerId}. Video call: ${isVideoCall}`, Utils.logLevels.INFO);

        try {
            const rtcConfig = Config.peerConnectionConfig;
            Utils.log(`Initializing RTCPeerConnection for ${peerId} with config: ${JSON.stringify(rtcConfig)}`, Utils.logLevels.DEBUG);
            const pc = new RTCPeerConnection(rtcConfig);
            this.connections[peerId] = {
                peerConnection: pc,
                dataChannel: null,
                isVideoCall: isVideoCall,
                isAudioOnly: false,
                wasInitiatedSilently: false
            };
            this.iceCandidates[peerId] = [];
            this.reconnectAttempts[peerId] = 0;

            pc.onicecandidate = (e) => this.handleIceCandidate(e, peerId);
            pc.onicegatheringstatechange = () => this.handleIceGatheringStateChange(peerId);
            pc.oniceconnectionstatechange = () => this.handleIceConnectionStateChange(peerId);
            pc.onconnectionstatechange = () => this.handleRtcConnectionStateChange(peerId);

            if (isVideoCall) {
            } else {
                pc.ondatachannel = (e) => this.setupDataChannel(e.channel, peerId);
            }
            return pc;
        } catch (error) {
            Utils.log(`CRITICAL: Failed to initialize RTCPeerConnection for ${peerId}: ${error.message}\nStack: ${error.stack}`, Utils.logLevels.ERROR);
            UIManager.showNotification(`Connection setup error for ${peerId}: ${error.message}`, 'error');
            delete this.connections[peerId];
            return null;
        }
    },

    createOffer: async function(targetPeerId = null, options = {}) {
        const { isVideoCall = false, isAudioOnly = false, isSilent = false } = options;
        let promptedForId = false;

        try {
            if (!targetPeerId && ChatManager.currentChatId && ChatManager.currentChatId !== UserManager.userId && !ChatManager.currentChatId.startsWith('group_')) {
                targetPeerId = ChatManager.currentChatId;
            }

            if (!targetPeerId && !isSilent) {
                Utils.log("Target Peer ID missing for createOffer, prompting user.", Utils.logLevels.INFO);
                targetPeerId = prompt('Enter Peer ID to connect to:'); // This prompt could also be a modal in future.
                promptedForId = true;
                if (!targetPeerId) {
                    UIManager.showNotification("Connection cancelled: No Peer ID entered.", "info");
                    return;
                }
            } else if (!targetPeerId && isSilent) {
                Utils.log("Target Peer ID missing for silent createOffer. Aborting this offer.", Utils.logLevels.WARN);
                return;
            }

            if (targetPeerId === UserManager.userId) {
                if (!isSilent) UIManager.showNotification("You cannot create an offer to connect to yourself.", "warning");
                else Utils.log("Attempted to create silent offer to self. Skipped.", Utils.logLevels.DEBUG);
                if (promptedForId && document.getElementById('modalSdpText')) {
                    document.getElementById('modalSdpText').value = "Cannot connect to self. Enter a different Peer ID.";
                }
                return;
            }

            if (!UserManager.userId) {
                Utils.log("UserManager.userId is null, cannot create offer.", Utils.logLevels.ERROR);
                if (!isSilent) UIManager.showNotification("Your user ID is not available. Cannot create offer.", "error");
                return;
            }

            if (!this.isWebSocketConnected) {
                try {
                    if (!isSilent) UIManager.showNotification("Signaling server not connected. Attempting to connect...", "info");
                    await this.connectWebSocket();
                } catch (e) {
                    if (!isSilent) UIManager.showNotification("Signaling server connection failed. Cannot create offer.", "error");
                    return;
                }
            }

            Utils.log(`Creating offer for target: ${targetPeerId}, from: ${UserManager.userId}, isVideo: ${isVideoCall}, isAudioOnly: ${isAudioOnly}, silent: ${isSilent}`, Utils.logLevels.DEBUG);

            const pc = this.initConnection(targetPeerId, isVideoCall);
            if (!pc) {
                if (!isSilent) UIManager.showNotification("Failed to initialize connection for offer.", "error");
                return;
            }
            this.connections[targetPeerId].isVideoCall = isVideoCall;
            this.connections[targetPeerId].isAudioOnly = isAudioOnly;
            this.connections[targetPeerId].wasInitiatedSilently = isSilent;

            if (!isVideoCall) {
                const dataChannel = pc.createDataChannel('chatChannel', { reliable: true });
                this.setupDataChannel(dataChannel, targetPeerId);
            } else {
                if (VideoCallManager.localStream) {
                    VideoCallManager.localStream.getTracks().forEach(track => {
                        if((track.kind === 'video' && !isAudioOnly) || track.kind === 'audio') {
                            pc.addTrack(track, VideoCallManager.localStream);
                        }
                    });
                } else {
                    Utils.log("Local stream not available for video call offer, proceed with caution.", Utils.logLevels.WARN);
                }
            }

            try {
                const offerOptions = {
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: isVideoCall && !isAudioOnly
                };
                const offer = await pc.createOffer(offerOptions);
                await pc.setLocalDescription(offer);

                Utils.log(`Offer created for ${targetPeerId}. State: ${pc.signalingState}. ICE Gathering... (Silent: ${isSilent})`, Utils.logLevels.INFO);
                if (!isSilent && ChatManager.currentChatId === targetPeerId) {
                    const contactName = UserManager.contacts[targetPeerId]?.name || targetPeerId.substring(0,8) + '...';
                    UIManager.updateChatHeaderStatus(`Connecting to ${contactName}...`);
                }

                if(promptedForId && document.getElementById('modalSdpText')) {
                    this.updateSdpTextInModal(targetPeerId);
                }

                this.waitForIceGatheringComplete(targetPeerId, () => {
                    if (!pc.localDescription) {
                        Utils.log(`Cannot send offer for ${targetPeerId}: localDescription is null after ICE.`, Utils.logLevels.ERROR);
                        if (!isSilent) UIManager.showNotification("Error: Could not finalize local connection details.", "error");
                        this.close(targetPeerId);
                        return;
                    }
                    const offerMessagePayload = {
                        type: 'OFFER',
                        userId: UserManager.userId,
                        targetUserId: targetPeerId,
                        sdp: pc.localDescription.sdp,
                        sdpType: pc.localDescription.type,
                        candidates: this.iceCandidates[targetPeerId] || [],
                        isVideoCall: isVideoCall,
                        isAudioOnly: isAudioOnly,
                    };
                    this.sendSignalingMessage(offerMessagePayload, isSilent);
                    Utils.log(`Offer sent to ${targetPeerId} via signaling. (Silent: ${isSilent})`, Utils.logLevels.INFO);
                });
            } catch (error) {
                Utils.log(`WebRTC error during offer creation for ${targetPeerId}: ${error.message}\nStack: ${error.stack}`, Utils.logLevels.ERROR);
                if (!isSilent) UIManager.showNotification(`Connection offer error: ${error.message}`, 'error');
                this.close(targetPeerId);
            }
        } catch (e) {
            Utils.log(`UNEXPECTED ERROR in createOffer for ${targetPeerId || 'unknown target'}: ${e.message}\nStack: ${e.stack}`, Utils.logLevels.ERROR);
            if (!isSilent) UIManager.showNotification("An unexpected error occurred while trying to connect.", "error");
            if (targetPeerId) {
                this.close(targetPeerId);
            }
        }
    },

    autoConnectToAllContacts: async function() {
        if (!UserManager.userSettings || typeof UserManager.userSettings.autoConnectEnabled === 'undefined') {
            Utils.log("Auto-connect setting not found or UserManager not fully initialized. Assuming disabled for this attempt.", Utils.logLevels.WARN);
            return;
        }

        if (!UserManager.userSettings.autoConnectEnabled) {
            Utils.log("Auto-connect to contacts is disabled by user setting.", Utils.logLevels.INFO);
            return;
        }

        Utils.log("Attempting to auto-connect to all contacts (setting is ON).", Utils.logLevels.INFO);
        if (!UserManager.contacts || Object.keys(UserManager.contacts).length === 0) {
            Utils.log("No contacts to auto-connect to.", Utils.logLevels.INFO);
            return;
        }

        const contactIds = Object.keys(UserManager.contacts);
        let offerDelay = 0;

        for (const contactId of contactIds) {
            if (contactId === UserManager.userId) continue;

            if (this.isConnectedTo(contactId)) {
                Utils.log(`Already connected to ${contactId}. Skipping auto-connect.`, Utils.logLevels.DEBUG);
                continue;
            }
            const existingConn = this.connections[contactId];
            if (existingConn && (
                existingConn.peerConnection?.connectionState === 'connecting' ||
                existingConn.peerConnection?.connectionState === 'new' ||
                existingConn.dataChannel?.readyState === 'connecting'
            )) {
                Utils.log(`Connection attempt already in progress for ${contactId}. Skipping auto-connect.`, Utils.logLevels.DEBUG);
                continue;
            }

            ((idToConnect, delay) => {
                setTimeout(async () => {
                    Utils.log(`Auto-connecting to contact (staggered): ${idToConnect}`, Utils.logLevels.DEBUG);
                    try {
                        await this.createOffer(idToConnect, {isVideoCall: false, isAudioOnly: false, isSilent: true});
                    } catch (error) {
                        Utils.log(`Error during auto-connecting initiation for ${idToConnect}: ${error.message}`, Utils.logLevels.WARN);
                    }
                }, delay);
            })(contactId, offerDelay);

            offerDelay += 300;
        }
        Utils.log("Finished dispatching auto-connection attempts to contacts.", Utils.logLevels.INFO);
    },

    handleAnswer: async function() {
        const sdpTextEl = document.getElementById('modalSdpText');
        if (!sdpTextEl || !sdpTextEl.value) {
            UIManager.showNotification("Paste answer info into the text area first.", "warning");
            return;
        }
        try {
            const answerDataFromModal = JSON.parse(sdpTextEl.value);
            sdpTextEl.value = '';

            if (!answerDataFromModal.sdp || !answerDataFromModal.sdp.sdp ||
                answerDataFromModal.sdp.type !== 'answer' ||
                !answerDataFromModal.userId) {
                UIManager.showNotification("Invalid answer data format in modal. Expected { sdp: {type: 'answer', sdp}, candidates, userId }.", "error");
                Utils.log(`Invalid answer data from modal: ${JSON.stringify(answerDataFromModal)}`, Utils.logLevels.ERROR);
                return;
            }
            if (answerDataFromModal.userId === UserManager.userId) {
                UIManager.showNotification("Cannot process an answer from yourself in this way.", "warning");
                return;
            }

            const fromUserId = answerDataFromModal.userId;
            const conn = this.connections[fromUserId];

            if (!conn || !conn.peerConnection) {
                UIManager.showNotification(`Error: No active offer found for peer ${fromUserId}. Please create an offer first.`, "error");
                Utils.log(`handleAnswer (manual): No peerConnection object for ${fromUserId} found, but an answer was provided. Original offer context lost or never existed.`, Utils.logLevels.ERROR);
                return;
            }

            const pc = conn.peerConnection;
            Utils.log(`handleAnswer (manual): Current signalingState for ${fromUserId} before setting remote answer: ${pc.signalingState}`, Utils.logLevels.DEBUG);

            if (pc.signalingState !== 'have-local-offer') {
                if (pc.signalingState === 'stable' && this.isConnectedTo(fromUserId)) {
                    UIManager.showNotification(`Already connected to ${fromUserId}. No action needed for manual answer.`, "info");
                    Utils.log(`handleAnswer (manual): Connection to ${fromUserId} is already stable. Ignoring manual answer.`, Utils.logLevels.INFO);
                } else {
                    UIManager.showNotification(`Error: Connection for ${fromUserId} is in an unexpected state (${pc.signalingState}). Expected 'have-local-offer' to process answer. Try resetting connections or creating a new offer.`, "error");
                    Utils.log(`handleAnswer (manual): PeerConnection for ${fromUserId} is in state ${pc.signalingState}, cannot set remote answer.`, Utils.logLevels.ERROR);
                }
                UIManager.toggleModal('mainMenuModal', false);
                return;
            }

            await this.handleRemoteAnswer(
                fromUserId,
                answerDataFromModal.sdp.sdp,
                answerDataFromModal.candidates,
                conn.isVideoCall,
                conn.isAudioOnly,
                'answer'
            );
            UIManager.toggleModal('mainMenuModal', false);

        } catch (e) {
            UIManager.showNotification("Error handling answer: " + e.message, "error");
            Utils.log("Error in ConnectionManager.handleAnswer (manual): " + e, Utils.logLevels.ERROR);
        }
    },

    handleRemoteAnswer: async function(fromUserId, sdpString, candidates, isVideoCallFlagFromOffer, isAudioOnlyFlagFromOffer, sdpTypeFromServer) {
        const conn = this.connections[fromUserId];
        if (!conn || !conn.peerConnection) {
            Utils.log(`handleRemoteAnswer: No active connection found for answer from ${fromUserId}.`, Utils.logLevels.WARN);
            return;
        }
        const pc = conn.peerConnection;
        const wasSilentContext = conn.wasInitiatedSilently || false;

        Utils.log(`handleRemoteAnswer for ${fromUserId}: Current signalingState: ${pc.signalingState}. SDP Type provided: ${sdpTypeFromServer}`, Utils.logLevels.DEBUG);

        if (sdpTypeFromServer !== 'answer') {
            Utils.log(`handleRemoteAnswer: Expected SDP type 'answer' but got '${sdpTypeFromServer}' for ${fromUserId}. Aborting.`, Utils.logLevels.ERROR);
            if (!wasSilentContext) UIManager.showNotification(`Protocol error: Expected answer SDP for ${fromUserId}.`, 'error');
            this.close(fromUserId);
            return;
        }

        if (pc.signalingState !== 'have-local-offer') {
            Utils.log(`handleRemoteAnswer: PeerConnection for ${fromUserId} is in state ${pc.signalingState}, but expected 'have-local-offer' to set remote answer. (Silent Context: ${wasSilentContext})`, Utils.logLevels.ERROR);
            if (!wasSilentContext) {
                if (pc.signalingState === 'stable' && this.isConnectedTo(fromUserId)) {
                    Utils.log(`handleRemoteAnswer: Connection to ${fromUserId} already stable. Answer might be duplicate or late.`, Utils.logLevels.INFO);
                } else {
                    UIManager.showNotification(`Connection state error processing answer for ${fromUserId}. State: ${pc.signalingState}.`, 'error');
                }
            }
            return;
        }

        try {
            if (typeof sdpString !== 'string') {
                Utils.log(`Invalid SDP string received in answer from ${fromUserId}. SDP: ${sdpString}`, Utils.logLevels.ERROR);
                this.close(fromUserId); return;
            }
            const remoteSdpObject = { type: 'answer', sdp: sdpString };
            await pc.setRemoteDescription(new RTCSessionDescription(remoteSdpObject));
            Utils.log(`Remote description (answer) set for ${fromUserId}. New state: ${pc.signalingState}. (Silent Context: ${wasSilentContext})`, Utils.logLevels.INFO);

            if (candidates) {
                for (const candidate of candidates) {
                    if (candidate && typeof candidate === 'object') {
                        await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => Utils.log(`Error adding remote ICE candidate from answer for ${fromUserId}: ${e}`, Utils.logLevels.WARN));
                    } else {
                        Utils.log(`Skipping invalid remote ICE candidate from answer for ${fromUserId}: ${JSON.stringify(candidate)}`, Utils.logLevels.WARN);
                    }
                }
            }
        } catch (error) {
            Utils.log(`Failed to set remote answer or add ICE for ${fromUserId}: ${error} (Signaling state was ${pc.signalingState} : ${error}}) (Silent Context: ${wasSilentContext})`, Utils.logLevels.ERROR);
            if (!wasSilentContext) UIManager.showNotification(`Error processing connection answer: ${error.message}`, 'error');
            this.close(fromUserId);
        }
    },

    createAnswer: async function() {
        const sdpTextEl = document.getElementById('modalSdpText');
        if (!sdpTextEl || !sdpTextEl.value) {
            UIManager.showNotification("Paste offer info into the text area first.", "warning");
            return;
        }
        let offerDataFromModal;
        try {
            offerDataFromModal = JSON.parse(sdpTextEl.value);

            if (!offerDataFromModal.sdp || typeof offerDataFromModal.sdp !== 'object' ||
                offerDataFromModal.sdp.type !== 'offer' ||
                !offerDataFromModal.sdp.sdp || !offerDataFromModal.userId) {
                UIManager.showNotification("Invalid offer data format in modal. Expected { sdp: {type: 'offer', sdp: '...'}, candidates: [...], userId: '...' }.", "error");
                Utils.log(`Pasted offer data for createAnswer was invalid: ${JSON.stringify(offerDataFromModal)}`, Utils.logLevels.ERROR);
                return;
            }
            if (offerDataFromModal.userId === UserManager.userId) {
                UIManager.showNotification("Cannot process an offer from yourself in this way.", "warning");
                return;
            }

            const fromUserId = offerDataFromModal.userId;

            const pc = this.initConnection(fromUserId, offerDataFromModal.isVideoCall || false);
            if (!pc) {
                UIManager.showNotification("Failed to initialize connection to create answer.", "error");
                return;
            }

            if(this.connections[fromUserId]){
                this.connections[fromUserId].wasInitiatedSilently = false;
                this.connections[fromUserId].isVideoCall = offerDataFromModal.isVideoCall || false;
                this.connections[fromUserId].isAudioOnly = offerDataFromModal.isAudioOnly || false;
            }

            await this.handleRemoteOffer(
                fromUserId,
                offerDataFromModal.sdp.sdp,
                offerDataFromModal.candidates,
                offerDataFromModal.isVideoCall,
                offerDataFromModal.isAudioOnly,
                'offer',
                true
            );
            UIManager.showNotification("Answer created and displayed in text area. Copy it and send to peer.", "info");

        } catch (e) {
            UIManager.showNotification("Error creating answer: " + e.message, "error");
            Utils.log("Error in ConnectionManager.createAnswer (manual): " + e, Utils.logLevels.ERROR);
        }
    },

    handleRemoteOffer: async function(fromUserId, sdpString, candidates, isVideoCall, isAudioOnly, sdpTypeFromServer, isManualCreateAnswerFlow = false) {
        Utils.log(`Handling remote offer from ${fromUserId}. isVideo: ${isVideoCall}, isAudioOnly: ${isAudioOnly}. ManualFlow: ${isManualCreateAnswerFlow}`, Utils.logLevels.INFO);

        if (!UserManager.contacts[fromUserId] && !GroupManager.groups[fromUserId]) {
            if(!isVideoCall && !fromUserId.startsWith('group_')){
                UserManager.addContact(fromUserId, `Peer ${fromUserId.substring(0,4)}`);
            }
        }

        let pc = this.connections[fromUserId]?.peerConnection;

        if (!isManualCreateAnswerFlow && (!pc || pc.signalingState !== 'new')) {
            Utils.log(`handleRemoteOffer (signaling): PC for ${fromUserId} is not new or doesn't exist. Re-initializing. Current state: ${pc?.signalingState}`, Utils.logLevels.DEBUG);
            pc = this.initConnection(fromUserId, isVideoCall);
            if (!pc) {
                UIManager.showNotification("Failed to initialize connection to handle offer.", "error");
                return;
            }
        } else if (!pc) {
            Utils.log(`handleRemoteOffer: pc is unexpectedly null for ${fromUserId} (ManualFlow: ${isManualCreateAnswerFlow}). Aborting.`, Utils.logLevels.ERROR);
            UIManager.showNotification("Connection object missing, cannot handle offer.", "error");
            return;
        } else if (isManualCreateAnswerFlow && pc.signalingState !== 'new') {
            Utils.log(`handleRemoteOffer (manual flow): PC for ${fromUserId} is in state ${pc.signalingState}, expected 'new'. This might indicate an issue if initConnection didn't reset properly.`, Utils.logLevels.WARN);
        }

        this.connections[fromUserId].wasInitiatedSilently = this.connections[fromUserId].wasInitiatedSilently && !isManualCreateAnswerFlow;
        this.connections[fromUserId].isVideoCall = isVideoCall;
        this.connections[fromUserId].isAudioOnly = isAudioOnly;

        try {
            if (typeof sdpString !== 'string' || sdpTypeFromServer !== 'offer') {
                Utils.log(`Invalid SDP string or sdpType (expected 'offer') received in offer from ${fromUserId}. SDP: ${sdpString}, Type: ${sdpTypeFromServer}`, Utils.logLevels.ERROR);
                this.close(fromUserId); return;
            }
            const remoteSdpObject = { type: 'offer', sdp: sdpString };
            await pc.setRemoteDescription(new RTCSessionDescription(remoteSdpObject));
            Utils.log(`Remote description (offer) set for ${fromUserId}. New state: ${pc.signalingState}.`, Utils.logLevels.INFO);

            if (candidates) {
                for (const candidate of candidates) {
                    if (candidate && typeof candidate === 'object') {
                        await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => Utils.log(`Error adding remote ICE candidate from offer for ${fromUserId}: ${e}`, Utils.logLevels.WARN));
                    } else {
                        Utils.log(`Skipping invalid remote ICE candidate from offer for ${fromUserId}: ${JSON.stringify(candidate)}`, Utils.logLevels.WARN);
                    }
                }
            }

            if (isVideoCall && VideoCallManager.isCallActive && VideoCallManager.currentPeerId === fromUserId) {
                if (VideoCallManager.localStream) {
                    VideoCallManager.localStream.getTracks().forEach(track => {
                        if((track.kind === 'video' && !isAudioOnly) || track.kind === 'audio') {
                            const existingSender = pc.getSenders().find(s => s.track?.kind === track.kind);
                            if (existingSender) {
                                existingSender.replaceTrack(track).catch(e => Utils.log(`Error replacing ${track.kind} track for ${fromUserId} in handleRemoteOffer: ${e}`, Utils.logLevels.WARN));
                            } else {
                                pc.addTrack(track, VideoCallManager.localStream);
                            }
                        }
                    });
                }
            }

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            Utils.log(`Local description (answer) created and set for ${fromUserId}. New state: ${pc.signalingState}. ICE Gathering...`, Utils.logLevels.INFO);

            if (isManualCreateAnswerFlow) {
                this.updateSdpTextInModal(fromUserId);
            } else {
                this.waitForIceGatheringComplete(fromUserId, () => {
                    if (!pc.localDescription) {
                        Utils.log(`Cannot send answer for ${fromUserId}: localDescription is null after ICE.`, Utils.logLevels.ERROR);
                        this.close(fromUserId);
                        return;
                    }
                    const answerMessagePayload = {
                        type: 'ANSWER',
                        userId: UserManager.userId,
                        targetUserId: fromUserId,
                        sdp: pc.localDescription.sdp,
                        sdpType: pc.localDescription.type,
                        candidates: this.iceCandidates[fromUserId] || [],
                        isVideoCall: this.connections[fromUserId].isVideoCall,
                        isAudioOnly: this.connections[fromUserId].isAudioOnly,
                    };
                    this.sendSignalingMessage(answerMessagePayload, false);
                    Utils.log(`Answer automatically sent to ${fromUserId} via signaling.`, Utils.logLevels.INFO);
                });
            }

        } catch (error) {
            Utils.log(`Failed to handle remote offer from ${fromUserId}: ${error.message}\nStack: ${error.stack}`, Utils.logLevels.ERROR);
            UIManager.showNotification(`Error processing connection offer: ${error.message}`, 'error');
            this.close(fromUserId);
        }
    },

    handleRemoteIceCandidate: async function(fromUserId, candidate) {
        const conn = this.connections[fromUserId];
        if (conn && conn.peerConnection && conn.peerConnection.remoteDescription && conn.peerConnection.signalingState !== 'closed') {
            try {
                if (candidate && typeof candidate === 'object') {
                    await conn.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                    Utils.log(`Added remote ICE candidate from ${fromUserId}.`, Utils.logLevels.DEBUG);
                } else {
                    Utils.log(`Skipping invalid remote ICE candidate from ${fromUserId}: ${JSON.stringify(candidate)}`, Utils.logLevels.WARN);
                }
            } catch (error) {
                Utils.log(`Error adding remote ICE candidate from ${fromUserId} (state: ${conn.peerConnection.signalingState}): ${error}`, Utils.logLevels.WARN);
            }
        } else {
            Utils.log(`Received ICE candidate from ${fromUserId}, but no valid connection or remoteDescription, or connection closed. State: ${conn?.peerConnection?.signalingState}. Candidate might be queued or dropped.`, Utils.logLevels.WARN);
        }
    },

    handleIceCandidate: function(event, peerId) {
        if (event.candidate) {
            if (!this.iceCandidates[peerId]) this.iceCandidates[peerId] = [];
            this.iceCandidates[peerId].push(event.candidate.toJSON());

            const connData = this.connections[peerId];
            const sendSilently = connData?.wasInitiatedSilently || false;

            const candidateMessagePayload = {
                type: 'ICE_CANDIDATE',
                userId: UserManager.userId,
                targetUserId: peerId,
                candidate: event.candidate.toJSON()
            };
            this.sendSignalingMessage(candidateMessagePayload, sendSilently);
        } else {
        }
    },

    waitForIceGatheringComplete: function(peerId, callback) {
        const pc = this.connections[peerId]?.peerConnection;
        if (!pc) {
            Utils.log(`waitForIceGatheringComplete: No PeerConnection for ${peerId}.`, Utils.logLevels.WARN);
            return;
        }

        if (this.iceTimers[peerId]) {
            clearTimeout(this.iceTimers[peerId]);
            delete this.iceTimers[peerId];
        }

        if (pc.iceGatheringState === 'complete') {
            Utils.log(`ICE gathering already complete for ${peerId}. Calling callback immediately.`, Utils.logLevels.DEBUG);
            callback();
        } else {
            Utils.log(`Waiting for ICE gathering to complete for ${peerId}... Current state: ${pc.iceGatheringState}`, Utils.logLevels.DEBUG);
            this.iceGatheringStartTimes[peerId] = Date.now();

            const iceTimeout = Config.timeouts.iceGathering || 8000;
            let checkInterval;

            const onDone = () => {
                clearInterval(checkInterval);
                if (this.iceTimers[peerId]) {
                    clearTimeout(this.iceTimers[peerId]);
                    delete this.iceTimers[peerId];
                    callback();
                }
            };

            this.iceTimers[peerId] = setTimeout(() => {
                Utils.log(`ICE gathering timeout for ${peerId} after ${iceTimeout}ms. Proceeding with collected candidates. State: ${pc.iceGatheringState}`, Utils.logLevels.WARN);
                onDone();
            }, iceTimeout);

            checkInterval = setInterval(() => {
                if (!this.connections[peerId] || !this.connections[peerId].peerConnection) {
                    clearInterval(checkInterval);
                    if (this.iceTimers[peerId]) clearTimeout(this.iceTimers[peerId]);
                    delete this.iceTimers[peerId];
                    Utils.log(`waitForIceGatheringComplete: PeerConnection for ${peerId} disappeared. Aborting wait.`, Utils.logLevels.WARN);
                    return;
                }
                if (this.connections[peerId].peerConnection.iceGatheringState === 'complete') {
                    Utils.log(`ICE gathering reported complete for ${peerId} by interval check.`, Utils.logLevels.DEBUG);
                    onDone();
                }
            }, 200);
        }
    },

    setupDataChannel: function(channel, peerId) {
        if (!this.connections[peerId]) {
            Utils.log(`Connection object for ${peerId} not found when setting up data channel. Channel name: ${channel.label}`, Utils.logLevels.ERROR);
            try { channel.close(); } catch(e){}
            return;
        }
        if (this.connections[peerId].dataChannel && this.connections[peerId].dataChannel.readyState === 'open') {
            Utils.log(`Data channel already exists and is open for ${peerId}. Ignoring new channel: ${channel.label}`, Utils.logLevels.WARN);
            return;
        }

        this.connections[peerId].dataChannel = channel;
        const wasSilentContext = this.connections[peerId].wasInitiatedSilently || false;
        Utils.log(`Setting up data channel "${channel.label}" for ${peerId}. Silent Context: ${wasSilentContext}`, Utils.logLevels.INFO);


        channel.onopen = () => {
            Utils.log(`Data channel with ${peerId} ("${channel.label}") opened. (Silent Context: ${wasSilentContext})`, Utils.logLevels.INFO);
            const contactName = UserManager.contacts[peerId]?.name || peerId.substring(0,8) + '...';
            if ((!wasSilentContext || ChatManager.currentChatId === peerId)) {
                UIManager.updateChatHeaderStatus(`Connected to ${contactName}`);
            }
            EventEmitter.emit('connectionEstablished', peerId);
            if (ChatManager.currentChatId === peerId && !this.connections[peerId].isVideoCall) {
                UIManager.setCallButtonsState(true, peerId);
            }
            this.reconnectAttempts[peerId] = 0;
        };

        channel.onclose = () => {
            Utils.log(`Data channel with ${peerId} ("${channel.label}") closed. (Was Silent Context: ${wasSilentContext})`, Utils.logLevels.INFO);
            const pcState = this.connections[peerId]?.peerConnection?.connectionState;
            if (pcState !== 'closed' && pcState !== 'failed') {
                EventEmitter.emit('connectionDisconnected', peerId);
            }

            if (ChatManager.currentChatId === peerId) {
                UIManager.setCallButtonsState(false);
                const contactName = UserManager.contacts[peerId]?.name || peerId.substring(0,8) + '...';
                if (!wasSilentContext || ChatManager.currentChatId === peerId) {
                }
            }
            if (this.connections[peerId]) {
                this.connections[peerId].dataChannel = null;
            }
        };

        channel.onerror = (error) => {
            Utils.log(`Data channel error with ${peerId} ("${channel.label}"): ${JSON.stringify(error)} (Was Silent: ${wasSilentContext})`, Utils.logLevels.ERROR);
        };

        channel.onmessage = (event) => {
            try {
                const rawMessage = event.data;
                let messageObjectToProcess;

                if (typeof rawMessage === 'string') {
                    let parsedJson;
                    try {
                        parsedJson = JSON.parse(rawMessage);
                    } catch (e) {
                        Utils.log(`Received malformed JSON or plain text from ${peerId} on DC "${channel.label}": ${String(rawMessage).substring(0,100)}... Error: ${e.message}`, Utils.logLevels.WARN);
                        messageObjectToProcess = {
                            type: 'text',
                            content: rawMessage,
                            sender: peerId,
                            timestamp: new Date().toISOString()
                        };
                    }

                    if (parsedJson) {
                        if (parsedJson.type === 'chunk-meta' || parsedJson.type === 'chunk-data') {
                            const reassembledData = Utils.reassembleChunk(parsedJson, peerId);
                            if (reassembledData) {
                                messageObjectToProcess = reassembledData;
                            } else {
                                return;
                            }
                        } else {
                            messageObjectToProcess = parsedJson;
                        }
                    }
                } else if (rawMessage instanceof ArrayBuffer || rawMessage instanceof Blob) {
                    Utils.log(`Received binary DataChannel message from ${peerId} on DC "${channel.label}". Length: ${rawMessage.byteLength || rawMessage.size}. Discarding (binary protocol not implemented here).`, Utils.logLevels.WARN);
                    return;
                }
                else {
                    Utils.log(`Received non-string/non-binary DataChannel message from ${peerId} on DC "${channel.label}". Type: ${typeof rawMessage}. Discarding.`, Utils.logLevels.WARN);
                    return;
                }

                if (!messageObjectToProcess) {
                    Utils.log(`Logic error: messageObjectToProcess is undefined before final handling. Raw: ${String(rawMessage).substring(0,100)}`, Utils.logLevels.ERROR);
                    return;
                }
                messageObjectToProcess.sender = messageObjectToProcess.sender || peerId;

                if (messageObjectToProcess.type && messageObjectToProcess.type.startsWith('video-call-')) {
                    VideoCallManager.handleMessage(messageObjectToProcess, peerId);
                } else if (messageObjectToProcess.groupId || messageObjectToProcess.type?.startsWith('group-')) {
                    GroupManager.handleGroupMessage(messageObjectToProcess);
                } else {
                    ChatManager.addMessage(messageObjectToProcess.groupId || peerId, messageObjectToProcess);
                }

            } catch (e) {
                Utils.log(`Critical error in DataChannel onmessage from ${peerId} on DC "${channel.label}": ${e.message}. Data: ${String(event.data).substring(0,100)} Stack: ${e.stack}`, Utils.logLevels.ERROR);
            }
        };
    },

    handleIceConnectionStateChange: function(peerId) {
        const pc = this.connections[peerId]?.peerConnection;
        if (!pc) return;
        const wasSilentContext = this.connections[peerId]?.wasInitiatedSilently || false;
        Utils.log(`ICE connection state for ${peerId}: ${pc.iceConnectionState} (Silent Context: ${wasSilentContext})`, Utils.logLevels.INFO);

        switch (pc.iceConnectionState) {
            case 'connected':
            case 'completed':
                this.reconnectAttempts[peerId] = 0;
                break;
            case 'disconnected':
                Utils.log(`ICE disconnected for ${peerId}. Attempting to reconnect if appropriate...`, Utils.logLevels.WARN);
                if (!this.connections[peerId]?.isVideoCall) {
                    this.attemptReconnect(peerId);
                }
                EventEmitter.emit('connectionDisconnected', peerId);
                break;
            case 'failed':
                Utils.log(`ICE connection failed for ${peerId}. (Silent Context: ${wasSilentContext})`, Utils.logLevels.ERROR);
                if (!wasSilentContext) UIManager.showNotification(`Connection with ${UserManager.contacts[peerId]?.name || peerId} failed.`, 'error');
                EventEmitter.emit('connectionFailed', peerId);
                this.close(peerId, false);
                break;
            case 'closed':
                Utils.log(`ICE connection closed for ${peerId}.`, Utils.logLevels.INFO);
                if (this.connections[peerId]) {
                    this.close(peerId, false);
                }
                break;
        }
    },

    handleRtcConnectionStateChange: function(peerId) {
        const pc = this.connections[peerId]?.peerConnection;
        if(!pc) return;
        const wasSilentContext = this.connections[peerId]?.wasInitiatedSilently || false;
        Utils.log(`RTCPeerConnection state for ${peerId}: ${pc.connectionState} (Silent Context: ${wasSilentContext})`, Utils.logLevels.INFO);

        switch (pc.connectionState) {
            case "new":
            case "connecting":
                break;
            case "connected":
                Utils.log(`RTCPeerConnection to ${peerId} is now 'connected'.`, Utils.logLevels.INFO);
                this.reconnectAttempts[peerId] = 0;
                break;
            case "disconnected":
                Utils.log(`RTCPeerConnection to ${peerId} is 'disconnected'. (Silent Context: ${wasSilentContext})`, Utils.logLevels.WARN);
                if (!this.connections[peerId]?.isVideoCall) {
                    EventEmitter.emit('connectionDisconnected', peerId);
                    this.attemptReconnect(peerId);
                } else {
                }
                break;
            case "failed":
                Utils.log(`RTCPeerConnection to ${peerId} has 'failed'. (Silent Context: ${wasSilentContext})`, Utils.logLevels.ERROR);
                if (!wasSilentContext) UIManager.showNotification(`Connection with ${UserManager.contacts[peerId]?.name || peerId} has failed critically.`, 'error');
                EventEmitter.emit('connectionFailed', peerId);
                this.close(peerId, false);
                break;
            case "closed":
                Utils.log(`RTCPeerConnection to ${peerId} is 'closed'.`, Utils.logLevels.INFO);
                if (this.connections[peerId]) {
                    this.close(peerId, false);
                }
                break;
        }
    },

    attemptReconnect: function(peerId) {
        if (!this.connections[peerId] || this.connections[peerId].isVideoCall) {
            Utils.log(`Skipping reconnect attempt for ${peerId} (no connection or is video call).`, Utils.logLevels.DEBUG);
            return;
        }
        if (this.isConnectedTo(peerId) || this.connections[peerId]?.peerConnection?.connectionState === 'connecting') {
            Utils.log(`Reconnect attempt for ${peerId} skipped: already connected or connecting.`, Utils.logLevels.DEBUG);
            this.reconnectAttempts[peerId] = 0;
            return;
        }

        this.reconnectAttempts[peerId] = (this.reconnectAttempts[peerId] || 0) + 1;
        if (this.reconnectAttempts[peerId] <= Config.reconnect.maxAttempts) {
            const delay = Config.reconnect.delay * Math.pow(Config.reconnect.backoffFactor, this.reconnectAttempts[peerId] -1);
            Utils.log(`Attempting to reconnect with ${peerId} (attempt ${this.reconnectAttempts[peerId]}) in ${delay/1000}s...`, Utils.logLevels.INFO);

            if (this.connectionTimeouts[peerId]) clearTimeout(this.connectionTimeouts[peerId]);

            this.connectionTimeouts[peerId] = setTimeout(() => {
                delete this.connectionTimeouts[peerId];
                if (this.connections[peerId] && !this.isConnectedTo(peerId) && this.connections[peerId].peerConnection.connectionState !== 'connecting') {
                    Utils.log(`Re-initiating offer to ${peerId} for reconnection.`, Utils.logLevels.INFO);
                    this.createOffer(peerId, { isVideoCall: false, isAudioOnly: false, isSilent: true });
                } else if (this.isConnectedTo(peerId)) {
                    Utils.log(`Reconnection to ${peerId} not needed, already connected. Resetting attempts.`, Utils.logLevels.INFO);
                    this.reconnectAttempts[peerId] = 0;
                } else {
                    Utils.log(`Reconnection to ${peerId} aborted, connection object no longer valid, already closed, or connecting. State: ${this.connections[peerId]?.peerConnection?.connectionState}`, Utils.logLevels.INFO);
                }
            }, delay);
        } else {
            Utils.log(`Max reconnection attempts reached for ${peerId}. Closing connection.`, Utils.logLevels.ERROR);
            this.close(peerId, false);
        }
    },

    sendTo: function(peerId, messageObject) {
        const conn = this.connections[peerId];
        if (conn && conn.dataChannel && conn.dataChannel.readyState === 'open') {
            try {
                messageObject.sender = messageObject.sender || UserManager.userId;
                messageObject.timestamp = messageObject.timestamp || new Date().toISOString();

                const messageString = JSON.stringify(messageObject);
                if (messageString.length > Config.chunkSize) {
                    Utils.sendInChunks(messageString,
                        (chunk) => conn.dataChannel.send(chunk),
                        peerId,
                        (messageObject.type === 'file' || messageObject.type === 'audio') ? (messageObject.fileId || messageObject.fileName || `blob-${Date.now()}`) : undefined
                    );
                } else {
                    conn.dataChannel.send(messageString);
                }
                return true;
            } catch (error) {
                Utils.log(`Error sending message to ${peerId} via DataChannel: ${error}`, Utils.logLevels.ERROR);
                return false;
            }
        } else {
            Utils.log(`Cannot send to ${peerId}: DataChannel not open or connection doesn't exist. DC State: ${conn?.dataChannel?.readyState}, PC State: ${conn?.peerConnection?.connectionState}`, Utils.logLevels.WARN);
            return false;
        }
    },

    isConnectedTo: function(peerId) {
        const conn = this.connections[peerId];
        if (!conn || !conn.peerConnection) return false;

        const pcConnected = conn.peerConnection.connectionState === 'connected';
        const dcOpen = !conn.isVideoCall && conn.dataChannel && conn.dataChannel.readyState === 'open';
        const videoCallConnected = conn.isVideoCall && pcConnected;

        return pcConnected && (dcOpen || videoCallConnected);
    },

    close: function(peerId, notifyPeer = true) {
        const conn = this.connections[peerId];
        if (conn) {
            const wasSilentContext = conn.wasInitiatedSilently || false;
            Utils.log(`Closing connection with ${peerId}. (Was Silent Context: ${wasSilentContext})`, Utils.logLevels.INFO);

            if (this.connectionTimeouts[peerId]) {
                clearTimeout(this.connectionTimeouts[peerId]);
                delete this.connectionTimeouts[peerId];
            }
            if (this.iceTimers[peerId]) {
                clearTimeout(this.iceTimers[peerId]);
                delete this.iceTimers[peerId];
            }

            if (conn.dataChannel) {
                try {
                    conn.dataChannel.onopen = null;
                    conn.dataChannel.onmessage = null;
                    conn.dataChannel.onerror = null;
                    conn.dataChannel.onclose = null;
                    if (conn.dataChannel.readyState !== 'closed') conn.dataChannel.close();
                } catch (e) { Utils.log(`Error closing data channel for ${peerId}: ${e}`, Utils.logLevels.WARN); }
            }
            if (conn.peerConnection) {
                try {
                    conn.peerConnection.onicecandidate = null;
                    conn.peerConnection.onicegatheringstatechange = null;
                    conn.peerConnection.oniceconnectionstatechange = null;
                    conn.peerConnection.onconnectionstatechange = null;
                    conn.peerConnection.ondatachannel = null;
                    conn.peerConnection.ontrack = null;
                    if (conn.peerConnection.signalingState !== 'closed') conn.peerConnection.close();
                } catch (e) { Utils.log(`Error closing peer connection for ${peerId}: ${e}`, Utils.logLevels.WARN); }
            }

            delete this.connections[peerId];
            delete this.iceCandidates[peerId];
            delete this.reconnectAttempts[peerId];
            delete this.iceGatheringStartTimes[peerId];

            if (ChatManager.currentChatId === peerId) {
                const contactName = UserManager.contacts[peerId]?.name || peerId.substring(0,8) + '...';
                if (!wasSilentContext || ChatManager.currentChatId === peerId) {
                    UIManager.updateChatHeaderStatus(`Disconnected from ${contactName}`);
                }
                UIManager.setCallButtonsState(false);
            }
            EventEmitter.emit('connectionClosed', peerId);
        } else {
            Utils.log(`Attempted to close non-existent connection for ${peerId}.`, Utils.logLevels.DEBUG);
        }
    },

    resetAllConnections: function() {
        UIManager.showConfirmationModal(
            "Are you sure you want to reset all connections? This will disconnect all active chats and calls.",
            () => { // onConfirm
                Utils.log("Resetting all connections.", Utils.logLevels.INFO);
                for (const peerId in this.connections) {
                    this.close(peerId, false);
                }
                this.connections = {};
                this.iceCandidates = {};
                this.reconnectAttempts = {};
                this.iceGatheringStartTimes = {};
                Object.keys(this.connectionTimeouts).forEach(peerId => clearTimeout(this.connectionTimeouts[peerId]));
                this.connectionTimeouts = {};
                Object.keys(this.iceTimers).forEach(peerId => clearTimeout(this.iceTimers[peerId]));
                this.iceTimers = {};

                if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                    this.websocket.onclose = null;
                    this.websocket.close();
                }
                this.websocket = null;
                this.isWebSocketConnected = false;
                EventEmitter.emit('websocketStatusUpdate');

                setTimeout(() => this.initialize(), 1000);

                UIManager.showNotification("All connections have been reset.", "info");
                if (ChatManager.currentChatId && !ChatManager.currentChatId.startsWith("group_")) {
                    UIManager.updateChatHeaderStatus("Disconnected - Connections Reset");
                    UIManager.setCallButtonsState(false);
                }
                ChatManager.renderChatList();
            }
        );
    },

    updateSdpTextInModal: function(peerId) {
        const sdpTextEl = document.getElementById('modalSdpText');
        if (!sdpTextEl) return;

        const conn = this.connections[peerId];
        const pc = conn?.peerConnection;

        if (pc && pc.localDescription) {
            const sdpType = pc.localDescription.type;
            const connectionInfo = {
                sdp: {
                    type: sdpType,
                    sdp: pc.localDescription.sdp
                },
                candidates: this.iceCandidates[peerId] || [],
                userId: UserManager.userId,
                isVideoCall: conn?.isVideoCall || false,
                isAudioOnly: conn?.isAudioOnly || false,
            };
            sdpTextEl.value = JSON.stringify(connectionInfo, null, 2);
            Utils.log(`Updated modalSdpText for ${peerId} with local ${sdpType}`, Utils.logLevels.DEBUG);
        } else {
            sdpTextEl.value = `Generating ${pc?.localDescription ? pc.localDescription.type : 'connection info'}... (ICE State: ${pc?.iceGatheringState})`;
        }
    },

    handleIceGatheringStateChange: function(peerId) {
        const pc = this.connections[peerId]?.peerConnection;
        if (!pc) return;
        Utils.log(`ICE gathering state for ${peerId}: ${pc.iceGatheringState}`, Utils.logLevels.DEBUG);

        if (pc.iceGatheringState === 'gathering') {
            if (!this.iceGatheringStartTimes[peerId]) {
                this.iceGatheringStartTimes[peerId] = Date.now();
            }
        } else if (pc.iceGatheringState === 'complete') {
            const duration = (Date.now() - (this.iceGatheringStartTimes[peerId] || Date.now())) / 1000;
            Utils.log(`ICE gathering reported complete for ${peerId} in ${duration.toFixed(1)}s.`, Utils.logLevels.DEBUG);

            if (document.getElementById('mainMenuModal').style.display === 'flex' &&
                document.getElementById('modalSdpText') &&
                pc.localDescription) {
            }
        }
    },
};

