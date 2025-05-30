const MediaManager = {
    mediaRecorder: null,
    audioChunks: [],
    recordingTimer: null,
    recordingStartTime: null,
    recordingDuration: 0,
    audioStream: null, // Store the stream to release it

    initVoiceRecording: function() {
        const voiceButton = document.getElementById('voiceButtonMain');
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            Utils.log('Browser does not support media devices.', Utils.logLevels.WARN);
            if(voiceButton) voiceButton.disabled = true;
            return;
        }
        if(voiceButton) voiceButton.disabled = false; // Enable button, permission requested on click
    },

    requestMicrophonePermission: async function() {
        if (this.mediaRecorder && this.audioStream && this.audioStream.active) {
            // Check if an old stream is still active from a previous interaction
            if (this.mediaRecorder.state === "inactive") {
                // Stream exists but recorder is inactive, likely safe to reuse or re-init
            } else {
                return true; // Already has an active recorder and stream
            }
        }

        // Release any existing stream before getting a new one
        this.releaseAudioResources();

        try {
            this.audioStream = await navigator.mediaDevices.getUserMedia({ audio: Config.media.audioConstraints || true });
            const options = { mimeType: 'audio/webm;codecs=opus' }; // Prefer Opus
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'audio/ogg;codecs=opus'; // Firefox Opus
                if(!MediaRecorder.isTypeSupported(options.mimeType)){
                    options.mimeType = 'audio/webm'; // Fallback
                }
            }

            this.mediaRecorder = new MediaRecorder(this.audioStream, options);

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) this.audioChunks.push(event.data);
            };

            this.mediaRecorder.onstop = () => {
                if (this.audioChunks.length === 0) {
                    Utils.log("No audio data recorded.", Utils.logLevels.WARN);
                    this.releaseAudioResources(); // Ensure resources are released
                    return;
                }
                const audioBlob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType });
                const reader = new FileReader();
                reader.onloadend = () => {
                    MessageManager.audioData = reader.result; // base64 data
                    MessageManager.audioDuration = this.recordingDuration;
                    this.displayAudioPreview(reader.result, this.recordingDuration);
                    // Don't release here, preview might want to play. Release after sending or cancelling.
                };
                reader.readAsDataURL(audioBlob);
                this.audioChunks = []; // Clear for next recording
            };
            Utils.log('Microphone permission granted.', Utils.logLevels.INFO);
            return true;
        } catch (error) {
            Utils.log(`Error getting microphone permission: ${error}`, Utils.logLevels.ERROR);
            UIManager.showNotification('Microphone access denied or unavailable.', 'error');
            const voiceButton = document.getElementById('voiceButtonMain');
            if(voiceButton) voiceButton.disabled = true;
            this.releaseAudioResources(); // Clean up
            return false;
        }
    },

    startRecording: async function() {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') return; // Already recording

        const permissionGranted = await this.requestMicrophonePermission();
        if (!permissionGranted) return;

        try {
            this.audioChunks = [];
            this.mediaRecorder.start();
            this.recordingStartTime = Date.now();
            this.recordingDuration = 0;

            const voiceButton = document.getElementById('voiceButtonMain');
            const voiceTimerEl = document.createElement('span'); // Create timer dynamically
            voiceTimerEl.id = 'recordingVoiceTimer';
            voiceTimerEl.className = 'audio-timer-indicator';
            voiceButton.classList.add('recording');
            voiceButton.innerHTML = '🛑'; // Stop icon
            voiceButton.appendChild(voiceTimerEl);


            this.updateRecordingTimer(); // Initial display
            this.recordingTimer = setInterval(() => this.updateRecordingTimer(), 1000);
            Utils.log('Audio recording started.', Utils.logLevels.INFO);
        } catch (error) {
            Utils.log(`Failed to start recording: ${error}`, Utils.logLevels.ERROR);
            this.releaseAudioResources();
        }
    },

    stopRecording: function() {
        if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') {
            // If stop is called when not recording (e.g. mouseleave after permission denied)
            this.resetRecordingButton();
            this.releaseAudioResources(); // Ensure resources are freed
            return;
        }

        try {
            this.mediaRecorder.stop(); // This will trigger ondataavailable and onstop
            clearInterval(this.recordingTimer);
            this.recordingTimer = null;
            this.resetRecordingButton();
            Utils.log('Audio recording stopped.', Utils.logLevels.INFO);
        } catch (error) {
            Utils.log(`Failed to stop recording: ${error}`, Utils.logLevels.ERROR);
            this.releaseAudioResources();
        }
    },

    resetRecordingButton: function() {
        const voiceButton = document.getElementById('voiceButtonMain');
        if (voiceButton) {
            voiceButton.classList.remove('recording');
            voiceButton.innerHTML = '🎙️'; // Record icon
            const timerEl = document.getElementById('recordingVoiceTimer');
            if(timerEl) timerEl.remove();
        }
    },

    updateRecordingTimer: function() {
        if (!this.recordingStartTime) return; // Guard against timer firing after stop
        const now = Date.now();
        const elapsedSeconds = Math.floor((now - this.recordingStartTime) / 1000);
        this.recordingDuration = elapsedSeconds;

        const voiceTimerEl = document.getElementById('recordingVoiceTimer');
        if (voiceTimerEl) {
            voiceTimerEl.textContent = Utils.formatTime(elapsedSeconds);
        }

        if (elapsedSeconds >= Config.media.maxAudioDuration) {
            this.stopRecording();
            UIManager.showNotification(`Max recording time of ${Config.media.maxAudioDuration}s reached.`, 'info');
        }
    },

    displayAudioPreview: function (audioDataUrl, duration) {
        const container = document.getElementById('audioPreviewContainer');
        if (!container) {
            Utils.log("Error: audioPreviewContainer not found in DOM.", Utils.logLevels.ERROR);
            return;
        }
        const formattedDuration = Utils.formatTime(duration);

        // Corrected the typo here: class="btn-cancel-preview"
        container.innerHTML = `
            <div class="voice-message-preview">
                <span>🎙️ Voice Message (${formattedDuration})</span>
                <audio controls src="${audioDataUrl}" style="display:none;"></audio> 
                <button class="btn-play-preview">Play</button>
                <button class="btn-cancel-preview">Cancel</button> 
            </div>
        `;
        const playBtn = container.querySelector('.btn-play-preview');
        const cancelBtn = container.querySelector('.btn-cancel-preview');
        const audioEl = container.querySelector('audio');

        if (playBtn && audioEl) {
            playBtn.onclick = () => {
                if (audioEl.paused) {
                    audioEl.play().catch(e => Utils.log("Error playing preview audio: " + e, Utils.logLevels.ERROR));
                    playBtn.textContent = "Pause";
                } else {
                    audioEl.pause();
                    playBtn.textContent = "Play";
                }
            };
            audioEl.onended = () => {
                playBtn.textContent = "Play";
            }
        } else {
            Utils.log("Audio preview: Play button or audio element not found.", Utils.logLevels.ERROR);
        }

        if (cancelBtn) {
            cancelBtn.onclick = () => { MessageManager.cancelAudioData(); };
        } else {
            Utils.log("Audio preview: Cancel button not found. This might be due to the corrected typo now, or other issues if it persists.", Utils.logLevels.ERROR);
        }
    },

    playAudio: function(buttonElement) {
        const audioDataUrl = buttonElement.dataset.audio;
        if (!audioDataUrl) return;

        // Simple audio player for message bubbles - create a new audio element each time
        // This avoids issues with managing a single player instance for multiple messages
        const existingAudio = buttonElement.querySelector('audio.playing-audio-instance');
        if (existingAudio) {
            existingAudio.pause();
            existingAudio.remove();
            buttonElement.innerHTML = '▶'; // Play icon
            return;
        }

        // Remove other playing instances if any
        document.querySelectorAll('audio.playing-audio-instance').forEach(aud => {
            aud.pause();
            const btn = aud.closest('.voice-message').querySelector('.play-voice-btn');
            if(btn) btn.innerHTML = '▶';
            aud.remove();

        });


        const audio = new Audio(audioDataUrl);
        audio.className = "playing-audio-instance"; // Add a class to identify it
        buttonElement.innerHTML = '❚❚';

        audio.play().catch(e => {
            Utils.log("Error playing audio: "+e, Utils.logLevels.ERROR);
            buttonElement.innerHTML = '▶';
        });

        audio.onended = () => {
            buttonElement.innerHTML = '▶';
            audio.remove(); // Clean up the audio element
        };
        audio.onerror = () => {
            buttonElement.innerHTML = '⚠️';
            setTimeout(() => {buttonElement.innerHTML = '▶'; audio.remove();}, 2000);
        };
        // Append to button or a hidden div if needed for controls, but usually not necessary for simple play
        // buttonElement.appendChild(audio); // Optional: if you want the audio element to be part of the button's DOM
    },

    releaseAudioResources: function() {
        if (this.audioStream) {
            this.audioStream.getTracks().forEach(track => track.stop());
            this.audioStream = null;
            Utils.log('Microphone stream released.', Utils.logLevels.INFO);
        }
        if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
            // If it's recording or paused, try to stop it cleanly
            // This case should ideally be handled by explicit stopRecording calls
            try {
                this.mediaRecorder.stop();
            } catch(e) { /* ignore errors if already stopped or in invalid state */ }
        }
        this.mediaRecorder = null; // Ensure it's nullified
        this.audioChunks = []; // Clear any pending chunks
    },

    formatFileSize: function(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },

    displayFilePreview: function(fileObj) {
        const container = document.getElementById('filePreviewContainer');
        if (!container) {
            Utils.log("Error: filePreviewContainer not found.", Utils.logLevels.ERROR);
            return;
        }
        container.innerHTML = '';

        const previewDiv = document.createElement('div');
        previewDiv.className = 'file-preview-item';

        let contentHtml = '';
        if (fileObj.type.startsWith('image/')) {
            contentHtml = `<img src="${fileObj.data}" alt="Preview" style="max-height: 50px; border-radius: 4px; margin-right: 8px;"> ${Utils.escapeHtml(fileObj.name)}`;
        } else if (fileObj.type.startsWith('video/')) {
            contentHtml = `🎬 ${Utils.escapeHtml(fileObj.name)} (Video)`;
        } else {
            contentHtml = `📄 ${Utils.escapeHtml(fileObj.name)} (${this.formatFileSize(fileObj.size)})`;
        }

        previewDiv.innerHTML = `
            <span>${contentHtml}</span>
            <button class="cancel-file-preview" title="Remove attachment">✕</button>
        `;
        container.appendChild(previewDiv);

        const cancelBtn = container.querySelector('.cancel-file-preview');
        if (cancelBtn) {
            cancelBtn.onclick = () => MessageManager.cancelFileData();
        } else {
            Utils.log("File preview: Cancel button not found.", Utils.logLevels.ERROR);
        }
    },

    handleFileSelect: async function(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (file.size > Config.media.maxFileSize) {
            UIManager.showNotification(`File too large. Max size: ${this.formatFileSize(Config.media.maxFileSize)}.`, 'error');
            event.target.value = ''; // Reset file input
            return;
        }

        try {
            const reader = new FileReader();
            reader.onload = (e) => {
                MessageManager.selectedFile = {
                    data: e.target.result, // base64 data
                    type: file.type,
                    name: file.name,
                    size: file.size
                };
                this.displayFilePreview(MessageManager.selectedFile);
            };
            reader.readAsDataURL(file);
        } catch (error) {
            Utils.log(`Error handling file select: ${error}`, Utils.logLevels.ERROR);
            UIManager.showNotification('Error processing file.', 'error');
        }
        event.target.value = ''; // Reset file input to allow selecting the same file again
    },
};