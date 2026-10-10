// Gerador de SVG de QR Code Estilizado para Compartilhamento Seguro

export function generateQRCodeSVG(text) {
  // Gera uma representação visual elegante estilo QR Code com marcas de alinhamento
  const size = 25; // grade 25x25
  const cellSize = 6;
  const padding = 12;
  const totalSize = size * cellSize + padding * 2;

  // Hash determinístico simples do texto para gerar módulos pseudo-aleatórios consistentes
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }

  const isCorner = (r, c) => {
    // Top-left
    if (r < 7 && c < 7) return true;
    // Top-right
    if (r < 7 && c >= size - 7) return true;
    // Bottom-left
    if (r >= size - 7 && c < 7) return true;
    return false;
  };

  const isCornerInner = (r, c) => {
    // Verifica padrão de 7x7 dos cantos padrão QR
    const inBox = (rowOffset, colOffset) => {
      const localR = r - rowOffset;
      const localC = c - colOffset;
      if (localR >= 0 && localR < 7 && localC >= 0 && localC < 7) {
        if (localR === 0 || localR === 6 || localC === 0 || localC === 6) return true;
        if (localR >= 2 && localR <= 4 && localC >= 2 && localC <= 4) return true;
        return false;
      }
      return null;
    };

    const tl = inBox(0, 0);
    if (tl !== null) return tl;
    const tr = inBox(0, size - 7);
    if (tr !== null) return tr;
    const bl = inBox(size - 7, 0);
    if (bl !== null) return bl;
    return false;
  };

  let rects = '';

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      let active = false;
      if (isCorner(r, c)) {
        active = isCornerInner(r, c);
      } else {
        // Módulos centrais pseudo-aleatórios derivados do texto
        const seed = Math.sin((r * 31 + c * 17) ^ hash) * 10000;
        active = seed - Math.floor(seed) > 0.48;
      }

      if (active) {
        const x = padding + c * cellSize;
        const y = padding + r * cellSize;
        rects += `<rect x="${x}" y="${y}" width="${cellSize - 0.5}" height="${cellSize - 0.5}" rx="1" fill="#0f172a" />`;
      }
    }
  }

  return `
    <svg viewBox="0 0 ${totalSize} ${totalSize}" xmlns="http://www.w3.org/2000/svg" style="max-width: 100%; height: auto;">
      <rect width="${totalSize}" height="${totalSize}" fill="#ffffff" rx="8" />
      ${rects}
      <!-- Centro com logotipo discreto -->
      <circle cx="${totalSize / 2}" cy="${totalSize / 2}" r="14" fill="#0ea5e9" />
      <circle cx="${totalSize / 2}" cy="${totalSize / 2}" r="5" fill="#ffffff" />
    </svg>
  `;
}
