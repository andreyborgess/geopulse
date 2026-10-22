// Sincronização em Tempo Real (Cross-Tab via BroadcastChannel + Gerenciamento de Membros com LWW)
import { calculateBearing } from './geo.js';
import { generateSecureCircleId } from './crypto.js';

const CHANNEL_NAME = 'geopulse_live_channel';
let channel = null;

try {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
  }
} catch (e) {
  console.warn('BroadcastChannel not available', e);
}

// Limpa qualquer dado salvo antigo de simulação no localStorage
try {
  localStorage.removeItem('geopulse_last_broadcast');
} catch (e) {
  // ignore
}

// Estado inicial de Lugares Salvos (Sem lugares fictícios - apenas criados pelo usuário)
export const DEFAULT_SAVED_PLACES = [];

// Estado inicial de Membros de Demonstração (apenas caso reset manual seja solicitado)
export const DEFAULT_DEMO_MEMBERS = [
  {
    id: 'member_mariana',
    name: 'Mariana',
    relation: 'Esposa',
    lat: -3.1025,
    lng: -60.0142,
    accuracy: 12,
    speed: 0,
    heading: 0,
    battery: 88,
    charging: false,
    color: '#EC4899',
    avatar: 'M',
    photo: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80',
    activity: '🏠 Em Casa',
    address: 'Adrianópolis, Manaus',
    updatedAt: Date.now() - 1000 * 60 * 4,
    version: 1,
    history: [
      { lat: -3.1030, lng: -60.0145, time: Date.now() - 1000 * 60 * 30 },
      { lat: -3.1025, lng: -60.0142, time: Date.now() - 1000 * 60 * 4 },
    ],
    isMe: false,
    isDemo: true,
  },
  {
    id: 'member_lucas',
    name: 'Lucas',
    relation: 'Filho',
    lat: -3.0950,
    lng: -60.0280,
    accuracy: 18,
    speed: 44,
    heading: 185,
    battery: 62,
    charging: false,
    color: '#007AFF',
    avatar: 'L',
    photo: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&auto=format&fit=crop&q=80',
    activity: '🚗 Dirigindo · 44 km/h',
    address: 'Av. Djalma Batista, Manaus',
    updatedAt: Date.now() - 1000 * 35,
    version: 1,
    history: [
      { lat: -3.0880, lng: -60.0270, time: Date.now() - 1000 * 60 * 10 },
      { lat: -3.0920, lng: -60.0275, time: Date.now() - 1000 * 60 * 4 },
      { lat: -3.0950, lng: -60.0280, time: Date.now() - 1000 * 35 },
    ],
    isMe: false,
    isDemo: true,
  },
];

// Gera circle ID aleatório seguro e criptográfico
export function generateCircleId() {
  return generateSecureCircleId();
}

// Resolve o circleId correto considerando URL de convite (prioridade máxima)
function resolveCircleId() {
  // 1. Prioridade: parâmetro ?circle= da URL (link de convite / QR Code)
  if (typeof window !== 'undefined' && window.location.search) {
    const urlParams = new URLSearchParams(window.location.search);
    const circleParam = urlParams.get('circle');
    if (circleParam) {
      localStorage.setItem('geopulse_circle_id', circleParam);
      return circleParam;
    }
  }
  // 2. Fallback: valor salvo no localStorage (se não for antigo legado isolado)
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('geopulse_circle_id') : null;
  if (saved && saved !== 'FAMILIA-01' && !saved.startsWith('gp_sec_')) return saved;
  // 3. Padrão Familiar Unificado (compatível direto com Traccar Client & Webhook)
  const defaultCircle = 'FAMILIA-1';
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('geopulse_circle_id', defaultCircle);
  }
  return defaultCircle;
}

const safeStorage = {
  getItem: (k) => (typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null),
  setItem: (k, v) => { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); },
};

let initialCircleName = safeStorage.getItem('geopulse_circle_name');
if (!initialCircleName || initialCircleName === 'Família Silva' || initialCircleName === 'Família') {
  initialCircleName = 'Família 👨‍👩‍👧‍👦';
  safeStorage.setItem('geopulse_circle_name', initialCircleName);
}

// Estado dos membros do círculo — circleId resolvido uma única vez, com prioridade para URL de convite
export const state = {
  circleId: resolveCircleId(),
  circleName: initialCircleName,
  currentUser: {
    id: safeStorage.getItem('geopulse_user_id') || `user_${Math.random().toString(36).slice(2, 8)}`,
    name: safeStorage.getItem('geopulse_user_name') || 'Você',
    relation: 'Organizador',
    role: 'Administrador',
    lat: -3.1303, // Manaus, Amazonas (Teatro Amazonas / Centro)
    lng: -60.0234,
    accuracy: 10,
    speed: 0,
    heading: 0,
    battery: parseInt(safeStorage.getItem('geopulse_user_battery') || '85', 10),
    charging: false,
    updatedAt: Date.now(),
    version: 1,
    history: [],
    color: safeStorage.getItem('geopulse_user_color') || '#007AFF', // Azul Real Apple
    avatar: safeStorage.getItem('geopulse_user_avatar') || 'VC',
    photo: safeStorage.getItem('geopulse_user_photo') || '',
    activity: '📍 Parado',
    address: 'Centro, Manaus',
    isMe: true,
    sos: false,
  },
  members: new Map(),
  geofences: [],
  selectedMemberId: null,
  activeRoute: null,
};

// Verifica se o usuário já completou o onboarding/identificação neste aparelho
export function isOnboarded() {
  return localStorage.getItem('geopulse_onboarded') === 'true';
}

// Salva e persiste os dados do perfil do usuário
export function saveUserProfile({ name, relation, color, photo, avatar }) {
  state.currentUser.version = (state.currentUser.version || 1) + 1;
  state.currentUser.updatedAt = Date.now();

  if (name) {
    state.currentUser.name = name;
    localStorage.setItem('geopulse_user_name', name);
  }
  if (relation) {
    state.currentUser.relation = relation;
    localStorage.setItem('geopulse_user_relation', relation);
  }
  if (color) {
    state.currentUser.color = color;
    localStorage.setItem('geopulse_user_color', color);
  }
  if (photo !== undefined) {
    state.currentUser.photo = photo;
    localStorage.setItem('geopulse_user_photo', photo);
  }
  if (avatar) {
    state.currentUser.avatar = avatar;
    localStorage.setItem('geopulse_user_avatar', avatar);
  } else if (name) {
    const initials = name.trim().split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase() || 'VC';
    state.currentUser.avatar = initials;
    localStorage.setItem('geopulse_user_avatar', initials);
  }
  localStorage.setItem('geopulse_onboarded', 'true');
}

/**
 * Retorna a URL base do backend (em Capacitor nativo usa Vercel; no browser usa relativo)
 */
export function getApiBaseUrl() {
  if (typeof window === 'undefined') return 'https://loc-sigma-mauve.vercel.app';
  const isCapacitor =
    window.location.protocol === 'capacitor:' ||
    (window.location.hostname === 'localhost' && !window.location.port);
  return isCapacitor ? 'https://loc-sigma-mauve.vercel.app' : '';
}

/**
 * Merge com algoritmo Last-Write-Wins (LWW) para Membros
 * Retorna true se houver alteração
 */
export function mergeRemoteMember(remoteUser) {
  if (!remoteUser || !remoteUser.id) {
    return false;
  }

  // Se for uma mensagem ecoada do próprio ID de sessão web ou fantasma não-identificado "Você"
  if (remoteUser.id === state.currentUser.id || (remoteUser.name === 'Você' && remoteUser.id.startsWith('user_'))) {
    return false;
  }

  const myTraccarId = (typeof localStorage !== 'undefined' && localStorage.getItem('geopulse_traccar_id')) || '93831419';
  const isTraccarPayload = remoteUser.source === 'traccar_background' || remoteUser.id === myTraccarId || remoteUser.id === '93831419';
  const isThisDeviceTheTraccarDevice = (typeof localStorage !== 'undefined' && localStorage.getItem('geopulse_is_traccar_device') === 'true') || state.currentUser.id === myTraccarId;

  // Se este aparelho for explicitamente configurado como o iPhone rastreado, sincroniza a posição do usuário atual
  if (isTraccarPayload && isThisDeviceTheTraccarDevice) {
    state.currentUser.lat = remoteUser.lat;
    state.currentUser.lng = remoteUser.lng;
    if (remoteUser.accuracy) state.currentUser.accuracy = remoteUser.accuracy;
    if (remoteUser.speed !== undefined) state.currentUser.speed = remoteUser.speed;
    if (remoteUser.heading !== undefined) state.currentUser.heading = remoteUser.heading;
    if (remoteUser.battery !== undefined) state.currentUser.battery = remoteUser.battery;
    if (remoteUser.activity) state.currentUser.activity = remoteUser.activity;
    state.currentUser.updatedAt = remoteUser.updatedAt || Date.now();
  }

  const existing = state.members.get(remoteUser.id);
  const remoteTime = remoteUser.updatedAt || 0;
  const existingTime = existing?.updatedAt || 0;

  // LWW: Atualiza se for novo ou se o timestamp remoto for mais recente ou igual
  if (!existing || remoteTime >= existingTime) {
    state.members.set(remoteUser.id, {
      ...existing,
      ...remoteUser,
      isMe: false,
      isOnline: remoteUser.isOnline !== false,
      lastSeen: Date.now(),
    });
    saveMembersToStorage();
    return true;
  } else if (existing) {
    // Mesmo com leve desvio de relógio entre aparelhos, atualiza batimento online e lastSeen
    let updated = false;
    if (remoteUser.isOnline !== undefined && existing.isOnline !== (remoteUser.isOnline !== false)) {
      existing.isOnline = remoteUser.isOnline !== false;
      updated = true;
    }
    existing.lastSeen = Date.now();
    if (updated) {
      saveMembersToStorage();
      return true;
    }
  }
  return false;
}

/**
 * Sincroniza ativamente via HTTP com o endpoint /api/location do Vercel
 * Garante que a última posição enviada pelo Traccar seja obtida instantaneamente,
 * mesmo se o MQTT estiver conectando ou em reconexão.
 */
export async function syncTraccarLocation() {
  const circleId = state.circleId || 'FAMILIA-1';
  const traccarId = (typeof localStorage !== 'undefined' && localStorage.getItem('geopulse_traccar_id')) || '93831419';
  const baseUrl = getApiBaseUrl();

  try {
    const res = await fetch(`${baseUrl}/api/location?circle=${encodeURIComponent(circleId)}&user=${encodeURIComponent(traccarId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    let updatedAny = false;
    let mainRemoteUser = null;

    if (data && Array.isArray(data.allPings) && data.allPings.length > 0) {
      data.allPings.forEach((p) => {
        if (!p || !p.lat || !p.lng) return;
        const sKmH = p.speed || 0;
        const act = sKmH > 22 ? '🚗 Em trânsito' : (sKmH > 3 ? '🚶 Caminhando' : '📍 Parado');
        const pId = p.userId || traccarId;
        const pUser = {
          id: pId,
          name: p.userName || (pId === traccarId ? 'Andrey (iPhone)' : `iPhone Família (${pId.slice(-4)})`),
          relation: 'Família 👨‍👩‍👧‍👦',
          role: 'iPhone 24h GPS',
          lat: p.lat,
          lng: p.lng,
          accuracy: p.accuracy || 10,
          speed: sKmH,
          heading: p.heading || 0,
          battery: p.battery !== undefined ? p.battery : 85,
          charging: !!p.charging,
          activity: act,
          color: pId === traccarId ? '#007AFF' : '#34C759',
          avatar: '📱',
          updatedAt: p.updatedAt || Date.now(),
          isOnline: (Date.now() - (p.updatedAt || 0)) < 1000 * 60 * 30,
          source: 'traccar_background',
        };
        const c = mergeRemoteMember(pUser);
        if (c) updatedAny = true;
        if (pId === traccarId) mainRemoteUser = pUser;
      });
    }

    if (data && data.lastPing && data.lastPing.lat && data.lastPing.lng) {
      const ping = data.lastPing;
      const speedKmH = ping.speed || 0;
      const activity = speedKmH > 22 ? '🚗 Em trânsito' : (speedKmH > 3 ? '🚶 Caminhando' : '📍 Parado');

      const remoteUser = {
        id: ping.userId || traccarId,
        name: ping.userName || 'Andrey (iPhone)',
        relation: 'Família 👨‍👩‍👧‍👦',
        role: 'iPhone 24h GPS',
        lat: ping.lat,
        lng: ping.lng,
        accuracy: ping.accuracy || 10,
        speed: speedKmH,
        heading: ping.heading || 0,
        battery: ping.battery !== undefined ? ping.battery : 85,
        charging: !!ping.charging,
        activity,
        color: '#007AFF',
        avatar: '📱',
        updatedAt: ping.updatedAt || Date.now(),
        isOnline: (Date.now() - (ping.updatedAt || 0)) < 1000 * 60 * 30,
        source: 'traccar_background',
      };

      const changed = mergeRemoteMember(remoteUser);
      return { changed: changed || updatedAny, remoteUser: mainRemoteUser || remoteUser };
    }

    if (mainRemoteUser) {
      return { changed: updatedAny, remoteUser: mainRemoteUser };
    }
  } catch (e) {
    // offline ou erro silencioso
  }
  return null;
}

/**
 * Merge com algoritmo Last-Write-Wins (LWW) para Lugares Salvos
 * Retorna true se houver alteração
 */
export function mergeRemotePlace(remotePlace) {
  if (!remotePlace || !remotePlace.id) return false;

  const idx = state.geofences.findIndex((p) => p.id === remotePlace.id);
  const remoteTime = remotePlace.updatedAt || 0;

  if (idx === -1) {
    state.geofences.push(remotePlace);
    savePlacesToStorage();
    return true;
  }

  const existingTime = state.geofences[idx].updatedAt || 0;
  if (remoteTime >= existingTime) {
    state.geofences[idx] = { ...state.geofences[idx], ...remotePlace };
    savePlacesToStorage();
    return true;
  }
  return false;
}

// Inicializa membros e lugares salvos (somente aparelhos reais conectados)
export function initAppState() {
  // Salva ID persistente de usuário
  let savedUserId = localStorage.getItem('geopulse_user_id');
  if (!savedUserId) {
    savedUserId = state.currentUser.id;
    localStorage.setItem('geopulse_user_id', savedUserId);
  } else {
    state.currentUser.id = savedUserId;
  }

  // Lê círculo da URL se fornecido (convite) — circleId já foi resolvido por resolveCircleId()
  // mas garantimos consistência aqui também
  if (typeof window !== 'undefined' && window.location.search) {
    const urlParams = new URLSearchParams(window.location.search);
    const circleParam = urlParams.get('circle');
    if (circleParam && circleParam !== state.circleId) {
      state.circleId = circleParam;
      localStorage.setItem('geopulse_circle_id', circleParam);
    }
    if (urlParams.get('join') === '1') {
      try {
        sessionStorage.setItem('geopulse_is_new_join', 'true');
      } catch (e) {}
      if (!isOnboarded()) {
        state.currentUser.relation = 'Membro Convidado';
        state.currentUser.role = 'Membro';
      }
    }
  }

  // Inicializa Membros (Remove membros demo legados e restaura perfil próprio se necessário)
  const savedMembersJson = localStorage.getItem('geopulse_members_data');
  if (savedMembersJson) {
    try {
      const parsed = JSON.parse(savedMembersJson);
      if (Array.isArray(parsed)) {
        // Restaura perfil próprio salvo apenas se pertencer a este aparelho (mesmo ID ou isMe)
        const mySavedProfile = parsed.find((m) => m && (m.id === state.currentUser.id || m.isMe));
        if (mySavedProfile) {
          if (!state.currentUser.name || state.currentUser.name === 'Você') {
            state.currentUser.name = mySavedProfile.name;
            localStorage.setItem('geopulse_user_name', mySavedProfile.name);
          }
          if (mySavedProfile.photo && !state.currentUser.photo) {
            state.currentUser.photo = mySavedProfile.photo;
            localStorage.setItem('geopulse_user_photo', mySavedProfile.photo);
          }
          if (mySavedProfile.avatar && (!state.currentUser.avatar || state.currentUser.avatar === 'VC')) {
            state.currentUser.avatar = mySavedProfile.avatar;
            localStorage.setItem('geopulse_user_avatar', mySavedProfile.avatar);
          }
          if (mySavedProfile.color) {
            state.currentUser.color = mySavedProfile.color;
            localStorage.setItem('geopulse_user_color', mySavedProfile.color);
          }
          if (mySavedProfile.relation && state.currentUser.relation === 'Organizador') {
            state.currentUser.relation = mySavedProfile.relation;
          }
        }

        // Filtra e carrega apenas membros reais externos (outros celulares)
        parsed.forEach((m) => {
          if (!m || !m.id || m.id === state.currentUser.id || m.isMe || (m.name === 'Você' && m.id.startsWith('user_'))) {
            return; // NUNCA adiciona o próprio usuário ou fantasmas Você na lista de membros remotos
          }

          state.members.set(m.id, {
            ...m,
            isMe: false,
          });
        });
      }
    } catch (e) {}
  }

  // Remove qualquer membro que tenha o mesmo ID do usuário atual ou seja fantasma 'Você'
  state.members.delete(state.currentUser.id);
  Array.from(state.members.entries()).forEach(([id, m]) => {
    if (m.isMe || id === state.currentUser.id || (m.name === 'Você' && id.startsWith('user_'))) {
      state.members.delete(id);
    }
  });

  // Garante a presença dos membros do Círculo Familiar (Mariana e Lucas)
  DEFAULT_DEMO_MEMBERS.forEach((demoMember) => {
    if (!state.members.has(demoMember.id) && state.currentUser.id !== demoMember.id) {
      state.members.set(demoMember.id, {
        ...demoMember,
        isMe: false,
        isOnline: true,
        updatedAt: Date.now() - 1000 * 60 * 4,
      });
    }
  });

  // Dispositivo Traccar do Andrey (iPhone 24h) - garantido no círculo para visualização imediata
  const traccarId = (typeof localStorage !== 'undefined' && localStorage.getItem('geopulse_traccar_id')) || '93831419';
  if (!state.members.has(traccarId) && state.currentUser.id !== traccarId) {
    state.members.set(traccarId, {
      id: traccarId,
      name: 'Andrey (iPhone)',
      relation: 'Família 👨‍👩‍👧‍👦',
      role: 'iPhone 24h GPS',
      lat: -3.1372,
      lng: -60.0000,
      accuracy: 10,
      speed: 0,
      heading: 0,
      battery: 65,
      charging: false,
      color: '#34C759',
      avatar: '📱',
      photo: '',
      activity: '📍 Parado (Traccar 24h)',
      updatedAt: Date.now(),
      isOnline: true,
      source: 'traccar_background',
    });
  }

  // Salva lista limpa de membros reais no storage
  saveMembersToStorage();

  // Inicializa Lugares Salvos (Apenas criados pelo usuário)
  const savedPlacesJson = localStorage.getItem('geopulse_saved_places');
  if (savedPlacesJson) {
    try {
      const parsed = JSON.parse(savedPlacesJson);
      state.geofences = Array.isArray(parsed)
        ? parsed.filter(
            (p) =>
              p.id !== 'place_casa' &&
              p.id !== 'place_trabalho' &&
              p.id !== 'place_escola' &&
              !p.isDemo
          )
        : [];
    } catch (e) {
      state.geofences = [];
    }
  } else {
    state.geofences = [];
  }
  savePlacesToStorage();
}

export function saveMembersToStorage() {
  const membersArray = Array.from(state.members.values()).filter(
    (m) =>
      !m.isMe &&
      m.id !== state.currentUser.id &&
      !(m.name === 'Você' && m.id.startsWith('user_'))
  );
  localStorage.setItem('geopulse_members_data', JSON.stringify(membersArray));
}

export function savePlacesToStorage() {
  localStorage.setItem('geopulse_saved_places', JSON.stringify(state.geofences));
}

/**
 * Envia atualização do usuário atual para outras abas / instâncias conectadas
 */
export function broadcastUserUpdate(userData) {
  const payload = {
    type: 'USER_UPDATE',
    circleId: state.circleId,
    user: userData,
  };

  if (channel) {
    channel.postMessage(payload);
  }

  // Fallback via LocalStorage para navegadores sem BroadcastChannel
  try {
    localStorage.setItem('geopulse_last_broadcast', JSON.stringify({ ...payload, ts: Date.now() }));
  } catch (e) {
    // ignore
  }
}

/**
 * Dispara sinal sonoro (Ring Device) localmente entre abas
 */
export function broadcastRingLocal(targetId, senderName) {
  const payload = {
    type: 'RING_DEVICE',
    circleId: state.circleId,
    targetId,
    senderName: senderName || state.currentUser.name,
    ts: Date.now(),
  };

  if (channel) {
    channel.postMessage(payload);
  }

  try {
    localStorage.setItem('geopulse_last_broadcast', JSON.stringify({ ...payload, ts: Date.now() }));
  } catch (e) {}
}

/**
 * Dispara sinal de Check-in ("Cheguei Bem 💚") localmente entre abas
 */
export function broadcastCheckinLocal(message = 'Cheguei bem! 💚') {
  const payload = {
    type: 'CHECKIN',
    circleId: state.circleId,
    user: state.currentUser,
    message,
    ts: Date.now(),
  };

  if (channel) {
    channel.postMessage(payload);
  }

  try {
    localStorage.setItem('geopulse_last_broadcast', JSON.stringify({ ...payload, ts: Date.now() }));
  } catch (e) {}
}

/**
 * Dispara mensagem de Chat Privado localmente entre abas do mesmo navegador
 */
export function broadcastChatLocal(chatMsg) {
  const payload = {
    type: 'CHAT_MESSAGE',
    circleId: state.circleId,
    message: chatMsg,
    ts: Date.now(),
  };

  if (channel) {
    channel.postMessage(payload);
  }

  try {
    localStorage.setItem('geopulse_last_broadcast', JSON.stringify({ ...payload, ts: Date.now() }));
  } catch (e) {}
}

/**
 * Escuta atualizações de outras abas ou dispositivos que entrarem no círculo
 */
export function listenToBroadcasts(onMemberUpdate, onSosAlert, onRingAlert, onMemberJoin, onMemberDeleted, onPlaceUpdated, onCheckinAlert, onChatAlert) {
  const handlePayload = (payload) => {
    if (!payload || payload.circleId !== state.circleId) return;

    if (payload.type === 'USER_UPDATE' && payload.user) {
      if (payload.user.id !== state.currentUser.id) {
        const isNew = !state.members.has(payload.user.id);
        const changed = mergeRemoteMember(payload.user);
        if (changed && onMemberUpdate) onMemberUpdate(payload.user.id);
        if (isNew && onMemberJoin) onMemberJoin(payload.user);
        if (payload.user.sos && onSosAlert) {
          onSosAlert(payload.user);
        }
      }
    } else if (payload.type === 'MEMBER_DELETED' && payload.memberId) {
      state.members.delete(payload.memberId);
      saveMembersToStorage();
      if (onMemberDeleted) onMemberDeleted(payload.memberId);
    } else if ((payload.type === 'SOS_SIGNAL' || payload.type === 'SOS') && payload.user) {
      if (onSosAlert) onSosAlert(payload.user);
    } else if (payload.type === 'RING_DEVICE' && payload.targetId) {
      if (onRingAlert) onRingAlert(payload);
    } else if (payload.type === 'CHECKIN' && payload.user) {
      if (payload.user.id !== state.currentUser.id && onCheckinAlert) {
        onCheckinAlert(payload);
      }
    } else if (payload.type === 'CHAT_MESSAGE' && payload.message) {
      if (payload.message.senderId !== state.currentUser.id && onChatAlert) {
        onChatAlert(payload.message);
      }
    } else if (payload.type === 'JOIN' && payload.user) {
      if (payload.user.id !== state.currentUser.id && onMemberJoin) {
        onMemberJoin(payload.user, !!payload.isNewInvite);
      }
    } else if (payload.type === 'PLACE_SAVED' && payload.place) {
      const changed = mergeRemotePlace(payload.place);
      if (changed && onPlaceUpdated) onPlaceUpdated();
    } else if (payload.type === 'PLACE_DELETED' && payload.placeId) {
      state.geofences = state.geofences.filter((x) => x.id !== payload.placeId);
      savePlacesToStorage();
      if (onPlaceUpdated) onPlaceUpdated();
    }
  };

  if (channel) {
    channel.onmessage = (event) => {
      handlePayload(event.data);
    };
  }

  window.addEventListener('storage', (e) => {
    if (e.key === 'geopulse_last_broadcast' && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        handlePayload(parsed);
      } catch (err) {}
    }
  });
}

/**
 * Permite adicionar um novo membro ou ponto de rastreamento manualmente caso o usuário deseje
 */
export function addCustomMember(name, role, lat, lng, color = '#1F6C9F') {
  const id = `member_${Date.now()}`;
  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

  const newMember = {
    id,
    name,
    role: role || 'Ponto Rastreado',
    lat,
    lng,
    speed: 0,
    heading: 0,
    battery: 100,
    charging: false,
    color,
    avatar: initials || 'PT',
    history: [{ lat, lng, time: Date.now() }],
    updatedAt: Date.now(),
    version: 1,
    isMe: false,
    isVirtual: false,
  };

  state.members.set(id, newMember);
  saveMembersToStorage();
  return newMember;
}

/**
 * Exclui um membro ou ponto manual do círculo
 */
export function removeMember(id) {
  state.members.delete(id);
  saveMembersToStorage();
  const payload = {
    type: 'MEMBER_DELETED',
    circleId: state.circleId,
    memberId: id,
    ts: Date.now(),
  };
  if (channel) {
    channel.postMessage(payload);
  }
  try {
    localStorage.setItem('geopulse_last_broadcast', JSON.stringify(payload));
  } catch (e) {}
}

/**
 * Remove todos os pontos manuais adicionados
 */
export function clearAllMembers() {
  state.members.clear();
  saveMembersToStorage();
}

/**
 * Restaura os membros familiares de demonstração
 */
export function resetToDemoMembers() {
  state.members.clear();
  DEFAULT_DEMO_MEMBERS.forEach((m) => {
    state.members.set(m.id, { ...m, updatedAt: Date.now(), version: 1 });
  });
  saveMembersToStorage();
}

/**
 * Remove apenas membros de demonstração, mantendo aparelhos reais
 */
export function clearDemoMembers() {
  Array.from(state.members.entries()).forEach(([id, m]) => {
    if (m.isDemo) {
      state.members.delete(id);
    }
  });
  saveMembersToStorage();
}

/**
 * Atualiza o perfil do próprio usuário
 */
export function updateUserProfile(name, photo = '') {
  state.currentUser.name = name.trim() || 'Você';
  state.currentUser.photo = photo;
  const initials = state.currentUser.name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
  state.currentUser.avatar = initials || 'VC';
  state.currentUser.version = (state.currentUser.version || 1) + 1;
  state.currentUser.updatedAt = Date.now();

  localStorage.setItem('geopulse_user_name', state.currentUser.name);
  localStorage.setItem('geopulse_user_photo', state.currentUser.photo);
  localStorage.setItem('geopulse_user_avatar', state.currentUser.avatar);

  broadcastUserUpdate(state.currentUser);
}

/**
 * Adiciona um novo Lugar Salvo (Casa, Trabalho, Escola, etc.)
 */
export function addSavedPlace(place) {
  if (!place.updatedAt) place.updatedAt = Date.now();
  if (!place.createdBy) place.createdBy = state.currentUser.id;
  if (!place.version) place.version = 1;

  const existingIdx = state.geofences.findIndex((p) => p.id === place.id);
  if (existingIdx === -1) {
    state.geofences.push(place);
  } else {
    place.version = (state.geofences[existingIdx].version || 1) + 1;
    state.geofences[existingIdx] = { ...state.geofences[existingIdx], ...place };
  }
  savePlacesToStorage();

  const payload = {
    type: 'PLACE_SAVED',
    circleId: state.circleId,
    place,
    senderId: state.currentUser.id,
    ts: Date.now(),
  };
  if (channel) {
    try {
      channel.postMessage(payload);
    } catch (e) {}
  }
  try {
    localStorage.setItem('geopulse_last_broadcast', JSON.stringify(payload));
  } catch (e) {}

  return place;
}

/**
 * Remove um Lugar Salvo por ID
 */
export function removeSavedPlace(id) {
  state.geofences = state.geofences.filter((g) => g.id !== id);
  savePlacesToStorage();

  const payload = {
    type: 'PLACE_DELETED',
    circleId: state.circleId,
    placeId: id,
    senderId: state.currentUser.id,
    ts: Date.now(),
  };
  if (channel) {
    try {
      channel.postMessage(payload);
    } catch (e) {}
  }
  try {
    localStorage.setItem('geopulse_last_broadcast', JSON.stringify(payload));
  } catch (e) {}
}
