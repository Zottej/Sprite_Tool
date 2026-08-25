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

/** Ruido determinista: la misma celda recibe siempre la misma variación. */
const cellNoise = (ix: number, iy: number, salt: number): number => {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

/**
 * "Píxeles sucios": ensucia el color con una variación fija por celda, sobre todo de
 * luminancia y con un poco de tinte, como el grano que tienen los sprites pintados a mano.
 * La distribución es triangular: casi siempre desvíos chicos, de vez en cuando uno marcado.
 */
export const dirtyHexColor = (hex: string, amountPct: number, ix: number, iy: number): string => {
  const t = Math.max(0, Math.min(1, amountPct / 100));
  if (t <= 0) return hex;
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const tri = (salt: number) => cellNoise(ix, iy, salt) + cellNoise(ix, iy, salt + 97) - 1;
  const lum = tri(1) * 34 * t;
  const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return rgbToHex(
    clamp255(rgb.r + lum + tri(2) * 14 * t),
    clamp255(rgb.g + lum + tri(3) * 14 * t),
    clamp255(rgb.b + lum + tri(4) * 14 * t),
  );
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

type Lab = { L: number; a: number; b: number };
type Rgb = { r: number; g: number; b: number };

const srgbToLinear = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

const linearToSrgb = (c: number) => {
  const x = Math.max(0, Math.min(1, c));
  const s = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(255, s * 255)));
};

export const rgbToLab = (r: number, g: number, b: number): Lab => {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = (R * 0.2126729 + G * 0.7151522 + B * 0.072175);
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
};

export const labToRgb = (L: number, a: number, b: number): Rgb => {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const finv = (t: number) => {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  const x = finv(fx) * 0.95047;
  const y = finv(fy);
  const z = finv(fz) * 1.08883;
  const R = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const G = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const B = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  return { r: linearToSrgb(R), g: linearToSrgb(G), b: linearToSrgb(B) };
};

/** Ojo: `rgb` y `lab` van anidados a propósito; ambos tienen una clave `b`. */
type PaletteLab = { hex: string; rgb: Rgb; lab: Lab; count: number };

const LUT_BINS = 256;

type ChannelRange = { min: number; max: number };

const LAB_RANGES: Record<'L' | 'a' | 'b', ChannelRange> = {
  L: { min: 0, max: 100 },
  a: { min: -110, max: 110 },
  b: { min: -110, max: 110 },
};

const binOf = (value: number, range: ChannelRange) => {
  const t = (value - range.min) / (range.max - range.min);
  return Math.max(0, Math.min(LUT_BINS - 1, Math.round(t * (LUT_BINS - 1))));
};

const valueOfBin = (bin: number, range: ChannelRange) =>
  range.min + (bin / (LUT_BINS - 1)) * (range.max - range.min);

const cdfFromHistogram = (hist: Float64Array) => {
  const cdf = new Float64Array(LUT_BINS);
  let acc = 0;
  for (let i = 0; i < LUT_BINS; i++) {
    acc += hist[i];
    cdf[i] = acc;
  }
  const total = acc || 1;
  for (let i = 0; i < LUT_BINS; i++) cdf[i] /= total;
  return cdf;
};

type LabHistograms = { L: Float64Array; a: Float64Array; b: Float64Array; count: number };

const labHistograms = (data: Uint8ClampedArray): LabHistograms => {
  const L = new Float64Array(LUT_BINS);
  const a = new Float64Array(LUT_BINS);
  const b = new Float64Array(LUT_BINS);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
    L[binOf(lab.L, LAB_RANGES.L)] += 1;
    a[binOf(lab.a, LAB_RANGES.a)] += 1;
    b[binOf(lab.b, LAB_RANGES.b)] += 1;
    count += 1;
  }
  return { L, a, b, count };
};

/**
 * LUT de igualación de histogramas: para cada bin del origen busca el bin de la
 * referencia con el mismo percentil. Es estable aunque las distribuciones tengan
 * formas muy distintas (a diferencia de normalizar por media/desvío, que dispara
 * la saturación cuando los desvíos difieren mucho).
 */
const matchHistogramLut = (src: Float64Array, ref: Float64Array, range: ChannelRange) => {
  const srcCdf = cdfFromHistogram(src);
  const refCdf = cdfFromHistogram(ref);
  const lut = new Float64Array(LUT_BINS);
  let refBin = 0;
  for (let i = 0; i < LUT_BINS; i++) {
    while (refBin < LUT_BINS - 1 && refCdf[refBin] < srcCdf[i]) refBin += 1;
    lut[i] = valueOfBin(refBin, range);
  }
  return lut;
};

/** Paleta con cobertura de luminancias (luces/medios/sombras), no solo los más frecuentes. */
export const extractTonePaletteFromImageData = (
  data: Uint8ClampedArray,
  maxColors = 96,
): PaletteLab[] => {
  const counts = new Map<string, { rgb: Rgb; count: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const hex = rgbToHex(data[i], data[i + 1], data[i + 2]);
    const prev = counts.get(hex);
    if (prev) prev.count += 1;
    else counts.set(hex, { rgb: { r: data[i], g: data[i + 1], b: data[i + 2] }, count: 1 });
  }
  const all: PaletteLab[] = [...counts.entries()].map(([hex, v]) => ({
    hex,
    rgb: v.rgb,
    lab: rgbToLab(v.rgb.r, v.rgb.g, v.rgb.b),
    count: v.count,
  }));
  if (all.length === 0) return [];

  const bins = 20;
  const perBin = Math.max(2, Math.ceil(maxColors / bins));
  const picked = new Map<string, PaletteLab>();
  for (let bi = 0; bi < bins; bi++) {
    const lo = (bi / bins) * 100;
    const hi = ((bi + 1) / bins) * 100;
    const inBin = all
      .filter((c) => c.lab.L >= lo && c.lab.L < hi + (bi === bins - 1 ? 1e-6 : 0))
      .sort((a, b) => b.count - a.count)
      .slice(0, perBin);
    for (const c of inBin) picked.set(c.hex, c);
  }
  // Completar con los más frecuentes globales si faltan.
  if (picked.size < maxColors) {
    for (const c of [...all].sort((a, b) => b.count - a.count)) {
      if (picked.size >= maxColors) break;
      picked.set(c.hex, c);
    }
  }
  return [...picked.values()].sort((a, b) => a.lab.L - b.lab.L);
};

/** ΔE en Lab con L apenas priorizada: mantiene el modelado sin arrastrar el matiz. */
const matchPaletteByTone = (lab: Lab, palette: PaletteLab[]): PaletteLab => {
  let best = palette[0];
  let bestScore = Infinity;
  for (const p of palette) {
    const dL = lab.L - p.lab.L;
    const da = lab.a - p.lab.a;
    const db = lab.b - p.lab.b;
    const score = 1.6 * dL * dL + da * da + db * db;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
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

export const nearestPaletteRgb = (
  r: number,
  g: number,
  b: number,
  palette: { r: number; g: number; b: number }[],
): { r: number; g: number; b: number } => {
  if (palette.length === 0) return { r, g, b };
  let best = palette[0];
  let bestD = Infinity;
  const sample = { r, g, b };
  for (const p of palette) {
    const d = colorDist2(sample, p);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
};

/** Remapea píxeles opacos a la paleta. intensityPct 0 = original, 100 = snap total. */
export const rematchImageDataToPalette = (
  imageData: ImageData,
  paletteHex: string[],
  intensityPct: number,
): ImageData => {
  const t = Math.max(0, Math.min(1, intensityPct / 100));
  if (t <= 0 || paletteHex.length === 0) return imageData;
  const palette = paletteHex
    .map((hex) => {
      const rgb = hexToRgb(hex);
      if (!rgb) return null;
      return { hex, rgb, lab: rgbToLab(rgb.r, rgb.g, rgb.b), count: 1 };
    })
    .filter((p): p is PaletteLab => !!p);
  if (palette.length === 0) return imageData;
  const out = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  const data = out.data;
  const lut = new Map<string, Rgb>();
  const full = t >= 0.999;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    let nr = lut.get(key);
    if (!nr) {
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      nr = matchPaletteByTone(lab, palette).rgb;
      lut.set(key, nr);
    }
    if (full) {
      data[i] = nr.r;
      data[i + 1] = nr.g;
      data[i + 2] = nr.b;
    } else {
      data[i] = Math.round(data[i] + (nr.r - data[i]) * t);
      data[i + 1] = Math.round(data[i + 1] + (nr.g - data[i + 1]) * t);
      data[i + 2] = Math.round(data[i + 2] + (nr.b - data[i + 2]) * t);
    }
  }
  return out;
};

/**
 * Transferencia de tonalidad hacia la referencia:
 * 1) Iguala los histogramas de L/a/b (percentil a percentil) → misma distribución
 *    de luces, sombras y temperatura que la referencia, sin disparar la saturación.
 * 2) Ajusta el resultado al color más parecido de la paleta de la referencia,
 *    para no inventar colores fuera de ella.
 */
export const transferImageColorsToReferenceData = (
  targetData: ImageData,
  referenceData: ImageData,
  intensityPct: number,
): ImageData => {
  const t = Math.max(0, Math.min(1, intensityPct / 100));
  if (t <= 0) return targetData;

  const palette = extractTonePaletteFromImageData(referenceData.data, 160);
  if (palette.length === 0) return targetData;

  const srcHist = labHistograms(targetData.data);
  const refHist = labHistograms(referenceData.data);
  const canMatch = srcHist.count >= 16 && refHist.count >= 16;
  const lutL = canMatch ? matchHistogramLut(srcHist.L, refHist.L, LAB_RANGES.L) : null;
  const lutA = canMatch ? matchHistogramLut(srcHist.a, refHist.a, LAB_RANGES.a) : null;
  const lutB = canMatch ? matchHistogramLut(srcHist.b, refHist.b, LAB_RANGES.b) : null;

  const out = new ImageData(
    new Uint8ClampedArray(targetData.data),
    targetData.width,
    targetData.height,
  );
  const data = out.data;
  const cache = new Map<string, Rgb>();

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    let mapped = cache.get(key);
    if (!mapped) {
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      const matched: Lab = lutL && lutA && lutB
        ? {
            L: lutL[binOf(lab.L, LAB_RANGES.L)],
            a: lutA[binOf(lab.a, LAB_RANGES.a)],
            b: lutB[binOf(lab.b, LAB_RANGES.b)],
          }
        : lab;
      mapped = matchPaletteByTone(matched, palette).rgb;
      cache.set(key, mapped);
    }
    if (t >= 0.999) {
      data[i] = mapped.r;
      data[i + 1] = mapped.g;
      data[i + 2] = mapped.b;
    } else {
      data[i] = Math.round(data[i] + (mapped.r - data[i]) * t);
      data[i + 1] = Math.round(data[i + 1] + (mapped.g - data[i + 1]) * t);
      data[i + 2] = Math.round(data[i + 2] + (mapped.b - data[i + 2]) * t);
    }
  }
  return out;
};

const canvasFromImage = (img: HTMLImageElement) => {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  return { canvas, ctx };
};

const imageFromCanvas = (canvas: HTMLCanvasElement): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const out = new Image();
    out.onload = () => resolve(out);
    out.onerror = reject;
    out.src = canvas.toDataURL('image/png');
  });

export const rematchImageToPalette = async (
  img: HTMLImageElement,
  paletteHex: string[],
  intensityPct: number,
): Promise<HTMLImageElement> => {
  const { canvas, ctx } = canvasFromImage(img);
  const matched = rematchImageDataToPalette(
    ctx.getImageData(0, 0, canvas.width, canvas.height),
    paletteHex,
    intensityPct,
  );
  ctx.putImageData(matched, 0, 0);
  return imageFromCanvas(canvas);
};

/** Iguala tonalidad/paleta del destino a la del sprite referencia (piel, pelo, etc.). */
export const transferImageColorsToReference = async (
  targetImg: HTMLImageElement,
  referenceImg: HTMLImageElement,
  intensityPct: number,
): Promise<HTMLImageElement> => {
  const target = canvasFromImage(targetImg);
  const reference = canvasFromImage(referenceImg);
  const transferred = transferImageColorsToReferenceData(
    target.ctx.getImageData(0, 0, target.canvas.width, target.canvas.height),
    reference.ctx.getImageData(0, 0, reference.canvas.width, reference.canvas.height),
    intensityPct,
  );
  target.ctx.putImageData(transferred, 0, 0);
  return imageFromCanvas(target.canvas);
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

export type DetectedPixelGrid = {
  /** Ancho/alto de celda; pueden ser fraccionarios (imágenes reescaladas o generadas por IA). */
  cellW: number;
  cellH: number;
  /** Coordenada del borde izquierdo/superior de una celda (el resto sale sumando celdas). */
  offsetX: number;
  offsetY: number;
  score: number;
};

/** Fuerza del borde entre dos píxeles vecinos; el borde de la silueta también cuenta. */
const edgeStrength = (data: Uint8ClampedArray, ia: number, ib: number) => {
  const aa = data[ia + 3];
  const ab = data[ib + 3];
  if (aa < 8 && ab < 8) return 0;
  if (aa < 8 || ab < 8) return 48;
  return (
    Math.abs(data[ia] - data[ib]) +
    Math.abs(data[ia + 1] - data[ib + 1]) +
    Math.abs(data[ia + 2] - data[ib + 2])
  );
};

type CombFit = { size: number; phase: number; score: number };

/** Tolerancia de ±1.5 px alrededor de cada línea: absorbe bordes borrosos y fases fraccionarias. */
const COMB_REACH = 1.5;

type CombScorer = {
  /**
   * Fracción de la energía de bordes que capta el peine, menos la que captaría si la
   * energía estuviera repartida al azar. Un múltiplo del período pierde la mitad de la
   * energía; un divisor la capta toda, pero pagando el doble de líneas.
   */
  score: (size: number, phase: number) => number;
  /** Mejor fase para un tamaño dado, y su puntaje. */
  bestPhase: (size: number, step?: number) => CombFit;
};

const combScorer = (prof: Float64Array): CombScorer | null => {
  const n = prof.length;
  let total = 0;
  for (let i = 0; i < n; i++) total += prof[i];
  if (n < 8 || total <= 0) return null;

  const score = (size: number, phase: number): number => {
    let marks = 0;
    let wSum = 0;
    let wProf = 0;
    for (let p = phase; p < n - 0.5; p += size) {
      const c = Math.round(p);
      if (c < 1 || c >= n) continue;
      for (let k = c - 1; k <= c + 1; k++) {
        if (k < 1 || k >= n) continue;
        const weight = 1 - Math.abs(k - p) / COMB_REACH;
        if (weight <= 0) continue;
        wSum += weight;
        wProf += weight * prof[k];
      }
      marks += 1;
    }
    if (marks < 4 || wSum >= n * 0.9) return -Infinity;
    return wProf / total - wSum / n;
  };

  const bestPhase = (size: number, step = 0.5): CombFit => {
    const s = Math.max(0.02, Math.min(step, size / 4));
    let best: CombFit = { size, phase: 0, score: -Infinity };
    for (let phase = 0; phase < size - 1e-9; phase += s) {
      const value = score(size, phase);
      if (value > best.score) best = { size, phase, score: value };
    }
    return best;
  };

  return { score, bestPhase };
};

/** Afina la fase alrededor de una estimación, con pasos cada vez más finos. */
const refinePhase = (scorer: CombScorer, size: number, phase: number): CombFit => {
  let best: CombFit = { size, phase, score: scorer.score(size, phase) };
  for (const step of [0.1, 0.02]) {
    for (let p = best.phase - step * 6; p <= best.phase + step * 6; p += step) {
      const value = scorer.score(size, p);
      if (value > best.score) best = { size, phase: p, score: value };
    }
  }
  return { ...best, phase: ((best.phase % size) + size) % size };
};

/**
 * Busca el período del perfil: barrido grueso, elección del período más chico entre los
 * casi empatados (los grandes suelen ser múltiplos) y afinado alrededor del elegido.
 */
const bestCombFit = (scorer: CombScorer, minSize: number, maxSize: number): CombFit | null => {
  if (maxSize < minSize) return null;
  const coarse: CombFit[] = [];
  for (let size = minSize; size <= maxSize + 1e-9; size += 0.05) {
    coarse.push(scorer.bestPhase(size));
  }
  if (coarse.length === 0) return null;
  const top = coarse.reduce((a, b) => (b.score > a.score ? b : a));
  if (top.score <= 0) return null;
  const chosen = coarse.find((f) => f.score >= top.score * 0.97) ?? top;

  let best = chosen;
  for (let size = Math.max(minSize, chosen.size - 0.1); size <= chosen.size + 0.1; size += 0.005) {
    const fit = scorer.bestPhase(size, 0.05);
    if (fit.score > best.score) best = fit;
  }
  return refinePhase(scorer, best.size, best.phase);
};

type EdgeProfiles = { profX: Float64Array; profY: Float64Array; x0: number; y0: number };

/** Perfiles de "cuánto cambia el color" por columna y por fila, dentro del recorte opaco. */
const edgeProfiles = (image: ImageData): EdgeProfiles | null => {
  const { width: w, height: h, data } = image;
  if (w < 8 || h < 8) return null;

  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0 || y1 < y0) return null;

  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw < 8 || bh < 8) return null;

  const profX = new Float64Array(bw);
  for (let xi = 1; xi < bw; xi++) {
    const x = x0 + xi;
    let sum = 0;
    for (let y = y0; y <= y1; y++) sum += edgeStrength(data, (y * w + x) * 4, (y * w + x - 1) * 4);
    profX[xi] = sum;
  }
  const profY = new Float64Array(bh);
  for (let yi = 1; yi < bh; yi++) {
    const y = y0 + yi;
    let sum = 0;
    for (let x = x0; x <= x1; x++) sum += edgeStrength(data, (y * w + x) * 4, ((y - 1) * w + x) * 4);
    profY[yi] = sum;
  }
  return { profX, profY, x0, y0 };
};

/** Realinea una grilla de tamaño dado (el usuario corrigió la medida a mano). */
export const alignPixelGrid = (
  image: ImageData,
  cellW: number,
  cellH: number,
): { offsetX: number; offsetY: number } | null => {
  const profiles = edgeProfiles(image);
  if (!profiles) return null;
  const sx = combScorer(profiles.profX);
  const sy = combScorer(profiles.profY);
  if (!sx || !sy) return null;
  return {
    offsetX: profiles.x0 + refinePhase(sx, cellW, sx.bestPhase(cellW, 0.05).phase).phase,
    offsetY: profiles.y0 + refinePhase(sy, cellH, sy.bestPhase(cellH, 0.05).phase).phase,
  };
};

/**
 * Deduce la grilla real del dibujo midiendo dónde caen los saltos de color.
 * Sirve para pixel art reescalado o generado por IA, donde los bloques no arrancan
 * en 0 ni miden un número entero de píxeles.
 */
export const detectPixelGrid = (image: ImageData, maxCell = 64): DetectedPixelGrid | null => {
  const profiles = edgeProfiles(image);
  if (!profiles) return null;
  const { profX, profY, x0, y0 } = profiles;

  const scorerX = combScorer(profX);
  const scorerY = combScorer(profY);
  if (!scorerX || !scorerY) return null;

  const maxX = Math.min(maxCell, Math.floor(profX.length / 4));
  const maxY = Math.min(maxCell, Math.floor(profY.length / 4));
  let fitX = bestCombFit(scorerX, 2, maxX);
  let fitY = bestCombFit(scorerY, 2, maxY);
  if (!fitX || !fitY) return null;

  /**
   * El pixel art es cuadrado. Si los dos ejes midieron parecido, buscamos un único tamaño
   * que maximice la evidencia combinada en vez de promediar: promediar dos medidas que
   * difieren un 3% deja la grilla corriéndose de a poco a lo largo de la imagen.
   */
  const spread = Math.abs(fitX.size - fitY.size) / Math.max(fitX.size, fitY.size);
  let cell: number;
  if (spread < 0.1) {
    // Ambos ejes coinciden: buscamos el tamaño que maximiza la evidencia combinada. Promediar
    // dos medidas que difieren un 3% deja la grilla corriéndose de a poco a lo largo del dibujo.
    const lo = Math.max(2, Math.min(fitX.size, fitY.size) - 0.2);
    const hi = Math.min(maxX, maxY, Math.max(fitX.size, fitY.size) + 0.2);
    cell = fitX.size;
    let bestScore = -Infinity;
    for (let size = lo; size <= hi + 1e-9; size += 0.005) {
      const joint = scorerX.bestPhase(size, 0.05).score + scorerY.bestPhase(size, 0.05).score;
      if (joint > bestScore) {
        bestScore = joint;
        cell = size;
      }
    }
  } else {
    // Discrepan: un eje con pocos bordes (mucho relleno plano) mide cualquier cosa,
    // así que mandamos el eje con más evidencia.
    cell = fitX.score >= fitY.score ? fitX.size : fitY.size;
  }
  fitX = refinePhase(scorerX, cell, scorerX.bestPhase(cell, 0.05).phase);
  fitY = refinePhase(scorerY, cell, scorerY.bestPhase(cell, 0.05).phase);

  return {
    cellW: fitX.size,
    cellH: fitY.size,
    offsetX: x0 + fitX.phase,
    offsetY: y0 + fitY.phase,
    score: Math.min(fitX.score, fitY.score),
  };
};

export const extractPaletteFromImage = (
  img: HTMLImageElement,
  maxColors = 64,
): string[] => {
  const { canvas, ctx } = canvasFromImage(img);
  if (canvas.width < 1 || canvas.height < 1) return [];
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return extractPaletteFromImageData(data, maxColors);
};
