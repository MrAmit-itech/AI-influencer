function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Upgrade Amazon thumbnail URL to 1200p high-res image for Gemini Vision & Google Flow

function toHighResAmazonImage(url) {
  if (!url) return '';
  return url.replace(/\._[A-Z0-9,_-]+_\.(jpg|png|webp)$/i, '._SL1200_.$1');
}

// ==========================================
// 2. NATIVE TELEGRAM API HELPER (NO LIBRARY NEEDED)
// ==========================================

module.exports = { escapeHtml, toHighResAmazonImage };
