// Gerador de QR Code Real (ISO/IEC 18004 Standard) - Escaneável por qualquer câmera de celular
import QRCode from 'qrcode';

export async function generateQRCodeSVG(text) {
  try {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: 2,
      color: {
        dark: '#0B0F19',
        light: '#FFFFFF',
      },
      errorCorrectionLevel: 'M',
      width: 260,
    });
    return svg;
  } catch (err) {
    console.error('[QRCode] Erro ao gerar SVG:', err);
    return `<div style="color: #ff3b30; padding: 20px; font-size: 12px; text-align: center;">Erro ao gerar QR Code: ${err.message}</div>`;
  }
}
