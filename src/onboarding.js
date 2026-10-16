// GeoPulse - Fluxo de Onboarding de Novos Aparelhos e Convidados do Círculo
import { state, saveUserProfile, isOnboarded } from './sync.js';
import { playTactileClick } from './audio.js';
import { broadcastJoin, broadcastLocation } from './realtime.js';
import { isStandalone } from './notifications.js';
import { compressImageFile, openInstallPWAModal, showToast, updateHeaderProfileUI } from './modals.js';
import { eventBus } from './eventBus.js';

let selectedOnboardingPhoto = '';
let selectedOnboardingColor = '#007AFF';

export function setupOnboardingModal() {
  const modal = document.getElementById('modal-onboarding');
  const titleCircle = document.getElementById('onboarding-circle-name');
  const modalTitle = document.getElementById('onboarding-modal-title');
  const inputName = document.getElementById('input-onboarding-name');
  const selectRelation = document.getElementById('select-onboarding-relation');
  const btnPickPhoto = document.getElementById('btn-onboarding-pick-photo');
  const btnRemovePhoto = document.getElementById('btn-onboarding-remove-photo');
  const inputFile = document.getElementById('input-onboarding-photo');
  const preview = document.getElementById('onboarding-avatar-preview');
  const previewInitials = document.getElementById('onboarding-avatar-initials');
  const btnSubmit = document.getElementById('btn-submit-onboarding');
  const btnClose = document.getElementById('btn-close-onboarding');

  if (titleCircle) titleCircle.textContent = state.circleId;

  const urlParams = new URLSearchParams(window.location.search);
  const hostName = urlParams.get('host');
  if (hostName && modalTitle) {
    modalTitle.textContent = `${hostName} convidou você!`;
  }

  // Pré-preenche se o usuário já tiver nome customizado
  if (inputName && state.currentUser.name && state.currentUser.name !== 'Você') {
    inputName.value = state.currentUser.name;
    if (previewInitials) previewInitials.textContent = state.currentUser.name.slice(0, 2).toUpperCase();
  }

  // Seletor de cores
  const colorBtns = document.querySelectorAll('#onboarding-color-palette .color-chip-btn');
  colorBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      playTactileClick();
      colorBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedOnboardingColor = btn.getAttribute('data-color') || '#007AFF';
      if (preview) preview.style.backgroundColor = selectedOnboardingColor;
    });
  });

  // Atualiza iniciais conforme digita
  inputName?.addEventListener('input', () => {
    const val = inputName.value.trim();
    if (!selectedOnboardingPhoto && previewInitials) {
      previewInitials.textContent = val ? val.slice(0, 2).toUpperCase() : '📱';
    }
  });

  // Upload da galeria do celular
  btnPickPhoto?.addEventListener('click', () => {
    playTactileClick();
    inputFile?.click();
  });

  inputFile?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      showToast('Processando foto...', 'info');
      const compressed = await compressImageFile(file, 240, 0.85);
      selectedOnboardingPhoto = compressed;
      if (preview) {
        preview.style.backgroundImage = `url('${selectedOnboardingPhoto}')`;
        if (previewInitials) previewInitials.textContent = '';
      }
      if (btnRemovePhoto) btnRemovePhoto.style.display = 'inline-block';
      showToast('Foto carregada!', 'info');
    } catch (err) {
      showToast('Erro ao carregar foto: ' + err.message, 'error');
    } finally {
      inputFile.value = '';
    }
  });

  btnRemovePhoto?.addEventListener('click', () => {
    selectedOnboardingPhoto = '';
    if (preview) {
      preview.style.backgroundImage = '';
      if (previewInitials) {
        const val = inputName?.value.trim();
        previewInitials.textContent = val ? val.slice(0, 2).toUpperCase() : '📱';
      }
    }
    btnRemovePhoto.style.display = 'none';
  });

  // Submissão
  btnSubmit?.addEventListener('click', () => {
    playTactileClick();
    const chosenName = inputName?.value.trim();
    if (!chosenName) {
      showToast('Por favor, digite seu nome ou o nome deste celular.', 'error');
      inputName?.focus();
      return;
    }

    const chosenRelation = selectRelation?.value || 'Membro';

    saveUserProfile({
      name: chosenName,
      relation: chosenRelation,
      color: selectedOnboardingColor,
      photo: selectedOnboardingPhoto,
    });

    updateHeaderProfileUI();
    eventBus.emit('user:profile-saved');

    // Transmite entrada para todos os celulares conectados
    broadcastJoin();
    broadcastLocation(state.currentUser);

    showToast(`Bem-vindo(a) ao Círculo, ${chosenName}!`, 'info');

    if (modal) modal.style.display = 'none';

    // Sugere instalação como PWA para manter rastreamento contínuo
    if (!isStandalone()) {
      setTimeout(() => {
        openInstallPWAModal(true);
      }, 700);
    }
  });

  btnClose?.addEventListener('click', () => {
    playTactileClick();
    if (modal) modal.style.display = 'none';
  });
}

export function checkAutoOpenOnboarding() {
  const urlParams = new URLSearchParams(window.location.search);
  const isExplicitJoin = urlParams.get('join') === '1' && urlParams.has('host');

  // Só abre se for explicitamente um novo convidado vindo de link com ?join=1 e ?host=
  if (isExplicitJoin && !isOnboarded()) {
    setTimeout(() => {
      const modal = document.getElementById('modal-onboarding');
      if (modal) {
        modal.style.display = 'flex';
        playTactileClick();
      }
    }, 500);
  }
}
