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
 * Mapa color→color a full: iguala los histogramas de L/a/b (percentil a percentil) para
 * copiar la distribución de luces, sombras y temperatura de la referencia sin disparar la
 * saturación, y después ajusta cada color al más parecido de la paleta de la referencia.
 */
const referenceColorMapper = (
  targetData: ImageData,
  referenceData: ImageData,
  palette: PaletteLab[],
): ((r: number, g: number, b: number) => Rgb) => {
  const srcHist = labHistograms(targetData.data);
  const refHist = labHistograms(referenceData.data);
  const canMatch = srcHist.count >= 16 && refHist.count >= 16;
  const lutL = canMatch ? matchHistogramLut(srcHist.L, refHist.L, LAB_RANGES.L) : null;
  const lutA = canMatch ? matchHistogramLut(srcHist.a, refHist.a, LAB_RANGES.a) : null;
  const lutB = canMatch ? matchHistogramLut(srcHist.b, refHist.b, LAB_RANGES.b) : null;
  const cache = new Map<string, Rgb>();

  return (r, g, b) => {
    const key = `${r},${g},${b}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const lab = rgbToLab(r, g, b);
    const matched: Lab = lutL && lutA && lutB
      ? {
          L: lutL[binOf(lab.L, LAB_RANGES.L)],
          a: lutA[binOf(lab.a, LAB_RANGES.a)],
          b: lutB[binOf(lab.b, LAB_RANGES.b)],
        }
      : lab;
    const mapped = matchPaletteByTone(matched, palette).rgb;
    cache.set(key, mapped);
    return mapped;
  };
};

/** Reparto de celdas de arte sobre el lienzo, con todos los índices en positivo. */
type CellLayout = {
  cellW: number;
  cellH: number;
  originX: number;
  originY: number;
  cols: number;
  rows: number;
};

const cellLayoutOf = (width: number, height: number, grid: DetectedPixelGrid): CellLayout => {
  const originX = grid.offsetX - Math.ceil(grid.offsetX / grid.cellW) * grid.cellW;
  const originY = grid.offsetY - Math.ceil(grid.offsetY / grid.cellH) * grid.cellH;
  return {
    cellW: grid.cellW,
    cellH: grid.cellH,
    originX,
    originY,
    cols: Math.max(1, Math.ceil((width - originX) / grid.cellW)),
    rows: Math.max(1, Math.ceil((height - originY) / grid.cellH)),
  };
};

/**
 * Diferencia media entre cada línea y la anterior. Los picos marcan dónde cambia el color,
 * o sea dónde caen los bordes entre píxeles de arte.
 */
const lineDeltas = (image: ImageData, axis: 'x' | 'y'): Float64Array => {
  const { data, width, height } = image;
  const n = axis === 'x' ? width : height;
  const across = axis === 'x' ? height : width;
  const deltas = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < across; j++) {
      const a = axis === 'x' ? (j * width + i) * 4 : (i * width + j) * 4;
      const b = axis === 'x' ? (j * width + i - 1) * 4 : ((i - 1) * width + j) * 4;
      if (data[a + 3] < 8 || data[b + 3] < 8) continue;
      sum +=
        (Math.abs(data[a] - data[b]) +
          Math.abs(data[a + 1] - data[b + 1]) +
          Math.abs(data[a + 2] - data[b + 2])) /
        3;
      count += 1;
    }
    deltas[i] = count > 0 ? sum / count : 0;
  }
  return deltas;
};

/**
 * El detector de grilla tolera hasta un píxel y medio de holgura en la fase, que para pintar
 * alcanza pero acá no: con celdas fraccionarias, medio píxel de corrimiento mete una línea
 * del píxel de arte vecino dentro de la celda y ensucia su color base. Se prueba la fase
 * fina que deje los saltos de color justo sobre los bordes de celda.
 */
const refineCellPhase = (deltas: Float64Array, size: number, offset: number): number => {
  const n = deltas.length;
  if (n < 4 || size < 2) return offset;
  let bestPhase = offset;
  let bestScore = -Infinity;
  for (let step = 0; step < 40; step++) {
    const phase = (step / 40) * size;
    let edgeSum = 0;
    let edgeCount = 0;
    let innerSum = 0;
    let innerCount = 0;
    for (let i = 1; i < n; i++) {
      const isEdge =
        Math.floor((i - phase) / size) > Math.floor((i - 1 - phase) / size);
      if (isEdge) {
        edgeSum += deltas[i];
        edgeCount += 1;
      } else {
        innerSum += deltas[i];
        innerCount += 1;
      }
    }
    if (edgeCount === 0 || innerCount === 0) continue;
    const score = edgeSum / edgeCount - innerSum / innerCount;
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  return bestPhase;
};

const alignedGrid = (image: ImageData, grid: DetectedPixelGrid): DetectedPixelGrid => ({
  ...grid,
  offsetX: refineCellPhase(lineDeltas(image, 'x'), grid.cellW, grid.offsetX),
  offsetY: refineCellPhase(lineDeltas(image, 'y'), grid.cellH, grid.offsetY),
});

const cellIndexAt = (layout: CellLayout, x: number, y: number): number => {
  const ix = Math.floor((x - layout.originX) / layout.cellW);
  const iy = Math.floor((y - layout.originY) / layout.cellH);
  if (ix < 0 || iy < 0 || ix >= layout.cols || iy >= layout.rows) return -1;
  return iy * layout.cols + ix;
};

/**
 * Color base de cada celda de arte y cuánta "suciedad" tiene dentro (desviación media
 * respecto de ese color base). Es lo que distingue un píxel de arte plano de uno granulado.
 */
type CellField = {
  layout: CellLayout;
  base: Float64Array;
  count: Uint32Array;
  /** Píxeles que abarca la celda, opacos o no. Con celdas fraccionarias no es constante. */
  total: Uint32Array;
  dirt: Float64Array;
};

const cellFieldOf = (image: ImageData, layout: CellLayout): CellField => {
  const { data, width, height } = image;
  const cells = layout.cols * layout.rows;
  const base = new Float64Array(cells * 3);
  const count = new Uint32Array(cells);
  const total = new Uint32Array(cells);
  const dirt = new Float64Array(cells);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const cell = cellIndexAt(layout, x, y);
      if (cell >= 0) total[cell] += 1;
      if (data[i + 3] < 8) continue;
      const c = cell;
      if (c < 0) continue;
      base[c * 3] += data[i];
      base[c * 3 + 1] += data[i + 1];
      base[c * 3 + 2] += data[i + 2];
      count[c] += 1;
    }
  }
  for (let c = 0; c < cells; c++) {
    if (count[c] === 0) continue;
    base[c * 3] /= count[c];
    base[c * 3 + 1] /= count[c];
    base[c * 3 + 2] /= count[c];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 8) continue;
      const c = cellIndexAt(layout, x, y);
      if (c < 0) continue;
      dirt[c] +=
        (Math.abs(data[i] - base[c * 3]) +
          Math.abs(data[i + 1] - base[c * 3 + 1]) +
          Math.abs(data[i + 2] - base[c * 3 + 2])) /
        3;
    }
  }
  for (let c = 0; c < cells; c++) if (count[c] > 0) dirt[c] /= count[c];

  return { layout, base, count, total, dirt };
};

/**
 * Todos los colores distintos, sin recortar. `extractTonePaletteFromImageData` reparte un
 * cupo por banda de luminancia, y en el mapa de celdas eso descarta colores base que sí
 * existen: la celda terminaba saltando a un tono aproximado.
 */
const everyColorOf = (data: Uint8ClampedArray, limit: number): PaletteLab[] | null => {
  const counts = new Map<string, { rgb: Rgb; count: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const hex = rgbToHex(data[i], data[i + 1], data[i + 2]);
    const prev = counts.get(hex);
    if (prev) prev.count += 1;
    else {
      if (counts.size >= limit) return null;
      counts.set(hex, { rgb: { r: data[i], g: data[i + 1], b: data[i + 2] }, count: 1 });
    }
  }
  return [...counts.entries()].map(([hex, v]) => ({
    hex,
    rgb: v.rgb,
    lab: rgbToLab(v.rgb.r, v.rgb.g, v.rgb.b),
    count: v.count,
  }));
};

/** Imagen chica donde cada píxel es una celda de arte: la paleta real, sin el grano. */
const cellImageOf = (field: CellField): ImageData => {
  const { cols, rows } = field.layout;
  const out = new ImageData(cols, rows);
  for (let c = 0; c < cols * rows; c++) {
    const o = c * 4;
    if (field.count[c] === 0) continue;
    out.data[o] = Math.round(field.base[c * 3]);
    out.data[o + 1] = Math.round(field.base[c * 3 + 1]);
    out.data[o + 2] = Math.round(field.base[c * 3 + 2]);
    out.data[o + 3] = 255;
  }
  return out;
};

/**
 * La suciedad no es pareja: en estos dibujos las sombras vienen más granuladas que las
 * luces. Por eso se guarda la distribución de suciedad separada por banda de luminancia,
 * y no un único promedio.
 */
const DIRT_BANDS = 5;
const DIRT_BAND_SPAN = 100 / DIRT_BANDS;

/**
 * Una celda a medio cubrir cae sobre el borde de la silueta: lo que parece suciedad ahí es
 * en realidad el contorno, no el grano. No sirve para medir ni conviene retocarla.
 */
const isFullCell = (field: CellField, c: number): boolean =>
  field.total[c] >= field.layout.cellW * field.layout.cellH * 0.5 &&
  field.count[c] >= field.total[c] * 0.9;

const dirtProfileOf = (field: CellField): Float64Array[] => {
  const buckets: number[][] = Array.from({ length: DIRT_BANDS }, () => []);
  const pooled: number[] = [];
  for (let c = 0; c < field.count.length; c++) {
    if (!isFullCell(field, c)) continue;
    const lab = rgbToLab(field.base[c * 3], field.base[c * 3 + 1], field.base[c * 3 + 2]);
    const bi = Math.max(0, Math.min(DIRT_BANDS - 1, Math.floor(lab.L / DIRT_BAND_SPAN)));
    buckets[bi].push(field.dirt[c]);
    pooled.push(field.dirt[c]);
  }
  pooled.sort((a, b) => a - b);
  const fallback = Float64Array.from(pooled);
  return buckets.map((b) => (b.length >= 8 ? Float64Array.from(b.sort((x, y) => x - y)) : fallback));
};

/** Bandas vecinas y mezcla entre ellas, para que no se note el salto de una banda a otra. */
const dirtBandMix = (L: number) => {
  const raw = L / DIRT_BAND_SPAN - 0.5;
  const base = Math.floor(raw);
  if (base < 0) return { lo: 0, hi: 0, t: 0 };
  if (base + 1 > DIRT_BANDS - 1) return { lo: DIRT_BANDS - 1, hi: DIRT_BANDS - 1, t: 0 };
  return { lo: base, hi: base + 1, t: raw - base };
};

const quantileAt = (sorted: Float64Array, p: number): number => {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.max(0, Math.min(1, p)) * (sorted.length - 1);
  const i0 = Math.floor(idx);
  const i1 = Math.min(sorted.length - 1, i0 + 1);
  return sorted[i0] + (sorted[i1] - sorted[i0]) * (idx - i0);
};

type DirtBandMix = { lo: number; hi: number; t: number };

/** Suciedad esperada en la posición p de la distribución mezclada entre dos bandas. */
const mixedQuantile = (bands: Float64Array[], mix: DirtBandMix, p: number): number =>
  quantileAt(bands[mix.lo], p) * (1 - mix.t) + quantileAt(bands[mix.hi], p) * mix.t;

/**
 * Posición (0..1) que ocupa un valor dentro de esa misma distribución mezclada. Se invierte
 * por bisección en vez de mezclar posiciones de cada banda por separado: mezclar posiciones
 * daría distinto según qué banda se mire, y entonces igualar una imagen consigo misma ya no
 * dejaría el grano intacto.
 */
const mixedRank = (bands: Float64Array[], mix: DirtBandMix, value: number): number => {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (mixedQuantile(bands, mix, mid) < value) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

/**
 * Transferencia de tonalidad hacia la referencia.
 *
 * Cuando el dibujo es pixel art escalado, cada píxel de arte es un bloque con su propio
 * grano. Mapear el lienzo píxel por píxel rompe ese grano: parte del bloque salta a un
 * color de la paleta y parte a otro. Por eso el tono se decide sobre el color base de cada
 * celda (promedio del bloque) y después se le vuelve a poner su grano original, con la
 * fuerza que tiene el grano de la referencia en ese mismo tono.
 */
export const transferImageColorsToReferenceData = (
  targetData: ImageData,
  referenceData: ImageData,
  intensityPct: number,
): ImageData => {
  const t = Math.max(0, Math.min(1, intensityPct / 100));
  if (t <= 0) return targetData;

  const out = new ImageData(
    new Uint8ClampedArray(targetData.data),
    targetData.width,
    targetData.height,
  );
  const data = out.data;

  const blend = (i: number, r: number, g: number, b: number) => {
    if (t >= 0.999) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      return;
    }
    data[i] = Math.round(data[i] + (r - data[i]) * t);
    data[i + 1] = Math.round(data[i + 1] + (g - data[i + 1]) * t);
    data[i + 2] = Math.round(data[i + 2] + (b - data[i + 2]) * t);
  };

  const targetGrid = detectPixelGrid(targetData);
  const referenceGrid = detectPixelGrid(referenceData);
  const blocky =
    targetGrid && referenceGrid && targetGrid.cellW >= 2.5 && targetGrid.cellH >= 2.5;

  if (blocky) {
    const targetCellGrid = alignedGrid(targetData, targetGrid);
    const refCellGrid = alignedGrid(referenceData, referenceGrid);
    const targetField = cellFieldOf(targetData, cellLayoutOf(targetData.width, targetData.height, targetCellGrid));
    const refField = cellFieldOf(referenceData, cellLayoutOf(referenceData.width, referenceData.height, refCellGrid));
    const targetCells = cellImageOf(targetField);
    const refCells = cellImageOf(refField);
    // La imagen de celdas es chica, así que entra entera como paleta.
    const cellPalette =
      everyColorOf(refCells.data, 8192) ?? extractTonePaletteFromImageData(refCells.data, 512);

    if (cellPalette.length > 0) {
      const mapCell = referenceColorMapper(targetCells, refCells, cellPalette);
      const srcDirt = dirtProfileOf(targetField);
      const refDirt = dirtProfileOf(refField);
      const layout = targetField.layout;

      /**
       * Cuánto hay que subir o bajar el grano de una celda: se busca qué tan sucia es
       * respecto de las demás celdas de su mismo tono en el original, y se le da la
       * suciedad que tiene una celda igual de sucia, del tono nuevo, en la referencia.
       * Así se conserva la distribución del grano dentro de la celda y también qué celdas
       * son las granuladas, pero el nivel pasa a ser el de la referencia.
       */
      const dirtScaleFor = (dirt: number, srcL: number, refL: number): number => {
        if (dirt < 0.35) return 1;
        const p = mixedRank(srcDirt, dirtBandMix(srcL), dirt);
        const wanted = mixedQuantile(refDirt, dirtBandMix(refL), p);
        return Math.max(0.3, Math.min(3, wanted / dirt));
      };

      const scaleCache = new Map<number, number>();
      const cellScale = (c: number, mapped: Rgb): number => {
        const hit = scaleCache.get(c);
        if (hit !== undefined) return hit;
        if (!isFullCell(targetField, c)) {
          scaleCache.set(c, 1);
          return 1;
        }
        const srcL = rgbToLab(
          targetField.base[c * 3],
          targetField.base[c * 3 + 1],
          targetField.base[c * 3 + 2],
        ).L;
        const refL = rgbToLab(mapped.r, mapped.g, mapped.b).L;
        const scale = dirtScaleFor(targetField.dirt[c], srcL, refL);
        scaleCache.set(c, scale);
        return scale;
      };
      const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

      for (let y = 0; y < targetData.height; y++) {
        for (let x = 0; x < targetData.width; x++) {
          const i = (y * targetData.width + x) * 4;
          if (data[i + 3] < 8) continue;
          const c = cellIndexAt(layout, x, y);
          if (c < 0 || targetField.count[c] === 0) continue;
          const mapped = mapCell(
            Math.round(targetField.base[c * 3]),
            Math.round(targetField.base[c * 3 + 1]),
            Math.round(targetField.base[c * 3 + 2]),
          );
          const scale = cellScale(c, mapped);
          // El color base ya es de la paleta de la referencia; el grano va libre encima,
          // igual que en la referencia. Engancharlo también a la paleta lo deformaba.
          blend(
            i,
            clamp255(mapped.r + (data[i] - targetField.base[c * 3]) * scale),
            clamp255(mapped.g + (data[i + 1] - targetField.base[c * 3 + 1]) * scale),
            clamp255(mapped.b + (data[i + 2] - targetField.base[c * 3 + 2]) * scale),
          );
        }
      }
      return out;
    }
  }

  const palette = extractTonePaletteFromImageData(referenceData.data, 160);
  if (palette.length === 0) return out;

  const mapPixel = referenceColorMapper(targetData, referenceData, palette);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const mapped = mapPixel(data[i], data[i + 1], data[i + 2]);
    blend(i, mapped.r, mapped.g, mapped.b);
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
