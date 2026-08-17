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
  pickFolder: () => Promise<DesktopFolder | null>;
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
  writeFilesToFolder: (
    folderPath: string,
    files: { name: string; data: ArrayBuffer | Uint8Array }[]
  ) => Promise<boolean>;
  revealInFolder: (targetPath: string) => Promise<boolean>;
};

declare global {
  interface Window {
    joaDesktop?: DesktopApi;
  }
}

export const getDesktop = (): DesktopApi | null =>
  typeof window !== 'undefined' && window.joaDesktop?.isDesktop ? window.joaDesktop : null;

export const isDesktopApp = (): boolean => !!getDesktop();

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
