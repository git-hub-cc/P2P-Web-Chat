const ChatManager = {
    currentChatId: null,
    chats: {}, // { chatId: [messages] }
    currentFilter: 'all', // 'all', 'contacts', 'groups'

    init: async function() {
        await this.loadChats();
        this.renderChatList(this.currentFilter); // Initial render
    },

    loadChats: async function() {
        try {
            await DBManager.init();
            const chatItems = await DBManager.getAllItems('chats');
            this.chats = {};
            if (chatItems && chatItems.length > 0) {
                chatItems.forEach(item => {
                    this.chats[item.id] = item.messages || [];
                });
            }
        } catch (error) {
            Utils.log(`加载聊天记录失败: ${error}`, Utils.logLevels.ERROR);
        }
    },

    saveCurrentChat: async function() {
        if (this.currentChatId && this.chats[this.currentChatId]) {
            try {
                await DBManager.setItem('chats', {
                    id: this.currentChatId,
                    messages: this.chats[this.currentChatId]
                });
            } catch (error) {
                Utils.log(`保存当前聊天记录失败 (${this.currentChatId}): ${error}`, Utils.logLevels.ERROR);
            }
        }
    },

    renderChatList: function(filter = 'all') {
        this.currentFilter = filter;
        const chatListEl = document.getElementById('chatListNav');
        chatListEl.innerHTML = '';

        UIManager.setActiveTab(filter);

        let itemsToRender = [];

        if (filter === 'all' || filter === 'contacts') {
            Object.values(UserManager.contacts).forEach(contact => {
                itemsToRender.push({
                    id: contact.id,
                    name: contact.name,
                    avatarText: contact.name.charAt(0).toUpperCase(),
                    lastMessage: contact.lastMessage || 'No messages yet',
                    lastTime: contact.lastTime,
                    unread: contact.unread || 0,
                    type: 'contact',
                    online: ConnectionManager.isConnectedTo(contact.id)
                });
            });
        }

        if (filter === 'all' || filter === 'groups') {
            Object.values(GroupManager.groups).forEach(group => {
                itemsToRender.push({
                    id: group.id,
                    name: group.name,
                    avatarText: '👥',
                    lastMessage: group.lastMessage || `Members: ${group.members.length}`,
                    lastTime: group.lastTime,
                    unread: group.unread || 0,
                    type: 'group'
                });
            });
        }

        itemsToRender.sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));

        const searchQuery = document.getElementById('chatSearchInput').value.toLowerCase();
        if (searchQuery) {
            itemsToRender = itemsToRender.filter(item => item.name.toLowerCase().includes(searchQuery));
        }

        if (itemsToRender.length === 0) {
            chatListEl.innerHTML = `<li class="chat-list-item-empty">No ${filter !== 'all' ? filter : 'chats'} found.</li>`;
            return;
        }

        itemsToRender.forEach(item => {
            const li = document.createElement('li');
            li.className = `chat-list-item ${item.id === this.currentChatId ? 'active' : ''} ${item.type === 'group' ? 'group' : ''}`;
            li.setAttribute('data-id', item.id);
            li.setAttribute('data-type', item.type);

            const formattedTime = item.lastTime ? Utils.formatDate(new Date(item.lastTime)) : '';
            let statusIndicator = '';
            if (item.type === 'contact' && item.online) {
                statusIndicator = '<span class="online-dot" title="Connected"></span>';
            }

            li.innerHTML = `
                <div class="chat-list-avatar">${item.avatarText}</div>
                <div class="chat-list-info">
                    <div class="chat-list-name">${item.name} ${statusIndicator}</div>
                    <div class="chat-list-preview">${item.lastMessage}</div>
                </div>
                <div class="chat-list-meta">
                    <div class="chat-list-time">${formattedTime}</div>
                    ${item.unread > 0 ? `<div class="chat-list-badge">${item.unread > 99 ? '99+' : item.unread}</div>` : ''}
                </div>
            `;
            li.addEventListener('click', () => this.openChat(item.id, item.type));
            chatListEl.appendChild(li);
        });
    },

    openChat: function(chatId, type) {
        if (this.currentChatId) {
            this.saveCurrentChat();
            const prevActive = document.querySelector(`#chatListNav .chat-list-item.active`);
            if (prevActive) prevActive.classList.remove('active');
        }

        this.currentChatId = chatId;
        UIManager.showChatArea();

        const currentActive = document.querySelector(`#chatListNav .chat-list-item[data-id="${chatId}"]`);
        if (currentActive) currentActive.classList.add('active');

        if (type === 'group') {
            GroupManager.openGroup(chatId);
        } else {
            const contact = UserManager.contacts[chatId];
            if (contact) {
                UIManager.updateChatHeader(contact.name, `ID: ${contact.id.substring(0,8)}...`, contact.name.charAt(0).toUpperCase());
                UserManager.clearUnread(chatId);
                UIManager.setCallButtonsState(ConnectionManager.isConnectedTo(chatId), chatId);
            }
            const detailsGroupManagement = document.getElementById('detailsGroupManagement');
            if (detailsGroupManagement) detailsGroupManagement.style.display = 'none';
            const groupActionsDetails = document.getElementById('groupActionsDetails');
            if (groupActionsDetails) groupActionsDetails.style.display = 'none';
        }

        UIManager.enableChatInterface(true);
        this.loadChatHistory(chatId);

        const messageInput = document.getElementById('messageInput');
        if (messageInput) {
            messageInput.value = '';
            messageInput.style.height = 'auto';
            setTimeout(() => messageInput.focus(), 0);
        }

        UIManager.toggleDetailsPanel(false);
        UIManager.updateDetailsPanel(chatId, type);
    },

    loadChatHistory: function(chatId) {
        const chatBox = document.getElementById('chatBox');
        if (!chatBox) {
            Utils.log("ChatManager.loadChatHistory: chatBox element NOT FOUND!", Utils.logLevels.ERROR);
            return;
        }
        chatBox.innerHTML = '';

        const messages = this.chats[chatId] || [];
        if (messages.length === 0 && chatId) {
            const placeholder = document.createElement('div');
            placeholder.className = "system-message";
            placeholder.textContent = "No messages yet. Start the conversation!";
            if(chatId.startsWith('group_') && GroupManager.groups[chatId]?.owner === UserManager.userId && GroupManager.groups[chatId]?.members.length === 1) {
                placeholder.textContent = "You created this group. Invite members to start chatting!";
            }
            chatBox.appendChild(placeholder);
        } else {
            messages.forEach(msg => {
                MessageManager.displayMessage(msg, msg.sender === UserManager.userId || msg.originalSender === UserManager.userId);
            });
        }
        chatBox.scrollTop = chatBox.scrollHeight;
    },

    addMessage: async function(chatId, message) {
        console.log("发送信息");
        if (!this.chats[chatId]) {
            this.chats[chatId] = [];
        }
        const lastMsg = this.chats[chatId][this.chats[chatId].length - 1];
        if (lastMsg && lastMsg.timestamp === message.timestamp && lastMsg.content === message.content && lastMsg.sender === message.sender) {
        }

        this.chats[chatId].push(message);

        if (chatId === this.currentChatId) {
            const noMsgPlaceholder = chatBox.querySelector('.system-message');
            if(noMsgPlaceholder && (noMsgPlaceholder.textContent.includes("No messages yet") || noMsgPlaceholder.textContent.includes("You created this group"))) {
                noMsgPlaceholder.remove();
            }
            MessageManager.displayMessage(message, message.sender === UserManager.userId || message.originalSender === UserManager.userId);
            document.getElementById('chatBox').scrollTop = document.getElementById('chatBox').scrollHeight;
        }

        const isGroup = chatId.startsWith('group_');
        const isUnread = chatId !== this.currentChatId || !document.hasFocus();

        if (isGroup) {
            const group = GroupManager.groups[chatId];
            if (group) {
                let previewText = GroupManager.formatMessagePreview(message);
                await GroupManager.updateGroupLastMessage(chatId, previewText, isUnread);
            }
        } else {
            const contact = UserManager.contacts[chatId];
            if (contact) {
                let previewText = UserManager.formatMessagePreview(message);
                await UserManager.updateContactLastMessage(chatId, previewText, isUnread);
            }
        }

        try {
            await DBManager.setItem('chats', { id: chatId, messages: this.chats[chatId] });
        } catch (error) {
            Utils.log(`保存消息到DB失败 (${chatId}): ${error}`, Utils.logLevels.ERROR);
        }
    },

    clearChat: async function(chatId) {
        if (chatId && this.chats[chatId]) {
            this.chats[chatId] = [];
            try {
                await DBManager.setItem('chats', { id: chatId, messages: [] });
                if (chatId === this.currentChatId) {
                    this.loadChatHistory(chatId);
                }
                return true;
            } catch (error) {
                Utils.log(`清空聊天记录失败 (${chatId}): ${error}`, Utils.logLevels.ERROR);
                if (chatId === this.currentChatId) {
                    this.loadChatHistory(chatId);
                }
                return true;
            }
        }
        return false;
    },

    clearAllChats: async function() {
        UIManager.showConfirmationModal(
            'Are you sure you want to clear ALL chat history? This cannot be undone.',
            async () => { // onConfirm
                this.chats = {};
                try {
                    await DBManager.clearStore('chats');
                    if (this.currentChatId) {
                        this.loadChatHistory(this.currentChatId);
                    }
                    Object.values(UserManager.contacts).forEach(c => UserManager.updateContactLastMessage(c.id, '', false, true));
                    Object.values(GroupManager.groups).forEach(g => GroupManager.updateGroupLastMessage(g.id, '', false, true));

                    this.renderChatList(this.currentFilter);
                    UIManager.showNotification('All chat history cleared.', 'success');
                } catch (error) {
                    Utils.log('清空所有聊天记录失败: ' + error, Utils.logLevels.ERROR);
                    UIManager.showNotification('Failed to clear all chat history from database.', 'error');
                }
            }
        );
    },

    deleteChat: function(chatId, type) {
        const group = GroupManager.groups[chatId]; // Need group info for message
        const confirmMessage = `Are you sure you want to ${type === 'group' ? (group?.owner === UserManager.userId ? 'dissolve this group' : 'leave this group') : 'delete this contact'}? All associated messages will be lost.`;

        UIManager.showConfirmationModal(
            confirmMessage,
            async () => { // onConfirm, make async for clearChat
                await this.clearChat(chatId); // Clear messages first

                if (type === 'group') {
                    if (group?.owner === UserManager.userId) { // Use the fetched group info
                        await GroupManager.dissolveGroup(chatId); // Handles DB removal and notifications
                    } else {
                        await GroupManager.leaveGroup(chatId); // Handles DB removal and notifications
                    }
                } else { // contact
                    await UserManager.removeContact(chatId); // Handles DB removal
                }

                if (chatId === this.currentChatId) {
                    this.currentChatId = null;
                    UIManager.showNoChatSelected();
                    UIManager.enableChatInterface(false);
                }
                this.renderChatList(this.currentFilter); // Re-render list
            }
        );
    },
};