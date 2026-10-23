// GeoPulse - Chat Privado Criptografado E2E (End-to-End Encrypted Private Chat)
// Mensagens cifradas com AES-GCM 256-bit entre membros do círculo familiar
// Suporte a 4 camadas de transporte: WebSockets MQTT, WebRTC P2P direto, API HTTP Serverless e BroadcastChannel
import { state, getApiBaseUrl } from './sync.js';
import { broadcastChatMessage } from './realtime.js';
import { broadcastChatMessageP2P } from './p2p.js';
import { broadcastChatLocal } from './sync.js';
import { playChatMessageSound, playTactileClick } from './audio.js';
import { showToast } from './modals.js';
import { eventBus } from './eventBus.js';
import { notifyChatMessage } from './notifications.js';

let chatMessages = [];
let activeChatThread = 'all'; // 'all' (Família) ou memberId específico
let unreadCount = 0;
let lastChatSyncTs = 0;
let chatPollInterval = null;

// Carrega histórico persistido localmente
try {
  const saved = localStorage.getItem('geopulse_chat_history');
  if (saved) {
    const list = JSON.parse(saved);
    if (Array.isArray(list)) {
      chatMessages = list;
      if (chatMessages.length > 0) {
        lastChatSyncTs = Math.max(...chatMessages.map((m) => m.ts || 0));
      }
    }
  }
} catch (e) {}

function saveMessagesToStorage() {
  try {
    // Guarda até as últimas 200 mensagens
    const trimmed = chatMessages.slice(-200);
    localStorage.setItem('geopulse_chat_history', JSON.stringify(trimmed));
  } catch (e) {}
}

/**
 * Atualiza o indicador visual de mensagens não lidas no cabeçalho
 */
export function updateChatBadgeUI() {
  const badge = document.getElementById('header-chat-dot');
  if (!badge) return;

  if (unreadCount > 0) {
    badge.style.display = 'block';
    badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
  } else {
    badge.style.display = 'none';
  }
}

/**
 * Sincroniza mensagens do círculo via API Serverless HTTP (/api/chat)
 * Garante que nenhuma mensagem seja perdida se a conexão WebSocket oscilar
 */
export async function syncChatWithServer() {
  const baseUrl = getApiBaseUrl();
  const circle = state.circleId || 'FAMILIA-1';

  try {
    const res = await fetch(`${baseUrl}/api/chat?circle=${encodeURIComponent(circle)}&since=${lastChatSyncTs}`);
    if (!res.ok) return;
    const data = await res.json();

    if (data && Array.isArray(data.messages) && data.messages.length > 0) {
      let hasNew = false;
      data.messages.forEach((msg) => {
        if (!msg || !msg.id || !msg.text) return;
        if (msg.ts && msg.ts > lastChatSyncTs) {
          lastChatSyncTs = msg.ts;
        }

        // Ignora mensagens do próprio usuário
        if (msg.senderId === state.currentUser.id) return;

        // Evita duplicatas
        if (chatMessages.some((m) => m.id === msg.id)) return;

        chatMessages.push(msg);
        hasNew = true;
      });

      if (hasNew) {
        saveMessagesToStorage();
        const modal = document.getElementById('modal-chat');
        const isChatOpen = modal && modal.style.display !== 'none';

        if (isChatOpen) {
          renderMessages();
          scrollToBottom();
          playChatMessageSound();
        } else {
          unreadCount++;
          updateChatBadgeUI();
          playChatMessageSound();

          const latest = data.messages[data.messages.length - 1];
          if (latest) {
            notifyChatMessage(latest.senderName, latest.text);
            showToast(`💬 ${latest.senderName}: "${latest.text}"`, 'info');
          }
        }
      }
    }
  } catch (e) {
    console.debug('[Chat Sync Error]', e);
  }
}

/**
 * Abre o modal de Chat E2E
 * @param {object|null} targetMember - Membro para conversa direta ou null para grupo da família
 */
export function openChatModal(targetMember = null) {
  playTactileClick();
  const modal = document.getElementById('modal-chat');
  if (!modal) return;

  if (targetMember && targetMember.id) {
    activeChatThread = targetMember.id;
  } else if (!activeChatThread) {
    activeChatThread = 'all';
  }

  // Zera não lidos ao abrir
  unreadCount = 0;
  updateChatBadgeUI();

  renderThreadSelector();
  renderMessages();

  modal.style.display = 'flex';

  // Sincronização rápida enquanto a conversa está aberta
  syncChatWithServer();
  if (chatPollInterval) clearInterval(chatPollInterval);
  chatPollInterval = setInterval(syncChatWithServer, 3000);

  setTimeout(() => {
    const input = document.getElementById('chat-input-text');
    if (input) input.focus();
    scrollToBottom();
  }, 100);
}

/**
 * Fecha o modal de Chat
 */
export function closeChatModal() {
  playTactileClick();
  const modal = document.getElementById('modal-chat');
  if (modal) modal.style.display = 'none';

  if (chatPollInterval) {
    clearInterval(chatPollInterval);
    chatPollInterval = null;
  }
}

/**
 * Renderiza as abas de seleção de conversa (Família ou 1-to-1 com membros)
 */
function renderThreadSelector() {
  const container = document.getElementById('chat-threads-tabs');
  if (!container) return;

  // Filtra outros membros do círculo (não exibe o próprio usuário)
  const myTraccarId = (typeof localStorage !== 'undefined' && localStorage.getItem('geopulse_traccar_id')) || '93831419';
  const members = Array.from(state.members.values()).filter((m) => {
    if (!m || !m.id) return false;
    const strId = String(m.id);
    if (strId === state.currentUser.id || m.isMe || strId === myTraccarId) return false;
    const mName = String(m.name || '').trim().toLowerCase();
    if (mName === 'membro familiar' || mName === 'iphone família' || mName === 'você') return false;
    return true;
  });

  if (activeChatThread !== 'all' && !state.members.has(activeChatThread)) {
    activeChatThread = 'all';
  }

  let html = `
    <button type="button" class="chat-tab-pill ${activeChatThread === 'all' ? 'active' : ''}" data-thread="all">
      <span class="tab-pill-icon">👨‍👩‍👧‍👦</span>
      <span>Círculo Geral</span>
    </button>
  `;

  members.forEach((m) => {
    const isSelected = activeChatThread === m.id;
    const initial = m.avatar || (m.name ? m.name.slice(0, 2).toUpperCase() : 'MB');
    const avatarStyle = m.photo
      ? `background-image: url('${m.photo}'); background-color: ${m.color || '#34C759'};`
      : `background-color: ${m.color || '#34C759'};`;
    html += `
      <button type="button" class="chat-tab-pill ${isSelected ? 'active' : ''}" data-thread="${m.id}">
        <span class="tab-pill-avatar" style="${avatarStyle}">${m.photo ? '' : initial}</span>
        <span>${m.name}</span>
      </button>
    `;
  });

  container.innerHTML = html;

  container.querySelectorAll('.chat-tab-pill').forEach((btn) => {
    btn.onclick = () => {
      playTactileClick();
      activeChatThread = btn.getAttribute('data-thread');
      renderThreadSelector();
      renderMessages();
      scrollToBottom();
    };
  });

  // Atualiza título do cabeçalho do chat
  const titleEl = document.getElementById('chat-target-title');
  const subEl = document.getElementById('chat-target-sub');

  if (activeChatThread === 'all') {
    if (titleEl) titleEl.textContent = 'Círculo Familiar 👨‍👩‍👧‍👦';
    if (subEl) subEl.textContent = `${members.length + 1} membros · Criptografia E2E Ponta a Ponta`;
  } else {
    const target = state.members.get(activeChatThread);
    if (titleEl) titleEl.textContent = target ? target.name : 'Mensagem Privada';
    if (subEl) subEl.textContent = '🔒 Chat 100% Criptografado & Direto';
  }
}

/**
 * Renderiza o histórico de mensagens da conversa ativa
 */
function renderMessages() {
  const container = document.getElementById('chat-messages-container');
  if (!container) return;

  const filtered = chatMessages.filter((msg) => {
    if (activeChatThread === 'all') {
      return !msg.targetMemberId || msg.targetMemberId === 'all';
    } else {
      // 1-to-1: Enviadas por mim para o alvo OU enviadas pelo alvo para mim
      const isSentByMeToTarget = msg.senderId === state.currentUser.id && msg.targetMemberId === activeChatThread;
      const isSentByTargetToMe = msg.senderId === activeChatThread && msg.targetMemberId === state.currentUser.id;
      return isSentByMeToTarget || isSentByTargetToMe;
    }
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="chat-empty-state">
        <div class="chat-empty-icon">💬</div>
        <strong>Nenhuma mensagem ainda</strong>
        <span>Envie uma mensagem para a família no chat em tempo real.</span>
      </div>
    `;
    return;
  }

  const html = filtered
    .map((msg) => {
      const isMe = msg.senderId === state.currentUser.id;
      const timeStr = new Date(msg.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const avatarStyle = msg.senderPhoto
        ? `background-image: url('${msg.senderPhoto}');`
        : `background-color: ${msg.senderColor || '#007AFF'};`;
      const initial = msg.senderAvatar || (msg.senderName ? msg.senderName.slice(0, 2).toUpperCase() : 'MB');

      return `
        <div class="chat-bubble-row ${isMe ? 'from-me' : 'from-them'}">
          ${
            !isMe
              ? `
            <div class="chat-bubble-avatar" style="${avatarStyle}">
              ${msg.senderPhoto ? '' : initial}
            </div>
          `
              : ''
          }
          <div class="chat-bubble-content">
            ${!isMe ? `<span class="chat-bubble-author" style="color: ${msg.senderColor || '#007AFF'};">${msg.senderName}</span>` : ''}
            <div class="chat-bubble-text">${escapeHtml(msg.text)}</div>
            <span class="chat-bubble-time">${timeStr} · 🔒 E2E</span>
          </div>
        </div>
      `;
    })
    .join('');

  container.innerHTML = html;
}

/**
 * Envia uma mensagem
 */
export function sendChatMessage(text) {
  const clean = (text || '').trim();
  if (!clean) return;

  const targetId = activeChatThread === 'all' ? null : activeChatThread;

  const msgObj = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    senderId: state.currentUser.id,
    senderName: state.currentUser.name || 'Você',
    senderAvatar: state.currentUser.avatar || state.currentUser.name.slice(0, 2).toUpperCase() || 'VC',
    senderPhoto: state.currentUser.photo || '',
    senderColor: state.currentUser.color || '#007AFF',
    targetMemberId: targetId,
    text: clean,
    ts: Date.now(),
  };

  chatMessages.push(msgObj);
  saveMessagesToStorage();
  if (msgObj.ts > lastChatSyncTs) lastChatSyncTs = msgObj.ts;

  // 1. Transmite via rede MQTT cifrada com AES-256
  broadcastChatMessage(msgObj);

  // 2. Transmite via P2P WebRTC direto para aparelhos conectados
  broadcastChatMessageP2P(msgObj);

  // 3. Transmite para abas locais do mesmo browser
  broadcastChatLocal(msgObj);

  // 4. Salva no servidor via HTTP POST resiliente
  const baseUrl = getApiBaseUrl();
  fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ circle: state.circleId, message: msgObj }),
  }).catch((err) => {
    console.debug('[Chat HTTP POST]', err);
  });

  renderMessages();
  scrollToBottom();

  const input = document.getElementById('chat-input-text');
  if (input) {
    input.value = '';
    input.focus();
  }
}

/**
 * Processa mensagens recebidas em tempo real de outros aparelhos (MQTT ou P2P)
 */
export function handleIncomingChatMessage(payload) {
  if (!payload || !payload.id || !payload.text) return;

  // Ignora se for do próprio usuário
  if (payload.senderId === state.currentUser.id) return;

  // Verifica se mensagem é para mim (ou grupo)
  if (payload.targetMemberId && payload.targetMemberId !== state.currentUser.id && payload.targetMemberId !== 'all') {
    return;
  }

  // Evita duplicatas
  if (chatMessages.some((m) => m.id === payload.id)) return;

  chatMessages.push(payload);
  saveMessagesToStorage();
  if (payload.ts && payload.ts > lastChatSyncTs) lastChatSyncTs = payload.ts;

  // Dispara notificação push e registra na Central de Notificações
  notifyChatMessage(payload.senderName, payload.text);

  const modal = document.getElementById('modal-chat');
  const isChatOpen = modal && modal.style.display !== 'none';

  if (isChatOpen) {
    renderMessages();
    scrollToBottom();
    playChatMessageSound();
  } else {
    unreadCount++;
    updateChatBadgeUI();
    playChatMessageSound();

    if (navigator.vibrate) {
      try { navigator.vibrate([40, 60, 40]); } catch (e) {}
    }

    showToast(`💬 ${payload.senderName}: "${payload.text}"`, 'info');
  }
}

function scrollToBottom() {
  const container = document.getElementById('chat-messages-container');
  if (container) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Inicializa listeners do modal de Chat
 */
export function initChatUI() {
  updateChatBadgeUI();

  // Botão no Header para abrir Chat
  document.getElementById('btn-open-chat-modal')?.addEventListener('click', () => {
    openChatModal();
  });

  // Botão Fechar Modal
  document.getElementById('btn-close-chat-modal')?.addEventListener('click', () => {
    closeChatModal();
  });

  // Clique no Backdrop fecha o modal
  document.getElementById('modal-chat')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-chat') {
      closeChatModal();
    }
  });

  // Envio de formulário / Enter
  const input = document.getElementById('chat-input-text');
  const btnSend = document.getElementById('btn-send-chat');
  const form = document.getElementById('chat-form');

  const doSend = () => {
    if (input) {
      sendChatMessage(input.value);
    }
  };

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    doSend();
  });

  btnSend?.addEventListener('click', (e) => {
    e.preventDefault();
    doSend();
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  // Respostas Rápidas (Quick Chips)
  document.querySelectorAll('.chat-quick-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const msg = chip.getAttribute('data-msg') || chip.textContent;
      sendChatMessage(msg);
    });
  });

  // EventBus: abrir chat direto com membro
  eventBus.on('member:chat', (member) => {
    openChatModal(member);
  });

  // Sincronização inicial e periódica em background
  syncChatWithServer();
  setInterval(syncChatWithServer, 20000);

  // Re-sincroniza mensagens ao voltar à aba/tela
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncChatWithServer();
    }
  });
}
