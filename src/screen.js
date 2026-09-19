// Optimized screenshot capture for low-latency multimodal prompts.
//
// The previous implementation captured the full physical resolution. On a
// 4K/Retina display that creates a very large PNG, increasing upload and vision
// preprocessing time. For interview questions, a ~1600px image is usually a
// better latency/readability trade-off.

const { desktopCapturer, screen } = require('electron');

const MAX_CAPTURE_WIDTH = 1600;
const MAX_CAPTURE_HEIGHT = 1000;
const JPEG_QUALITY = 80;

function fitInside(width, height, maxWidth, maxHeight) {
  const ratio = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio))
  };
}

async function captureScreenshot() {
  const primary = screen.getPrimaryDisplay();
  const scale = primary.scaleFactor || 1;

  const physicalWidth = Math.max(1, Math.floor(primary.size.width * scale));
  const physicalHeight = Math.max(1, Math.floor(primary.size.height * scale));
  const target = fitInside(
    physicalWidth,
    physicalHeight,
    MAX_CAPTURE_WIDTH,
    MAX_CAPTURE_HEIGHT
  );

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: target
  });

  if (!sources.length) return null;

  // Prefer the primary display source.
  const src =
    sources.find((s) => String(s.display_id) === String(primary.id)) ||
    sources[0];

  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;

  // JPEG is dramatically smaller than a full-resolution PNG for desktop
  // screenshots. All currently supported multimodal providers accept JPEG.
  try {
    const jpeg = img.toJPEG(JPEG_QUALITY);
    if (jpeg && jpeg.length) {
      return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    }
  } catch (_) {
    // Fall back to PNG if JPEG conversion is unavailable for any reason.
  }

  return img.toDataURL();
}

module.exports = { captureScreenshot, fitInside };
