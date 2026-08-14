import {
  compressTextureToBytes,
  TextureFormat,
  type EncodedLevelBytes,
} from 'gputex';

/** Fórmula exacta del juego (0.30 / 0.35 en 0–1 → 76.5 / 89.25 en 0–255). */
export const applyLoveGreenChromaKey = (data: Uint8ClampedArray | Uint8Array): void => {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const verdeDominante = g - Math.max(r, b);
    if (verdeDominante > 76.5 && g > 89.25) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
    }
  }
};

export const spriteNameToDds = (name: string): string =>
  name.replace(/\.[^.]+$/i, '') + '.dds';

const expectedMipCount = (width: number, height: number): number =>
  Math.floor(Math.log2(Math.max(width, height))) + 1;

const writeU32 = (view: DataView, offset: number, value: number) => {
  view.setUint32(offset, value >>> 0, true);
};

/**
 * Empaqueta niveles BC7 en un DDS DX10 real:
 * - DXGI_FORMAT_BC7_UNORM
 * - cadena de mipmaps completa hasta 1×1
 * - DXGI_ALPHA_MODE_STRAIGHT (alfa no premultiplicado)
 */
export const buildBc7Dds = (
  levels: EncodedLevelBytes[],
  width: number,
  height: number
): ArrayBuffer => {
  const needed = expectedMipCount(width, height);
  if (levels.length < needed) {
    throw new Error(
      `Cadena de mipmaps incompleta: ${levels.length} niveles (se necesitan ${needed} hasta 1×1 para ${width}×${height}).`
    );
  }

  let w = width;
  let h = height;
  for (let i = 0; i < needed; i++) {
    const lvl = levels[i];
    if (lvl.width !== w || lvl.height !== h) {
      throw new Error(
        `Mip ${i} con tamaño ${lvl.width}×${lvl.height}, se esperaba ${w}×${h}.`
      );
    }
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }

  const used = levels.slice(0, needed);
  const payloadSize = used.reduce((sum, lvl) => sum + lvl.data.byteLength, 0);
  const headerSize = 128 + 20; // DDS_HEADER + DDS_HEADER_DXT10
  const out = new ArrayBuffer(headerSize + payloadSize);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  // Magic "DDS "
  bytes[0] = 0x44;
  bytes[1] = 0x44;
  bytes[2] = 0x53;
  bytes[3] = 0x20;

  // DDS_HEADER
  writeU32(view, 4, 124); // dwSize
  writeU32(
    view,
    8,
    0x1 | // DDSD_CAPS
      0x2 | // DDSD_HEIGHT
      0x4 | // DDSD_WIDTH
      0x1000 | // DDSD_PIXELFORMAT
      0x20000 | // DDSD_MIPMAPCOUNT
      0x80000 // DDSD_LINEARSIZE
  );
  writeU32(view, 12, height);
  writeU32(view, 16, width);
  writeU32(view, 20, used[0].data.byteLength); // dwPitchOrLinearSize
  writeU32(view, 24, 0); // dwDepth
  writeU32(view, 28, needed); // dwMipMapCount
  // dwReserved1[11]
  for (let i = 0; i < 11; i++) writeU32(view, 32 + i * 4, 0);

  // DDS_PIXELFORMAT (32 bytes) with FOURCC DX10
  writeU32(view, 76, 32); // pfSize
  writeU32(view, 80, 0x4); // DDPF_FOURCC
  writeU32(view, 84, 0x30315844); // 'DX10'
  writeU32(view, 88, 0); // RGBBitCount
  writeU32(view, 92, 0);
  writeU32(view, 96, 0);
  writeU32(view, 100, 0);
  writeU32(view, 104, 0);

  writeU32(
    view,
    108,
    0x8 | // DDSCAPS_COMPLEX
      0x1000 | // DDSCAPS_TEXTURE
      0x400000 // DDSCAPS_MIPMAP
  );
  writeU32(view, 112, 0); // caps2
  writeU32(view, 116, 0);
  writeU32(view, 120, 0);
  writeU32(view, 124, 0); // reserved2

  // DDS_HEADER_DXT10
  writeU32(view, 128, 98); // DXGI_FORMAT_BC7_UNORM
  writeU32(view, 132, 3); // D3D10_RESOURCE_DIMENSION_TEXTURE2D
  writeU32(view, 136, 0); // miscFlag
  writeU32(view, 140, 1); // arraySize
  writeU32(view, 144, 1); // DXGI_ALPHA_MODE_STRAIGHT

  let offset = headerSize;
  for (const lvl of used) {
    bytes.set(lvl.data, offset);
    offset += lvl.data.byteLength;
  }

  return out;
};

export const canvasToBc7Dds = async (canvas: HTMLCanvasElement): Promise<ArrayBuffer> => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No se pudo leer el canvas del sprite.');

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyLoveGreenChromaKey(imageData.data);

  const result = await compressTextureToBytes(imageData, {
    hint: 'colorWithAlpha',
    mipmaps: true,
    flipY: false,
    colorSpace: 'linear',
  });

  const isBc7 =
    result.format === TextureFormat.BC7 || result.format === TextureFormat.BC7_SRGB;

  if (!result.levels || !isBc7) {
    throw new Error(
      `No se pudo comprimir a BC7 (backend=${result.backend}, format=${result.format ?? 'ninguno'}). ` +
        'Se necesita una GPU con soporte BC7 (WebGPU texture-compression-bc o WebGL EXT_texture_compression_bptc).'
    );
  }

  // Forzar BC7_UNORM en el contenedor aunque el encoder marque SRGB en metadatos.
  return buildBc7Dds(result.levels, canvas.width, canvas.height);
};
