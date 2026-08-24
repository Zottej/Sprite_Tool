/** Patrones de dither por celda (o por píxel si Grilla está apagada). Off = sólido. */

export type DitherPattern =
  | 'off'
  | 'checker50'
  | 'bayer25'
  | 'bayer75'
  | 'hstripes'
  | 'vstripes'
  | 'bayer4';

export type DitherPick = 'a' | 'b';

const BAYER2 = [
  [0, 2],
  [3, 1],
];

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const wrap = (n: number, m: number) => ((n % m) + m) % m;

export const DITHER_OPTIONS: { id: DitherPattern; label: string; title: string }[] = [
  { id: 'off', label: 'Off', title: 'Pincel sólido (sin dither)' },
  { id: 'checker50', label: '50%', title: 'Damero 50/50' },
  { id: 'bayer25', label: '25%', title: 'Bayer 2×2 al 25%' },
  { id: 'bayer75', label: '75%', title: 'Bayer 2×2 al 75%' },
  { id: 'hstripes', label: 'H', title: 'Rayas horizontales' },
  { id: 'vstripes', label: 'V', title: 'Rayas verticales' },
  { id: 'bayer4', label: '4×4', title: 'Bayer 4×4 al 50%' },
];

export const ditherPick = (ix: number, iy: number, pattern: DitherPattern): DitherPick => {
  switch (pattern) {
    case 'off':
      return 'a';
    case 'checker50':
      return ((ix + iy) & 1) === 0 ? 'a' : 'b';
    case 'hstripes':
      return (iy & 1) === 0 ? 'a' : 'b';
    case 'vstripes':
      return (ix & 1) === 0 ? 'a' : 'b';
    case 'bayer25':
      return BAYER2[wrap(iy, 2)][wrap(ix, 2)] === 0 ? 'a' : 'b';
    case 'bayer75':
      return BAYER2[wrap(iy, 2)][wrap(ix, 2)] < 3 ? 'a' : 'b';
    case 'bayer4':
      return BAYER4[wrap(iy, 4)][wrap(ix, 4)] < 8 ? 'a' : 'b';
    default:
      return 'a';
  }
};

export const hexToRgbaCss = (hex: string, opacityPct: number): string => {
  const h = hex.trim().toLowerCase();
  const m = h.match(/^#([0-9a-f]{6})$/);
  const r = m ? parseInt(m[1].slice(0, 2), 16) : 255;
  const g = m ? parseInt(m[1].slice(2, 4), 16) : 0;
  const b = m ? parseInt(m[1].slice(4, 6), 16) : 0;
  const a = Math.max(0, Math.min(1, opacityPct / 100));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

/** Radio de blur (px) a partir de intensidad 0–100 y tamaño de pincel. */
export const brushBlurRadius = (softPct: number, brushSize: number): number => {
  const soft = Math.max(0, Math.min(100, softPct)) / 100;
  if (soft <= 0) return 0;
  return Math.max(1, Math.round(soft * Math.max(1, brushSize) * 0.65));
};

/** Box blur separable sobre ImageData (pérdida de definición pareja en toda la zona). */
export const boxBlurImageData = (imageData: ImageData, radius: number): ImageData => {
  const r = Math.max(0, Math.round(radius));
  if (r <= 0) return imageData;
  const { width: w, height: h } = imageData;
  const src = imageData.data;
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  const pass = (from: Uint8ClampedArray, to: Uint8ClampedArray, horizontal: boolean) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sa = 0;
        let n = 0;
        if (horizontal) {
          const x0 = Math.max(0, x - r);
          const x1 = Math.min(w - 1, x + r);
          for (let xi = x0; xi <= x1; xi++) {
            const i = (y * w + xi) * 4;
            const a = from[i + 3];
            sr += from[i] * a;
            sg += from[i + 1] * a;
            sb += from[i + 2] * a;
            sa += a;
            n += 1;
          }
        } else {
          const y0 = Math.max(0, y - r);
          const y1 = Math.min(h - 1, y + r);
          for (let yi = y0; yi <= y1; yi++) {
            const i = (yi * w + x) * 4;
            const a = from[i + 3];
            sr += from[i] * a;
            sg += from[i + 1] * a;
            sb += from[i + 2] * a;
            sa += a;
            n += 1;
          }
        }
        const o = (y * w + x) * 4;
        if (sa <= 0) {
          to[o] = 0;
          to[o + 1] = 0;
          to[o + 2] = 0;
          to[o + 3] = 0;
        } else {
          to[o] = Math.round(sr / sa);
          to[o + 1] = Math.round(sg / sa);
          to[o + 2] = Math.round(sb / sa);
          to[o + 3] = Math.round(sa / n);
        }
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, out, false);
  return new ImageData(out, w, h);
};

export const parseDitherPattern = (value: unknown): DitherPattern =>
  DITHER_OPTIONS.some((o) => o.id === value) ? (value as DitherPattern) : 'off';

export const rgbToHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

export const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const m = hex.trim().toLowerCase().match(/^#([0-9a-f]{6})$/);
  if (!m) return null;
  return {
    r: parseInt(m[1].slice(0, 2), 16),
    g: parseInt(m[1].slice(2, 4), 16),
    b: parseInt(m[1].slice(4, 6), 16),
  };
};

const colorDist2 = (
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
) => {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
};

export const nearestPaletteHex = (hex: string, palette: string[]): string => {
  if (palette.length === 0) return hex;
  const rgb = hexToRgb(hex);
  if (!rgb) return palette[0];
  let best = palette[0];
  let bestD = Infinity;
  for (const p of palette) {
    const pr = hexToRgb(p);
    if (!pr) continue;
    const d = colorDist2(rgb, pr);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
};

/** Colores opacos únicos, los más frecuentes primero. */
export const extractPaletteFromImageData = (
  data: Uint8ClampedArray,
  maxColors = 64,
): string[] => {
  const counts = new Map<string, number>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const hex = rgbToHex(data[i], data[i + 1], data[i + 2]);
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxColors)
    .map(([hex]) => hex);
};
