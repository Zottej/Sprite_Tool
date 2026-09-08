import opentype from 'opentype.js';

export type PixelFontGlyph = {
  /** Uno o más codepoints; se usa el primero como unicode principal. */
  char: string;
  imageData: ImageData;
  /** Ancho de avance en píxeles. Por defecto = ancho de la imagen. */
  advanceWidth?: number;
};

export type BuildPixelFontOptions = {
  familyName: string;
  styleName?: string;
  /**
   * Tamaño de diseño (unitsPerEm). Con fuentes pixel tipo Alkhemikal conviene
   * igualarlo a la altura de línea en píxeles para render nítido a ese size.
   */
  unitsPerEm?: number;
  /** Píxeles bajo la baseline (dentro del em). 0 = baseline al borde inferior. */
  descenderPx?: number;
  /** Píxeles extra sumados a cada avance. */
  letterSpacing?: number;
  /** Alfa mínimo para considerar un píxel “tinta”. */
  alphaThreshold?: number;
};

const addPixelRect = (
  path: opentype.Path,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) => {
  path.moveTo(x0, y0);
  path.lineTo(x0, y1);
  path.lineTo(x1, y1);
  path.lineTo(x1, y0);
  path.close();
};

/** Une runs horizontales de tinta en rectángulos (menos contornos que 1×1). */
export const imageDataToPixelPath = (
  imageData: ImageData,
  scale: number,
  alphaThreshold: number,
): opentype.Path => {
  const { width: w, height: h, data } = imageData;
  const path = new opentype.Path();
  const solid = (x: number, y: number) => data[(y * w + x) * 4 + 3] >= alphaThreshold;

  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      while (x < w && !solid(x, y)) x++;
      if (x >= w) break;
      const x0 = x;
      while (x < w && solid(x, y)) x++;
      // Imagen Y-down → TTF Y-up; baseline se aplica fuera con offset.
      const px0 = x0 * scale;
      const px1 = x * scale;
      const pyBottom = (h - y - 1) * scale;
      const pyTop = (h - y) * scale;
      addPixelRect(path, px0, pyBottom, px1, pyTop);
    }
  }
  return path;
};

const glyphNameFor = (ch: string): string => {
  if (ch === ' ') return 'space';
  if (ch === '.') return 'period';
  if (ch === ',') return 'comma';
  if (ch === '-') return 'hyphen';
  if (ch === '_') return 'underscore';
  const cp = ch.codePointAt(0) ?? 0;
  if (ch.length === 1 && /[A-Za-z0-9]/.test(ch)) return ch;
  return `uni${cp.toString(16).toUpperCase().padStart(4, '0')}`;
};

/**
 * Arma un TTF TrueType a partir de glifos bitmap (estilo fuentes pixel empaquetadas).
 * Coordenadas: 1 unidad = 1 píxel cuando unitsPerEm coincide con la altura de diseño.
 */
export const buildPixelFontTtf = (
  glyphs: PixelFontGlyph[],
  options: BuildPixelFontOptions,
): ArrayBuffer => {
  const familyName = (options.familyName || 'JOA Pixel').trim() || 'JOA Pixel';
  const styleName = (options.styleName || 'Regular').trim() || 'Regular';
  const alphaThreshold = options.alphaThreshold ?? 16;
  const letterSpacing = Math.max(0, Math.round(options.letterSpacing ?? 0));
  const descenderPx = Math.max(0, Math.round(options.descenderPx ?? 0));

  const heights = glyphs.map((g) => g.imageData.height);
  const maxH = heights.length ? Math.max(...heights) : 16;
  const unitsPerEm = Math.max(1, Math.round(options.unitsPerEm ?? maxH));
  const scale = unitsPerEm / Math.max(1, maxH);
  const ascender = Math.max(1, Math.round(unitsPerEm - descenderPx * scale));
  const descender = -Math.round(descenderPx * scale);

  const notdef = new opentype.Glyph({
    name: '.notdef',
    unicode: 0,
    advanceWidth: Math.round(unitsPerEm * 0.5),
    path: new opentype.Path(),
  });

  const built: opentype.Glyph[] = [notdef];
  const seen = new Set<number>();

  for (const g of glyphs) {
    const ch = [...(g.char || '')][0];
    if (!ch) continue;
    const unicode = ch.codePointAt(0);
    if (unicode === undefined || unicode <= 0) continue;
    if (seen.has(unicode)) continue;
    seen.add(unicode);

    const advancePx = g.advanceWidth ?? g.imageData.width;
    const advanceWidth = Math.max(1, Math.round(advancePx * scale) + Math.round(letterSpacing * scale));

    // Borde inferior de la imagen = baseline (o descender si descenderPx > 0).
    const path = imageDataToPixelPath(g.imageData, scale, alphaThreshold);
    if (descender !== 0) {
      for (const cmd of path.commands) {
        if ('y' in cmd && typeof cmd.y === 'number') cmd.y += descender;
        if ('y1' in cmd && typeof (cmd as { y1?: number }).y1 === 'number') {
          (cmd as { y1: number }).y1 += descender;
        }
        if ('y2' in cmd && typeof (cmd as { y2?: number }).y2 === 'number') {
          (cmd as { y2: number }).y2 += descender;
        }
      }
    }

    built.push(
      new opentype.Glyph({
        name: glyphNameFor(ch),
        unicode,
        advanceWidth,
        path,
      }),
    );
  }

  if (built.length < 2) {
    throw new Error('Necesitás al menos un glifo con carácter asignado.');
  }

  const font = new opentype.Font({
    familyName,
    styleName,
    unitsPerEm,
    ascender,
    descender,
    glyphs: built,
  });

  return font.toArrayBuffer();
};

export const imageElementToImageData = (img: HTMLImageElement): ImageData => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, img.naturalWidth || img.width);
  canvas.height = Math.max(1, img.naturalHeight || img.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
};
