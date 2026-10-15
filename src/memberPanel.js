// GeoPulse - Painel de Membros, Lugares Salvos e Ficha de Detalhes (Apple Sheet)
import { state, removeMember, removeSavedPlace, saveMembersToStorage, broadcastRingLocal } from './sync.js';
import { calculateDistance, formatDistance } from './geo.js';
import { playTactileClick, playRadarPing, playGeofenceAlert } from './audio.js';
import { broadcastRingDevice, broadcastMemberDeleted, broadcastPlaceDeleted } from './realtime.js';
import { notifyGeofenceEvent } from './notifications.js';
import { eventBus } from './eventBus.js';
import { drawRouteToMember, getMapInstance } from './mapRenderer.js';

// Monitoramento ativo de saída de área (Avisar ao Sair)
export const memberLeaveAlerts = new Map();
try {
  const savedAlerts = localStorage.getItem('geopulse_leave_alerts');
  if (savedAlerts) {
    const list = JSON.parse(savedAlerts);
    if (Array.isArray(list)) {
      list.forEach((item) => memberLeaveAlerts.set(item.memberId, item));
    }
  }
} catch (e) {}

export function saveLeaveAlertsToStorage() {
  try {
    const list = Array.from(memberLeaveAlerts.values());
    localStorage.setItem('geopulse_leave_alerts', JSON.stringify(list));
  } catch (e) {}
}

/**
 * Renderiza a lista de cartões de membros na gaveta
 */
export function renderMembersList() {
  const container = document.getElementById('members-list');
  if (!container) return;

  const countBadge = document.getElementById('header-member-count');
  const tabBadge = document.getElementById('tab-badge-people');
  const totalCount = 1 + state.members.size;

  if (countBadge) countBadge.textContent = totalCount;
  if (tabBadge) tabBadge.textContent = totalCount;

  const allMembers = [state.currentUser, ...Array.from(state.members.values())];

  const membersCardsHtml = allMembers
    .map((member) => {
      const isMe = member.isMe;
      const avatarText = member.avatar || member.name.slice(0, 2).toUpperCase();
      const color = member.color || (isMe ? '#007AFF' : '#EC4899');
      const photo = member.photo || '';
      const avatarStyle = photo
        ? `background-image: url('${photo}'); background-color: ${color};`
        : `background-color: ${color};`;

      const dist = isMe
        ? ''
        : formatDistance(
            calculateDistance(
              state.currentUser.lat,
              state.currentUser.lng,
              member.lat,
              member.lng
            )
          );

      const elapsedMs = Date.now() - (member.updatedAt || 0);
      const isOnline = isMe || (member.isOnline !== false && elapsedMs < 1000 * 60 * 5);
      const dotClass = isOnline ? 'online' : 'offline';
      const displayName = isMe ? `${member.name} (Você)` : member.name;
      const relationText = isMe
        ? member.role === 'Administrador'
          ? 'Organizador do Círculo'
          : 'Seu Aparelho'
        : member.relation || 'Membro do Círculo';

      let activityText = member.activity || relationText;
      if (isMe) {
        activityText = member.activity || relationText;
      } else if (!isOnline) {
        const mins = Math.floor(elapsedMs / (1000 * 60));
        if (mins < 1) activityText = 'Offline · Desconectado';
        else if (mins < 60) activityText = `Offline · Visto há ${mins}m`;
        else {
          const hours = Math.floor(mins / 60);
          activityText = `Offline · Visto há ${hours}h`;
        }
      }

      return `
        <div class="member-card ${state.selectedMemberId === member.id ? 'active-selected' : ''}" data-id="${member.id}">
          <div class="card-avatar-wrapper">
            <div class="card-avatar" style="${avatarStyle}">
              ${photo ? '' : avatarText}
            </div>
            <span class="card-avatar-dot ${dotClass}" title="${isOnline ? 'Online' : 'Offline'}"></span>
          </div>
          <div class="card-info">
            <div class="card-name-row">
              <strong class="card-name">${displayName}</strong>
              ${dist ? `<span class="card-distance">${dist}</span>` : ''}
            </div>
            <div class="card-activity-row">
              <span class="card-activity">${activityText}</span>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  const emptyCardHtml =
    state.members.size === 0
      ? `
    <div class="empty-members-card" id="card-empty-invite" title="Conectar outro celular">
      <div class="empty-members-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </div>
      <div class="empty-members-text">
        <strong>Conectar Novo Aparelho</strong>
        <span>Toque para gerar o QR Code e conectar o celular da família em tempo real.</span>
      </div>
    </div>
  `
      : '';

  container.innerHTML = membersCardsHtml + emptyCardHtml;

  document.getElementById('card-empty-invite')?.addEventListener('click', () => {
    playTactileClick();
    eventBus.emit('modal:open-share');
  });

  container.querySelectorAll('.member-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      if (id === state.currentUser.id) {
        eventBus.emit('modal:open-profile');
        return;
      }
      const member = state.members.get(id);
      if (member) {
        if (member.isMe || member.id === state.currentUser.id) {
          eventBus.emit('modal:open-profile');
          return;
        }
        openMemberDetailSheet(member);
      }
    });
  });
}

/**
 * Renderiza a lista de lugares salvos na gaveta
 */
export function renderPlacesList() {
  const container = document.getElementById('places-list');
  if (!container) return;

  const tabBadge = document.getElementById('tab-badge-places');
  if (tabBadge) tabBadge.textContent = state.geofences.length;

  if (state.geofences.length === 0) {
    container.innerHTML = `
      <div class="empty-places-state">
        <div class="empty-icon">📍</div>
        <strong>Nenhum lugar cadastrado</strong>
        <span>Toque em "+ Adicionar Novo Lugar" abaixo para salvar sua casa, trabalho ou locais da família.</span>
      </div>
    `;
    return;
  }

  const allMembers = [state.currentUser, ...Array.from(state.members.values())];

  container.innerHTML = state.geofences
    .map((place) => {
      const peopleInside = allMembers.filter((m) => {
        return calculateDistance(place.lat, place.lng, m.lat, m.lng) <= place.radius;
      });

      const presenceText =
        peopleInside.length > 0
          ? `${peopleInside.length} presente(s): ${peopleInside.map((p) => (p.isMe ? 'Você' : p.name.split(' ')[0])).join(', ')}`
          : 'Ninguém neste local agora';

      return `
        <div class="place-card" data-id="${place.id}">
          <div class="place-icon-box" style="border-color:${place.color};">
            ${place.icon || '📍'}
          </div>
          <div class="place-info">
            <strong class="place-name">${place.name}</strong>
            <span class="place-presence">${presenceText}</span>
          </div>
          <button class="btn-delete-place-card" data-id="${place.id}" title="Excluir este lugar">
            🗑️
          </button>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.place-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      const place = state.geofences.find((p) => p.id === id);
      const map = getMapInstance();
      if (place && map) {
        map.flyTo([place.lat, place.lng], 16, { duration: 0.8 });
      }
    });
  });

  container.querySelectorAll('.btn-delete-place-card').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const place = state.geofences.find((p) => p.id === id);
      const placeName = place ? place.name : 'Lugar';
      if (confirm(`Deseja realmente excluir o lugar "${placeName}"?`)) {
        removeSavedPlace(id);
        broadcastPlaceDeleted(id);
        eventBus.emit('places:changed');
        eventBus.emit('toast:show', { message: `Lugar "${placeName}" excluído.`, type: 'info' });
      }
    });
  });
}

/**
 * Abre a ficha de detalhes completa do membro
 */
export function openMemberDetailSheet(member) {
  if (!member) return;

  // Se for o próprio usuário, abre o modal de edição de perfil
  if (member.isMe || member.id === state.currentUser.id) {
    closeMemberDetailSheet();
    eventBus.emit('modal:open-profile');
    return;
  }

  playTactileClick();
  state.selectedMemberId = member.id;

  const sheet = document.getElementById('member-detail-sheet');
  const avatarEl = document.getElementById('detail-avatar');
  const nameEl = document.getElementById('detail-name');
  const relationEl = document.getElementById('detail-relation');
  const activityText = document.getElementById('detail-activity-text');
  const addressEl = document.getElementById('detail-address');
  const speedEl = document.getElementById('detail-speed');
  const distanceEl = document.getElementById('detail-distance');
  const updatedEl = document.getElementById('detail-updated');

  if (avatarEl) {
    if (member.photo) {
      avatarEl.style.backgroundImage = `url('${member.photo}')`;
      avatarEl.textContent = '';
    } else {
      avatarEl.style.backgroundImage = '';
      avatarEl.textContent = member.avatar || member.name.slice(0, 2).toUpperCase();
    }
    avatarEl.style.backgroundColor = member.color || '#007AFF';
  }

  if (nameEl) nameEl.textContent = member.name;
  if (relationEl) relationEl.textContent = member.relation || 'Família 👨‍👩‍👧‍👦';
  if (activityText) activityText.textContent = member.activity || '📍 Parado';
  if (addressEl) addressEl.textContent = member.address || 'Localização em tempo real';
  if (speedEl) speedEl.textContent = `${member.speed || 0} km/h`;

  const distMeters = calculateDistance(state.currentUser.lat, state.currentUser.lng, member.lat, member.lng);
  if (distanceEl) distanceEl.textContent = formatDistance(distMeters);

  if (updatedEl) {
    const diffMs = Date.now() - (member.updatedAt || 0);
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) {
      updatedEl.textContent = 'Agora';
    } else if (diffMins < 60) {
      updatedEl.textContent = `${diffMins} min atrás`;
    } else {
      const diffHours = Math.floor(diffMins / 60);
      updatedEl.textContent = `${diffHours}h atrás`;
    }
  }

  // Configura botão de Traçar Rota
  const btnRoute = document.getElementById('btn-action-route');
  if (btnRoute) {
    btnRoute.onclick = () => {
      playTactileClick();
      drawRouteToMember(member);
      closeMemberDetailSheet();
    };
  }

  // Configura botão de Tocar Som (Find My Ring)
  const btnPing = document.getElementById('btn-action-ping');
  if (btnPing) {
    btnPing.onclick = () => {
      playRadarPing();
      broadcastRingDevice(member.id);
      broadcastRingLocal(member.id, state.currentUser.name);
      eventBus.emit('toast:show', {
        message: `🔊 Enviando sinal sonoro para ${member.name}...`,
        type: 'info',
      });
    };
  }

  // Configura botão de Aviso ao Sair
  const btnNotify = document.getElementById('btn-action-notify');
  if (btnNotify) {
    const isWatching = memberLeaveAlerts.has(member.id);
    if (isWatching) {
      btnNotify.classList.add('active');
      btnNotify.querySelector('span').textContent = '✓ Avisando ao Sair';
    } else {
      btnNotify.classList.remove('active');
      btnNotify.querySelector('span').textContent = 'Avisar ao Sair';
    }

    btnNotify.onclick = () => {
      playTactileClick();
      if (memberLeaveAlerts.has(member.id)) {
        memberLeaveAlerts.delete(member.id);
        saveLeaveAlertsToStorage();
        btnNotify.classList.remove('active');
        btnNotify.querySelector('span').textContent = 'Avisar ao Sair';
        eventBus.emit('toast:show', {
          message: `Aviso de saída desativado para ${member.name}.`,
          type: 'info',
        });
      } else {
        const place = state.geofences.find((g) => calculateDistance(g.lat, g.lng, member.lat, member.lng) <= g.radius);
        const placeName = place ? place.name : member.address || 'local atual';
        const radius = place ? place.radius : 200;

        memberLeaveAlerts.set(member.id, {
          memberId: member.id,
          memberName: member.name,
          originLat: member.lat,
          originLng: member.lng,
          radius,
          placeName,
        });
        saveLeaveAlertsToStorage();

        btnNotify.classList.add('active');
        btnNotify.querySelector('span').textContent = '✓ Avisando ao Sair';
        eventBus.emit('toast:show', {
          message: `✓ Alerta ativado! Você será avisado quando ${member.name} sair de ${placeName}.`,
          type: 'geofence',
        });

        if ('Notification' in window && Notification.permission === 'default') {
          Notification.requestPermission();
        }
      }
    };
  }

  // Câmera com Realidade Aumentada (AR Precision Finding)
  const btnAR = document.getElementById('btn-action-ar');
  if (btnAR) {
    btnAR.onclick = () => {
      playTactileClick();
      closeMemberDetailSheet();
      eventBus.emit('member:ar-finder', member);
    };
  }

  // Chat Privado E2E
  const btnChat = document.getElementById('btn-action-chat');
  if (btnChat) {
    btnChat.onclick = () => {
      playTactileClick();
      closeMemberDetailSheet();
      eventBus.emit('member:chat', member);
    };
  }

  // Google Maps Externo
  const btnExt = document.getElementById('btn-action-external-maps');
  if (btnExt) {
    btnExt.onclick = () => {
      const url = `https://www.google.com/maps/dir/?api=1&origin=${state.currentUser.lat},${state.currentUser.lng}&destination=${member.lat},${member.lng}`;
      window.open(url, '_blank');
    };
  }

  // Remover Membro do Círculo
  const wrapRemove = document.getElementById('wrap-remove-member');
  const btnRemove = document.getElementById('btn-action-remove-member');
  if (wrapRemove) {
    wrapRemove.style.display = 'flex';
  }
  if (btnRemove) {
    btnRemove.onclick = () => {
      playTactileClick();
      const memberName = member.name || 'este membro';
      if (confirm(`Deseja remover "${memberName}" do círculo familiar?`)) {
        const targetId = member.id;
        state.members.delete(targetId);
        saveMembersToStorage();

        if (memberLeaveAlerts.has(targetId)) {
          memberLeaveAlerts.delete(targetId);
          saveLeaveAlertsToStorage();
        }

        broadcastMemberDeleted(targetId);
        removeMember(targetId);
        closeMemberDetailSheet();
        eventBus.emit('member:deleted', targetId);
        eventBus.emit('toast:show', { message: `"${memberName}" foi removido do círculo.`, type: 'info' });
      }
    };
  }

  // Garante que o botão de fechar (✕) funcione tanto em click quanto em toque
  const btnCloseDetail = document.getElementById('btn-close-member-detail');
  if (btnCloseDetail) {
    const handleClose = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      closeMemberDetailSheet();
    };
    btnCloseDetail.onclick = handleClose;
    btnCloseDetail.ontouchend = handleClose;
  }

  const map = getMapInstance();
  if (map) {
    map.flyTo([member.lat, member.lng], 16, { duration: 0.8 });
  }

  if (sheet) sheet.style.display = 'flex';
}

export function closeMemberDetailSheet() {
  playTactileClick();
  const sheet = document.getElementById('member-detail-sheet');
  if (sheet) sheet.style.display = 'none';
  state.selectedMemberId = null;
}

/**
 * Checa se algum membro monitorado saiu do raio de alerta
 */
export function checkMemberLeaveAlerts(member) {
  if (!member || !memberLeaveAlerts.has(member.id)) return;
  const alertData = memberLeaveAlerts.get(member.id);
  const dist = calculateDistance(alertData.originLat, alertData.originLng, member.lat, member.lng);

  if (dist > alertData.radius) {
    playGeofenceAlert(false);
    if ('vibrate' in navigator) navigator.vibrate([300, 150, 300]);
    notifyGeofenceEvent(member.name, 'saiu de', alertData.placeName);
    eventBus.emit('toast:show', {
      message: `🚶 Atenção: ${member.name} acabou de sair de ${alertData.placeName}!`,
      type: 'geofence',
    });

    memberLeaveAlerts.delete(member.id);
    saveLeaveAlertsToStorage();

    if (state.selectedMemberId === member.id) {
      const btnNotify = document.getElementById('btn-action-notify');
      if (btnNotify) {
        btnNotify.classList.remove('active');
        btnNotify.querySelector('span').textContent = 'Avisar ao Sair';
      }
    }
  }
}

/**
 * Configura o controle do Bottom Sheet estilo Apple Maps
 */
export function setupBottomSheet() {
  const mainContainer = document.querySelector('.main-container');
  const sidebar = document.getElementById('sidebar');
  const sheetHandle = document.getElementById('sheet-handle');
  const sheetTabsRow = document.querySelector('.sheet-tabs-row');

  const setSheetCollapsed = (collapsed) => {
    if (collapsed) {
      mainContainer?.classList.add('sheet-collapsed');
      sidebar?.classList.add('collapsed');
    } else {
      mainContainer?.classList.remove('sheet-collapsed');
      sidebar?.classList.remove('collapsed');
    }
    setTimeout(() => {
      const map = getMapInstance();
      if (map) map.invalidateSize();
    }, 320);
  };

  const toggleSheet = () => {
    playTactileClick();
    const isCollapsed =
      mainContainer?.classList.contains('sheet-collapsed') || sidebar?.classList.contains('collapsed');
    setSheetCollapsed(!isCollapsed);
  };

  sheetHandle?.addEventListener('click', toggleSheet);

  let sheetTouchStartY = 0;
  const sheetTouchArea = sheetHandle || sheetTabsRow;
  sheetTouchArea?.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches && e.touches.length > 0) {
        sheetTouchStartY = e.touches[0].clientY;
      }
    },
    { passive: true }
  );

  sheetTouchArea?.addEventListener(
    'touchend',
    (e) => {
      if (e.changedTouches && e.changedTouches.length > 0) {
        const diff = e.changedTouches[0].clientY - sheetTouchStartY;
        if (diff > 35) {
          setSheetCollapsed(true);
          playTactileClick();
        } else if (diff < -35) {
          setSheetCollapsed(false);
          playTactileClick();
        }
      }
    },
    { passive: true }
  );

  // Alternador de Abas (Pessoas vs Lugares)
  const tabPeople = document.getElementById('tab-btn-people');
  const tabPlaces = document.getElementById('tab-btn-places');
  const panelPeople = document.getElementById('panel-people');
  const panelPlaces = document.getElementById('panel-places');

  tabPeople?.addEventListener('click', () => {
    playTactileClick();
    tabPeople.classList.add('active');
    tabPlaces?.classList.remove('active');
    if (panelPeople) panelPeople.style.display = 'flex';
    if (panelPlaces) panelPlaces.style.display = 'none';
    setSheetCollapsed(false);
  });

  tabPlaces?.addEventListener('click', () => {
    playTactileClick();
    tabPlaces.classList.add('active');
    tabPeople?.classList.remove('active');
    if (panelPlaces) panelPlaces.style.display = 'flex';
    if (panelPeople) panelPeople.style.display = 'none';
    setSheetCollapsed(false);
  });

  // Configuração global de fechamento da Ficha de Detalhes do Membro (X, Backdrop, Swipe down, ESC)
  const detailSheet = document.getElementById('member-detail-sheet');
  const btnCloseMemberDetail = document.getElementById('btn-close-member-detail');
  const detailCard = document.querySelector('.member-detail-card');

  const handleGlobalCloseDetail = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    closeMemberDetailSheet();
  };

  btnCloseMemberDetail?.addEventListener('click', handleGlobalCloseDetail);
  btnCloseMemberDetail?.addEventListener('touchend', handleGlobalCloseDetail);

  detailSheet?.addEventListener('click', (e) => {
    if (e.target === detailSheet) {
      closeMemberDetailSheet();
    }
  });

  let detailTouchStartY = 0;
  detailCard?.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches && e.touches.length > 0) {
        detailTouchStartY = e.touches[0].clientY;
      }
    },
    { passive: true }
  );

  detailCard?.addEventListener(
    'touchend',
    (e) => {
      if (e.changedTouches && e.changedTouches.length > 0) {
        const diffY = e.changedTouches[0].clientY - detailTouchStartY;
        if (diffY > 40) {
          closeMemberDetailSheet();
        }
      }
    },
    { passive: true }
  );

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const sheet = document.getElementById('member-detail-sheet');
      if (sheet && sheet.style.display !== 'none') {
        closeMemberDetailSheet();
      }
    }
  });
}
