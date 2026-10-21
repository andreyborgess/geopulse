// GeoPulse - Gerenciador Unificado de Modais, Alertas e Compartilhamento E2E
import { state, updateUserProfile, addSavedPlace, saveUserProfile, isOnboarded } from './sync.js';
import { playTactileClick, stopFindMyChime } from './audio.js';
import { generateQRCodeSVG } from './qrcode.js';
import { getExportedCryptoKey } from './crypto.js';
import { broadcastPlaceSaved } from './realtime.js';
import {
  isIOS,
  isStandalone,
  getPermissionStatus,
  requestPushPermission,
  triggerTestPushNotification,
  getOrRegisterSubscription,
  getNotificationPreferences,
  saveNotificationPreferences,
  getNotificationsFeed,
  clearNotificationsFeed,
  markNotificationsAsRead,
  updateNotificationBadgeUI,
} from './notifications.js';
import { eventBus } from './eventBus.js';
import { getMapInstance } from './mapRenderer.js';

let selectedProfilePhoto = '';
let deferredPwaPrompt = null;

/**
 * Utilitário de compressão de foto de perfil
 */
export function compressImageFile(file, maxSize = 240, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file) {
      return reject(new Error('Nenhum arquivo selecionado.'));
    }
    const isImageMime = file.type && file.type.startsWith('image/');
    const isImageExt = file.name && /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/i.test(file.name);
    if (!isImageMime && !isImageExt && file.type !== '') {
      return reject(new Error('Selecione uma imagem válida da galeria.'));
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Erro ao ler a foto do celular.'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => {
        // Fallback: se o browser não conseguir decodificar via Image element, passa a dataURL crua
        if (e.target.result && typeof e.target.result === 'string') {
          resolve(e.target.result);
        } else {
          reject(new Error('Não foi possível carregar a imagem selecionada.'));
        }
      };
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = maxSize;
          canvas.height = maxSize;
          const ctx = canvas.getContext('2d');

          const minSide = Math.min(img.width, img.height);
          const startX = (img.width - minSide) / 2;
          const startY = (img.height - minSide) / 2;

          ctx.drawImage(img, startX, startY, minSide, minSide, 0, 0, maxSize, maxSize);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          resolve(dataUrl);
        } catch (err) {
          resolve(e.target.result);
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Constrói o link de convite seguro com o fragmento #key=... (Zero-Knowledge)
 */
export function getInviteUrl() {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const baseUrl = isLocal ? 'https://loc-sigma-mauve.vercel.app' : window.location.origin;
  const keyFragment = getExportedCryptoKey() ? `#key=${encodeURIComponent(getExportedCryptoKey())}` : '';
  return `${baseUrl}/?circle=${encodeURIComponent(state.circleId)}&host=${encodeURIComponent(state.currentUser.name)}&join=1${keyFragment}`;
}

export function updateHeaderProfileUI() {
  const headerAvatar = document.getElementById('header-user-avatar');
  if (headerAvatar) {
    if (state.currentUser.photo) {
      headerAvatar.style.backgroundImage = `url('${state.currentUser.photo}')`;
      headerAvatar.textContent = '';
    } else {
      headerAvatar.style.backgroundImage = '';
      headerAvatar.textContent = state.currentUser.avatar || 'VC';
    }
  }
  const headerCircleName = document.getElementById('header-circle-name');
  if (headerCircleName) {
    headerCircleName.textContent = state.circleName || 'Família 👨‍👩‍👧‍👦';
  }
}

/**
 * Sistema de Toasts Visuais
 */
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

// ---------------------------------------------------------------------------
// MODAL PERFIL DO USUÁRIO
// ---------------------------------------------------------------------------
export function openProfileModal() {
  playTactileClick();
  const modal = document.getElementById('modal-profile');
  const inputName = document.getElementById('input-profile-name');
  const previewName = document.getElementById('profile-edit-name-preview');
  const previewAvatar = document.getElementById('profile-edit-avatar-preview');
  const btnRemovePhoto = document.getElementById('btn-remove-custom-photo');

  if (inputName) inputName.value = state.currentUser.name;
  if (previewName) previewName.textContent = state.currentUser.name;

  selectedProfilePhoto = state.currentUser.photo || '';

  if (previewAvatar) {
    if (selectedProfilePhoto) {
      previewAvatar.style.backgroundImage = `url('${selectedProfilePhoto}')`;
      previewAvatar.textContent = '';
    } else {
      previewAvatar.style.backgroundImage = '';
      previewAvatar.textContent = state.currentUser.avatar;
    }
  }

  if (btnRemovePhoto) {
    btnRemovePhoto.style.display = selectedProfilePhoto ? 'block' : 'none';
  }

  document.querySelectorAll('.avatar-choice-btn').forEach((btn) => {
    const photo = btn.getAttribute('data-photo') || '';
    if (photo === selectedProfilePhoto) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  if (modal) modal.style.display = 'flex';
}

export function closeProfileModal() {
  playTactileClick();
  const modal = document.getElementById('modal-profile');
  if (modal) modal.style.display = 'none';
}

// ---------------------------------------------------------------------------
// MODAL TRACCAR CLIENT (RASTREAMENTO 24H IOS)
// ---------------------------------------------------------------------------
export async function openTraccarModal() {
  playTactileClick();
  const modal = document.getElementById('modal-traccar');
  if (!modal) return;

  const urlInput = document.getElementById('input-traccar-server-url');
  const idInput = document.getElementById('input-traccar-device-id');
  const isLocalOrCap = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'capacitor:';
  const serverOrigin = isLocalOrCap ? 'https://loc-sigma-mauve.vercel.app' : window.location.origin;

  const circleId = state.circleId || 'FAMILIA-1';
  const userId = state.currentUser.id || 'me';
  const traccarDeviceId = localStorage.getItem('geopulse_traccar_id') || '93831419';

  // Registra automaticamente o vínculo do Traccar ID com este usuário e círculo
  fetch(`/api/location?bind=1&device=${encodeURIComponent(traccarDeviceId)}&circle=${encodeURIComponent(circleId)}&user=${encodeURIComponent(userId)}&name=${encodeURIComponent(state.currentUser.name)}`).catch(() => {});

  if (urlInput) {
    urlInput.value = `${serverOrigin}/api/location?circle=${encodeURIComponent(circleId)}&user=${encodeURIComponent(userId)}`;
  }
  if (idInput) {
    idInput.value = traccarDeviceId;
  }

  modal.style.display = 'flex';
  checkTraccarSignalStatus(circleId, userId, traccarDeviceId);
}

export function closeTraccarModal() {
  playTactileClick();
  const modal = document.getElementById('modal-traccar');
  if (modal) modal.style.display = 'none';
}

export async function checkTraccarSignalStatus(circleId, userId, traccarId = '93831419') {
  const dot = document.getElementById('traccar-status-dot');
  const title = document.getElementById('traccar-status-title');
  const meta = document.getElementById('traccar-status-meta');

  if (title) title.textContent = 'Verificando sinal no servidor...';

  try {
    let res = await fetch(`/api/location?circle=${encodeURIComponent(circleId)}&user=${encodeURIComponent(userId)}`);
    let data = await res.json();

    if (!data.lastPing && traccarId) {
      const altRes = await fetch(`/api/location?circle=FAMILIA-1&user=${encodeURIComponent(traccarId)}`);
      const altData = await altRes.json();
      if (altData.lastPing) data = altData;
    }

    if (data.lastPing && data.lastPing.updatedAt) {
      const diffSec = Math.max(1, Math.round((Date.now() - data.lastPing.updatedAt) / 1000));
      let timeText = `${diffSec}s atrás`;
      if (diffSec > 60) timeText = `${Math.round(diffSec / 60)} min atrás`;

      if (dot) {
        dot.style.background = '#34C759';
        dot.style.boxShadow = '0 0 10px #34C759';
      }
      if (title) title.textContent = '🟢 Sinal Traccar Ativo!';
      if (meta) {
        meta.textContent = `Último envio: ${timeText} · Bateria: ${data.lastPing.battery || 100}% · Vel: ${data.lastPing.speed || 0} km/h`;
      }
    } else {
      if (dot) {
        dot.style.background = '#FF9500';
        dot.style.boxShadow = 'none';
      }
      if (title) title.textContent = 'Aguardando 1º sinal do Traccar...';
      if (meta) meta.textContent = 'Abra o Traccar Client no iPhone e ative a chave "Status de Serviço".';
    }
  } catch (err) {
    if (title) title.textContent = 'Servidor Online';
    if (meta) meta.textContent = 'Pronto para receber transmissões do Traccar Client.';
  }
}

// ---------------------------------------------------------------------------
// MODAL NOVO LUGAR SALVO
// ---------------------------------------------------------------------------
export function openPlaceModal() {
  playTactileClick();
  const modal = document.getElementById('modal-place');
  if (modal) modal.style.display = 'flex';
}

export function closePlaceModal() {
  playTactileClick();
  const modal = document.getElementById('modal-place');
  if (modal) modal.style.display = 'none';
}

// ---------------------------------------------------------------------------
// MODAL COMPARTILHAR CÍRCULO RÁPIDO (WhatsApp, SMS, etc)
// ---------------------------------------------------------------------------
export async function openQuickShare() {
  playTactileClick();
  const inviteUrl = getInviteUrl();
  const shareData = {
    title: 'Família 👨‍👩‍👧‍👦 - Compartilhar Localização',
    text: 'Entre no círculo da nossa Família 👨‍👩‍👧‍👦 para acompanharmos localização em tempo real no mapa:',
    url: inviteUrl,
  };

  if (navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
    try {
      await navigator.share(shareData);
      showToast('Convite compartilhado com sucesso!', 'info');
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  const modal = document.getElementById('modal-quick-share');
  if (modal) modal.style.display = 'flex';
}

export function closeQuickShare() {
  playTactileClick();
  const modal = document.getElementById('modal-quick-share');
  if (modal) modal.style.display = 'none';
}

// ---------------------------------------------------------------------------
// MODAL CONECTAR NOVO APARELHO (QR CODE COM CHAVE E2E)
// ---------------------------------------------------------------------------
export async function openConnectDeviceModal() {
  playTactileClick();
  const modal = document.getElementById('modal-share');
  const linkInput = document.getElementById('share-link-input');
  const qrContainer = document.getElementById('qr-container');
  const modalCircleCode = document.getElementById('modal-circle-code');

  if (modalCircleCode) {
    modalCircleCode.textContent = state.circleId;
  }

  const inviteUrl = getInviteUrl();
  if (linkInput) linkInput.value = inviteUrl;

  if (qrContainer) {
    qrContainer.innerHTML =
      '<div style="padding: 24px; font-size: 13px; color: var(--text-muted); text-align: center;">Gerando QR Code criptografado...</div>';
    try {
      const svg = await generateQRCodeSVG(inviteUrl);
      qrContainer.innerHTML = svg;
    } catch (err) {
      qrContainer.innerHTML = `<div style="color: #ff3b30; font-size: 12px; padding: 16px;">Erro: ${err.message}</div>`;
    }
  }

  if (modal) modal.style.display = 'flex';
}

export function closeConnectDeviceModal() {
  playTactileClick();
  const modal = document.getElementById('modal-share');
  if (modal) modal.style.display = 'none';
}

// ---------------------------------------------------------------------------
// MODAL INSTALAR PWA
// ---------------------------------------------------------------------------
export function openInstallPWAModal(isDirectInvite = false) {
  playTactileClick();
  const modal = document.getElementById('modal-install-pwa');
  const circleTitle = document.getElementById('pwa-circle-title');
  const nativeBox = document.getElementById('pwa-native-install-box');
  const iosBox = document.getElementById('pwa-ios-guide-box');

  if (circleTitle) {
    circleTitle.textContent = isDirectInvite
      ? `Você foi conectado ao Círculo "${state.circleId}"!`
      : 'Instale o GeoPulse no seu Celular';
  }

  if (isIOS()) {
    if (nativeBox) nativeBox.style.display = 'none';
    if (iosBox) iosBox.style.display = 'flex';
  } else {
    if (nativeBox) nativeBox.style.display = 'block';
    if (iosBox) iosBox.style.display = deferredPwaPrompt ? 'none' : 'flex';
  }

  if (modal) modal.style.display = 'flex';
}

export function closeInstallPWAModal() {
  playTactileClick();
  const modal = document.getElementById('modal-install-pwa');
  if (modal) modal.style.display = 'none';
}

export async function triggerPWAInstall() {
  playTactileClick();
  if (deferredPwaPrompt) {
    try {
      deferredPwaPrompt.prompt();
      const choice = await deferredPwaPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        showToast('Instalando GeoPulse...', 'info');
      }
      deferredPwaPrompt = null;
      const nativeBox = document.getElementById('pwa-native-install-box');
      if (nativeBox) nativeBox.style.display = 'none';
    } catch (e) {
      console.error('Erro no prompt de instalação:', e);
    }
  } else if (isIOS()) {
    showToast('No Safari: Toque em Compartilhar e depois em "Adicionar à Tela de Início".', 'info');
  } else {
    showToast('Toque no menu (⋮) do seu navegador e selecione "Instalar aplicativo".', 'info');
  }
}

// ---------------------------------------------------------------------------
// MODAL NOTIFICAÇÕES PUSH
// ---------------------------------------------------------------------------
export function updateNotificationUI() {
  const perm = getPermissionStatus();
  const indicator = document.getElementById('notif-status-indicator');
  const title = document.getElementById('notif-status-title');
  const sub = document.getElementById('notif-status-sub');
  const btnPerm = document.getElementById('btn-request-notification-perm');
  const headerDot = document.getElementById('header-notif-dot');
  const iosBanner = document.getElementById('notif-ios-banner');
  const subJsonCode = document.getElementById('sub-json-code');

  if (headerDot) {
    headerDot.className = 'header-notif-dot ' + (perm === 'granted' ? 'granted' : perm === 'denied' ? 'denied' : '');
  }

  if (iosBanner) {
    iosBanner.style.display = isIOS() ? 'block' : 'none';
  }

  if (indicator && title && sub && btnPerm) {
    indicator.className = 'notif-status-indicator ' + (perm === 'granted' ? 'granted' : perm === 'denied' ? 'denied' : '');

    if (perm === 'granted') {
      title.textContent = 'Notificações Ativas';
      sub.textContent = 'Aparelho pronto para receber alertas na tela de bloqueio.';
      btnPerm.disabled = true;
      btnPerm.innerHTML = '<span>Permitido ✓</span>';
    } else if (perm === 'denied') {
      title.textContent = 'Permissão Bloqueada';
      sub.textContent = 'Permissão bloqueada no navegador ou Ajustes do iPhone.';
      btnPerm.disabled = true;
      btnPerm.innerHTML = '<span>Bloqueado</span>';
    } else {
      title.textContent = 'Permissão Pendente';
      sub.textContent = 'Autorize notificações para receber avisos de chegada e saída.';
      btnPerm.disabled = false;
      btnPerm.innerHTML = '<span>Ativar no Aparelho</span>';
    }
  }

  if (subJsonCode) {
    getOrRegisterSubscription()
      .then((subObj) => {
        subJsonCode.textContent = subObj ? JSON.stringify(subObj, null, 2) : 'Clique em "Ativar no Aparelho".';
      })
      .catch(() => {
        subJsonCode.textContent = 'Sem subscrição ativa.';
      });
  }

  const prefs = getNotificationPreferences();
  const prefSos = document.getElementById('pref-sos-notif');
  const prefFence = document.getElementById('pref-fence-notif');
  if (prefSos) prefSos.checked = prefs.sos !== false;
  if (prefFence) prefFence.checked = prefs.fence !== false;
}

function formatNotifTimeAgo(ts) {
  if (!ts) return 'agora';
  const diffSec = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s atrás`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min atrás`;
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h atrás`;
  return `${Math.round(diffHours / 24)}d atrás`;
}

export function renderNotificationFeedUI() {
  const container = document.getElementById('notif-feed-list');
  if (!container) return;

  const feed = getNotificationsFeed();

  if (feed.length === 0) {
    container.innerHTML = `
      <div class="notif-feed-empty">
        <span class="empty-notif-icon">🔔</span>
        <strong>Nenhuma notificação recente</strong>
        <span>Avisos de "Cheguei Bem", mensagens do chat e toques sonoros aparecerão aqui.</span>
      </div>
    `;
    return;
  }

  let html = '';
  feed.forEach((item) => {
    const timeText = formatNotifTimeAgo(item.timestamp);
    html += `
      <div class="notif-feed-item ${item.read ? 'read' : 'unread'}">
        <span class="notif-feed-item-icon">${item.icon || '🔔'}</span>
        <div class="notif-feed-item-body">
          <div class="notif-feed-item-top">
            <strong class="notif-feed-item-title">${item.title}</strong>
            <span class="notif-feed-item-time">${timeText}</span>
          </div>
          <p class="notif-feed-item-desc">${item.body}</p>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

export function openNotificationsModal() {
  playTactileClick();
  updateNotificationUI();
  renderNotificationFeedUI();
  markNotificationsAsRead();
  const modal = document.getElementById('modal-notifications');
  if (modal) modal.style.display = 'flex';
}

export function closeNotificationsModal() {
  playTactileClick();
  const modal = document.getElementById('modal-notifications');
  if (modal) modal.style.display = 'none';
}

// ---------------------------------------------------------------------------
// INICIALIZAÇÃO DE TODOS OS LISTENERS DE MODAL
// ---------------------------------------------------------------------------
export function initModals() {
  // PWA Prompt capture
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPwaPrompt = e;
    const nativeBox = document.getElementById('pwa-native-install-box');
    if (nativeBox) nativeBox.style.display = 'block';
  });

  window.addEventListener('appinstalled', () => {
    deferredPwaPrompt = null;
    const nativeBox = document.getElementById('pwa-native-install-box');
    if (nativeBox) nativeBox.style.display = 'none';
    showToast('GeoPulse instalado com sucesso no seu celular!', 'info');
    closeInstallPWAModal();
  });

  // Atualiza badge de notificações no início
  updateNotificationBadgeUI();

  // Listener para limpar histórico de notificações
  document.getElementById('btn-clear-notif-feed')?.addEventListener('click', () => {
    playTactileClick();
    clearNotificationsFeed();
    renderNotificationFeedUI();
    showToast('Histórico de notificações limpo.', 'info');
  });

  // Modal Profile triggers
  document.getElementById('btn-my-profile')?.addEventListener('click', openProfileModal);
  document.getElementById('btn-close-profile-modal')?.addEventListener('click', closeProfileModal);
  document.getElementById('btn-cancel-profile')?.addEventListener('click', closeProfileModal);

  // File Picker Perfil
  const inputProfileFile = document.getElementById('input-profile-photo-file');
  const btnPickGallery = document.getElementById('btn-pick-from-gallery');
  const btnTriggerAvatar = document.getElementById('btn-trigger-avatar-click');
  const btnTriggerBadge = document.getElementById('btn-trigger-badge-click');
  const previewAvatar = document.getElementById('profile-edit-avatar-preview');
  const btnRemovePhoto = document.getElementById('btn-remove-custom-photo');

  const openPhoneGallery = () => {
    playTactileClick();
    inputProfileFile?.click();
  };

  btnPickGallery?.addEventListener('click', openPhoneGallery);
  btnTriggerAvatar?.addEventListener('click', openPhoneGallery);
  btnTriggerBadge?.addEventListener('click', (e) => {
    e.stopPropagation();
    openPhoneGallery();
  });

  inputProfileFile?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      showToast('Processando foto...', 'info');
      const compressedDataUrl = await compressImageFile(file, 240, 0.85);
      selectedProfilePhoto = compressedDataUrl;

      if (previewAvatar) {
        previewAvatar.style.backgroundImage = `url('${selectedProfilePhoto}')`;
        previewAvatar.textContent = '';
      }

      if (btnRemovePhoto) btnRemovePhoto.style.display = 'block';

      document.querySelectorAll('.avatar-choice-btn').forEach((b) => b.classList.remove('active'));
      showToast('Foto carregada da galeria!', 'info');
      playTactileClick();
    } catch (err) {
      showToast('Erro ao carregar foto: ' + err.message, 'error');
    } finally {
      inputProfileFile.value = '';
    }
  });

  btnRemovePhoto?.addEventListener('click', (e) => {
    e.stopPropagation();
    playTactileClick();
    selectedProfilePhoto = '';
    if (previewAvatar) {
      previewAvatar.style.backgroundImage = '';
      previewAvatar.textContent = state.currentUser.avatar;
    }
    btnRemovePhoto.style.display = 'none';
    showToast('Foto removida.', 'info');
  });

  document.querySelectorAll('.avatar-choice-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.avatar-choice-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedProfilePhoto = btn.getAttribute('data-photo') || '';
      if (previewAvatar) {
        if (selectedProfilePhoto) {
          previewAvatar.style.backgroundImage = `url('${selectedProfilePhoto}')`;
          previewAvatar.textContent = '';
        } else {
          previewAvatar.style.backgroundImage = '';
          previewAvatar.textContent = state.currentUser.avatar;
        }
      }
      if (btnRemovePhoto) {
        btnRemovePhoto.style.display = selectedProfilePhoto ? 'block' : 'none';
      }
    });
  });

  document.getElementById('btn-save-profile')?.addEventListener('click', () => {
    playTactileClick();
    const nameInput = document.getElementById('input-profile-name');
    const newName = nameInput?.value.trim() || 'Você';

    updateUserProfile(newName, selectedProfilePhoto);
    updateHeaderProfileUI();
    eventBus.emit('user:profile-saved');
    closeProfileModal();
    showToast('Perfil atualizado com sucesso!', 'info');
  });

  // Traccar Client Setup Triggers
  document.getElementById('btn-open-traccar-setup')?.addEventListener('click', openTraccarModal);
  document.getElementById('btn-close-traccar-modal')?.addEventListener('click', closeTraccarModal);
  document.getElementById('btn-done-traccar')?.addEventListener('click', closeTraccarModal);

  document.getElementById('btn-copy-traccar-url')?.addEventListener('click', async () => {
    playTactileClick();
    const urlInput = document.getElementById('input-traccar-server-url');
    if (urlInput?.value) {
      try {
        await navigator.clipboard.writeText(urlInput.value);
        showToast('URL do Servidor copiada com sucesso!', 'info');
      } catch (e) {
        urlInput.select();
        document.execCommand('copy');
        showToast('URL copiada!', 'info');
      }
    }
  });

  document.getElementById('btn-copy-traccar-id')?.addEventListener('click', async () => {
    playTactileClick();
    const idInput = document.getElementById('input-traccar-device-id');
    if (idInput?.value) {
      try {
        await navigator.clipboard.writeText(idInput.value);
        showToast('ID do Dispositivo copiado!', 'info');
      } catch (e) {
        idInput.select();
        document.execCommand('copy');
        showToast('ID copiado!', 'info');
      }
    }
  });

  document.getElementById('btn-test-traccar-signal')?.addEventListener('click', async () => {
    playTactileClick();
    showToast('Enviando sinal de teste para simular o Traccar...', 'info');
    const circleId = state.circleId || 'FAMILIA-1';
    const userId = state.currentUser.id || 'me';
    const lat = state.currentUser.lat || -23.55052;
    const lon = state.currentUser.lng || -46.633308;
    const batt = state.currentUser.battery || 95;

    try {
      const res = await fetch(`/api/location?circle=${encodeURIComponent(circleId)}&user=${encodeURIComponent(userId)}&lat=${lat}&lon=${lon}&batt=${batt}&speed=10`);
      const data = await res.json();
      if (data.status === 'ok') {
        showToast('Sinal de teste recebido e publicado com sucesso no círculo!', 'info');
        checkTraccarSignalStatus(circleId, userId);
      }
    } catch (err) {
      showToast('Erro ao testar sinal: ' + err.message, 'error');
    }
  });

  // Modal Place triggers
  document.getElementById('btn-open-place-modal')?.addEventListener('click', openPlaceModal);
  document.getElementById('btn-close-place-modal')?.addEventListener('click', closePlaceModal);
  document.getElementById('btn-cancel-place')?.addEventListener('click', closePlaceModal);

  let selectedCategory = 'home';
  let selectedIcon = '🏠';
  let selectedColor = '#007AFF';

  document.querySelectorAll('.cat-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.cat-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      selectedCategory = chip.getAttribute('data-cat') || 'home';
      selectedIcon = chip.getAttribute('data-icon') || '🏠';
      selectedColor = chip.getAttribute('data-color') || '#007AFF';
    });
  });

  const sliderRadius = document.getElementById('place-radius-slider');
  const labelRadius = document.getElementById('place-radius-val');
  sliderRadius?.addEventListener('input', (e) => {
    if (labelRadius) labelRadius.textContent = `${e.target.value}m`;
  });

  document.getElementById('btn-save-place')?.addEventListener('click', () => {
    const nameInput = document.getElementById('place-name-input');
    const name = nameInput?.value.trim() || 'Novo Lugar';
    const radius = parseInt(sliderRadius?.value || '250', 10);
    const map = getMapInstance();
    const center = map ? map.getCenter() : { lat: state.currentUser.lat, lng: state.currentUser.lng };

    const newPlace = addSavedPlace({
      id: `place_${Date.now()}`,
      name,
      category: selectedCategory,
      icon: selectedIcon,
      color: selectedColor,
      lat: center.lat,
      lng: center.lng,
      radius,
      address: 'Manaus, AM',
      updatedAt: Date.now(),
      createdBy: state.currentUser.id,
    });

    broadcastPlaceSaved(newPlace);
    eventBus.emit('places:changed');
    closePlaceModal();
    showToast(`Lugar "${name}" adicionado com sucesso!`, 'geofence');
  });

  // Botão + rápido da gaveta (aba Pessoas → Conectar Novo Aparelho | aba Lugares → Novo Lugar)
  document.getElementById('btn-sheet-quick-add')?.addEventListener('click', () => {
    playTactileClick();
    const tabPlaces = document.getElementById('tab-btn-places');
    const isOnPlacesTab = tabPlaces?.classList.contains('active');
    if (isOnPlacesTab) {
      openPlaceModal();
    } else {
      openConnectDeviceModal();
    }
  });

  // Share Triggers
  document.getElementById('btn-share-circle')?.addEventListener('click', openQuickShare);
  document.getElementById('btn-circle-info')?.addEventListener('click', openConnectDeviceModal);
  document.getElementById('btn-close-share-modal')?.addEventListener('click', closeConnectDeviceModal);
  document.getElementById('btn-close-quick-share')?.addEventListener('click', closeQuickShare);
  document.getElementById('btn-invite-flow')?.addEventListener('click', openConnectDeviceModal);

  document.getElementById('btn-share-whatsapp')?.addEventListener('click', () => {
    playTactileClick();
    const url =
      'https://api.whatsapp.com/send?text=' +
      encodeURIComponent(
        'Entre no círculo da nossa Família 👨‍👩‍👧‍👦 para acompanharmos localização em tempo real no mapa: ' +
          getInviteUrl()
      );
    window.open(url, '_blank');
  });

  document.getElementById('btn-share-copy-link')?.addEventListener('click', () => {
    playTactileClick();
    navigator.clipboard.writeText(getInviteUrl());
    const textEl = document.getElementById('btn-share-copy-text');
    if (textEl) textEl.textContent = '✓ Link Copiado!';
    showToast('Link de convite copiado com sucesso!', 'info');
    setTimeout(() => {
      if (textEl) textEl.textContent = 'Copiar Link de Convite';
    }, 2500);
  });

  document.getElementById('btn-share-sms')?.addEventListener('click', () => {
    playTactileClick();
    const url = 'sms:?body=' + encodeURIComponent('Entre no círculo da nossa Família 👨‍👩‍👧‍👦: ' + getInviteUrl());
    window.location.href = url;
  });

  document.getElementById('btn-quick-share-open-qr')?.addEventListener('click', () => {
    playTactileClick();
    closeQuickShare();
    openConnectDeviceModal();
  });

  // Copiar links e códigos
  document.getElementById('btn-copy-code')?.addEventListener('click', () => {
    playTactileClick();
    navigator.clipboard.writeText(state.circleId);
    showToast('Código copiado!', 'info');
  });

  document.getElementById('btn-copy-link')?.addEventListener('click', () => {
    playTactileClick();
    const linkInput = document.getElementById('share-link-input');
    if (linkInput) {
      navigator.clipboard.writeText(linkInput.value);
      showToast('Link do círculo copiado!', 'info');
    }
  });

  // Entrar em outro círculo
  document.getElementById('btn-submit-join-circle')?.addEventListener('click', () => {
    playTactileClick();
    const input = document.getElementById('input-join-circle-code');
    let raw = input ? input.value.trim() : '';
    if (!raw) {
      showToast('Digite o código ou cole o link do círculo.', 'error');
      return;
    }

    let newCode = raw;
    let urlKey = '';

    // Suporte inteligente: se o usuário colou o link completo do convite
    if (raw.includes('circle=')) {
      try {
        const parsedUrl = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
        const cParam = parsedUrl.searchParams.get('circle');
        if (cParam) newCode = cParam;
        if (parsedUrl.hash) {
          const hashParams = new URLSearchParams(parsedUrl.hash.slice(1));
          urlKey = hashParams.get('key') || '';
        }
      } catch (e) {
        const match = raw.match(/[?&]circle=([^&#\s]+)/);
        if (match) newCode = decodeURIComponent(match[1]);
      }
    } else if (!newCode.startsWith('gp_sec_') && !newCode.startsWith('FAMILIA-') && newCode.length <= 6) {
      // Compatibilidade legada com códigos curtos manuais
      newCode = `FAMILIA-${newCode.toUpperCase()}`;
    }

    state.circleId = newCode;
    localStorage.setItem('geopulse_circle_id', newCode);
    if (urlKey) {
      localStorage.setItem('geopulse_e2e_key', urlKey);
    }

    // Limpa membros do círculo anterior para não misturar dados
    state.members.clear();
    localStorage.removeItem('geopulse_members_data');
    try {
      sessionStorage.setItem('geopulse_is_new_join', 'true');
    } catch (e) {}

    showToast('Conectando ao círculo...', 'info');
    closeConnectDeviceModal();

    const hashPart = urlKey ? `#key=${encodeURIComponent(urlKey)}` : (window.location.hash || '');
    setTimeout(() => {
      window.location.href = `/?circle=${encodeURIComponent(newCode)}&join=1${hashPart}`;
    }, 400);
  });

  // PWA Install Triggers
  document.getElementById('btn-open-install-guide')?.addEventListener('click', () => openInstallPWAModal(false));
  document.getElementById('btn-close-install-modal')?.addEventListener('click', closeInstallPWAModal);
  document.getElementById('btn-continue-in-browser')?.addEventListener('click', closeInstallPWAModal);
  document.getElementById('btn-trigger-pwa-install')?.addEventListener('click', triggerPWAInstall);

  // Notifications Modal Triggers
  document.getElementById('btn-open-notifications-modal')?.addEventListener('click', openNotificationsModal);
  document.getElementById('btn-close-notifications-modal')?.addEventListener('click', closeNotificationsModal);

  document.getElementById('btn-request-notification-perm')?.addEventListener('click', async () => {
    playTactileClick();
    try {
      const res = await requestPushPermission();
      showToast(res.permission === 'granted' ? 'Notificações autorizadas!' : 'Permissão negada.', 'info');
      updateNotificationUI();
    } catch (e) {
      showToast('Erro: ' + e.message, 'error');
    }
  });

  document.getElementById('btn-test-notification-now')?.addEventListener('click', async () => {
    playTactileClick();
    try {
      await triggerTestPushNotification({ delaySeconds: 0 });
      showToast('Notificação enviada!', 'info');
      updateNotificationUI();
    } catch (e) {
      showToast('Erro: ' + e.message, 'error');
    }
  });

  let delayTimer = null;
  document.getElementById('btn-test-notification-delay')?.addEventListener('click', async () => {
    playTactileClick();
    if (delayTimer) return;
    try {
      showToast('Agendado em 5s! Bloqueie a tela do celular agora!', 'info');
      await triggerTestPushNotification({ delaySeconds: 5 });
      let sec = 5;
      const lbl = document.getElementById('btn-delay-text');
      if (lbl) lbl.textContent = `Disparando em ${sec}s...`;
      delayTimer = setInterval(() => {
        sec--;
        if (sec > 0) {
          if (lbl) lbl.textContent = `Disparando em ${sec}s...`;
        } else {
          clearInterval(delayTimer);
          delayTimer = null;
          if (lbl) lbl.textContent = 'Testar em 5s (Bloqueie a Tela)';
        }
      }, 1000);
    } catch (e) {
      showToast('Erro: ' + e.message, 'error');
    }
  });

  // Toggle e cópia da subscrição técnica Push
  document.getElementById('btn-toggle-raw-sub')?.addEventListener('click', () => {
    playTactileClick();
    const container = document.getElementById('raw-sub-container');
    const btn = document.getElementById('btn-toggle-raw-sub');
    if (container) {
      const isHidden = container.style.display === 'none';
      container.style.display = isHidden ? 'block' : 'none';
      if (btn) btn.textContent = isHidden ? 'Ocultar JSON Técnico' : 'Ver JSON Técnico';
    }
  });

  document.getElementById('btn-copy-subscription')?.addEventListener('click', () => {
    playTactileClick();
    const codeEl = document.getElementById('sub-json-code');
    if (codeEl?.textContent) {
      navigator.clipboard.writeText(codeEl.textContent);
      showToast('Objeto JSON copiado!', 'info');
    }
  });

  // Tocar som modal
  document.getElementById('btn-stop-incoming-ring')?.addEventListener('click', () => {
    playTactileClick();
    stopFindMyChime();
    const modal = document.getElementById('modal-incoming-ring');
    if (modal) modal.style.display = 'none';
  });

  // SOS Confirm Modal
  const modalSosConfirm = document.getElementById('modal-sos-confirm');
  document.getElementById('btn-sos')?.addEventListener('click', () => {
    playTactileClick();
    if (state.currentUser.sos) {
      eventBus.emit('sos:toggle');
    } else if (modalSosConfirm) {
      modalSosConfirm.style.display = 'flex';
    }
  });

  document.getElementById('btn-confirm-sos')?.addEventListener('click', () => {
    playTactileClick();
    if (modalSosConfirm) modalSosConfirm.style.display = 'none';
    eventBus.emit('sos:toggle');
  });

  document.getElementById('btn-cancel-sos')?.addEventListener('click', () => {
    playTactileClick();
    if (modalSosConfirm) modalSosConfirm.style.display = 'none';
  });

  document.getElementById('btn-close-sos-confirm')?.addEventListener('click', () => {
    playTactileClick();
    if (modalSosConfirm) modalSosConfirm.style.display = 'none';
  });

  document.getElementById('btn-dismiss-sos')?.addEventListener('click', (e) => {
    e.stopPropagation();
    eventBus.emit('sos:dismiss');
  });

  // EventBus listeners
  eventBus.on('toast:show', ({ message, type }) => showToast(message, type));
  eventBus.on('modal:open-share', openConnectDeviceModal);
  eventBus.on('modal:open-profile', openProfileModal);

  // Fecha modais ao tocar no backdrop fora do cartão
  const backdropClosers = [
    { id: 'modal-profile', close: closeProfileModal },
    { id: 'modal-traccar', close: closeTraccarModal },
    { id: 'modal-place', close: closePlaceModal },
    { id: 'modal-share', close: closeConnectDeviceModal },
    { id: 'modal-quick-share', close: closeQuickShare },
    { id: 'modal-notifications', close: closeNotificationsModal },
    { id: 'modal-install-pwa', close: closeInstallPWAModal },
    { id: 'modal-sos-confirm', close: () => {
      const m = document.getElementById('modal-sos-confirm');
      if (m) m.style.display = 'none';
    }},
    { id: 'modal-onboarding', close: () => {
      const m = document.getElementById('modal-onboarding');
      if (m) m.style.display = 'none';
    }},
  ];

  backdropClosers.forEach(({ id, close }) => {
    const el = document.getElementById(id);
    el?.addEventListener('click', (e) => {
      if (e.target === el) {
        close();
      }
    });
  });
}
