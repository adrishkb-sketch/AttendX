import QRCode from 'qrcode';

/**
 * Draws a highly stylish QR code with rounded data dots, smooth finder rings, 
 * a purple-to-pink gradient fill, and a center brand logo.
 */
export function drawStylishQR(text, canvas, options = {}) {
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'H' });
    const modules = qr.modules;
    const size = modules.size;
    
    const width = options.width || 360;
    const height = width;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    
    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    
    // Draw white canvas background (clean base for scanning contrast)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    
    const cellSize = width / size;
    
    // Setup vibrant brand gradient colors
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#8b5cf6'); // Violet brand primary
    gradient.addColorStop(1, '#ec4899'); // Pink accent
    ctx.fillStyle = gradient;
    
    // Render bit matrix
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (modules.get(r, c)) {
          // Reserve center space (5x5 matrix modules) for the branding overlay badge
          const centerStart = Math.floor(size / 2) - 2;
          const centerEnd = Math.floor(size / 2) + 2;
          if (r >= centerStart && r <= centerEnd && c >= centerStart && c <= centerEnd) {
            continue;
          }

          const cx = c * cellSize + cellSize / 2;
          const cy = r * cellSize + cellSize / 2;
          const radius = (cellSize / 2) * 0.85; // Padding for premium circular dots
          
          ctx.beginPath();
          
          // Finder locator shapes (Top-Left, Top-Right, Bottom-Left)
          const isFinder = (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);
          
          if (isFinder) {
            // Draw a rounded corner rect for locator blocks instead of pixel blocks
            const x = c * cellSize + 0.5;
            const y = r * cellSize + 0.5;
            const w = cellSize - 1;
            const h = cellSize - 1;
            const rVal = cellSize * 0.22;
            
            ctx.moveTo(x + rVal, y);
            ctx.arcTo(x + w, y, x + w, y + h, rVal);
            ctx.arcTo(x + w, y + h, x, y + h, rVal);
            ctx.arcTo(x, y + h, x, y, rVal);
            ctx.arcTo(x, y, x + w, y, rVal);
          } else {
            // Data blocks rendered as smooth circular micro-dots
            ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
          }
          ctx.fill();
        }
      }
    }
    
    // Render Center Branding Emblem
    const logoSize = cellSize * 5.5;
    
    // Outer white masking ring
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, logoSize / 2 + 3, 0, 2 * Math.PI);
    ctx.fill();
    
    // Inner badge fill
    ctx.fillStyle = '#8b5cf6';
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, logoSize / 2 - 1, 0, 2 * Math.PI);
    ctx.fill();
    
    // Center brand character symbol
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${logoSize * 0.55}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('◈', width / 2, height / 2);
  } catch (err) {
    console.error("Error drawing custom QR Code:", err);
  }
}
