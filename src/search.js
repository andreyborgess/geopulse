// GeoPulse - Busca Inteligente de Endereços e Lugares (OpenStreetMap Nominatim)
import { searchAddress } from './geo.js';
import { playTactileClick } from './audio.js';
import { getMapInstance } from './mapRenderer.js';

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
    if (!query || query.length < 2) {
      if (searchDropdown) searchDropdown.style.display = 'none';
      return;
    }

    searchTimeout = setTimeout(async () => {
      const results = await searchAddress(query);
      if (searchDropdown) {
        if (results.length === 0) {
          searchDropdown.innerHTML = `<div class="search-item search-empty">Nenhum resultado encontrado</div>`;
          searchDropdown.style.display = 'block';
          return;
        }

        searchDropdown.innerHTML = results
          .map((res) => `<div class="search-item" data-lat="${res.lat}" data-lng="${res.lon}">📍 ${res.display_name}</div>`)
          .join('');
        searchDropdown.style.display = 'block';

        searchDropdown.querySelectorAll('.search-item').forEach((item) => {
          item.addEventListener('click', () => {
            const lat = parseFloat(item.getAttribute('data-lat'));
            const lng = parseFloat(item.getAttribute('data-lng'));
            const map = getMapInstance();
            if (map && !isNaN(lat) && !isNaN(lng)) {
              playTactileClick();
              map.flyTo([lat, lng], 16, { duration: 1 });
            }
            searchDropdown.style.display = 'none';
          });
        });
      }
    }, 350);
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
