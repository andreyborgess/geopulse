// Módulo de Gerenciamento de Cercas Virtuais (Geofencing)
import { calculateDistance } from './geo.js';
import { playGeofenceAlert } from './audio.js';

// Rastreia estado anterior (dentro / fora) para disparar apenas na transição
const memberZoneState = new Map();

/**
 * Verifica as cercas virtuais para todos os membros e emite eventos de entrada/saída
 */
export function checkGeofences(geofences, allMembers, onEvent) {
  geofences.forEach((fence) => {
    allMembers.forEach((member) => {
      const dist = calculateDistance(fence.lat, fence.lng, member.lat, member.lng);
      const isInside = dist <= fence.radius;
      const stateKey = `${fence.id}_${member.id}`;
      const previousState = memberZoneState.get(stateKey);

      if (previousState === undefined) {
        // Primeira checagem inicial
        memberZoneState.set(stateKey, isInside);
      } else if (previousState !== isInside) {
        // Transição de estado detectada!
        memberZoneState.set(stateKey, isInside);
        const eventType = isInside ? 'ENTERED' : 'EXITED';

        playGeofenceAlert(isInside);

        if (onEvent) {
          onEvent({
            type: eventType,
            memberName: member.name,
            fenceName: fence.name,
            fenceColor: fence.color,
            distance: Math.round(dist),
            timestamp: Date.now(),
          });
        }
      }
    });
  });
}
