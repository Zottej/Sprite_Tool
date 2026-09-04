export type DesktopFolder = { path: string; name: string };

export type DesktopOpenFile = {
  name: string;
  path: string;
  data: ArrayBuffer;
};

export type DesktopApi = {
  isDesktop: true;
  getWorkingFolder: () => Promise<DesktopFolder | null>;
  setWorkingFolder: (folderPath: string | null) => Promise<DesktopFolder | null>;
  clearWorkingFolder: () => Promise<null>;
  pickFolder: (options?: { title?: string }) => Promise<DesktopFolder | null>;
  pickOpenFiles: (options?: {
    title?: string;
    multiple?: boolean;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<DesktopOpenFile[]>;
  pickSaveFile: (options?: {
    title?: string;
    suggestedName?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<string | null>;
  writeFile: (filePath: string, data: ArrayBuffer | Uint8Array) => Promise<boolean>;
  writeFileBegin: (filePath: string) => Promise<boolean>;
  writeFileChunk: (filePath: string, data: ArrayBuffer | Uint8Array) => Promise<boolean>;
  writeFileEnd: (filePath: string) => Promise<boolean>;
  writeFilesToFolder: (
    folderPath: string,
    files: { name: string; data: ArrayBuffer | Uint8Array }[]
  ) => Promise<boolean>;
  revealInFolder: (targetPath: string) => Promise<boolean>;
  /** Copia PNGs al portapapeles del SO como archivos (varios = archivos separados). */
  copyImagesToClipboard: (files: { name: string; data: ArrayBuffer }[]) => Promise<boolean>;
};

declare global {
  interface Window {
    joaDesktop?: DesktopApi;
  }
}

export const getDesktop = (): DesktopApi | null =>
  typeof window !== 'undefined' && window.joaDesktop?.isDesktop ? window.joaDesktop : null;

export const isDesktopApp = (): boolean => !!getDesktop();

export const DESKTOP_WRITE_CHUNK_BYTES = 16 * 1024 * 1024;

export const writeDesktopFileBytes = async (filePath: string, data: Uint8Array): Promise<boolean> => {
  const desktop = getDesktop();
  if (!desktop) return false;
  if (data.byteLength === 0) return false;
  const copy = (bytes: Uint8Array) =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  if (data.byteLength <= DESKTOP_WRITE_CHUNK_BYTES) {
    return desktop.writeFile(filePath, copy(data));
  }
  await desktop.writeFileBegin(filePath);
  try {
    for (let offset = 0; offset < data.byteLength; offset += DESKTOP_WRITE_CHUNK_BYTES) {
      const chunk = data.subarray(offset, Math.min(offset + DESKTOP_WRITE_CHUNK_BYTES, data.byteLength));
      await desktop.writeFileChunk(filePath, copy(chunk));
    }
    return await desktop.writeFileEnd(filePath);
  } catch (err) {
    try { await desktop.writeFileEnd(filePath); } catch { /* ignore */ }
    throw err;
  }
};

export const arrayBufferFromBlob = async (blob: Blob | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> => {
  if (blob instanceof ArrayBuffer) return blob;
  if (blob instanceof Uint8Array) {
    return blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
  }
  return await blob.arrayBuffer();
};

export const filesFromDesktopOpen = (items: DesktopOpenFile[]): File[] =>
  items.map((item) => new File([item.data], item.name, { type: guessMime(item.name) }));

const guessMime = (name: string): string => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.dds')) return 'application/octet-stream';
  if (lower.endsWith('.zip') || lower.endsWith('.joa')) return 'application/zip';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
};
