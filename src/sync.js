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

// Estado dos membros do círculo
export const state = {
  circleId: localStorage.getItem('geopulse_circle_id') || 'RADAR-01',
  circleName: localStorage.getItem('geopulse_circle_name') || 'Meu Círculo',
  currentUser: {
    id: localStorage.getItem('geopulse_user_id') || `user_${Math.random().toString(36).substr(2, 6)}`,
    name: localStorage.getItem('geopulse_user_name') || 'Você (Atual)',
    role: 'Comando Central',
    lat: -3.1303, // Manaus, Amazonas (Teatro Amazonas / Centro)
    lng: -60.0234,
    accuracy: 10,
    speed: 0,
    heading: 0,
    battery: 90,
    charging: false,
    updatedAt: Date.now(),
    history: [],
    color: '#00F0FF', // Ciano vibrante de radar tático
    avatar: 'VC',
    isMe: true,
    sos: false,
  },
  // Nenhum membro fantasma cadastrado previamente - inicia limpo!
  members: new Map(),
  // Nenhuma cerca pré-cadastrada - inicia limpo para o usuário cadastrar apenas o que quiser!
  geofences: [],
  simulationActive: false,
};

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
}
