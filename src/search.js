// GeoPulse - Busca Unificada de Pessoas, Lugares Salvos e Endereços
import { state } from './sync.js';
import { searchAddress, calculateDistance, formatDistance } from './geo.js';
import { playTactileClick } from './audio.js';
import { getMapInstance } from './mapRenderer.js';
import { eventBus } from './eventBus.js';

export function setupSearch() {
  const searchInput = document.getElementById('map-search-input');
  const searchDropdown = document.getElementById('search-dropdown');
  const btnClear = document.getElementById('btn-search-clear');
  let searchTimeout = null;

  if (!searchInput) return;

  const toggleClearButton = (show) => {
    if (btnClear) btnClear.style.display = show ? 'block' : 'none';
  };

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    toggleClearButton(query.length > 0);

    if (searchTimeout) clearTimeout(searchTimeout);
    if (!query || query.length < 1) {
      if (searchDropdown) searchDropdown.style.display = 'none';
      return;
    }

    searchTimeout = setTimeout(async () => {
      const qLower = query.toLowerCase();

      // 1. Busca nos Membros do Círculo (Você + outros celulares)
      const allMembers = [state.currentUser, ...Array.from(state.members.values())];
      const matchedMembers = allMembers.filter((m) => {
        if (!m || !m.name) return false;
        return (
          m.name.toLowerCase().includes(qLower) ||
          (m.relation && m.relation.toLowerCase().includes(qLower)) ||
          (m.activity && m.activity.toLowerCase().includes(qLower))
        );
      });

      // 2. Busca nos Lugares Salvos da Família
      const matchedPlaces = state.geofences.filter((p) => {
        if (!p || !p.name) return false;
        return p.name.toLowerCase().includes(qLower) || (p.category && p.category.toLowerCase().includes(qLower));
      });

      // 3. Busca de Ruas / Endereços (Nominatim) se 3+ letras
      let addressResults = [];
      if (query.length >= 3) {
        addressResults = await searchAddress(query);
      }

      if (!searchDropdown) return;

      const hasAnyResults = matchedMembers.length > 0 || matchedPlaces.length > 0 || addressResults.length > 0;

      if (!hasAnyResults) {
        searchDropdown.innerHTML = `<div class="search-item search-empty">Nenhum resultado para "${escapeHtml(query)}"</div>`;
        searchDropdown.style.display = 'block';
        return;
      }

      let html = '';

      // Seção Membros
      if (matchedMembers.length > 0) {
        html += `<div class="search-section-header">👨‍👩‍👧‍👦 Círculo Familiar</div>`;
        matchedMembers.forEach((m) => {
          const isMe = m.isMe || m.id === state.currentUser.id;
          const initial = m.avatar || m.name.slice(0, 2).toUpperCase();
          const dist = isMe
            ? 'Você'
            : formatDistance(calculateDistance(state.currentUser.lat, state.currentUser.lng, m.lat, m.lng));
          const avatarStyle = m.photo
            ? `background-image: url('${m.photo}'); background-color: ${m.color || '#007AFF'};`
            : `background-color: ${m.color || '#007AFF'};`;

          html += `
            <div class="search-item search-member-item" data-type="member" data-id="${m.id}" data-lat="${m.lat}" data-lng="${m.lng}">
              <span class="search-item-avatar" style="${avatarStyle}">${m.photo ? '' : initial}</span>
              <div class="search-item-meta">
                <strong>${escapeHtml(m.name)}${isMe ? ' (Você)' : ''}</strong>
                <span>${escapeHtml(m.activity || m.relation || 'Membro')} · ${dist}</span>
              </div>
            </div>
          `;
        });
      }

      // Seção Lugares
      if (matchedPlaces.length > 0) {
        html += `<div class="search-section-header">📍 Lugares Salvos</div>`;
        matchedPlaces.forEach((p) => {
          html += `
            <div class="search-item search-place-item" data-type="place" data-id="${p.id}" data-lat="${p.lat}" data-lng="${p.lng}">
              <span class="search-item-icon">${p.icon || '📍'}</span>
              <div class="search-item-meta">
                <strong>${escapeHtml(p.name)}</strong>
                <span>Raio monitorado: ${p.radius || 250}m</span>
              </div>
            </div>
          `;
        });
      }

      // Seção Endereços / Ruas
      if (addressResults.length > 0) {
        html += `<div class="search-section-header">🗺️ Ruas & Endereços</div>`;
        addressResults.forEach((res) => {
          html += `
            <div class="search-item search-address-item" data-type="address" data-lat="${res.lat}" data-lng="${res.lon}">
              <span class="search-item-icon">📍</span>
              <div class="search-item-meta">
                <strong>${escapeHtml(res.display_name.split(',')[0])}</strong>
                <span>${escapeHtml(res.display_name)}</span>
              </div>
            </div>
          `;
        });
      }

      searchDropdown.innerHTML = html;
      searchDropdown.style.display = 'block';

      // Eventos de clique nos resultados
      searchDropdown.querySelectorAll('.search-item').forEach((item) => {
        item.addEventListener('click', () => {
          playTactileClick();
          const type = item.getAttribute('data-type');
          const lat = parseFloat(item.getAttribute('data-lat'));
          const lng = parseFloat(item.getAttribute('data-lng'));
          const map = getMapInstance();

          if (map && !isNaN(lat) && !isNaN(lng)) {
            map.flyTo([lat, lng], 16, { duration: 0.8 });
          }

          if (type === 'member') {
            const id = item.getAttribute('data-id');
            const member = allMembers.find((m) => m.id === id);
            if (member) {
              if (member.isMe || member.id === state.currentUser.id) {
                eventBus.emit('modal:open-profile');
              } else {
                eventBus.emit('member:selected', member);
              }
            }
          }

          searchDropdown.style.display = 'none';
        });
      });
    }, 280);
  });

  btnClear?.addEventListener('click', () => {
    playTactileClick();
    searchInput.value = '';
    toggleClearButton(false);
    if (searchDropdown) searchDropdown.style.display = 'none';
    searchInput.focus();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#map-search-box') && searchDropdown) {
      searchDropdown.style.display = 'none';
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
