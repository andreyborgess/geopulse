// Sincronização em Tempo Real (Cross-Tab via BroadcastChannel + Gerenciamento de Membros)
import { calculateBearing } from './geo.js';

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

// Estado inicial de Lugares Salvos (Padrão Família)
export const DEFAULT_SAVED_PLACES = [
  {
    id: 'place_casa',
    name: 'Casa da Família',
    category: 'home',
    icon: '🏠',
    lat: -3.1025,
    lng: -60.0142,
    radius: 250,
    color: '#007AFF',
    address: 'Adrianópolis, Manaus',
  },
  {
    id: 'place_trabalho',
    name: 'Trabalho / Centro',
    category: 'work',
    icon: '💼',
    lat: -3.1310,
    lng: -60.0240,
    radius: 200,
    color: '#5856D6',
    address: 'Centro, Manaus',
  },
  {
    id: 'place_escola',
    name: 'Faculdade / Campus',
    category: 'school',
    icon: '🎓',
    lat: -3.0990,
    lng: -59.9880,
    radius: 350,
    color: '#34C759',
    address: 'Coroado, Manaus',
  },
];

// Estado inicial de Membros de Demonstração (Realistas e Orgânicos)
export const DEFAULT_DEMO_MEMBERS = [
  {
    id: 'member_mariana',
    name: 'Mariana Silva',
    relation: 'Esposa',
    lat: -3.1025,
    lng: -60.0142,
    accuracy: 12,
    speed: 0,
    heading: 0,
    battery: 88,
    charging: false,
    color: '#EC4899',
    avatar: 'MS',
    photo: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80',
    activity: '🏠 Em Casa',
    address: 'Adrianópolis, Manaus',
    updatedAt: Date.now() - 1000 * 60 * 4,
    history: [
      { lat: -3.1030, lng: -60.0145, time: Date.now() - 1000 * 60 * 30 },
      { lat: -3.1025, lng: -60.0142, time: Date.now() - 1000 * 60 * 4 },
    ],
    isMe: false,
    isDemo: true,
  },
  {
    id: 'member_lucas',
    name: 'Lucas Silva',
    relation: 'Filho',
    lat: -3.0950,
    lng: -60.0280,
    accuracy: 18,
    speed: 44,
    heading: 185,
    battery: 62,
    charging: false,
    color: '#007AFF',
    avatar: 'LS',
    photo: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&auto=format&fit=crop&q=80',
    activity: '🚗 Dirigindo · 44 km/h',
    address: 'Av. Djalma Batista, Manaus',
    updatedAt: Date.now() - 1000 * 35,
    history: [
      { lat: -3.0880, lng: -60.0270, time: Date.now() - 1000 * 60 * 10 },
      { lat: -3.0920, lng: -60.0275, time: Date.now() - 1000 * 60 * 4 },
      { lat: -3.0950, lng: -60.0280, time: Date.now() - 1000 * 35 },
    ],
    isMe: false,
    isDemo: true,
  },
  {
    id: 'member_carlos',
    name: 'Carlos Mendes',
    relation: 'Irmão',
    lat: -3.0990,
    lng: -59.9880,
    accuracy: 15,
    speed: 0,
    heading: 45,
    battery: 95,
    charging: true,
    color: '#34C759',
    avatar: 'CM',
    photo: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
    activity: '🎓 Na Faculdade',
    address: 'Setor Sul / UFAM, Manaus',
    updatedAt: Date.now() - 1000 * 60 * 12,
    history: [
      { lat: -3.0995, lng: -59.9885, time: Date.now() - 1000 * 60 * 20 },
      { lat: -3.0990, lng: -59.9880, time: Date.now() - 1000 * 60 * 12 },
    ],
    isMe: false,
    isDemo: true,
  },
];

// Estado dos membros do círculo
export const state = {
  circleId: localStorage.getItem('geopulse_circle_id') || 'FAMILIA-01',
  circleName: localStorage.getItem('geopulse_circle_name') || 'Família Silva',
  currentUser: {
    id: localStorage.getItem('geopulse_user_id') || `user_${Math.random().toString(36).substr(2, 6)}`,
    name: localStorage.getItem('geopulse_user_name') || 'Você',
    relation: 'Organizador',
    role: 'Administrador',
    lat: -3.1303, // Manaus, Amazonas (Teatro Amazonas / Centro)
    lng: -60.0234,
    accuracy: 10,
    speed: 0,
    heading: 0,
    battery: 90,
    charging: false,
    updatedAt: Date.now(),
    history: [],
    color: '#007AFF', // Azul Real Apple
    avatar: localStorage.getItem('geopulse_user_avatar') || 'VC',
    photo: localStorage.getItem('geopulse_user_photo') || '',
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

// Inicializa membros e lugares salvos (somente aparelhos reais conectados)
export function initAppState() {
  // Salva ID persistente de usuário
  localStorage.setItem('geopulse_user_id', state.currentUser.id);

  // Lê círculo da URL se fornecido (convite)
  if (typeof window !== 'undefined' && window.location.search) {
    const urlParams = new URLSearchParams(window.location.search);
    const circleParam = urlParams.get('circle');
    if (circleParam) {
      state.circleId = circleParam;
      localStorage.setItem('geopulse_circle_id', circleParam);
    }
    if (urlParams.get('join') === '1' && !isOnboarded()) {
      state.currentUser.relation = 'Membro Convidado';
      state.currentUser.role = 'Membro';
    }
  }

  // Inicializa Membros (Remove qualquer membro demo antigo)
  const savedMembersJson = localStorage.getItem('geopulse_members_data');
  if (savedMembersJson) {
    try {
      const parsed = JSON.parse(savedMembersJson);
      parsed.forEach((m) => {
        // Ignora qualquer membro demo
        if (!m.isDemo && !m.id.startsWith('member_')) {
          state.members.set(m.id, m);
        }
      });
    } catch (e) {}
  }

  // Salva lista limpa de membros reais no storage
  saveMembersToStorage();

  // Inicializa Lugares Salvos
  const savedPlacesJson = localStorage.getItem('geopulse_saved_places');
  if (savedPlacesJson) {
    try {
      state.geofences = JSON.parse(savedPlacesJson);
    } catch (e) {
      state.geofences = [...DEFAULT_SAVED_PLACES];
    }
  } else {
    state.geofences = [...DEFAULT_SAVED_PLACES];
    localStorage.setItem('geopulse_saved_places', JSON.stringify(state.geofences));
  }
}

export function saveMembersToStorage() {
  const membersArray = Array.from(state.members.values());
  localStorage.setItem('geopulse_members_data', JSON.stringify(membersArray));
}

export function savePlacesToStorage() {
  localStorage.setItem('geopulse_saved_places', JSON.stringify(state.geofences));
}

// Salva ID persistente de usuário
localStorage.setItem('geopulse_user_id', state.currentUser.id);

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
 * Escuta atualizações de outras abas ou dispositivos que entrarem no círculo
 */
export function listenToBroadcasts(onMemberUpdate, onSosAlert) {
  const handlePayload = (payload) => {
    if (!payload || payload.circleId !== state.circleId) return;

    if (payload.type === 'USER_UPDATE' && payload.user) {
      if (payload.user.id !== state.currentUser.id) {
        state.members.set(payload.user.id, {
          ...payload.user,
          isMe: false,
          isVirtual: false,
        });
        if (onMemberUpdate) onMemberUpdate(payload.user.id);
        if (payload.user.sos && onSosAlert) {
          onSosAlert(payload.user);
        }
      }
    } else if (payload.type === 'SOS_SIGNAL' && payload.user) {
      if (onSosAlert) onSosAlert(payload.user);
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
      } catch (err) {
        // ignore
      }
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
    isMe: false,
    isVirtual: false,
  };

  state.members.set(id, newMember);
  return newMember;
}

/**
 * Exclui um membro ou ponto manual do círculo
 */
export function removeMember(id) {
  state.members.delete(id);
  const payload = {
    type: 'MEMBER_DELETED',
    circleId: state.circleId,
    memberId: id,
  };
  if (channel) {
    channel.postMessage(payload);
  }
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
    state.members.set(m.id, { ...m, updatedAt: Date.now() });
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

  localStorage.setItem('geopulse_user_name', state.currentUser.name);
  localStorage.setItem('geopulse_user_photo', state.currentUser.photo);
  localStorage.setItem('geopulse_user_avatar', state.currentUser.avatar);

  broadcastUserUpdate(state.currentUser);
}

/**
 * Adiciona um novo Lugar Salvo (Casa, Trabalho, Escola, etc.)
 */
export function addSavedPlace(place) {
  state.geofences.push(place);
  savePlacesToStorage();
  return place;
}

/**
 * Remove um Lugar Salvo por ID
 */
export function removeSavedPlace(id) {
  state.geofences = state.geofences.filter((g) => g.id !== id);
  savePlacesToStorage();
}

