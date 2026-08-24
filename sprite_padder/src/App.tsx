import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { 
  Trash2, Plus, Archive, CheckSquare, Square, 
  Target, FolderSync, Save, AlertTriangle, Eraser, RotateCcw, Search, MapPin, Pencil, MoreHorizontal, FlipHorizontal, FlipVertical, Droplets, Grid, Circle, Maximize, Layers, Play, Pause, Film, PaintBucket, Scissors, Type, Crop, Brush, ChevronLeft, ChevronRight,
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Pipette, Stamp, Lock, Columns2, FolderOpen, Rows3, Hash, ChevronDown, Maximize2, X
} from 'lucide-react';
import JSZip from 'jszip';
import { canvasToBc7Dds, spriteNameToDds } from './ddsExport';
import {
  arrayBufferFromBlob,
  filesFromDesktopOpen,
  getDesktop,
  writeDesktopFileBytes,
  type DesktopFolder,
} from './desktopBridge';
import {
  DITHER_OPTIONS,
  boxBlurImageData,
  brushBlurRadius,
  ditherPick,
  extractPaletteFromImageData,
  hexToRgbaCss,
  nearestPaletteHex,
  parseDitherPattern,
  rgbToHex,
  type DitherPattern,
} from './paintPixelArt';

// Chrome/Edge recuerdan la última carpeta asociada a este mismo ID.
// Importar archivos usa otro ID: compartir el de carpetas hace fallar
// showOpenFilePicker de forma intermitente.
const WORKING_PICKER_ID = 'joa-working-folder';
const OPEN_FILES_PICKER_ID = 'joa-open-images';
const OPEN_PROJECT_PICKER_ID = 'joa-open-project';
const SAVE_FILE_PICKER_ID = 'joa-save-file';
const JOA_PROJECT_KIND = 'joa-sprite-project';
const JOA_PROJECT_VERSION = 1;

const isProbablyImageFile = (file: File) => {
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|bmp|ico|svg|avif)$/i.test(file.name);
};

const isLikelyJpegFile = (file: File) => {
  const t = (file.type || '').toLowerCase();
  if (t === 'image/jpeg' || t === 'image/jpg') return true;
  return /\.jpe?g$/i.test(file.name);
};

const shouldNormalizeOnImport = (file: File) => {
  if (isLikelyJpegFile(file)) return true;
  const t = (file.type || '').toLowerCase();
  if (t === 'image/webp') return true;
  return /\.webp$/i.test(file.name);
};

/** Abre el selector de imágenes. null = usar fallback <input>; [] = canceló. */
const pickImageFiles = async (
  multiple: boolean,
  startIn?: FileSystemHandle | null
): Promise<File[] | null> => {
  if (!('showOpenFilePicker' in window)) return null;
  const base = {
    id: OPEN_FILES_PICKER_ID,
    multiple,
    types: [{
      description: 'Imágenes',
      accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.svg'] },
    }],
  };
  const readHandles = async (options: Record<string, unknown>) => {
    const handles = await (window as any).showOpenFilePicker(options);
    return Promise.all(handles.map((handle: FileSystemFileHandle) => handle.getFile()));
  };
  try {
    if (startIn) {
      try {
        return await readHandles({ ...base, startIn });
      } catch (err: any) {
        if (err?.name === 'AbortError') return [];
      }
    }
    return await readHandles(base);
  } catch (err: any) {
    if (err?.name === 'AbortError') return [];
    console.warn('showOpenFilePicker falló, se usa el selector clásico:', err);
    return null;
  }
};

/** Abre el selector de proyecto JOA (.zip / .joa). null = fallback <input>; [] = canceló. */
const pickProjectFile = async (
  startIn?: FileSystemHandle | null
): Promise<File[] | null> => {
  if (!('showOpenFilePicker' in window)) return null;
  const base = {
    id: OPEN_PROJECT_PICKER_ID,
    multiple: false,
    types: [{
      description: 'Proyecto JOA',
      accept: { 'application/zip': ['.zip', '.joa'] },
    }],
  };
  const readHandles = async (options: Record<string, unknown>) => {
    const handles = await (window as any).showOpenFilePicker(options);
    return Promise.all(handles.map((handle: FileSystemFileHandle) => handle.getFile()));
  };
  try {
    if (startIn) {
      try {
        return await readHandles({ ...base, startIn });
      } catch (err: any) {
        if (err?.name === 'AbortError') return [];
      }
    }
    return await readHandles(base);
  } catch (err: any) {
    if (err?.name === 'AbortError') return [];
    console.warn('showOpenFilePicker (proyecto) falló, se usa el selector clásico:', err);
    return null;
  }
};

// --- Persistencia del handle de carpeta de trabajo (IndexedDB) ---
const IDB_NAME = 'joa-sprite-tool';
const IDB_STORE = 'handles';
const IDB_KEY = 'working-dir';

const openHandleDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const saveWorkingDirHandle = async (handle: FileSystemDirectoryHandle | null) => {
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      if (handle) store.put(handle, IDB_KEY);
      else store.delete(IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('No se pudo persistir la carpeta de trabajo:', err);
  }
};

const loadWorkingDirHandle = async (): Promise<FileSystemDirectoryHandle | null> => {
  try {
    const db = await openHandleDb();
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch (err) {
    console.warn('No se pudo restaurar la carpeta de trabajo:', err);
    return null;
  }
};

/** Verifica (y opcionalmente solicita) permiso de lectura/escritura sobre un handle. */
const ensureHandlePermission = async (
  handle: any,
  mode: 'read' | 'readwrite' = 'readwrite'
): Promise<boolean> => {
  if (!handle) return false;
  try {
    if ((await handle.queryPermission?.({ mode })) === 'granted') return true;
    if ((await handle.requestPermission?.({ mode })) === 'granted') return true;
  } catch (err) {
    console.warn('No se pudo verificar el permiso de la carpeta:', err);
  }
  return false;
};

const loadPref = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const savePref = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota / private mode */
  }
};

const clampNum = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** Prompt numérico que recuerda el último valor válido usado. Cancelar → null. */
const promptLastInt = (
  prefKey: string,
  message: string,
  fallback: number,
  opts?: { min?: number; max?: number; invalidMessage?: string },
): number | null => {
  const min = opts?.min ?? Number.NEGATIVE_INFINITY;
  const max = opts?.max ?? Number.POSITIVE_INFINITY;
  const def = Math.round(clampNum(loadPref<number>(prefKey, fallback), min, max, fallback));
  const str = prompt(message, String(def));
  if (str === null) return null;
  const n = parseInt(str.trim(), 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    if (opts?.invalidMessage) alert(opts.invalidMessage);
    return null;
  }
  savePref(prefKey, n);
  return n;
};

/** Confirm Sí/No que recuerda la última elección y preselecciona ese botón. */
const confirmLastBool = (
  prefKey: string,
  message: string,
  fallback = false,
  labels: { yes?: string; no?: string; title?: string } = {},
): Promise<boolean> => {
  const lastYes = loadPref<boolean>(prefKey, fallback) === true;
  const yesLabel = labels.yes ?? 'Aceptar';
  const noLabel = labels.no ?? 'Cancelar';
  const title = labels.title ?? 'Confirmar';

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay joa-confirm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const box = document.createElement('div');
    box.className = 'joa-confirm-box';
    box.addEventListener('click', (e) => e.stopPropagation());

    const heading = document.createElement('h3');
    heading.className = 'joa-confirm-title';
    heading.textContent = title;

    const body = document.createElement('p');
    body.className = 'joa-confirm-message';
    body.textContent = message;

    const hint = document.createElement('p');
    hint.className = 'joa-confirm-hint';
    hint.textContent = lastYes
      ? 'Última vez: Aceptar (preseleccionado)'
      : 'Última vez: Cancelar (preseleccionado)';

    const actions = document.createElement('div');
    actions.className = 'joa-confirm-actions';

    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'btn btn-outline';
    noBtn.textContent = noLabel;

    const yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'btn btn-primary';
    yesBtn.textContent = yesLabel;

    const finish = (value: boolean) => {
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      savePref(prefKey, value);
      resolve(value);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const active = document.activeElement;
        if (active === noBtn) finish(false);
        else if (active === yesBtn) finish(true);
        else finish(lastYes);
      }
    };

    yesBtn.addEventListener('click', () => finish(true));
    noBtn.addEventListener('click', () => finish(false));
    overlay.addEventListener('click', () => finish(false));

    actions.append(noBtn, yesBtn);
    box.append(heading, body, hint, actions);
    overlay.append(box);
    document.body.append(overlay);
    window.addEventListener('keydown', onKey, true);

    requestAnimationFrame(() => {
      (lastYes ? yesBtn : noBtn).focus();
    });
  });
};

const LAST_COLOR_KEY = 'joa-last-color';
const LAST_SLICE_COLS_KEY = 'joa-last-slice-cols';
const LAST_SLICE_ROWS_KEY = 'joa-last-slice-rows';
const LAST_EXPORT_STRIP_COLS_KEY = 'joa-last-export-strip-cols';
const LAST_EXPORT_STRIP_ROWS_KEY = 'joa-last-export-strip-rows';
const LAST_EXPORT_STRIP_GRID_KEY = 'joa-last-export-strip-grid';
const LAST_BG_BLACK_SMART_TOL_KEY = 'joa-last-bg-black-smart-tol';
const LAST_BG_BLACK_PRECISE_TOL_KEY = 'joa-last-bg-black-precise-tol';
const LAST_REMOVE_TEXT_TOL_KEY = 'joa-last-remove-text-tol';
const LAST_ADD_TEXT_SIZE_KEY = 'joa-last-add-text-size';
const LAST_COMPOSITE_SIZE_KEY = 'joa-last-composite-size';

const normalizeHexColor = (value: unknown, fallback = ''): string => {
  if (typeof value !== 'string') return fallback;
  const s = value.trim().toLowerCase();
  const hex8 = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (hex8) return `#${hex8[1]}`;
  const hex3 = s.match(/^#([0-9a-f]{3})$/);
  if (hex3) return `#${hex3[1].split('').map((c) => c + c).join('')}`;
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    const to = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
    return `#${to(rgb[1])}${to(rgb[2])}${to(rgb[3])}`;
  }
  return fallback;
};

const rememberLastColor = (hex: string) => {
  const normalized = normalizeHexColor(hex);
  if (normalized) savePref(LAST_COLOR_KEY, normalized);
  return normalized;
};

const loadLastColor = (fallback: string) =>
  normalizeHexColor(loadPref<string>(LAST_COLOR_KEY, fallback), fallback);

/** Recuerda left/top del scroll de un workspace por nombre de sprite. */
const useRememberedScroll = (storageKey: string, restoreKey: string, extraDeps: unknown[] = []) => {
  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const all = loadPref<Record<string, { left: number; top: number }>>(storageKey, {});
    const saved = all[restoreKey] || all.__last;
    if (!saved) return;
    const apply = () => {
      el.scrollLeft = saved.left;
      el.scrollTop = saved.top;
    };
    apply();
    const frame = requestAnimationFrame(apply);
    const timer = window.setTimeout(apply, 40);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [storageKey, restoreKey, ...extraDeps]);

  const onWorkspaceScroll = () => {
    const el = workspaceRef.current;
    if (!el) return;
    const all = loadPref<Record<string, { left: number; top: number }>>(storageKey, {});
    const pos = { left: el.scrollLeft, top: el.scrollTop };
    savePref(storageKey, { ...all, [restoreKey]: pos, __last: pos });
  };

  return { workspaceRef, onWorkspaceScroll };
};

/** Shift+rueda = zoom hacia el cursor; Alt+rueda = tamaño de pincel (si hay). */
const useModalWheelControls = (opts: {
  zoom: number;
  setZoom: (value: number) => void;
  zoomMin?: number;
  zoomMax?: number;
  zoomStep?: number;
  brushSize?: number;
  setBrushSize?: (value: number) => void;
  brushMin?: number;
  brushMax?: number;
  enabled?: boolean;
  /** Contenedor con overflow:auto cuyo contenido escala con zoom. */
  workspaceRef?: React.RefObject<HTMLElement | null>;
  /** Elemento que cambia de tamaño con el zoom; por defecto el primer hijo del workspace. */
  contentRef?: React.RefObject<HTMLElement | null>;
}) => {
  const {
    zoom, setZoom,
    zoomMin = 0.5, zoomMax = 8, zoomStep = 0.1,
    brushSize, setBrushSize,
    brushMin = 1, brushMax = 100,
    enabled = true,
    workspaceRef,
    contentRef,
  } = opts;

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const brushRef = useRef(brushSize);
  brushRef.current = brushSize;
  const pendingAnchorRef = useRef<{
    clientX: number;
    clientY: number;
    localX: number;
    localY: number;
    oldZoom: number;
    newZoom: number;
  } | null>(null);

  const resolveContent = (workspace: HTMLElement) => {
    const fromRef = contentRef?.current;
    if (fromRef) return fromRef;
    const first = workspace.firstElementChild;
    return first instanceof HTMLElement ? first : null;
  };

  useEffect(() => {
    if (!enabled) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey && !e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      // En Windows, Shift+rueda suele reportar el gesto en deltaX.
      const axis = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const dir = axis > 0 ? -1 : 1;

      if (e.altKey && setBrushSize) {
        const cur = brushRef.current ?? brushMin;
        setBrushSize(Math.min(brushMax, Math.max(brushMin, cur + dir)));
        return;
      }

      if (!e.shiftKey) return;
      const oldZoom = zoomRef.current;
      const next = Number((oldZoom + dir * zoomStep).toFixed(2));
      const clamped = Math.min(zoomMax, Math.max(zoomMin, next));
      if (clamped === oldZoom) return;

      const workspace = workspaceRef?.current;
      const content = workspace ? resolveContent(workspace) : null;
      if (workspace && content) {
        const cRect = content.getBoundingClientRect();
        if (cRect.width > 1 && cRect.height > 1) {
          pendingAnchorRef.current = {
            clientX: e.clientX,
            clientY: e.clientY,
            localX: e.clientX - cRect.left,
            localY: e.clientY - cRect.top,
            oldZoom,
            newZoom: clamped,
          };
        }
      }
      setZoom(clamped);
    };
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', onWheel, { capture: true });
  }, [
    enabled, setZoom, zoomMin, zoomMax, zoomStep,
    setBrushSize, brushMin, brushMax, workspaceRef, contentRef,
  ]);

  useLayoutEffect(() => {
    const workspace = workspaceRef?.current;
    const anchor = pendingAnchorRef.current;
    if (!workspace || !anchor) return;
    pendingAnchorRef.current = null;

    const content = resolveContent(workspace);
    if (!content) return;
    const ratio = anchor.newZoom / anchor.oldZoom;
    if (!Number.isFinite(ratio) || ratio <= 0) return;

    // 2 pases: el segundo corrige el salto cuando aparecen las barras de scroll.
    for (let pass = 0; pass < 2; pass++) {
      const cRect = content.getBoundingClientRect();
      if (cRect.width <= 1 || cRect.height <= 1) return;
      const errX = (cRect.left + anchor.localX * ratio) - anchor.clientX;
      const errY = (cRect.top + anchor.localY * ratio) - anchor.clientY;
      if (Math.abs(errX) < 0.5 && Math.abs(errY) < 0.5) break;
      workspace.scrollLeft += errX;
      workspace.scrollTop += errY;
    }
  }, [zoom, workspaceRef, contentRef]);
};

const KNOWN_MIME_EXTENSIONS: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'image/x-icon': ['.ico'],
  'application/zip': ['.zip'],
};

const toSaveDotExt = (ext: string) => {
  const clean = String(ext || '').replace(/^\./, '').toLowerCase();
  return clean ? `.${clean}` : '';
};

const pickerTypesForSave = (
  suggestedName: string,
  filters?: { name: string; extensions: string[] }[]
) => {
  const makeType = (description: string, rawExts: string[]) => {
    const dots = rawExts.map(toSaveDotExt).filter(Boolean);
    const accept: Record<string, string[]> = {
      'application/octet-stream': dots.length ? dots : ['.bin'],
    };
    for (const [mime, known] of Object.entries(KNOWN_MIME_EXTENSIONS)) {
      const overlap = dots.filter((d) => known.includes(d));
      if (overlap.length) accept[mime] = overlap;
    }
    return { description, accept };
  };

  if (filters && filters.length > 0) {
    return filters.map((f) => makeType(f.name, f.extensions));
  }
  const ext = suggestedName.includes('.') ? suggestedName.split('.').pop()! : 'bin';
  return [makeType('Archivo', [ext])];
};

/** Nombre de archivo seguro para guardar/descargar. */
const sanitizeExportFileName = (rawName: string, extWithDot: string) => {
  const ext = extWithDot.startsWith('.') ? extWithDot : `.${extWithDot}`;
  let base = String(rawName || 'sprite')
    .replace(/\.[^/.]+$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) base = 'sprite';
  // Evitar nombres tipo "." / ".."
  if (base === '.' || base === '..') base = 'sprite';
  return `${base}${ext}`;
};

/** Descarga forzada: último recurso que casi nunca falla en navegador. */
const forceDownloadBlob = (blob: Blob, suggestedName: string): boolean => {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // No revocar al instante: algunos navegadores cancelan la descarga.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } catch (err) {
    console.error('forceDownloadBlob failed:', err);
    return false;
  }
};

const JOA_JPEG_QUALITY = 0.92;

/** Convierte data URL a Blob sin fetch (fetch falla con data URLs largas, típico al exportar JPG). */
const dataUrlToBlob = (dataUrl: string): Blob => {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Data URL inválida.');
  const header = dataUrl.slice(0, comma);
  const base64 = dataUrl.slice(comma + 1);
  const mimeMatch = /^data:([^;,]+)/i.exec(header);
  const mime = mimeMatch?.[1] || 'application/octet-stream';
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('No se pudo decodificar la imagen generada.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

const canvasToImageBlob = async (
  canvas: HTMLCanvasElement,
  mimeType: 'image/png' | 'image/jpeg',
  quality = JOA_JPEG_QUALITY,
): Promise<Blob> => {
  const fromToBlob = await new Promise<Blob | null>((resolve) => {
    try {
      if (typeof canvas.toBlob !== 'function') {
        resolve(null);
        return;
      }
      if (mimeType === 'image/jpeg') {
        canvas.toBlob((b) => resolve(b), mimeType, quality);
      } else {
        canvas.toBlob((b) => resolve(b), mimeType);
      }
    } catch {
      resolve(null);
    }
  });
  if (fromToBlob && fromToBlob.size > 0) return fromToBlob;

  let dataUrl: string;
  try {
    dataUrl = mimeType === 'image/jpeg'
      ? canvas.toDataURL(mimeType, quality)
      : canvas.toDataURL(mimeType);
  } catch {
    throw new Error('No se pudo generar la imagen (canvas demasiado grande o bloqueado por el navegador).');
  }
  const prefix = mimeType === 'image/jpeg' ? 'data:image/jpeg' : 'data:image/png';
  if (!dataUrl || !dataUrl.startsWith(prefix)) {
    throw new Error('No se pudo generar la imagen.');
  }
  const blob = dataUrlToBlob(dataUrl);
  if (!blob || blob.size === 0) {
    throw new Error('La imagen generada quedó vacía.');
  }
  return blob;
};

/** PNG desde canvas con fallback a dataURL si toBlob falla. */
const canvasToPngBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  canvasToImageBlob(canvas, 'image/png');

const canvasToJpegBlob = (canvas: HTMLCanvasElement, quality = JOA_JPEG_QUALITY): Promise<Blob> =>
  canvasToImageBlob(canvas, 'image/jpeg', quality);

type SaveDestination = {
  kind: 'desktop' | 'picker' | 'download';
  write: (blob: Blob) => Promise<boolean>;
};

const alertSaveFailed = (err: unknown, fallback = 'No se pudo guardar el archivo.') => {
  const msg = err instanceof Error ? err.message : (typeof err === 'string' && err ? err : fallback);
  alert(msg);
};

const downloadDestination = (suggestedName: string): SaveDestination => ({
  kind: 'download',
  write: async (blob) => forceDownloadBlob(blob, suggestedName),
});

const PICKER_WRITE_CHUNK_BYTES = 64 * 1024 * 1024;
const MIN_ZIP_BYTES = 22;

const blobToUint8Array = async (blob: Blob): Promise<Uint8Array> =>
  blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer());

const writeBytesToWritable = async (writable: FileSystemWritableFileStream, data: Uint8Array) => {
  for (let offset = 0; offset < data.byteLength; offset += PICKER_WRITE_CHUNK_BYTES) {
    const end = Math.min(offset + PICKER_WRITE_CHUNK_BYTES, data.byteLength);
    const chunk = data.subarray(offset, end);
    await writable.write(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer);
  }
  await writable.close();
};

const pickerFromHandle = (handle: FileSystemFileHandle): SaveDestination => ({
  kind: 'picker',
  write: async (blob) => {
    const data = await blobToUint8Array(blob);
    if (data.byteLength === 0) throw new Error('El archivo generado quedó vacío.');
    const writable = await handle.createWritable();
    await writeBytesToWritable(writable, data);
    return true;
  },
});

/**
 * Abre el diálogo nativo de Guardar como (un paso: carpeta + nombre + archivos existentes).
 */
const openSaveDestination = async (
  suggestedName: string,
  filters?: { name: string; extensions: string[] }[]
): Promise<SaveDestination | null> => {
  const desktop = getDesktop();
  if (desktop) {
    try {
      const filePath = await desktop.pickSaveFile({
        suggestedName,
        filters: filters || [{ name: 'Archivo', extensions: ['*'] }],
      });
      if (!filePath) return null;
      return {
        kind: 'desktop',
        write: async (blob) => {
          const data = await blobToUint8Array(blob);
          if (data.byteLength === 0) throw new Error('El archivo generado quedó vacío.');
          const ok = await writeDesktopFileBytes(filePath, data);
          if (!ok) throw new Error(`No se pudo escribir el archivo:\n${filePath}`);
          return true;
        },
      };
    } catch (err) {
      console.error('pickSaveFile (desktop) falló, se usa descarga:', err);
      return downloadDestination(suggestedName);
    }
  }

  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        id: SAVE_FILE_PICKER_ID,
        suggestedName,
        types: pickerTypesForSave(suggestedName, filters),
      });
      return pickerFromHandle(handle);
    } catch (err: any) {
      if (err?.name === 'AbortError') return null;
      console.error('showSaveFilePicker falló, se usa descarga:', err);
    }
  }

  return downloadDestination(suggestedName);
};

/** Escribe el blob; si falla el destino elegido, fuerza descarga y avisa. */
const writeBlobWithFallback = async (
  dest: SaveDestination,
  blob: Blob,
  suggestedName: string
): Promise<'saved' | 'downloaded' | 'failed'> => {
  if (!blob || blob.size === 0) {
    alertSaveFailed('El archivo generado quedó vacío. No se guardó nada.');
    return 'failed';
  }
  try {
    const ok = await dest.write(blob);
    if (ok) return dest.kind === 'download' ? 'downloaded' : 'saved';
    throw new Error('La escritura devolvió un resultado vacío.');
  } catch (err) {
    console.error('Escritura principal falló:', err);
    if (dest.kind !== 'download') {
      if (forceDownloadBlob(blob, suggestedName)) {
        alert(
          `No se pudo escribir en la ubicación elegida:\n${err instanceof Error ? err.message : String(err)}\n\n` +
          `Se descargó una copia como «${suggestedName}». Revisá la carpeta Descargas.`
        );
        return 'downloaded';
      }
    }
    alertSaveFailed(err);
    return 'failed';
  }
};

/** Guarda un blob: en desktop usa diálogo nativo; en web carpeta / download. */
const saveBlobToDisk = async (
  blob: Blob,
  suggestedName: string,
  filters?: { name: string; extensions: string[] }[]
): Promise<boolean> => {
  const dest = await openSaveDestination(suggestedName, filters);
  if (!dest) return false;
  const result = await writeBlobWithFallback(dest, blob, suggestedName);
  return result !== 'failed';
};

interface Padding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface Region {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SpriteData {
  id: string;
  name: string;
  img: HTMLImageElement;
  padding: Padding;
  anchor: { x: number, y: number } | null;
  pixelation?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  hue?: number;
  opacity?: number;
  /** absolute = uniforme (default); radial = mayor en el centro de la imagen, menor hacia los bordes */
  opacityMode?: 'absolute' | 'radial';
  originalImg?: HTMLImageElement; // Store original for reset
  scale?: number;
  rotation?: number;
  offsetX?: number;
  offsetY?: number;
  flipH?: boolean;
  flipV?: boolean;
  regions?: Region[];
  grayscale?: number;
  sepia?: number;
  invert?: number;
  blur?: number;
  exposure?: number;
  outlineColor?: string;
  outlineWidth?: number;
  /** smooth = drop-shadow limpio (default); pixel = contorno en grilla de pixelación */
  outlineStyle?: 'smooth' | 'pixel';
  shadowX?: number;
  shadowY?: number;
  shadowBlur?: number;
  shadowColor?: string;
  glowIntensity?: number;
  glowColor?: string;
  highlights?: number;
  stretchX?: number;
  stretchY?: number;
  posterize?: number;
  tintColor?: string;
  tintOpacity?: number;
  greenHueShift?: number;
  greenSaturation?: number;
  greenOpacity?: number;
  blackHueShift?: number;
  blackSaturation?: number;
  blackOpacity?: number;
  whiteHueShift?: number;
  whiteSaturation?: number;
  whiteOpacity?: number;
  effectMasks?: Region[];
  effectMaskMode?: 'rect' | 'brush';
  effectMaskBrush?: string | null;
  handDrawn?: number;
  pencilDrawn?: number;
  /** Columna de comparación en la grilla principal. Ausente = Sin grupo. */
  columnId?: string;
  /** Fila compartida de comparación. Ausente = Sin fila. */
  rowId?: string;
  /** Dato numérico de interfaz (overlay). No se pinta ni se exporta con el sprite. */
  compareValue?: string;
  /** En grilla default con Separar: true = debajo de la barra horizontal. */
  belowSplit?: boolean;
}

const getSpriteFilter = (sprite: SpriteData, isExport = false) => {
  const b = sprite.brightness ?? 100;
  const c = sprite.contrast ?? 100;
  const s = sprite.saturation ?? 100;
  const useRadialOpacity = sprite.opacityMode === 'radial' && hasActiveEffectMask(sprite);
  const o = useRadialOpacity ? 100 : (sprite.opacity ?? 100);
  const hRotate = sprite.hue ?? 0;
  const gs = sprite.grayscale ?? 0;
  const sp = sprite.sepia ?? 0;
  const inv = sprite.invert ?? 0;
  const bl = sprite.blur ?? 0;
  const exp = sprite.exposure ?? 100;
  const hl = sprite.highlights ?? 100;

  // Highlights approximation: apply a contrast boost, then brightness, then invert the contrast
  // A highlights boost (hl > 100) will stretch the upper range of luminosity.
  const highlightsFilter = hl !== 100 ? `contrast(${100 + (hl - 100) * 0.5}%) brightness(${100 + (hl - 100) * 0.2}%) contrast(${100 / (1 + (hl - 100) * 0.005)}%)` : '';

  let filter = `brightness(${b * (exp / 100)}%) contrast(${c}%) saturate(${s}%) hue-rotate(${hRotate}deg) opacity(${o}%) grayscale(${gs}%) sepia(${sp}%) invert(${inv}%) blur(${bl}px) ${highlightsFilter}`;
  
  if (sprite.shadowColor && (sprite.shadowX || sprite.shadowY || sprite.shadowBlur)) {
    filter += ` drop-shadow(${sprite.shadowX || 0}px ${sprite.shadowY || 0}px ${sprite.shadowBlur || 0}px ${sprite.shadowColor})`;
  }
  
  if (sprite.glowColor && sprite.glowIntensity) {
    filter += ` drop-shadow(0 0 ${sprite.glowIntensity}px ${sprite.glowColor})`;
  }
  
  if (sprite.outlineColor && sprite.outlineWidth && sprite.outlineStyle !== 'pixel') {
    const w = sprite.outlineWidth;
    const oc = sprite.outlineColor;
    filter += ` drop-shadow(${w}px 0 0 ${oc}) drop-shadow(-${w}px 0 0 ${oc}) drop-shadow(0 ${w}px 0 ${oc}) drop-shadow(0 -${w}px 0 ${oc}) drop-shadow(${w}px ${w}px 0 ${oc}) drop-shadow(-${w}px -${w}px 0 ${oc}) drop-shadow(${w}px -${w}px 0 ${oc}) drop-shadow(-${w}px ${w}px 0 ${oc})`;
  }

  if (!isExport && sprite.posterize && sprite.posterize >= 2) {
    const steps = sprite.posterize;
    const table = [];
    for(let i = 0; i < steps; i++){ table.push(i / (steps - 1)); }
    const tableStr = table.join(' ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><filter id="p"><feComponentTransfer><feFuncR type="discrete" tableValues="${tableStr}"/><feFuncG type="discrete" tableValues="${tableStr}"/><feFuncB type="discrete" tableValues="${tableStr}"/></feComponentTransfer></filter></svg>`;
    const b64 = btoa(svg);
    filter += ` url('data:image/svg+xml;base64,${b64}#p')`;
  }
  
  return filter;
};

const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s, l];
};

const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  h /= 360;
  let r, g, b;
  if (s === 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
};

const applyGreenFilters = (img: HTMLImageElement | HTMLCanvasElement, shiftDeg: number, satFilter: number, opFilter: number): HTMLCanvasElement | HTMLImageElement => {
  if (shiftDeg === 0 && satFilter === 100 && opFilter === 100) return img;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
    if (a === 0) continue;
    
    let [h, s, l] = rgbToHsl(r, g, b);
    
    // Rango verde ~60 a ~160 en HSL
    let isGreen = h >= 60 && h <= 160 && s > 0.1 && l > 0.1 && l < 0.9;
    
    if (isGreen) {
      let newH = h + shiftDeg;
      if (newH < 0) newH += 360;
      if (newH >= 360) newH -= 360;
      
      let newS = s * (satFilter / 100);
      if (newS > 1) newS = 1;
      if (newS < 0) newS = 0;
      
      const [nR, nG, nB] = hslToRgb(newH, newS, l);
      data[i] = nR;
      data[i+1] = nG;
      data[i+2] = nB;
      data[i+3] = data[i+3] * (opFilter / 100);
    }
  }
  
  ctx.putImageData(imgData, 0, 0);
  return canvas;
};

const applyBlackFilters = (img: HTMLImageElement | HTMLCanvasElement, shiftDeg: number, satFilter: number, opFilter: number): HTMLCanvasElement | HTMLImageElement => {
  if (shiftDeg === 0 && satFilter === 100 && opFilter === 100) return img;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
    if (a === 0) continue;

    let [h, s, l] = rgbToHsl(r, g, b);

    // Negros: baja luminosidad (tonos oscuros y grises profundos)
    let isBlack = l < 0.25 && l > 0.01;

    if (isBlack) {
      let newH = h + shiftDeg;
      if (newH < 0) newH += 360;
      if (newH >= 360) newH -= 360;

      let newS = s * (satFilter / 100);
      if (newS > 1) newS = 1;
      if (newS < 0) newS = 0;

      const [nR, nG, nB] = hslToRgb(newH, newS, l);
      data[i] = nR;
      data[i+1] = nG;
      data[i+2] = nB;
      data[i+3] = data[i+3] * (opFilter / 100);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
};

const applyWhiteFilters = (img: HTMLImageElement | HTMLCanvasElement, shiftDeg: number, satFilter: number, opFilter: number): HTMLCanvasElement | HTMLImageElement => {
  if (shiftDeg === 0 && satFilter === 100 && opFilter === 100) return img;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
    if (a === 0) continue;

    let [h, s, l] = rgbToHsl(r, g, b);

    // Blancos: alta luminosidad (tonos claros y grises pálidos)
    let isWhite = l > 0.75 && l < 0.99;

    if (isWhite) {
      let newH = h + shiftDeg;
      if (newH < 0) newH += 360;
      if (newH >= 360) newH -= 360;

      let newS = s * (satFilter / 100);
      if (newS > 1) newS = 1;
      if (newS < 0) newS = 0;

      const [nR, nG, nB] = hslToRgb(newH, newS, l);
      data[i] = nR;
      data[i+1] = nG;
      data[i+2] = nB;
      data[i+3] = data[i+3] * (opFilter / 100);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
};

const pixelLuminance = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

const pixelSaturation = (r: number, g: number, b: number) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max <= 0 ? 0 : (max - min) / max;
};

const applyHandDrawnEffect = (img: HTMLImageElement | HTMLCanvasElement, amount: number): HTMLCanvasElement | HTMLImageElement => {
  if (amount <= 0) return img;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  const orig = new Uint8ClampedArray(data);
  const w = canvas.width;
  const h = canvas.height;
  const t = amount / 100;
  const levels = Math.max(4, Math.round(24 - t * 20));
  const factor = 255 / (levels - 1);
  const edgeThreshold = 18 + t * 42;
  const edges = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      if (orig[idx + 3] === 0) continue;
      let gx = 0;
      let gy = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = ((y + dy) * w + (x + dx)) * 4;
          const l = pixelLuminance(orig[ni], orig[ni + 1], orig[ni + 2]);
          gx += l * (dx === 0 ? 0 : dx);
          gy += l * (dy === 0 ? 0 : dy);
        }
      }
      const strength = Math.hypot(gx, gy);
      edges[y * w + x] = strength > edgeThreshold ? Math.min(1, (strength - edgeThreshold) / (120 * t + 40)) : 0;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = orig[i + 3];
      if (a === 0) continue;

      const r = orig[i];
      const g = orig[i + 1];
      const b = orig[i + 2];
      const edge = edges[y * w + x] || 0;

      let qr = Math.round((r / 255) * (levels - 1)) * factor;
      let qg = Math.round((g / 255) * (levels - 1)) * factor;
      let qb = Math.round((b / 255) * (levels - 1)) * factor;

      const fillL = pixelLuminance(qr, qg, qb);
      const desat = 0.35 * t;
      qr = qr + (fillL - qr) * desat;
      qg = qg + (fillL - qg) * desat;
      qb = qb + (fillL - qb) * desat;

      const paper = 248 - ((x * 7 + y * 13) % 5) * t * 2;
      qr = qr + (paper - qr) * 0.12 * t;
      qg = qg + (paper - qg) * 0.12 * t;
      qb = qb + (paper - qb) * 0.12 * t;

      const ink = Math.min(1, edge * (0.6 + t * 0.9));
      const inkR = 28 + ((x + y) % 3) * 4;
      const inkG = 22 + ((x * 2 + y) % 3) * 3;
      const inkB = 18 + ((x + y * 2) % 3) * 3;
      qr = qr * (1 - ink) + inkR * ink;
      qg = qg * (1 - ink) + inkG * ink;
      qb = qb * (1 - ink) + inkB * ink;

      const wobble = (((x * 17 + y * 31) % 7) - 3) * t * 0.4;
      qr = Math.max(0, Math.min(255, qr + wobble));
      qg = Math.max(0, Math.min(255, qg - wobble * 0.5));
      qb = Math.max(0, Math.min(255, qb + wobble * 0.3));

      data[i] = Math.round(r + (qr - r) * t);
      data[i + 1] = Math.round(g + (qg - g) * t);
      data[i + 2] = Math.round(b + (qb - b) * t);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
};

const applyPencilDrawnEffect = (img: HTMLImageElement | HTMLCanvasElement, amount: number): HTMLCanvasElement | HTMLImageElement => {
  if (amount <= 0) return img;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  const orig = new Uint8ClampedArray(data);
  const w = canvas.width;
  const h = canvas.height;
  const t = amount / 100;
  const edgeThreshold = 12 + t * 35;
  const hatchSpacing = Math.max(3, Math.round(8 - t * 4));
  const edges = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      if (orig[idx + 3] === 0) continue;
      let gx = 0;
      let gy = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = ((y + dy) * w + (x + dx)) * 4;
          const l = pixelLuminance(orig[ni], orig[ni + 1], orig[ni + 2]);
          gx += l * (dx === 0 ? 0 : dx);
          gy += l * (dy === 0 ? 0 : dy);
        }
      }
      const strength = Math.hypot(gx, gy);
      edges[y * w + x] = strength > edgeThreshold ? Math.min(1, (strength - edgeThreshold) / (90 * t + 30)) : 0;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = orig[i + 3];
      if (a === 0) continue;

      const r = orig[i];
      const g = orig[i + 1];
      const b = orig[i + 2];
      const lum = pixelLuminance(r, g, b);
      const edge = edges[y * w + x] || 0;

      let graphite = lum;
      graphite = graphite + (255 - graphite) * 0.06 * t;

      const hatchA = ((x + y) % hatchSpacing) === 0;
      const hatchB = ((x - y + hatchSpacing * 10) % hatchSpacing) === 0;
      const darkFactor = 1 - lum / 255;
      if (darkFactor > 0.25 * t) {
        if (hatchA) graphite -= 22 * t * darkFactor;
        if (hatchB && t > 0.35) graphite -= 14 * t * darkFactor;
      }

      const edgeGray = 55 + ((x * 3 + y * 5) % 7) * 3;
      const stroke = Math.min(1, edge * (0.5 + t * 0.8));
      graphite = graphite * (1 - stroke) + edgeGray * stroke;

      const grain = (((x * 11 + y * 19) % 5) - 2) * t * 1.2;
      graphite = Math.max(0, Math.min(255, graphite + grain));

      const warm = 1 + t * 0.02;
      let pr = graphite * warm;
      let pg = graphite * (1 + t * 0.008);
      let pb = graphite * (1 - t * 0.015);

      const paper = 252 - ((x * 5 + y * 9) % 4);
      pr = pr + (paper - pr) * 0.1 * t * (1 - darkFactor);
      pg = pg + (paper - pg) * 0.1 * t * (1 - darkFactor);
      pb = pb + (paper - pb) * 0.1 * t * (1 - darkFactor);

      data[i] = Math.round(r + (pr - r) * t);
      data[i + 1] = Math.round(g + (pg - g) * t);
      data[i + 2] = Math.round(b + (pb - b) * t);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
};

const getSpriteImageSource = (sprite: SpriteData): HTMLImageElement | HTMLCanvasElement => {
  let source: HTMLImageElement | HTMLCanvasElement = sprite.img;

  const hShift = sprite.greenHueShift ?? 0;
  const gSat = sprite.greenSaturation ?? 100;
  const gOp = sprite.greenOpacity ?? 100;
  if (hShift !== 0 || gSat !== 100 || gOp !== 100) {
    source = applyGreenFilters(source, hShift, gSat, gOp);
  }

  const bShift = sprite.blackHueShift ?? 0;
  const bSat = sprite.blackSaturation ?? 100;
  const bOp = sprite.blackOpacity ?? 100;
  if (bShift !== 0 || bSat !== 100 || bOp !== 100) {
    source = applyBlackFilters(source, bShift, bSat, bOp);
  }

  const wShift = sprite.whiteHueShift ?? 0;
  const wSat = sprite.whiteSaturation ?? 100;
  const wOp = sprite.whiteOpacity ?? 100;
  if (wShift !== 0 || wSat !== 100 || wOp !== 100) {
    source = applyWhiteFilters(source, wShift, wSat, wOp);
  }

  const handDrawn = sprite.handDrawn ?? 0;
  if (handDrawn > 0) {
    source = applyHandDrawnEffect(source, handDrawn);
  }

  const pencilDrawn = sprite.pencilDrawn ?? 0;
  if (pencilDrawn > 0) {
    source = applyPencilDrawnEffect(source, pencilDrawn);
  }

  return source;
};

const NEUTRAL_EFFECTS: Partial<SpriteData> = {
  brightness: 100, contrast: 100, saturation: 100, hue: 0, opacity: 100,
  opacityMode: 'absolute' as const,
  grayscale: 0, sepia: 0, invert: 0, blur: 0, exposure: 100, highlights: 100,
  pixelation: 1, posterize: undefined, tintOpacity: 0,
  greenHueShift: 0, greenSaturation: 100, greenOpacity: 100,
  blackHueShift: 0, blackSaturation: 100, blackOpacity: 100,
  whiteHueShift: 0, whiteSaturation: 100, whiteOpacity: 100,
  handDrawn: 0,
  pencilDrawn: 0,
  outlineWidth: 0, outlineStyle: 'smooth' as const, glowIntensity: 0, shadowBlur: 0, shadowX: 0, shadowY: 0,
};

const getNeutralSprite = (sprite: SpriteData): SpriteData => ({
  ...sprite,
  ...NEUTRAL_EFFECTS,
  scale: 1,
});

/** Contorno pixel-art: dilata la silueta en la grilla actual (Chebyshev) y pinta debajo del sprite. */
const applyPixelOutlineToCanvas = (
  source: HTMLCanvasElement,
  color: string,
  radiusPx: number
): HTMLCanvasElement => {
  const r = Math.max(1, Math.round(radiusPx));
  const w = source.width;
  const h = source.height;

  const silhouette = document.createElement('canvas');
  silhouette.width = w;
  silhouette.height = h;
  const sctx = silhouette.getContext('2d')!;
  sctx.drawImage(source, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = color;
  sctx.fillRect(0, 0, w, h);

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = false;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > r) continue;
      octx.drawImage(silhouette, dx, dy);
    }
  }
  octx.drawImage(source, 0, 0);
  return out;
};

const drawSpriteImageLayer = (
  ctx: CanvasRenderingContext2D,
  sprite: SpriteData,
  variant: 'neutral' | 'full',
  isExport: boolean
) => {
  const effective = variant === 'neutral' ? getNeutralSprite(sprite) : sprite;
  const imgSource = variant === 'neutral' ? sprite.img : getSpriteImageSource(sprite);
  const scale = effective.scale || 1;
  const stretchX = effective.stretchX || 1;
  const stretchY = effective.stretchY || 1;
  const sw = sprite.img.width * scale * stretchX;
  const sh = sprite.img.height * scale * stretchY;

  const usePixelOutline =
    variant === 'full' &&
    effective.outlineStyle === 'pixel' &&
    !!effective.outlineWidth &&
    effective.outlineWidth > 0 &&
    !!effective.outlineColor;

  ctx.filter = getSpriteFilter(effective, isExport);

  const paintLayer = (layer: HTMLCanvasElement) => {
    ctx.drawImage(layer, -sw / 2, -sh / 2, sw, sh);
  };

  if (effective.pixelation && effective.pixelation > 1) {
    const p = effective.pixelation;
    const tw = Math.max(1, Math.floor(sw / p));
    const th = Math.max(1, Math.floor(sh / p));
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = tw;
    tempCanvas.height = th;
    const tctx = tempCanvas.getContext('2d')!;
    tctx.imageSmoothingEnabled = false;
    // Filtros de color se aplican al upscale; acá solo rasterizamos la fuente.
    // Para contorno pixelado: primero dibujamos con filtro a un buffer a tamaño final,
    // pero el contorno se calcula en la grilla de pixelación.
    tctx.filter = 'none';
    tctx.drawImage(imgSource, 0, 0, tw, th);

    if (usePixelOutline) {
      // Grosor en "bloques" de pixelación (misma unidad visual que el sprite pixelado)
      const outlined = applyPixelOutlineToCanvas(
        tempCanvas,
        effective.outlineColor!,
        effective.outlineWidth!
      );
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(outlined, 0, 0, tw, th, -sw / 2, -sh / 2, sw, sh);
    } else {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tempCanvas, 0, 0, tw, th, -sw / 2, -sh / 2, sw, sh);
    }
  } else if (usePixelOutline) {
    const layer = document.createElement('canvas');
    layer.width = Math.max(1, Math.ceil(sw));
    layer.height = Math.max(1, Math.ceil(sh));
    const lctx = layer.getContext('2d')!;
    lctx.imageSmoothingEnabled = false;
    lctx.filter = getSpriteFilter(effective, isExport);
    lctx.drawImage(imgSource, 0, 0, layer.width, layer.height);
    lctx.filter = 'none';
    const outlined = applyPixelOutlineToCanvas(
      layer,
      effective.outlineColor!,
      effective.outlineWidth!
    );
    ctx.filter = 'none';
    paintLayer(outlined);
  } else {
    ctx.drawImage(imgSource, -sw / 2, -sh / 2, sw, sh);
  }
  ctx.filter = 'none';

  if (variant === 'full' && effective.tintOpacity && effective.tintOpacity > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = effective.tintColor || '#000000';
    ctx.globalAlpha = effective.tintOpacity / 100;
    ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
    ctx.restore();
  }
};

const getEffectMasks = (sprite: SpriteData): Region[] =>
  (sprite.effectMasks || []).filter(m => m.w > 0 && m.h > 0);

const brushMaskCache = new Map<string, HTMLCanvasElement>();

const getBrushMaskCanvas = (sprite: SpriteData): HTMLCanvasElement | null => {
  if (!sprite.effectMaskBrush) return null;
  const key = sprite.effectMaskBrush;
  if (brushMaskCache.has(key)) return brushMaskCache.get(key)!;

  const canvas = document.createElement('canvas');
  canvas.width = sprite.img.width;
  canvas.height = sprite.img.height;
  const ctx = canvas.getContext('2d')!;
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    brushMaskCache.set(key, canvas);
    window.dispatchEvent(new CustomEvent('brushmask-loaded'));
  };
  img.src = key;
  if (img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, 0, 0);
    brushMaskCache.set(key, canvas);
    return canvas;
  }
  return brushMaskCache.get(key) ?? null;
};

const hasActiveEffectMask = (sprite: SpriteData): boolean => {
  if (sprite.effectMaskMode === 'brush') return !!sprite.effectMaskBrush;
  return getEffectMasks(sprite).length > 0;
};

const isPointInEffectMasks = (x: number, y: number, masks: Region[]) =>
  masks.some(m => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);

const isPointInBrushMask = (sprite: SpriteData, x: number, y: number): boolean => {
  const canvas = getBrushMaskCanvas(sprite);
  if (!canvas) return false;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= canvas.width || iy >= canvas.height) return false;
  const alpha = canvas.getContext('2d')!.getImageData(ix, iy, 1, 1).data[3];
  return alpha > 0;
};

const isPointInEffectMask = (sprite: SpriteData, x: number, y: number): boolean => {
  if (!hasActiveEffectMask(sprite)) return true;
  if (sprite.effectMaskMode === 'brush') return isPointInBrushMask(sprite, x, y);
  return isPointInEffectMasks(x, y, getEffectMasks(sprite));
};

/** Máscara = área seleccionada ∩ píxeles opacos del PNG original */
const buildEffectCoverageMask = (sprite: SpriteData): HTMLCanvasElement | null => {
  const w = sprite.img.width;
  const h = sprite.img.height;
  const coverage = document.createElement('canvas');
  coverage.width = w;
  coverage.height = h;
  const cctx = coverage.getContext('2d')!;

  if (sprite.effectMaskMode === 'brush' && sprite.effectMaskBrush) {
    const brush = getBrushMaskCanvas(sprite);
    if (!brush) return null;
    cctx.drawImage(brush, 0, 0);
  } else {
    const masks = getEffectMasks(sprite);
    if (masks.length === 0) return null;
    cctx.fillStyle = '#ffffff';
    for (const mask of masks) {
      cctx.fillRect(mask.x, mask.y, mask.w, mask.h);
    }
  }

  // Solo donde el PNG tiene dibujo
  cctx.globalCompositeOperation = 'destination-in';
  cctx.drawImage(sprite.img, 0, 0);
  cctx.globalCompositeOperation = 'source-over';
  return coverage;
};

/** Opacidad radial: mayor en el centro de la imagen, menor hacia los bordes */
const applyRadialOpacityToLayer = (
  layerCtx: CanvasRenderingContext2D,
  layerW: number,
  layerH: number,
  opacityPercent: number
) => {
  const mask = document.createElement('canvas');
  mask.width = layerW;
  mask.height = layerH;
  const mctx = mask.getContext('2d')!;
  const cx = layerW / 2;
  const cy = layerH / 2;
  const maxR = Math.hypot(cx, cy) || 1;
  const a = Math.max(0, Math.min(1, (opacityPercent ?? 100) / 100));
  const grad = mctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
  grad.addColorStop(0, `rgba(255,255,255,${a})`);
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  mctx.fillStyle = grad;
  mctx.fillRect(0, 0, layerW, layerH);

  layerCtx.save();
  layerCtx.globalCompositeOperation = 'destination-in';
  layerCtx.drawImage(mask, 0, 0);
  layerCtx.restore();
};

/** Reemplaza (no mezcla) la zona afectada: opacidad/filtros aplican al sprite, no a la capa encima del original */
const drawMaskedEffectsReplacing = (
  ctx: CanvasRenderingContext2D,
  sprite: SpriteData,
  sw: number,
  sh: number,
  isExport: boolean
) => {
  const coverage = buildEffectCoverageMask(sprite);
  if (!coverage) return;

  const layerW = Math.max(1, Math.ceil(sw));
  const layerH = Math.max(1, Math.ceil(sh));

  const effectsLayer = document.createElement('canvas');
  effectsLayer.width = layerW;
  effectsLayer.height = layerH;
  const lctx = effectsLayer.getContext('2d')!;
  lctx.imageSmoothingEnabled = false;
  lctx.save();
  lctx.translate(layerW / 2, layerH / 2);
  drawSpriteImageLayer(lctx, sprite, 'full', isExport);
  lctx.restore();

  lctx.globalCompositeOperation = 'destination-in';
  lctx.drawImage(coverage, 0, 0, sprite.img.width, sprite.img.height, 0, 0, layerW, layerH);
  lctx.globalCompositeOperation = 'source-over';

  if (sprite.opacityMode === 'radial') {
    applyRadialOpacityToLayer(lctx, layerW, layerH, sprite.opacity ?? 100);
  }

  // Quitar el sprite neutro solo en la zona afectada, para que la opacidad se vea contra el fondo
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(coverage, 0, 0, sprite.img.width, sprite.img.height, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();

  ctx.drawImage(effectsLayer, -sw / 2, -sh / 2, sw, sh);
};

const renderSpriteToContext = (ctx: CanvasRenderingContext2D, sprite: SpriteData, isExport = false) => {
  const { padding } = sprite;
  const scale = sprite.scale || 1;
  const stretchX = sprite.stretchX || 1;
  const stretchY = sprite.stretchY || 1;
  const sw = sprite.img.width * scale * stretchX;
  const sh = sprite.img.height * scale * stretchY;
  const ox = sprite.offsetX || 0;
  const oy = sprite.offsetY || 0;
  const rot = (sprite.rotation || 0) * Math.PI / 180;
  const hSign = sprite.flipH ? -1 : 1;
  const vSign = sprite.flipV ? -1 : 1;

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, Math.max(1, sw + padding.left + padding.right), Math.max(1, sh + padding.top + padding.bottom));

  ctx.save();
  ctx.translate(padding.left + sw / 2 + ox, padding.top + sh / 2 + oy);
  ctx.rotate(rot);
  ctx.scale(hSign, vSign);

  if (!hasActiveEffectMask(sprite)) {
    drawSpriteImageLayer(ctx, sprite, 'full', isExport);
  } else {
    drawSpriteImageLayer(ctx, sprite, 'neutral', isExport);
    drawMaskedEffectsReplacing(ctx, sprite, sw, sh, isExport);
  }

  ctx.restore();
};

const applyPosterizeToCanvas = (canvas: HTMLCanvasElement, sprite: SpriteData) => {
  if (!sprite.posterize || sprite.posterize < 2) return;
  const ctx = canvas.getContext('2d')!;
  const idata = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = idata.data;
  const steps = sprite.posterize;
  const factor = 255 / (steps - 1);

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (hasActiveEffectMask(sprite)) {
      const px = (i / 4) % canvas.width;
      const py = Math.floor(i / 4 / canvas.width);
      const scX = (sprite.scale || 1) * (sprite.stretchX || 1);
      const scY = (sprite.scale || 1) * (sprite.stretchY || 1);
      const imgX = (px - sprite.padding.left) / scX;
      const imgY = (py - sprite.padding.top) / scY;
      if (!isPointInEffectMask(sprite, imgX, imgY)) continue;
    }
    d[i] = Math.round((d[i] / 255) * (steps - 1)) * factor;
    d[i + 1] = Math.round((d[i + 1] / 255) * (steps - 1)) * factor;
    d[i + 2] = Math.round((d[i + 2] / 255) * (steps - 1)) * factor;
  }
  ctx.putImageData(idata, 0, 0);
};

const getSpriteFrameSize = (sprite: SpriteData) => {
  const scX = (sprite.scale || 1) * (sprite.stretchX || 1);
  const scY = (sprite.scale || 1) * (sprite.stretchY || 1);
  return {
    w: Math.max(1, sprite.img.width * scX + sprite.padding.left + sprite.padding.right),
    h: Math.max(1, sprite.img.height * scY + sprite.padding.top + sprite.padding.bottom),
  };
};

const renderSpriteToCanvas = (sprite: SpriteData, isExport = true): HTMLCanvasElement => {
  const { w: totalW, h: totalH } = getSpriteFrameSize(sprite);
  const canvas = document.createElement('canvas');
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d')!;
  renderSpriteToContext(ctx, sprite, isExport);
  applyPosterizeToCanvas(canvas, sprite);
  return canvas;
};


const getEffectMaskOverlayPercents = (sprite: SpriteData, mask: Region) => {
  const scX = (sprite.scale || 1) * (sprite.stretchX || 1);
  const scY = (sprite.scale || 1) * (sprite.stretchY || 1);
  const totalW = sprite.img.width * scX + sprite.padding.left + sprite.padding.right;
  const totalH = sprite.img.height * scY + sprite.padding.top + sprite.padding.bottom;
  return {
    left: ((sprite.padding.left + mask.x * (sprite.stretchX || 1) * (sprite.scale || 1)) / totalW) * 100,
    top: ((sprite.padding.top + mask.y * (sprite.stretchY || 1) * (sprite.scale || 1)) / totalH) * 100,
    width: (mask.w * (sprite.stretchX || 1) * (sprite.scale || 1) / totalW) * 100,
    height: (mask.h * (sprite.stretchY || 1) * (sprite.scale || 1) / totalH) * 100,
  };
};

const generateId = () => {
  try { return crypto.randomUUID(); } catch (e) { return Math.random().toString(36).substring(2, 15) + Date.now().toString(36); }
};

const DEFAULT_SPRITE_COLUMN_ID = 'ungrouped';
const DEFAULT_SPRITE_ROW_ID = 'row-default';
const SPRITE_COLUMNS_KEY = 'joa-sprite-columns';
const SPRITE_ROWS_KEY = 'joa-sprite-rows';
const COLUMN_VIEW_KEY = 'joa-column-view';
const GRID_SPLIT_KEY = 'joa-grid-split';
const QUADRANT_VIEW_KEY = 'joa-quadrant-view';
const COLLAPSED_COLUMNS_KEY = 'joa-collapsed-columns';
const COLLAPSED_ROWS_KEY = 'joa-collapsed-rows';
const ROW_LABEL_WIDTH_KEY = 'joa-row-label-width';
const ROW_LABELS_COLLAPSED_KEY = 'joa-row-labels-collapsed';
const ROW_LABEL_WIDTH_MIN = 72;
const ROW_LABEL_WIDTH_MAX = 420;
const ROW_LABEL_WIDTH_DEFAULT = 148;
const ROW_LABEL_WIDTH_COLLAPSED = 42;
const COMPARE_NUMBER_SIZE_KEY = 'joa-compare-number-size';
const COMPARE_NUMBER_SIZE_MIN = 12;
const COMPARE_NUMBER_SIZE_MAX = 160;

type SpriteColumn = { id: string; name: string };
type SpriteRow = { id: string; name: string };

const normalizeSpriteColumns = (saved: unknown): SpriteColumn[] => {
  if (!Array.isArray(saved)) return [];
  return saved.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const c = raw as { id?: unknown; name?: unknown };
    if (typeof c.id !== 'string' || c.id === DEFAULT_SPRITE_COLUMN_ID || typeof c.name !== 'string' || !c.name.trim()) return [];
    return [{ id: c.id, name: c.name.trim() }];
  });
};

const normalizeSpriteRows = (saved: unknown): SpriteRow[] => {
  const fallback: SpriteRow[] = [{ id: DEFAULT_SPRITE_ROW_ID, name: 'Sin fila' }];
  if (!Array.isArray(saved)) return fallback;
  const rows = saved.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as { id?: unknown; name?: unknown };
    if (typeof r.id !== 'string' || typeof r.name !== 'string' || !r.name.trim()) return [];
    return [{ id: r.id, name: r.name.trim() }];
  });
  if (rows.length === 0) return fallback;
  const def = rows.find((r) => r.id === DEFAULT_SPRITE_ROW_ID);
  const rest = rows.filter((r) => r.id !== DEFAULT_SPRITE_ROW_ID);
  return [{ id: DEFAULT_SPRITE_ROW_ID, name: def?.name || 'Sin fila' }, ...rest];
};

const loadSpriteColumns = (): SpriteColumn[] => normalizeSpriteColumns(loadPref<SpriteColumn[]>(SPRITE_COLUMNS_KEY, []));
const loadSpriteRows = (): SpriteRow[] => normalizeSpriteRows(loadPref<SpriteRow[]>(SPRITE_ROWS_KEY, []));

/** Orden fila × columna del tablero (Sin fila → filas; Sin grupo → columnas). */
const buildSpritesInBoardOrder = (
  sprites: SpriteData[],
  rows: SpriteRow[],
  columns: SpriteColumn[],
): SpriteData[] => {
  const colIds = new Set(columns.map((c) => c.id));
  const rowIds = new Set(rows.map((r) => r.id));
  const resolveColumnId = (s: SpriteData) => {
    const id = s.columnId;
    if (id && id !== DEFAULT_SPRITE_COLUMN_ID && colIds.has(id)) return id;
    return DEFAULT_SPRITE_COLUMN_ID;
  };
  const resolveRowId = (s: SpriteData) => {
    const id = s.rowId;
    if (id && id !== DEFAULT_SPRITE_ROW_ID && rowIds.has(id)) return id;
    return DEFAULT_SPRITE_ROW_ID;
  };
  const boardColumns: SpriteColumn[] = [
    { id: DEFAULT_SPRITE_COLUMN_ID, name: 'Sin grupo' },
    ...columns,
  ];
  const ordered: SpriteData[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const col of boardColumns) {
      for (const s of sprites) {
        if (resolveColumnId(s) === col.id && resolveRowId(s) === row.id) {
          ordered.push(s);
          seen.add(s.id);
        }
      }
    }
  }
  for (const s of sprites) {
    if (!seen.has(s.id)) ordered.push(s);
  }
  return ordered;
};

const spritesOrderMatches = (a: SpriteData[], b: SpriteData[]) =>
  a.length === b.length && a.every((s, i) => s.id === b[i]?.id);

type TextComponentStats = {
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  sumR: number;
  sumG: number;
  sumB: number;
  edgeTouch: boolean;
  highContrast: number;
};

const localContrastAt = (data: Uint8ClampedArray, w: number, h: number, x: number, y: number) => {
  const idx = (y * w + x) * 4;
  if (data[idx + 3] === 0) return 0;
  const center = pixelLuminance(data[idx], data[idx + 1], data[idx + 2]);
  let maxDiff = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = (ny * w + nx) * 4;
      if (data[ni + 3] === 0) continue;
      maxDiff = Math.max(maxDiff, Math.abs(center - pixelLuminance(data[ni], data[ni + 1], data[ni + 2])));
    }
  }
  return maxDiff;
};

const labelOpaqueComponents = (data: Uint8ClampedArray, w: number, h: number) => {
  const labels = new Int32Array(w * h);
  const comps = new Map<number, TextComponentStats>();
  let nextLabel = 1;
  const stack: number[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const idx = p * 4;
      if (data[idx + 3] === 0 || labels[p] !== 0) continue;

      const label = nextLabel++;
      labels[p] = label;
      stack.push(p);
      const stats: TextComponentStats = {
        area: 0,
        minX: x,
        minY: y,
        maxX: x,
        maxY: y,
        sumR: 0,
        sumG: 0,
        sumB: 0,
        edgeTouch: x === 0 || y === 0 || x === w - 1 || y === h - 1,
        highContrast: 0,
      };

      while (stack.length > 0) {
        const cur = stack.pop()!;
        const cx = cur % w;
        const cy = Math.floor(cur / w);
        const cidx = cur * 4;
        stats.area += 1;
        stats.minX = Math.min(stats.minX, cx);
        stats.minY = Math.min(stats.minY, cy);
        stats.maxX = Math.max(stats.maxX, cx);
        stats.maxY = Math.max(stats.maxY, cy);
        stats.sumR += data[cidx];
        stats.sumG += data[cidx + 1];
        stats.sumB += data[cidx + 2];
        if (localContrastAt(data, w, h, cx, cy) >= 42) stats.highContrast += 1;
        if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) stats.edgeTouch = true;

        if (cx > 0) {
          const n = cur - 1;
          if (data[n * 4 + 3] > 0 && labels[n] === 0) {
            labels[n] = label;
            stack.push(n);
          }
        }
        if (cx < w - 1) {
          const n = cur + 1;
          if (data[n * 4 + 3] > 0 && labels[n] === 0) {
            labels[n] = label;
            stack.push(n);
          }
        }
        if (cy > 0) {
          const n = cur - w;
          if (data[n * 4 + 3] > 0 && labels[n] === 0) {
            labels[n] = label;
            stack.push(n);
          }
        }
        if (cy < h - 1) {
          const n = cur + w;
          if (data[n * 4 + 3] > 0 && labels[n] === 0) {
            labels[n] = label;
            stack.push(n);
          }
        }
      }

      comps.set(label, stats);
    }
  }

  return { labels, comps };
};

const isLikelyTextComponent = (
  comp: TextComponentStats,
  w: number,
  h: number,
  imageArea: number,
  mainArea: number,
  toneThreshold: number,
) => {
  const area = comp.area;
  if (area < 6) return true;
  if (area >= mainArea * 0.92) return false;
  if (area > imageArea * 0.42) return false;

  const bboxW = comp.maxX - comp.minX + 1;
  const bboxH = comp.maxY - comp.minY + 1;
  const aspect = bboxW / Math.max(1, bboxH);
  const avgR = comp.sumR / area;
  const avgG = comp.sumG / area;
  const avgB = comp.sumB / area;
  const lum = pixelLuminance(avgR, avgG, avgB);
  const sat = pixelSaturation(avgR, avgG, avgB);
  const grayish = sat < 0.42;
  const extremeTone = lum <= toneThreshold || lum >= 255 - toneThreshold;
  const contrastRatio = comp.highContrast / area;

  const inTop = comp.maxY < h * 0.24;
  const inBottom = comp.minY > h * 0.76;
  const inSide = comp.maxX < w * 0.16 || comp.minX > w * 0.84;
  const inMargin = inTop || inBottom || inSide;

  if (grayish && extremeTone && inMargin && area < imageArea * 0.28) return true;
  if (grayish && extremeTone && aspect >= 2 && bboxH <= h * 0.16 && area < imageArea * 0.22) return true;
  if (comp.edgeTouch && grayish && extremeTone && area < imageArea * 0.18) return true;
  if (inMargin && contrastRatio > 0.28 && area < imageArea * 0.14 && bboxH <= h * 0.2) return true;
  return false;
};

/** Detecta manchas de texto (watermarks, etiquetas) y las vuelve transparentes. */
const removeTextSmart = async (img: HTMLImageElement, tolerance: number): Promise<HTMLImageElement> => {
  const toneThreshold = Math.min(96, Math.max(4, Math.round(tolerance * 2.55)));
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    const w = canvas.width;
    const h = canvas.height;
    const imageArea = w * h;

    const { labels, comps } = labelOpaqueComponents(data, w, h);
    let mainLabel = 0;
    let mainArea = 0;
    for (const [label, comp] of comps) {
      if (comp.area > mainArea) {
        mainArea = comp.area;
        mainLabel = label;
      }
    }

    const removeLabels = new Set<number>();
    for (const [label, comp] of comps) {
      if (label === mainLabel) continue;
      if (isLikelyTextComponent(comp, w, h, imageArea, mainArea, toneThreshold)) {
        removeLabels.add(label);
      }
    }

    for (let p = 0; p < w * h; p++) {
      const label = labels[p];
      if (label > 0 && removeLabels.has(label)) {
        data[p * 4 + 3] = 0;
      }
    }

    const marginBandY = (y: number) => y < h * 0.2 || y > h * 0.8;
    for (let y = 0; y < h; y++) {
      if (!marginBandY(y)) continue;
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        if (data[idx + 3] === 0) continue;
        const lum = pixelLuminance(data[idx], data[idx + 1], data[idx + 2]);
        const sat = pixelSaturation(data[idx], data[idx + 1], data[idx + 2]);
        if (sat >= 0.42) continue;
        if (lum > 255 - toneThreshold || lum < toneThreshold) {
          if (localContrastAt(data, w, h, x, y) >= 36) data[idx + 3] = 0;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const newImg = new Image();
    newImg.onload = () => resolve(newImg);
    newImg.src = canvas.toDataURL('image/png');
  });
};

const normalizeIdList = (saved: unknown): string[] => {
  if (!Array.isArray(saved)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of saved) {
    if (typeof raw !== 'string' || !raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
};

const toggleIdInList = (ids: string[], id: string) =>
  ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];

const isJoaProjectFileName = (name: string) =>
  /\.(zip|joa)$/i.test(name);

const ensureImageDecoded = async (img: HTMLImageElement) => {
  if (typeof img.decode === 'function') {
    try {
      await img.decode();
    } catch {
      /* algunos JPG progresivos fallan decode() pero igual se pueden dibujar */
    }
  }
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('La imagen no tiene dimensiones válidas.');
};

const drawImageToCanvas = async (img: HTMLImageElement): Promise<HTMLCanvasElement> => {
  await ensureImageDecoded(img);
  const w = Math.max(1, img.naturalWidth || img.width);
  const h = Math.max(1, img.naturalHeight || img.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo crear el canvas.');
  ctx.imageSmoothingEnabled = false;
  try {
    ctx.drawImage(img, 0, 0, w, h);
  } catch {
    if (typeof createImageBitmap !== 'function') {
      throw new Error('No se pudo dibujar la imagen en el canvas.');
    }
    const bitmap = await createImageBitmap(img);
    try {
      ctx.drawImage(bitmap, 0, 0, w, h);
    } finally {
      bitmap.close?.();
    }
  }
  return canvas;
};

/** Siempre PNG: los JPG/WebP se reconvierten al guardar el proyecto. */
const imageToProjectPngBlob = async (img: HTMLImageElement): Promise<Blob> => {
  const canvas = await drawImageToCanvas(img);
  const blob = await canvasToPngBlob(canvas);
  if (!blob.size) throw new Error('La conversión a PNG quedó vacía.');
  return blob;
};

const loadImageFromFileReader = (file: File): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.onload = (e) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('No se pudo decodificar la imagen.'));
      image.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });

/** JPG/WebP en memoria como data URL larga suele romper la exportación; re-codificar a PNG al importar. */
const normalizeImportedImage = async (img: HTMLImageElement): Promise<HTMLImageElement> => {
  return loadImageFromBlob(await imageToProjectPngBlob(img));
};

const loadImageFromBlob = (blob: Blob): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    // Data URL (no blob:) para que img.src siga siendo usable en miniaturas <img>
    // tras cerrar el Blob — createObjectURL + revoke deja el bitmap OK pero src muerto.
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer una imagen del proyecto.'));
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('No se pudo leer una imagen del proyecto.'));
      image.src = String(reader.result || '');
    };
    reader.readAsDataURL(blob);
  });

/** Miniatura desde el bitmap en memoria (no depende de img.src; sirve si el blob URL ya se revocó). */
const imageToPreviewDataUrl = (img: HTMLImageElement, maxEdge = 180): string => {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w < 1 || h < 1) return '';
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return img.src && !img.src.startsWith('blob:') ? img.src : '';
  ctx.imageSmoothingEnabled = false;
  try {
    ctx.drawImage(img, 0, 0, dw, dh);
    return canvas.toDataURL('image/png');
  } catch {
    return img.src && !img.src.startsWith('blob:') ? img.src : '';
  }
};

const SpriteThumb: React.FC<{
  img: HTMLImageElement;
  maxWidth?: number;
  maxHeight?: number;
  alt?: string;
  style?: React.CSSProperties;
}> = ({ img, maxWidth = 140, maxHeight = 88, alt = '', style }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w < 1 || h < 1) return;
    const scale = Math.min(maxWidth / w, maxHeight / h, 1);
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    if (canvas.width !== dw) canvas.width = dw;
    if (canvas.height !== dh) canvas.height = dh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, dw, dh);
    try {
      ctx.drawImage(img, 0, 0, dw, dh);
    } catch {
      /* ignore */
    }
  }, [img, maxWidth, maxHeight]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={alt}
      style={{
        maxWidth: '100%',
        maxHeight: '100%',
        objectFit: 'contain',
        imageRendering: 'pixelated',
        ...style,
      }}
    />
  );
};

type JoaProjectSpriteMeta = Omit<SpriteData, 'img' | 'originalImg'> & {
  image: string;
  originalImage?: string;
};

type JoaProjectFile = {
  version: number;
  kind: typeof JOA_PROJECT_KIND;
  savedAt: string;
  columnView: boolean;
  columns: SpriteColumn[];
  rows?: SpriteRow[];
  collapsedColumns?: string[];
  collapsedRows?: string[];
  rowLabelWidth?: number;
  rowLabelsCollapsed?: boolean;
  referenceId: string | null;
  sprites: JoaProjectSpriteMeta[];
};

const spriteToProjectMeta = (
  s: SpriteData,
  hasSeparateOriginal: boolean,
  imagePath: string,
  originalImagePath?: string,
): JoaProjectSpriteMeta => {
  const { img: _img, originalImg: _orig, ...meta } = s;
  return {
    ...meta,
    image: imagePath,
    originalImage: hasSeparateOriginal && originalImagePath ? originalImagePath : undefined,
  };
};

const normalizeZipPath = (name: string) =>
  String(name || '').replace(/\\/g, '/').replace(/^\.?\//, '');

const isSafeZipPath = (name: string) => {
  const parts = normalizeZipPath(name).split('/');
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
};

const findZipEntry = (zip: JSZip, path: string) => {
  const want = normalizeZipPath(path).toLowerCase();
  if (!want || !isSafeZipPath(want)) return null;
  return Object.values(zip.files).find((f) => !f.dir && normalizeZipPath(f.name).toLowerCase() === want) || null;
};

const resolveProjectImageEntry = (
  zip: JSZip,
  meta: JoaProjectSpriteMeta,
  kind: 'main' | 'original',
) => {
  const primary = kind === 'main'
    ? (typeof meta.image === 'string' ? meta.image : `images/${meta.id}.png`)
    : meta.originalImage;
  if (!primary || !isSafeZipPath(primary)) return null;
  const hit = findZipEntry(zip, primary);
  if (hit) return hit;
  const id = meta.id;
  const fallbacks = kind === 'main'
    ? [`images/${id}.jpg`, `images/${id}.jpeg`, `images/${id}.png`]
    : [`images/${id}.original.jpg`, `images/${id}.original.jpeg`, `images/${id}.original.png`];
  for (const path of fallbacks) {
    const entry = findZipEntry(zip, path);
    if (entry) return entry;
  }
  return null;
};

const parseJoaProjectJson = (raw: unknown): JoaProjectFile => {
  if (!raw || typeof raw !== 'object') throw new Error('project.json inválido.');
  const o = raw as Record<string, unknown>;
  if (o.kind !== JOA_PROJECT_KIND) {
    throw new Error('El archivo no es un proyecto de JOA Sprite Padder.');
  }
  if (typeof o.version !== 'number' || o.version < 1) {
    throw new Error('Versión de proyecto no reconocida.');
  }
  if (!Array.isArray(o.sprites)) throw new Error('El proyecto no tiene sprites.');
  return {
    version: o.version,
    kind: JOA_PROJECT_KIND,
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
    columnView: o.columnView === true,
    columns: normalizeSpriteColumns(o.columns),
    rows: normalizeSpriteRows(o.rows),
    collapsedColumns: normalizeIdList(o.collapsedColumns),
    collapsedRows: normalizeIdList(o.collapsedRows),
    rowLabelWidth: clampNum(o.rowLabelWidth, ROW_LABEL_WIDTH_MIN, ROW_LABEL_WIDTH_MAX, ROW_LABEL_WIDTH_DEFAULT),
    rowLabelsCollapsed: o.rowLabelsCollapsed === true,
    referenceId: typeof o.referenceId === 'string' ? o.referenceId : null,
    sprites: o.sprites as JoaProjectSpriteMeta[],
  };
};

type LoadedJoaProject = {
  sprites: SpriteData[];
  columns: SpriteColumn[];
  rows: SpriteRow[];
  collapsedColumns: string[];
  collapsedRows: string[];
  rowLabelWidth: number;
  rowLabelsCollapsed: boolean;
  columnView: boolean;
  referenceId: string | null;
};

const loadJoaProjectFromBlob = async (blob: Blob): Promise<LoadedJoaProject> => {
  if (!blob || blob.size === 0) {
    throw new Error('El archivo está vacío (0 bytes). El guardado falló: volvé a guardar el proyecto.');
  }
  if (blob.size < MIN_ZIP_BYTES) {
    throw new Error('El archivo es demasiado pequeño para ser un proyecto JOA válido.');
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await blob.arrayBuffer());
  } catch (err) {
    console.error(err);
    throw new Error('No se pudo leer el ZIP. Puede estar corrupto o incompleto — guardá una copia nueva del proyecto.');
  }
  const jsonEntry = findZipEntry(zip, 'project.json');
  if (!jsonEntry) throw new Error('El archivo no es un proyecto JOA (falta project.json).');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await jsonEntry.async('string'));
  } catch {
    throw new Error('No se pudo leer project.json.');
  }
  const project = parseJoaProjectJson(parsed);
  const sprites: SpriteData[] = [];
  for (const meta of project.sprites) {
    if (!meta || typeof meta !== 'object' || typeof meta.id !== 'string') continue;
    const imgEntry = resolveProjectImageEntry(zip, meta, 'main');
    if (!imgEntry) throw new Error(`Falta la imagen de ${meta.name || meta.id}.`);
    const img = await loadImageFromBlob(await imgEntry.async('blob'));
    let originalImg = img;
    if (typeof meta.originalImage === 'string' && isSafeZipPath(meta.originalImage)) {
      const origEntry = resolveProjectImageEntry(zip, meta, 'original');
      if (origEntry) originalImg = await loadImageFromBlob(await origEntry.async('blob'));
    }
    const { image: _image, originalImage: _originalImage, ...rest } = meta;
    const padding = meta.padding && typeof meta.padding === 'object'
      ? {
          top: Number(meta.padding.top) || 0,
          bottom: Number(meta.padding.bottom) || 0,
          left: Number(meta.padding.left) || 0,
          right: Number(meta.padding.right) || 0,
        }
      : { top: 0, bottom: 0, left: 0, right: 0 };
    const anchor = meta.anchor && typeof meta.anchor === 'object'
      ? { x: Number(meta.anchor.x) || 0, y: Number(meta.anchor.y) || 0 }
      : { x: Math.floor(img.width / 2), y: Math.floor(img.height / 2) };
    sprites.push({
      ...(rest as Omit<SpriteData, 'img' | 'originalImg' | 'padding' | 'anchor'>),
      id: meta.id,
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name : `${meta.id}.png`,
      img,
      originalImg,
      padding,
      anchor,
    });
  }
  if (sprites.length === 0) throw new Error('El proyecto no contiene sprites válidos.');
  const ids = new Set(sprites.map((s) => s.id));
  return {
    sprites,
    columns: project.columns,
    rows: project.rows || normalizeSpriteRows([]),
    collapsedColumns: project.collapsedColumns || [],
    collapsedRows: project.collapsedRows || [],
    rowLabelWidth: project.rowLabelWidth ?? ROW_LABEL_WIDTH_DEFAULT,
    rowLabelsCollapsed: project.rowLabelsCollapsed === true,
    columnView: project.columnView,
    referenceId: project.referenceId && ids.has(project.referenceId) ? project.referenceId : null,
  };
};


// --- Sprite Module Component ---
interface SpriteModuleProps {
  sprite: SpriteData;
  isSelected: boolean;
  onToggleSelect: (id: string, multi: boolean) => void;
  onRemove: (id: string) => void;
  onSetAnchor: (id: string, x: number, y: number) => void;
  onSetReference: (id: string) => void;
  onOpenEraser: (id: string) => void;
  onOpenGhostCompare: (id: string) => void;
  onOpenReplace: (id: string) => void;
  onOpenCopyRect: (id: string) => void;
  onOpenPixelEditor: (id: string) => void;
  onOpenTransform: (id: string) => void;
  onOpenTagging: (id: string) => void;
  onOpenPaint: (id: string) => void;
  onOpenBucket: (id: string) => void;
  onOpenStretch: (id: string) => void;
  onOpenComposite: (id: string, size?: number) => void;
  onExport: (id: string, format?: 'png' | 'jpg' | 'ico' | 'dds') => void;
  onFocusResolution?: (id: string) => void;
  onUpdateSprite: (id: string, updates: Partial<SpriteData>) => void;
  isReference?: boolean;
  isWhiteBg?: boolean;
  quadrantView?: boolean;
  onOpenQuadrantPreview?: (id: string) => void;
}

const SpriteModule: React.FC<SpriteModuleProps> = ({ sprite, isSelected, onToggleSelect, onRemove, onSetAnchor, onSetReference, onOpenEraser, onOpenGhostCompare, onOpenReplace, onOpenCopyRect, onOpenPixelEditor, onOpenTransform, onOpenTagging, onOpenPaint, onOpenBucket, onOpenStretch, onOpenComposite, onExport, onFocusResolution, onUpdateSprite, isReference, isWhiteBg, quadrantView, onOpenQuadrantPreview }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const quadrantPointerRef = useRef<{ x: number; y: number } | null>(null);
  const leftClickTimerRef = useRef<number | null>(null);
  const rightClickTimerRef = useRef<number | null>(null);
  const [toolsMenu, setToolsMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const { padding } = sprite;
    const scX = (sprite.scale || 1) * (sprite.stretchX || 1);
    const scY = (sprite.scale || 1) * (sprite.stretchY || 1);
    const sw = sprite.img.width * scX;
    const sh = sprite.img.height * scY;
    const w = Math.max(1, sw + padding.left + padding.right);
    const h = Math.max(1, sh + padding.top + padding.bottom);

    canvas.width = w * window.devicePixelRatio;
    canvas.height = h * window.devicePixelRatio;
    canvas.style.width = `100%`;
    canvas.style.height = `100%`;
    canvas.style.objectFit = 'contain';
    canvas.style.imageRendering = 'pixelated';

    ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    ctx.imageSmoothingEnabled = false;
    renderSpriteToContext(ctx, sprite, false);
  }, [sprite]);

  useEffect(() => {
    const redraw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
      ctx.imageSmoothingEnabled = false;
      renderSpriteToContext(ctx, sprite, false);
    };
    window.addEventListener('brushmask-loaded', redraw);
    return () => window.removeEventListener('brushmask-loaded', redraw);
  }, [sprite]);


  const [isDragging, setIsDragging] = useState(false);
  const [compareDraft, setCompareDraft] = useState(sprite.compareValue ?? '');

  useEffect(() => {
    setCompareDraft(sprite.compareValue ?? '');
  }, [sprite.id, sprite.compareValue]);

  const commitCompareValue = () => {
    const next = compareDraft.trim();
    const prev = (sprite.compareValue ?? '').trim();
    if (next === prev) return;
    onUpdateSprite(sprite.id, { compareValue: next || undefined });
  };

  useEffect(() => {
    if (!toolsMenu) return;
    const clickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setToolsMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setToolsMenu(null);
    };
    window.addEventListener('mousedown', clickOutside);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', clickOutside);
      window.removeEventListener('keydown', onKey);
    };
  }, [toolsMenu]);

  const openToolsMenuAt = (x: number, y: number) => {
    const w = 230;
    const h = Math.min(420, window.innerHeight - 16);
    setToolsMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    });
  };

  const closeTools = () => setToolsMenu(null);

  useEffect(() => () => {
    if (leftClickTimerRef.current) window.clearTimeout(leftClickTimerRef.current);
    if (rightClickTimerRef.current) window.clearTimeout(rightClickTimerRef.current);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      
      const internalX = clickX * (canvas.width / rect.width) / window.devicePixelRatio;
      const internalY = clickY * (canvas.height / rect.height) / window.devicePixelRatio;

      const imgX = Math.round((internalX - sprite.padding.left) / (sprite.stretchX || 1));
      const imgY = Math.round((internalY - sprite.padding.top) / (sprite.stretchY || 1));

      onSetAnchor(sprite.id, imgX, imgY);
    };

    const handleMouseUp = () => setIsDragging(false);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, sprite.id, sprite.padding, onSetAnchor]);
  const handleAddText = async () => {
    const text = prompt('Escribe el texto a añadir a la imagen:');
    if (!text) return;
    const size = promptLastInt(
      LAST_ADD_TEXT_SIZE_KEY,
      'Elige el tamaño del texto (en píxeles):',
      16,
      { min: 1, max: 4096 },
    );
    if (size === null) return;

    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = sprite.img.width;
    tmpCanvas.height = sprite.img.height;
    const ctx = tmpCanvas.getContext('2d')!;
    
    ctx.drawImage(sprite.img, 0, 0);

    ctx.font = `${size}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    
    ctx.lineWidth = Math.max(1, Math.floor(size / 8));
    ctx.strokeStyle = 'black';
    ctx.strokeText(text, tmpCanvas.width - 2, 2);
    
    ctx.fillStyle = 'white';
    ctx.fillText(text, tmpCanvas.width - 2, 2);

    const newImg = await new Promise<HTMLImageElement>((res, rej) => {
      const image = new Image();
      image.onload = () => res(image);
      image.onerror = rej;
      image.src = tmpCanvas.toDataURL('image/png');
    });

    onUpdateSprite(sprite.id, { img: newImg, originalImg: newImg });
  };

  return (
    <div className={`sprite-module ${isSelected ? 'selected' : ''} ${isReference ? 'reference' : ''} ${toolsMenu ? 'tools-open' : ''} ${quadrantView ? 'is-quadrant' : ''}`} 
         onPointerDown={(e) => {
           if (!quadrantView) return;
           quadrantPointerRef.current = { x: e.clientX, y: e.clientY };
         }}
         onContextMenu={(e) => {
           e.preventDefault();
           e.stopPropagation();
           if ((e.target as HTMLElement).closest('input, textarea, button')) return;
           closeTools();
           // Segundo clic derecho antes de abrir el menú = mismo Exportar PNG del menú.
           if (rightClickTimerRef.current) {
             window.clearTimeout(rightClickTimerRef.current);
             rightClickTimerRef.current = null;
             onExport(sprite.id, 'png');
             return;
           }
           const { clientX, clientY, shiftKey, ctrlKey, metaKey } = e;
           rightClickTimerRef.current = window.setTimeout(() => {
             rightClickTimerRef.current = null;
             onToggleSelect(sprite.id, shiftKey || ctrlKey || metaKey);
             openToolsMenuAt(clientX, clientY);
           }, 500);
         }}
         onDoubleClick={(e) => {
           if ((e.target as HTMLElement).closest('input, textarea, button')) return;
           e.preventDefault();
           e.stopPropagation();
           if (leftClickTimerRef.current) {
             window.clearTimeout(leftClickTimerRef.current);
             leftClickTimerRef.current = null;
           }
           onFocusResolution?.(sprite.id);
         }}
         onClick={(e) => {
           if (e.shiftKey || e.ctrlKey || e.metaKey) {
             onToggleSelect(sprite.id, true);
             return;
           }
           if (e.detail > 1) return;
           if (quadrantView && onOpenQuadrantPreview) {
             const start = quadrantPointerRef.current;
             quadrantPointerRef.current = null;
             const moved = start
               ? Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8
               : false;
             if (!moved) {
               if (leftClickTimerRef.current) window.clearTimeout(leftClickTimerRef.current);
               leftClickTimerRef.current = window.setTimeout(() => {
                 leftClickTimerRef.current = null;
                 onToggleSelect(sprite.id, false);
                 onOpenQuadrantPreview(sprite.id);
               }, 280);
               return;
             }
           }
           onToggleSelect(sprite.id, false);
         }}>
      <div className="module-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isSelected ? <CheckSquare size={14} color="#6b66ff" /> : <Square size={14} color="var(--text-muted)" />}
          <span className="module-title">{sprite.name}</span>
        </div>
        <div style={{ display: 'flex', gap: '4px', position: 'relative' }}>
          <button className={`btn-ghost ${toolsMenu ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (toolsMenu) {
                closeTools();
                return;
              }
              const r = e.currentTarget.getBoundingClientRect();
              openToolsMenuAt(r.right - 220, r.bottom + 6);
            }}
            title="Herramientas"
          >
            <MoreHorizontal size={14} />
          </button>
          
          <button className="btn-ghost" 
            style={{ color: isReference ? '#ffcc00' : undefined }}
            onClick={(e) => { e.stopPropagation(); onSetReference(sprite.id); }}
            title="Establecer como Referencia"
          >
            <Target size={14} />
          </button>
          <button className="btn-ghost" onClick={(e) => { e.stopPropagation(); onRemove(sprite.id); }} title="Eliminar">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      
      <div className={`module-canvas-area checker-mini ${isWhiteBg ? 'white-bg' : ''}`} style={{ position: 'relative' }}>
        <canvas ref={canvasRef} />
        {sprite.effectMaskMode !== 'brush' && getEffectMasks(sprite).map((mask) => {
          const overlay = getEffectMaskOverlayPercents(sprite, mask);
          return (
            <div
              key={mask.id}
              style={{
                position: 'absolute',
                left: `${overlay.left}%`,
                top: `${overlay.top}%`,
                width: `${overlay.width}%`,
                height: `${overlay.height}%`,
                border: '2px solid #6b66ff',
                background: 'rgba(107, 102, 255, 0.15)',
                pointerEvents: 'none',
                boxSizing: 'border-box',
              }}
            />
          );
        })}
        {sprite.anchor && (
          <div className="anchor-crosshair" 
            style={{ 
              left: `${(((sprite.anchor.x * (sprite.scale || 1) * (sprite.stretchX || 1)) + sprite.padding.left) / ((sprite.img.width * (sprite.scale || 1) * (sprite.stretchX || 1)) + sprite.padding.left + sprite.padding.right)) * 100}%`,
              top: `${(((sprite.anchor.y * (sprite.scale || 1) * (sprite.stretchY || 1)) + sprite.padding.top) / ((sprite.img.height * (sprite.scale || 1) * (sprite.stretchY || 1)) + sprite.padding.top + sprite.padding.bottom)) * 100}%`,
              cursor: 'move',
              pointerEvents: 'auto'
            }} 
            onMouseDown={(e) => { e.stopPropagation(); setIsDragging(true); }}
          />
        )}
        {isReference && <div className="reference-badge">REF</div>}
        {(() => {
          if (!hasActiveEffectMask(sprite)) return null;
          const isBrush = sprite.effectMaskMode === 'brush';
          const count = isBrush ? 1 : getEffectMasks(sprite).length;
          return (
            <div className="reference-badge" style={{ background: '#6b66ff', right: 'auto', left: '8px' }}>
              {isBrush ? 'PINCEL' : `ÁREA${count > 1 ? ` ×${count}` : ''}`}
            </div>
          );
        })()}
        <div
          className="sprite-compare-value"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            value={compareDraft}
            placeholder="—"
            inputMode="decimal"
            spellCheck={false}
            draggable={false}
            title="Número de comparación (solo interfaz, no se guarda en la imagen)"
            onChange={(e) => setCompareDraft(e.target.value)}
            onBlur={commitCompareValue}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                setCompareDraft(sprite.compareValue ?? '');
                e.currentTarget.blur();
              }
            }}
            onDragStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        </div>
      </div>

      <div className="module-footer">
        <span className="badge">Res: {(sprite.img.width * (sprite.scale || 1) * (sprite.stretchX || 1)).toFixed(0)}×{(sprite.img.height * (sprite.scale || 1) * (sprite.stretchY || 1)).toFixed(0)}</span>
        <span className="badge badge-accent">
          Full: {(sprite.img.width * (sprite.scale || 1) * (sprite.stretchX || 1) + sprite.padding.left + sprite.padding.right).toFixed(0)}×{(sprite.img.height * (sprite.scale || 1) * (sprite.stretchY || 1) + sprite.padding.top + sprite.padding.bottom).toFixed(0)}
        </span>
      </div>
      {toolsMenu && createPortal(
        <div
          className="tools-dropdown is-context"
          ref={dropdownRef}
          style={{ left: toolsMenu.x, top: toolsMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {onOpenQuadrantPreview && (
            <button type="button" className="dropdown-item" onClick={() => { onOpenQuadrantPreview(sprite.id); closeTools(); }}>
              <Maximize2 size={12} /> Ver en grande
            </button>
          )}
          <button type="button" className="dropdown-item" onClick={() => { onExport(sprite.id, 'png'); closeTools(); }}>
            <Save size={12} /> Exportar PNG
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onExport(sprite.id, 'jpg'); closeTools(); }}>
            <Save size={12} /> Exportar JPG
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onOpenPaint(sprite.id); closeTools(); }}>
            <Pencil size={12} /> Pintar
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onOpenTagging(sprite.id); closeTools(); }}>
            <MapPin size={12} /> Zonas (Tags)
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onOpenTransform(sprite.id); closeTools(); }}>
            <RotateCcw size={12} /> Transformar
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onOpenEraser(sprite.id); closeTools(); }}>
            <Eraser size={12} /> Goma (Borrador)
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onOpenGhostCompare(sprite.id); closeTools(); }}>
            <Layers size={12} /> Comparar overlay
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onOpenReplace(sprite.id); closeTools(); }}>
            <Stamp size={12} /> Reemplazar de...
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onOpenCopyRect(sprite.id); closeTools(); }}>
            <Crop size={12} /> Copiar recorte
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onOpenPixelEditor(sprite.id); closeTools(); }}>
            <Grid size={12} /> Editor Pixel Art
          </button>
          <button type="button" className="dropdown-item" onClick={() => { handleAddText(); closeTools(); }}>
            <Type size={12} /> Añadir Texto
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onOpenBucket(sprite.id); closeTools(); }}>
            <PaintBucket size={12} /> Color Swap (Balde)
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onOpenStretch(sprite.id); closeTools(); }}>
            <Maximize size={12} /> Estirar (Resize)
          </button>
          <button type="button" className="dropdown-item" onClick={() => {
            const fallback = Math.max(8192, sprite.img.width, sprite.img.height);
            const size = promptLastInt(
              LAST_COMPOSITE_SIZE_KEY,
              '¿Tamaño del lienzo de trabajo (en píxeles)?',
              fallback,
              { min: 1, max: 32768 },
            );
            if (size !== null) onOpenComposite(sprite.id, size);
            closeTools();
          }}>
            <Layers size={12} /> Componer (Collage)
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onExport(sprite.id, 'ico'); closeTools(); }}>
            <Save size={12} /> Exportar como .ICO
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onExport(sprite.id, 'dds'); closeTools(); }}>
            <Layers size={12} /> Exportar como .DDS
          </button>
          <div className="dropdown-sep" />
          <button type="button" className="dropdown-item" onClick={() => { onUpdateSprite(sprite.id, { flipH: !sprite.flipH }); closeTools(); }}>
            <FlipHorizontal size={12} /> Invertir Horizontal
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onUpdateSprite(sprite.id, { flipV: !sprite.flipV }); closeTools(); }}>
            <FlipVertical size={12} /> Invertir Vertical
          </button>
          <button type="button" className="dropdown-item" onClick={() => { onSetReference(sprite.id); closeTools(); }}>
            <Target size={12} /> {isReference ? 'Quitar referencia' : 'Usar como referencia'}
          </button>
          <div className="dropdown-sep" />
          <button type="button" className="dropdown-item is-danger" onClick={() => { onRemove(sprite.id); closeTools(); }}>
            <Trash2 size={12} /> Eliminar
          </button>
        </div>,
        document.body
      )}
    </div>
  );
};

const QuadrantPreviewPane: React.FC<{
  sprite: SpriteData;
  fit: number;
  isWhiteBg?: boolean;
  compareNumberSize: number;
  onRemove?: () => void;
}> = ({ sprite, fit, isWhiteBg, compareNumberSize, onRemove }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sprite.img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = getSpriteFrameSize(sprite);
    canvas.width = w * window.devicePixelRatio;
    canvas.height = h * window.devicePixelRatio;
    canvas.style.width = `${Math.max(1, Math.floor(w * fit))}px`;
    canvas.style.height = `${Math.max(1, Math.floor(h * fit))}px`;
    canvas.style.imageRendering = 'pixelated';
    ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    ctx.imageSmoothingEnabled = false;
    renderSpriteToContext(ctx, sprite, false);
  }, [sprite, fit]);

  const compareLabel = (sprite.compareValue ?? '').trim();

  return (
    <div className="quadrant-preview-pane">
      <div className="quadrant-preview-pane-name">
        <span>{sprite.name}</span>
        {onRemove && (
          <button type="button" className="btn-ghost" title="Quitar" onClick={onRemove}>
            <X size={14} />
          </button>
        )}
      </div>
      <div className={`quadrant-preview-canvas checker-mini ${isWhiteBg ? 'white-bg' : ''}`}>
        <canvas ref={canvasRef} />
        {compareLabel && (
          <div
            className="sprite-compare-value"
            style={{ '--compare-num-size': `${Math.max(compareNumberSize, 40)}px` } as React.CSSProperties}
          >
            <span>{compareLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
};

const QuadrantPreviewOverlay: React.FC<{
  sprites: SpriteData[];
  picking: boolean;
  isWhiteBg?: boolean;
  compareNumberSize: number;
  neighbors: { prev: string | null; next: string | null; up: string | null; down: string | null };
  onBrowse: (id: string) => void;
  onClose: () => void;
  onStartPick: () => void;
  onCancelPick: () => void;
  onRemove: (id: string) => void;
}> = ({
  sprites, picking, isWhiteBg, compareNumberSize, neighbors,
  onBrowse, onClose, onStartPick, onCancelPick, onRemove,
}) => {
  const [fit, setFit] = useState(1);
  const pair = sprites.length > 1;
  const canBrowse = !picking && !!(neighbors.prev || neighbors.next);

  useEffect(() => {
    const update = () => {
      if (sprites.length === 0) return;
      const chromeH = 64;
      const gap = pair ? 24 : 0;
      const availableW = Math.max(160, window.innerWidth - 24);
      const availableH = Math.max(160, window.innerHeight - chromeH);
      const maxW = pair ? Math.floor((availableW - gap) / 2) : availableW;
      const maxH = availableH;
      const sizes = sprites.map(getSpriteFrameSize);
      const next = Math.min(...sizes.map((s) => Math.min(maxW / s.w, maxH / s.h)));
      setFit(Number.isFinite(next) && next > 0 ? next : 1);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [sprites, pair]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (picking) onCancelPick();
        else onClose();
        return;
      }
      if (picking) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const go =
        e.key === 'ArrowLeft' ? neighbors.prev
        : e.key === 'ArrowRight' ? neighbors.next
        : e.key === 'ArrowUp' ? neighbors.up
        : e.key === 'ArrowDown' ? neighbors.down
        : null;
      if (!go) return;
      e.preventDefault();
      onBrowse(go);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking, neighbors, onBrowse, onClose, onCancelPick]);

  const title = pair
    ? `${sprites[0].name}  vs  ${sprites[1].name}`
    : sprites[0]?.name || 'Vista grande';

  return (
    <div
      className={`quadrant-preview-overlay${pair ? ' is-pair' : ''}${picking ? ' is-picking' : ''}`}
      role="dialog"
      aria-label={picking ? 'Elegir sprite para comparar' : 'Vista grande del cuadrante'}
      onClick={picking ? undefined : onClose}
    >
      {canBrowse && neighbors.prev && (
        <button
          type="button"
          className="quadrant-preview-nav is-prev"
          title="Anterior (←)"
          onClick={(e) => { e.stopPropagation(); onBrowse(neighbors.prev!); }}
        >
          <ChevronLeft size={48} strokeWidth={1.6} />
        </button>
      )}
      {canBrowse && neighbors.next && (
        <button
          type="button"
          className="quadrant-preview-nav is-next"
          title="Siguiente (→)"
          onClick={(e) => { e.stopPropagation(); onBrowse(neighbors.next!); }}
        >
          <ChevronRight size={48} strokeWidth={1.6} />
        </button>
      )}
      <div className="quadrant-preview-stage" onClick={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
        <div className="quadrant-preview-bar">
          <span className="quadrant-preview-title">
            {picking ? 'Click un sprite de la grilla para comparar' : title}
          </span>
          <div className="quadrant-preview-bar-actions">
            {picking ? (
              <button type="button" className="btn btn-outline" onClick={onCancelPick}>
                Cancelar
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-outline"
                onClick={onStartPick}
                title="Ver la grilla y elegir otro sprite"
              >
                <Columns2 size={14} />
                {pair ? 'Cambiar' : 'Comparar'}
              </button>
            )}
            <button type="button" className="btn-ghost" onClick={onClose} title="Cerrar (Esc)">
              <X size={18} />
            </button>
          </div>
        </div>
        {!picking && (
          <div className={`quadrant-preview-pair${pair ? ' is-pair' : ''}`}>
            {sprites.map((sprite, idx) => (
              <QuadrantPreviewPane
                key={sprite.id}
                sprite={sprite}
                fit={fit}
                isWhiteBg={isWhiteBg}
                compareNumberSize={compareNumberSize}
                onRemove={pair && idx === 1 ? () => onRemove(sprite.id) : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// --- Pixel Art Editor Modal ---
interface PixelEditorModalProps {
  sprite: SpriteData;
  onSave: (id: string, newImg: HTMLImageElement) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

type PEdTool = 'select' | 'pencil' | 'eraser' | 'fill' | 'eyedropper' | 'move';

const PixelEditorModal: React.FC<PixelEditorModalProps> = ({ sprite, onSave, onClose, isWhiteBg }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const [zoom, setZoom] = useState(() => {
    const savedZoom = loadPref<number>('joa-pixel-editor-zoom', 0);
    if (savedZoom >= 1 && savedZoom <= 32) return savedZoom;
    const fit = Math.min(Math.floor(700 / sprite.img.width), Math.floor(600 / sprite.img.height));
    return Math.max(1, Math.min(fit, 16));
  });
  const [tool, setTool] = useState<PEdTool>(() => {
    const saved = loadPref<PEdTool>('joa-pixel-editor-tool', 'pencil');
    return (['select', 'pencil', 'eraser', 'fill', 'eyedropper', 'move'] as PEdTool[]).includes(saved) ? saved : 'pencil';
  });
  const [color, setColor] = useState(() => {
    const saved = loadPref<string>('joa-pixel-editor-color', '');
    return normalizeHexColor(saved, loadLastColor('#ffffff')) || '#ffffff';
  });
  const [brushSize, setBrushSize] = useState(() => Math.round(clampNum(loadPref('joa-pixel-editor-brush', 1), 1, 32, 1)));
  const { workspaceRef, onWorkspaceScroll } = useRememberedScroll('joa-pixel-editor-scroll', sprite.name);
  useModalWheelControls({
    zoom, setZoom, zoomMin: 0.1, zoomMax: 32, zoomStep: 0.1,
    brushSize, setBrushSize, brushMin: 1, brushMax: 32,
    workspaceRef,
  });
  const [history, setHistory] = useState<ImageData[]>([]);
  const [clipboard, setClipboard] = useState<ImageData | null>(null);
  const [sel, setSel] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const selRef = useRef<typeof sel>(null);
  const [selDrag, setSelDrag] = useState<{ startX: number; startY: number } | null>(null);
  const [moveOffset, setMoveOffset] = useState<{ dx: number; dy: number } | null>(null);
  const isDrawing = useRef(false);
  const lastPx = useRef<{ x: number; y: number } | null>(null);

  // Init canvas with sprite image
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = sprite.img.width;
    canvas.height = sprite.img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sprite.img, 0, 0);
  }, [sprite.img]);

  useEffect(() => {
    savePref('joa-pixel-editor-zoom', zoom);
    savePref('joa-pixel-editor-tool', tool);
    savePref('joa-pixel-editor-color', color);
    savePref('joa-pixel-editor-brush', brushSize);
    rememberLastColor(color);
  }, [zoom, tool, color, brushSize]);

  const saveHistory = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setHistory(h => [...h.slice(-30), data]);
  };

  const undo = () => {
    if (history.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const prev = history[history.length - 1];
    ctx.putImageData(prev, 0, 0);
    setHistory(h => h.slice(0, -1));
  };

  const hexToRgba = (hex: string): [number, number, number, number] => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b, 255];
  };

  const rgbaToHex = (r: number, g: number, b: number) =>
    '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

  const getPixelCoords = (e: React.MouseEvent): { x: number; y: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.floor((e.clientX - rect.left) / zoom),
      y: Math.floor((e.clientY - rect.top) / zoom),
    };
  };

  const drawPixelBlock = (ctx: CanvasRenderingContext2D, px: number, py: number) => {
    const half = Math.floor(brushSize / 2);
    ctx.fillStyle = tool === 'eraser' ? 'rgba(0,0,0,0)' : color;
    if (tool === 'eraser') {
      ctx.clearRect(px - half, py - half, brushSize, brushSize);
    } else {
      ctx.fillRect(px - half, py - half, brushSize, brushSize);
    }
  };

  const floodFill = (startX: number, startY: number) => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    const w = canvas.width;
    const h = canvas.height;
    const idx = (startY * w + startX) * 4;
    const tr = d[idx]; const tg = d[idx + 1]; const tb = d[idx + 2]; const ta = d[idx + 3];
    const [fr, fg, fb, fa] = hexToRgba(color);
    if (tr === fr && tg === fg && tb === fb && ta === fa) return;
    const stack = [startX + startY * w];
    while (stack.length) {
      const pos = stack.pop()!;
      const x = pos % w;
      const y = Math.floor(pos / w);
      const i = pos * 4;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      if (d[i] !== tr || d[i+1] !== tg || d[i+2] !== tb || d[i+3] !== ta) continue;
      d[i] = fr; d[i+1] = fg; d[i+2] = fb; d[i+3] = fa;
      stack.push(pos - 1, pos + 1, pos - w, pos + w);
    }
    ctx.putImageData(imgData, 0, 0);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const { x, y } = getPixelCoords(e);
    const canvas = canvasRef.current!;
    if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return;

    if (tool === 'eyedropper') {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const px = ctx.getImageData(x, y, 1, 1).data;
      const hex = rememberLastColor(rgbaToHex(px[0], px[1], px[2]));
      if (hex) setColor(hex);
      setTool('pencil');
      return;
    }
    if (tool === 'fill') {
      saveHistory();
      floodFill(x, y);
      return;
    }
    if (tool === 'select') {
      setSelDrag({ startX: x, startY: y });
      setSel(null);
      selRef.current = null;
      return;
    }
    if (tool === 'move') {
      if (!sel) return;
      setMoveOffset({ dx: x - sel.x, dy: y - sel.y });
      isDrawing.current = true;
      return;
    }
    saveHistory();
    isDrawing.current = true;
    lastPx.current = { x, y };
    const ctx = canvas.getContext('2d')!;
    drawPixelBlock(ctx, x, y);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const { x, y } = getPixelCoords(e);
    const canvas = canvasRef.current!;
    const ov = overlayRef.current!;
    const ovCtx = ov.getContext('2d')!;
    ovCtx.clearRect(0, 0, ov.width, ov.height);

    if (selDrag) {
      const sx = Math.min(selDrag.startX, x);
      const sy = Math.min(selDrag.startY, y);
      const sw = Math.abs(x - selDrag.startX) + 1;
      const sh = Math.abs(y - selDrag.startY) + 1;
      ovCtx.strokeStyle = '#00d4ff';
      ovCtx.lineWidth = 1 / zoom;
      ovCtx.setLineDash([3 / zoom, 3 / zoom]);
      ovCtx.strokeRect(sx, sy, sw, sh);
      return;
    }

    if (sel) {
      ovCtx.strokeStyle = '#00d4ff';
      ovCtx.lineWidth = 1 / zoom;
      ovCtx.setLineDash([3 / zoom, 3 / zoom]);
      ovCtx.strokeRect(sel.x, sel.y, sel.w, sel.h);
    }

    if (tool === 'move' && isDrawing.current && sel && moveOffset) {
      const nx = x - moveOffset.dx;
      const ny = y - moveOffset.dy;
      setSel(prev => prev ? { ...prev, x: nx, y: ny } : prev);
      return;
    }

    if (!isDrawing.current) return;
    const ctx = canvas.getContext('2d')!;
    // Bresenham line from lastPx to current
    const lp = lastPx.current || { x, y };
    let { x: x0, y: y0 } = lp;
    let { x: x1, y: y1 } = { x, y };
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx2 = x0 < x1 ? 1 : -1, sy2 = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
      drawPixelBlock(ctx, x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx2; }
      if (e2 < dx) { err += dx; y0 += sy2; }
    }
    lastPx.current = { x, y };
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    isDrawing.current = false;
    setMoveOffset(null);
    if (selDrag) {
      const { x, y } = getPixelCoords(e);
      const sx = Math.min(selDrag.startX, x);
      const sy = Math.min(selDrag.startY, y);
      const sw = Math.abs(x - selDrag.startX) + 1;
      const sh = Math.abs(y - selDrag.startY) + 1;
      const newSel = { x: sx, y: sy, w: sw, h: sh };
      setSel(newSel);
      selRef.current = newSel;
      setSelDrag(null);
    }
  };

  const copySelection = () => {
    if (!sel) return;
    const ctx = canvasRef.current!.getContext('2d', { willReadFrequently: true })!;
    const data = ctx.getImageData(sel.x, sel.y, sel.w, sel.h);
    setClipboard(data);
  };

  const cutSelection = () => {
    if (!sel) return;
    saveHistory();
    copySelection();
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.clearRect(sel.x, sel.y, sel.w, sel.h);
  };

  const pasteClipboard = () => {
    if (!clipboard) return;
    saveHistory();
    const ctx = canvasRef.current!.getContext('2d')!;
    const tmp = document.createElement('canvas');
    tmp.width = clipboard.width; tmp.height = clipboard.height;
    tmp.getContext('2d')!.putImageData(clipboard, 0, 0);
    const px = sel ? sel.x : 0;
    const py = sel ? sel.y : 0;
    ctx.drawImage(tmp, px, py);
  };

  const deleteSelection = () => {
    if (!sel) return;
    saveHistory();
    canvasRef.current!.getContext('2d')!.clearRect(sel.x, sel.y, sel.w, sel.h);
  };

  const selectAll = () => {
    const c = canvasRef.current!;
    const all = { x: 0, y: 0, w: c.width, h: c.height };
    setSel(all);
    selRef.current = all;
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'z') { e.preventDefault(); undo(); }
      if (ctrl && e.key === 'c') { e.preventDefault(); copySelection(); }
      if (ctrl && e.key === 'x') { e.preventDefault(); cutSelection(); }
      if (ctrl && e.key === 'v') { e.preventDefault(); pasteClipboard(); }
      if (ctrl && e.key === 'a') { e.preventDefault(); selectAll(); }
      if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
      if (e.key === 'p') setTool('pencil');
      if (e.key === 'e') setTool('eraser');
      if (e.key === 's') setTool('select');
      if (e.key === 'f') setTool('fill');
      if (e.key === 'i') setTool('eyedropper');
      if (e.key === 'm') setTool('move');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const handleSave = () => {
    const canvas = canvasRef.current!;
    const newImg = new Image();
    newImg.onload = () => onSave(sprite.id, newImg);
    newImg.src = canvas.toDataURL('image/png');
  };

  const btnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? 'var(--accent)' : 'var(--surface-2)',
    color: active ? '#fff' : 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    padding: '6px 8px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    fontWeight: 600,
  });

  const W = sprite.img.width * zoom;
  const H = sprite.img.height * zoom;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.88)',
      display: 'flex', flexDirection: 'column',
    }} onMouseLeave={() => { isDrawing.current = false; setSelDrag(null); }}>
      {/* Header */}
      <div style={{
        padding: '8px 16px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap'
      }}>
        <span style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent)' }}>Editor Pixel Art — {sprite.name}</span>
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {(['select','pencil','eraser','fill','eyedropper','move'] as PEdTool[]).map(t => (
            <button key={t} style={btnStyle(tool === t)} onClick={() => setTool(t)} title={`${t} (${({select:'s',pencil:'p',eraser:'e',fill:'f',eyedropper:'i',move:'m'}[t])})`}>
              {t === 'select' && '⬜'}
              {t === 'pencil' && '✏️'}
              {t === 'eraser' && '🧹'}
              {t === 'fill' && '🪣'}
              {t === 'eyedropper' && '💉'}
              {t === 'move' && '✋'}
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <button style={btnStyle(false)} onClick={cutSelection} disabled={!sel} title="Ctrl+X">✂️ Cortar</button>
          <button style={btnStyle(false)} onClick={copySelection} disabled={!sel} title="Ctrl+C">📋 Copiar</button>
          <button style={btnStyle(false)} onClick={pasteClipboard} disabled={!clipboard} title="Ctrl+V">📌 Pegar</button>
          <button style={btnStyle(false)} onClick={deleteSelection} disabled={!sel} title="Delete">🗑️ Borrar</button>
          <button style={btnStyle(false)} onClick={selectAll} title="Ctrl+A">⬜ Todo</button>
          <button style={btnStyle(false)} onClick={undo} title="Ctrl+Z">↩️ Deshacer</button>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Color:</label>
          <input type="color" value={color} onChange={e => setColor(e.target.value)}
            style={{ width: '28px', height: '28px', padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} />
          <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Pincel:</label>
          <input type="range" min={1} max={32} value={brushSize} onChange={e => setBrushSize(Number(e.target.value))}
            style={{ width: '80px' }} />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{brushSize}px</span>
          <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Zoom:</label>
          <input type="range" min={0.1} max={32} step={0.1} value={zoom} onChange={e => setZoom(Number(e.target.value))}
            style={{ width: '80px' }} />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{zoom.toFixed(1)}x</span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
          <button style={btnStyle(false)} onClick={handleSave}>💾 Guardar</button>
          <button style={{ ...btnStyle(false), borderColor: '#ff4444', color: '#ff4444' }} onClick={onClose}>✕ Cerrar</button>
        </div>
      </div>

      {/* Canvas area */}
      <div
        ref={workspaceRef}
        onScroll={onWorkspaceScroll}
        style={{
        flex: 1, overflow: 'auto',
        background: isWhiteBg ? '#fff' : 'repeating-conic-gradient(#1a1a1a 0% 25%, #252525 0% 50%) 0 0 / 16px 16px',
      }}>
        <div style={{ position: 'relative', width: W, height: H, imageRendering: 'pixelated', flexShrink: 0 }}>
          <canvas ref={canvasRef}
            style={{ position: 'absolute', top: 0, left: 0, width: W, height: H, imageRendering: 'pixelated',
              cursor: ({ select: 'crosshair', pencil: 'crosshair', eraser: 'cell', fill: 'copy', eyedropper: 'zoom-in', move: 'move' }[tool]) }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          />
          <canvas ref={overlayRef}
            width={sprite.img.width} height={sprite.img.height}
            style={{ position: 'absolute', top: 0, left: 0, width: W, height: H,
              imageRendering: 'pixelated', pointerEvents: 'none' }}
          />
        </div>
      </div>

      {/* Status bar */}
      <div style={{ padding: '4px 16px', background: 'var(--surface)', borderTop: '1px solid var(--border)',
        fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '16px' }}>
        <span>Tamaño: {sprite.img.width} × {sprite.img.height} px</span>
        {sel && <span>Selección: ({sel.x},{sel.y}) {sel.w}×{sel.h} px</span>}
        <span>Atajos: S=Selección P=Lápiz E=Goma F=Relleno I=Cuentagotas M=Mover Ctrl+Z/C/X/V/A Del</span>
      </div>
    </div>
  );
};

// --- Eraser Modal Component ---
interface EraserModalProps {
  sprite: SpriteData;
  onSave: (id: string, newImg: HTMLImageElement) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

type EraserPrefs = {
  zoom: number;
  brushSize: number;
  brushShape: 'circle' | 'square';
};

const ERASER_PREFS_KEY = 'joa-eraser-prefs';

const loadEraserPrefs = (): EraserPrefs => {
  const saved = loadPref<Partial<EraserPrefs>>(ERASER_PREFS_KEY, {});
  return {
    zoom: clampNum(saved.zoom, 0.5, 8, 1),
    brushSize: Math.round(clampNum(saved.brushSize, 1, 100, 20)),
    brushShape: saved.brushShape === 'square' ? 'square' : 'circle',
  };
};

const EraserModal: React.FC<EraserModalProps> = ({ sprite, onSave, onClose, isWhiteBg }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [brushSize, setBrushSize] = useState(() => loadEraserPrefs().brushSize);
  const [brushShape, setBrushShape] = useState<'circle' | 'square'>(() => loadEraserPrefs().brushShape);
  const [zoom, setZoom] = useState(() => loadEraserPrefs().zoom);
  const [mousePos, setMousePos] = useState<{ x: number, y: number } | null>(null);
  const lastPos = useRef<{ x: number, y: number } | null>(null);
  const historyRef = useRef<ImageData[]>([]);
  const [historyLen, setHistoryLen] = useState(0);
  const strokeSavedRef = useRef(false);
  const isDrawingRef = useRef(false);
  const { workspaceRef, onWorkspaceScroll } = useRememberedScroll('joa-eraser-scroll', sprite.name);
  useModalWheelControls({ zoom, setZoom, brushSize, setBrushSize, workspaceRef });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    canvas.width = sprite.img.width;
    canvas.height = sprite.img.height;
    ctx.drawImage(sprite.img, 0, 0);
  }, [sprite]);

  useEffect(() => {
    savePref(ERASER_PREFS_KEY, { zoom, brushSize, brushShape });
  }, [zoom, brushSize, brushShape]);

  const pushHistory = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const next = [...historyRef.current, snapshot];
    if (next.length > 40) next.shift();
    historyRef.current = next;
    setHistoryLen(next.length);
  };

  const undo = () => {
    if (historyRef.current.length === 0) return;
    const snapshot = historyRef.current[historyRef.current.length - 1];
    historyRef.current = historyRef.current.slice(0, -1);
    setHistoryLen(historyRef.current.length);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.putImageData(snapshot, 0, 0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        undo();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const erase = (e: React.MouseEvent, forceFirstPoint = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d')!;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / zoom;
    const y = (e.clientY - rect.top) / zoom;

    setMousePos({ x, y });

    if (!isDrawingRef.current && !forceFirstPoint) {
      lastPos.current = null;
      return;
    }

    const scaleX = canvas.width / (rect.width / zoom);
    const scaleY = canvas.height / (rect.height / zoom);
    const currX = x * scaleX;
    const currY = y * scaleY;
    
    ctx.globalCompositeOperation = 'destination-out';
    if (lastPos.current && !forceFirstPoint) {
      if (brushShape === 'circle') {
        ctx.beginPath();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = brushSize * 2;
        ctx.moveTo(lastPos.current.x, lastPos.current.y);
        ctx.lineTo(currX, currY);
        ctx.stroke();
      } else {
        const dx = currX - lastPos.current.x;
        const dy = currY - lastPos.current.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const steps = Math.max(1, Math.ceil(dist));
        for (let i = 0; i <= steps; i++) {
          const t = steps === 0 ? 0 : i / steps;
          const x = lastPos.current.x + dx * t;
          const y = lastPos.current.y + dy * t;
          ctx.fillRect(x - brushSize, y - brushSize, brushSize * 2, brushSize * 2);
        }
      }
    } else {
      if (brushShape === 'circle') {
        ctx.beginPath();
        ctx.arc(currX, currY, brushSize, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(currX - brushSize, currY - brushSize, brushSize * 2, brushSize * 2);
      }
    }
    lastPos.current = { x: currX, y: currY };
  };

  const beginStroke = (e: React.MouseEvent) => {
    if (!strokeSavedRef.current) {
      pushHistory();
      strokeSavedRef.current = true;
    }
    isDrawingRef.current = true;
    erase(e, true);
  };

  const endStroke = () => {
    isDrawingRef.current = false;
    lastPos.current = null;
    strokeSavedRef.current = false;
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    const newImg = new Image();
    newImg.onload = () => onSave(sprite.id, newImg);
    newImg.src = dataUrl;
  };

  const handleReset = () => {
    if (!confirm('¿Seguro que quieres resetear los cambios de esta imagen?')) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    pushHistory();
    const ctx = canvas.getContext('2d')!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sprite.originalImg || sprite.img, 0, 0);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Eraser size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem' }}>Editar: {sprite.name}</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        <div
          ref={workspaceRef}
          className={`eraser-workspace checker-mini ${isWhiteBg ? 'white-bg' : ''}`}
          style={{ overflow: 'auto' }}
          onScroll={onWorkspaceScroll}
        >
           <div style={{
             width: sprite.img.width * zoom,
             height: sprite.img.height * zoom,
             position: 'relative'
           }}>
             <div style={{ 
               position: 'absolute',
               left: 0,
               top: 0,
               cursor: 'none', 
               width: sprite.img.width,
               height: sprite.img.height,
               transform: `scale(${zoom})`,
               transformOrigin: 'top left'
             }}>
             <canvas 
              ref={canvasRef}
              onMouseDown={beginStroke}
              onMouseUp={endStroke}
              onMouseMove={(e) => erase(e)}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setMousePos({ x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom });
              }}
              onMouseLeave={() => {
                endStroke();
                setMousePos(null);
              }}
             />
             {mousePos && canvasRef.current && (
               <div className="brush-preview" style={{
                 left: mousePos.x,
                 top: mousePos.y,
                 width: brushSize * (canvasRef.current.offsetWidth / canvasRef.current.width) * 2,
                 height: brushSize * (canvasRef.current.offsetWidth / canvasRef.current.width) * 2,
                 borderRadius: brushShape === 'circle' ? '50%' : '0'
               }} />
             )}
             </div>
           </div>
        </div>
        <div className="modal-footer" style={{ padding: '20px', background: 'var(--bg-panel)', borderTop: '1px solid var(--border)', gap: '24px' }}>
          <div className="slider-item" style={{ flex: 1, marginBottom: 0 }}>
            <div className="slider-label">
              <span><Search size={14} /> Zoom</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                <input
                  type="number"
                  min={0.5}
                  max={8}
                  step={0.1}
                  value={Number(zoom.toFixed(1))}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!Number.isFinite(v)) return;
                    setZoom(Math.min(8, Math.max(0.5, v)));
                  }}
                  style={{
                    width: '48px', background: '#1a1a1a', border: '1px solid #333', color: 'white',
                    padding: '2px 4px', borderRadius: '4px', textAlign: 'right', fontSize: '0.75rem',
                  }}
                />
                x
              </span>
            </div>
            <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
          </div>
          <div className="slider-item" style={{ flex: 1, marginBottom: 0 }}>
            <div className="slider-label">
              <span>Tamaño de Goma</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={brushSize}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isFinite(v)) return;
                    setBrushSize(Math.min(100, Math.max(1, v)));
                  }}
                  style={{
                    width: '48px', background: '#1a1a1a', border: '1px solid #333', color: 'white',
                    padding: '2px 4px', borderRadius: '4px', textAlign: 'right', fontSize: '0.75rem',
                  }}
                />
                px
              </span>
            </div>
            <input type="range" min="1" max="100" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} />
          </div>
          <div className="slider-item" style={{ width: 'auto', marginBottom: 0 }}>
            <div className="slider-label"><span>Forma</span></div>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button className={`btn-ghost ${brushShape === 'circle' ? 'active' : ''}`} onClick={() => setBrushShape('circle')} title="Círculo">
                <Circle size={16} fill={brushShape === 'circle' ? 'currentColor' : 'none'} />
              </button>
              <button className={`btn-ghost ${brushShape === 'square' ? 'active' : ''}`} onClick={() => setBrushShape('square')} title="Cuadrado">
                <Square size={16} fill={brushShape === 'square' ? 'currentColor' : 'none'} />
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="btn btn-outline" onClick={undo} disabled={historyLen === 0} title="Ctrl+Z">
              <RotateCcw size={16} /> Deshacer
            </button>
            <button className="btn btn-outline" onClick={handleReset}>Reiniciar</button>
            <button className="btn btn-primary" style={{ paddingLeft: '24px', paddingRight: '24px' }} onClick={handleSave}>Guardar Cambios</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Ghost / onion compare: source transparent behind current sprite ---
interface GhostCompareModalProps {
  sprite: SpriteData;
  sprites: SpriteData[];
  onChangeSprite: (next: SpriteData) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

const GHOST_COMPARE_PREFS_KEY = 'joa-ghost-compare-prefs';

const nudgeSpriteContent = (s: SpriteData, dx: number, dy: number): SpriteData => {
  if (!dx && !dy) return s;
  return {
    ...s,
    padding: {
      left: s.padding.left + dx,
      right: s.padding.right - dx,
      top: s.padding.top + dy,
      bottom: s.padding.bottom - dy,
    },
  };
};

const setSpriteInternalScale = (s: SpriteData, val: number): SpriteData => {
  const stretchX = s.stretchX || 1;
  const stretchY = s.stretchY || 1;
  const currScX = (s.scale || 1) * stretchX;
  const currScY = (s.scale || 1) * stretchY;
  const currW = s.img.width * currScX;
  const currH = s.img.height * currScY;
  const newScX = val * stretchX;
  const newScY = val * stretchY;
  const newW = s.img.width * newScX;
  const newH = s.img.height * newScY;
  const diffW = currW - newW;
  const diffH = currH - newH;
  return {
    ...s,
    scale: val,
    padding: {
      left: s.padding.left + diffW / 2,
      right: s.padding.right + diffW / 2,
      top: s.padding.top + diffH / 2,
      bottom: s.padding.bottom + diffH / 2,
    },
  };
};

const drawSpriteFrameToTemp = (sprite: SpriteData) => {
  const { w, h } = getSpriteFrameSize(sprite);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  renderSpriteToContext(ctx, sprite, false);
  return c;
};

/** Primer píxel opaco de la fila más baja con dibujo (izq → der). */
const findBottomFirstPainted = (canvas: HTMLCanvasElement): { x: number; y: number } | null => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const w = canvas.width;
  const h = canvas.height;
  if (w < 1 || h < 1) return null;
  const { data } = ctx.getImageData(0, 0, w, h);
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] >= 12) return { x, y };
    }
  }
  return null;
};

/** Alinea `moving` a `fixed` por el primer píxel pintado de la base. */
const autoAlignSpriteToFixedBottom = (moving: SpriteData, fixed: SpriteData): SpriteData | null => {
  const fixedPt = findBottomFirstPainted(drawSpriteFrameToTemp(fixed));
  const movingPt = findBottomFirstPainted(drawSpriteFrameToTemp(moving));
  if (!fixedPt || !movingPt) return null;
  return nudgeSpriteContent(moving, fixedPt.x - movingPt.x, fixedPt.y - movingPt.y);
};

const GhostCompareModal: React.FC<GhostCompareModalProps> = ({ sprite, sprites, onChangeSprite, onClose, isWhiteBg }) => {
  const others = sprites.filter((s) => s.id !== sprite.id);
  const [sourceId, setSourceId] = useState<string | null>(() => {
    if (others.length === 1) return others[0].id;
    const lastName = loadPref<string>('joa-ghost-compare-last-source', '');
    const remembered = others.find((s) => s.name === lastName);
    return remembered?.id ?? null;
  });
  const source = others.find((s) => s.id === sourceId) || null;
  const prefs = loadPref<{ zoom?: number; opacity?: number; targetOpacity?: number; editSource?: boolean }>(GHOST_COMPARE_PREFS_KEY, {});
  const [zoom, setZoom] = useState(() => clampNum(prefs.zoom, 0.5, 8, 1));
  const [opacity, setOpacity] = useState(() => Math.round(clampNum(prefs.opacity, 5, 100, 40)));
  const [targetOpacity, setTargetOpacity] = useState(() => Math.round(clampNum(prefs.targetOpacity, 5, 100, 100)));
  const [editSource, setEditSource] = useState(() => prefs.editSource === true);
  const [nudgeStep, setNudgeStep] = useState(() => Math.round(clampNum(loadPref('joa-content-nudge-step', 1), 1, 512, 1)));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { workspaceRef, onWorkspaceScroll } = useRememberedScroll('joa-ghost-compare-scroll', sprite.name);
  useModalWheelControls({ zoom, setZoom, workspaceRef });

  useEffect(() => {
    if (source) savePref('joa-ghost-compare-last-source', source.name);
  }, [source]);

  useEffect(() => {
    savePref(GHOST_COMPARE_PREFS_KEY, { zoom, opacity, targetOpacity, editSource });
  }, [zoom, opacity, targetOpacity, editSource]);

  useEffect(() => {
    savePref('joa-content-nudge-step', nudgeStep);
  }, [nudgeStep]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;
    const bg = drawSpriteFrameToTemp(source);
    const fg = drawSpriteFrameToTemp(sprite);
    const w = Math.max(bg.width, fg.width);
    const h = Math.max(bg.height, fg.height);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = opacity / 100;
    ctx.drawImage(bg, 0, 0);
    ctx.globalAlpha = targetOpacity / 100;
    ctx.drawImage(fg, 0, 0);
  }, [sprite, source, opacity, targetOpacity]);

  const spriteRef = useRef(sprite);
  spriteRef.current = sprite;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const editSourceRef = useRef(editSource);
  editSourceRef.current = editSource;
  const onChangeRef = useRef(onChangeSprite);
  onChangeRef.current = onChangeSprite;

  useEffect(() => {
    if (!source) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const step = e.shiftKey ? Math.max(1, nudgeStep * 5) : nudgeStep;
      let dx = 0;
      let dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      else return;
      e.preventDefault();
      const moving = editSourceRef.current ? sourceRef.current : spriteRef.current;
      if (!moving) return;
      onChangeRef.current(nudgeSpriteContent(moving, dx, dy));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [source, nudgeStep]);

  const picker = (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '1080px', height: 'auto', maxHeight: '92vh' }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Layers size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem' }}>Comparar overlay: {sprite.name}</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        <div style={{ padding: '16px 20px', overflow: 'auto' }}>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.45 }}>
            Elegí el sprite fuente. Se superponen ambos sprites (misma esquina superior izquierda del envase Full); podés ajustar la opacidad de cada capa en el comparador.
          </p>
          {others.length === 0 ? (
            <div className="empty-msg">Cargá al menos otro sprite para compararlo.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px' }}>
              {others.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setSourceId(s.id)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '10px',
                    height: 'auto',
                    textAlign: 'center',
                  }}
                >
                  <div className="checker-mini" style={{ width: '100%', height: '88px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', overflow: 'hidden' }}>
                    <SpriteThumb img={s.img} maxWidth={140} maxHeight={88} alt={s.name} />
                  </div>
                  <span style={{ fontSize: '0.7rem', wordBreak: 'break-all' }}>{s.name}</span>
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{s.img.width}×{s.img.height}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (!source) return picker;

  const editTarget = editSource ? source : sprite;
  const alignFixed = editSource ? sprite : source;
  const fgSize = getSpriteFrameSize(sprite);
  const bgSize = getSpriteFrameSize(source);
  const stageW = Math.max(fgSize.w, bgSize.w);
  const stageH = Math.max(fgSize.h, bgSize.h);
  const internalScale = editTarget.scale || 1;
  const nudgeBtn = (dx: number, dy: number, title: string, icon: React.ReactNode) => (
    <button
      type="button"
      className="btn btn-outline"
      style={{ width: '34px', height: '34px', padding: 0 }}
      title={title}
      onClick={() => onChangeSprite(nudgeSpriteContent(editTarget, dx, dy))}
    >
      {icon}
    </button>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <Layers size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Overlay: {sprite.name}
            </h3>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>
              fondo ← {source.name}
            </span>
            <span style={{
              fontSize: '0.65rem',
              flexShrink: 0,
              padding: '2px 8px',
              borderRadius: '999px',
              border: '1px solid var(--border)',
              color: editSource ? '#ffcc66' : 'var(--accent)',
              background: editSource ? 'rgba(255,204,102,0.12)' : 'rgba(107,102,255,0.12)',
            }}>
              editando: {editTarget.name}
            </span>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        <div
          ref={workspaceRef}
          className={`eraser-workspace checker-mini ${isWhiteBg ? 'white-bg' : ''}`}
          style={{ overflow: 'auto' }}
          onScroll={onWorkspaceScroll}
        >
          <div style={{ width: stageW * zoom, height: stageH * zoom, position: 'relative' }}>
            <canvas
              ref={canvasRef}
              style={{
                width: stageW * zoom,
                height: stageH * zoom,
                imageRendering: 'pixelated',
                display: 'block',
              }}
            />
          </div>
        </div>
        <div className="modal-footer" style={{ padding: '16px 20px', background: 'var(--bg-panel)', borderTop: '1px solid var(--border)', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              userSelect: 'none',
              padding: '6px 10px',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              background: editSource ? 'rgba(255,204,102,0.08)' : 'transparent',
            }}
            title="Si está activo, mover / escala / autoalinear modifican la fuente (fondo). Si no, modifican el sprite de arriba."
          >
            <input
              type="checkbox"
              checked={editSource}
              onChange={(e) => setEditSource(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Editar fuente
          </label>
          <div className="slider-item" style={{ flex: '1 1 140px', marginBottom: 0, minWidth: '120px' }}>
            <div className="slider-label"><span><Search size={14} /> Zoom</span><span>{zoom.toFixed(1)}x</span></div>
            <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
          </div>
          <div className="slider-item" style={{ flex: '1 1 140px', marginBottom: 0, minWidth: '120px' }}>
            <div className="slider-label"><span>Opacidad fuente</span><span>{opacity}%</span></div>
            <input type="range" min="5" max="100" step="1" value={opacity} onChange={(e) => setOpacity(parseInt(e.target.value, 10))} />
          </div>
          <div className="slider-item" style={{ flex: '1 1 140px', marginBottom: 0, minWidth: '120px' }}>
            <div className="slider-label"><span>Opacidad destino</span><span>{targetOpacity}%</span></div>
            <input type="range" min="5" max="100" step="1" value={targetOpacity} onChange={(e) => setTargetOpacity(parseInt(e.target.value, 10))} />
          </div>
          <div className="slider-item" style={{ flex: '1 1 160px', marginBottom: 0, minWidth: '140px' }}>
            <div className="slider-label"><span>Escala interna</span><span>{internalScale.toFixed(2)}x</span></div>
            <input
              type="range"
              min="0.1"
              max="4"
              step="0.01"
              value={internalScale}
              onChange={(e) => onChangeSprite(setSpriteInternalScale(editTarget, parseFloat(e.target.value)))}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 34px)',
                gridTemplateRows: 'repeat(3, 34px)',
                gap: '4px',
                justifyItems: 'center',
                alignItems: 'center',
              }}
            >
              <span />
              {nudgeBtn(0, -nudgeStep, 'Subir contenido (↑)', <ArrowUp size={16} />)}
              <span />
              {nudgeBtn(-nudgeStep, 0, 'Mover a la izquierda (←)', <ArrowLeft size={16} />)}
              <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>px</span>
              {nudgeBtn(nudgeStep, 0, 'Mover a la derecha (→)', <ArrowRight size={16} />)}
              <span />
              {nudgeBtn(0, nudgeStep, 'Bajar contenido (↓)', <ArrowDown size={16} />)}
              <span />
            </div>
            <div style={{ width: '72px' }}>
              <div className="slider-label" style={{ marginBottom: '4px' }}>
                <span>Paso</span>
                <span>{nudgeStep}px</span>
              </div>
              <input
                type="number"
                min={1}
                max={512}
                className="input-small"
                style={{ width: '100%' }}
                value={nudgeStep}
                onChange={(e) => setNudgeStep(Math.max(1, parseInt(e.target.value, 10) || 1))}
              />
            </div>
            <button
              type="button"
              className="btn btn-outline"
              title={editSource
                ? 'Alinea la fuente al primer píxel pintado de la base del sprite de arriba (el de arriba no se mueve)'
                : 'Alinea el sprite de arriba al primer píxel pintado de la base de la fuente (la fuente no se mueve)'}
              onClick={() => {
                const aligned = autoAlignSpriteToFixedBottom(editTarget, alignFixed);
                if (!aligned) {
                  alert('No se encontró dibujo en la base de alguno de los dos sprites.');
                  return;
                }
                onChangeSprite(aligned);
              }}
            >
              <Target size={14} /> Autoalinear base
            </button>
          </div>
          <div style={{ display: 'flex', gap: '12px', marginLeft: 'auto' }}>
            <button className="btn btn-outline" onClick={() => setSourceId(null)}>Cambiar fuente</button>
            <button className="btn btn-primary" onClick={onClose}>Cerrar</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Replace-from-sprite brush (like eraser, but stamps the other image) ---
interface ReplaceBrushModalProps {
  sprite: SpriteData;
  sprites: SpriteData[];
  onSave: (id: string, newImg: HTMLImageElement) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

type ReplacePrefs = {
  zoom: number;
  brushSize: number;
  brushShape: 'circle' | 'square';
  paintedOnly: boolean;
  emptyOnly: boolean;
  fillEmpty: boolean;
};

const REPLACE_PREFS_KEY = 'joa-replace-prefs';

const loadReplacePrefs = (): ReplacePrefs => {
  const saved = loadPref<Partial<ReplacePrefs>>(REPLACE_PREFS_KEY, {});
  const fillEmpty = saved.fillEmpty === true;
  const emptyOnly = !fillEmpty && saved.emptyOnly === true;
  const paintedOnly = !fillEmpty && !emptyOnly && saved.paintedOnly === true;
  return {
    zoom: clampNum(saved.zoom, 0.5, 8, 1),
    brushSize: Math.round(clampNum(saved.brushSize, 1, 100, 20)),
    brushShape: saved.brushShape === 'square' ? 'square' : 'circle',
    paintedOnly,
    emptyOnly,
    fillEmpty,
  };
};

const ReplaceBrushModal: React.FC<ReplaceBrushModalProps> = ({ sprite, sprites, onSave, onClose, isWhiteBg }) => {
  const others = sprites.filter((s) => s.id !== sprite.id);
  const [sourceId, setSourceId] = useState<string | null>(() => {
    if (others.length === 1) return others[0].id;
    const lastName = loadPref<string>('joa-replace-last-source', '');
    const remembered = others.find((s) => s.name === lastName);
    return remembered?.id ?? null;
  });
  const source = others.find((s) => s.id === sourceId) || null;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const originalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [brushMode, setBrushMode] = useState<'replace' | 'invert' | 'erase'>('replace');
  const [brushSize, setBrushSize] = useState(() => loadReplacePrefs().brushSize);
  const [brushShape, setBrushShape] = useState<'circle' | 'square'>(() => loadReplacePrefs().brushShape);
  const [paintedOnly, setPaintedOnly] = useState(() => loadReplacePrefs().paintedOnly);
  const [emptyOnly, setEmptyOnly] = useState(() => loadReplacePrefs().emptyOnly);
  const [fillEmpty, setFillEmpty] = useState(() => loadReplacePrefs().fillEmpty);
  const [zoom, setZoom] = useState(() => loadReplacePrefs().zoom);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [historyLen, setHistoryLen] = useState(0);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const historyRef = useRef<ImageData[]>([]);
  const strokeSavedRef = useRef(false);
  const isDrawingRef = useRef(false);
  const { workspaceRef, onWorkspaceScroll } = useRememberedScroll('joa-replace-scroll', sprite.name);
  useModalWheelControls({ zoom, setZoom, brushSize, setBrushSize, workspaceRef });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sourceId) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    canvas.width = sprite.img.width;
    canvas.height = sprite.img.height;
    ctx.drawImage(sprite.img, 0, 0);
    const original = document.createElement('canvas');
    original.width = sprite.img.width;
    original.height = sprite.img.height;
    original.getContext('2d')!.drawImage(sprite.img, 0, 0);
    originalCanvasRef.current = original;
    historyRef.current = [];
    setHistoryLen(0);
  }, [sprite, sourceId]);

  useEffect(() => {
    if (!source) {
      sourceCanvasRef.current = null;
      return;
    }
    const c = document.createElement('canvas');
    c.width = source.img.width;
    c.height = source.img.height;
    const sctx = c.getContext('2d')!;
    sctx.drawImage(source.img, 0, 0);
    sourceCanvasRef.current = c;
    savePref('joa-replace-last-source', source.name);
  }, [source]);

  useEffect(() => {
    savePref(REPLACE_PREFS_KEY, { zoom, brushSize, brushShape, paintedOnly, emptyOnly, fillEmpty });
  }, [zoom, brushSize, brushShape, paintedOnly, emptyOnly, fillEmpty]);

  const pushHistory = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const next = [...historyRef.current, snapshot];
    if (next.length > 40) next.shift();
    historyRef.current = next;
    setHistoryLen(next.length);
  };

  const undo = () => {
    if (historyRef.current.length === 0) return;
    const snapshot = historyRef.current[historyRef.current.length - 1];
    historyRef.current = historyRef.current.slice(0, -1);
    setHistoryLen(historyRef.current.length);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.putImageData(snapshot, 0, 0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        undo();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const stampSource = (ctx: CanvasRenderingContext2D, x: number, y: number, from: { x: number; y: number } | null) => {
    const src = brushMode === 'invert' ? originalCanvasRef.current : sourceCanvasRef.current;
    if (brushMode !== 'erase' && !src) return;
    if (from && (from.x !== x || from.y !== y)) {
      const dx = x - from.x;
      const dy = y - from.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(dist / Math.max(1, brushSize * 0.4)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        if (brushMode === 'erase') eraseDot(ctx, from.x + dx * t, from.y + dy * t);
        else stampDot(ctx, src!, from.x + dx * t, from.y + dy * t);
      }
    } else if (brushMode === 'erase') {
      eraseDot(ctx, x, y);
    } else {
      stampDot(ctx, src!, x, y);
    }
  };

  /** ¿El píxel (px,py) cae dentro del pincel duro? (sin antialias de clip) */
  const inBrush = (px: number, py: number, cx: number, cy: number) => {
    const r = brushSize;
    if (brushShape === 'circle') {
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      return dx * dx + dy * dy <= r * r;
    }
    return px >= cx - r && px < cx + r && py >= cy - r && py < cy + r;
  };

  /**
   * Solo en pintado: píxel a píxel, borde duro del pincel.
   * Evita el bug de clip() antialias + destination-in/out (halos en el margen).
   */
  const stampPaintedOnly = (ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number) => {
    const canvas = ctx.canvas;
    const w = canvas.width;
    const h = canvas.height;
    const r = brushSize;
    const x0 = Math.max(0, Math.floor(x - r));
    const y0 = Math.max(0, Math.floor(y - r));
    const x1 = Math.min(w, Math.ceil(x + r));
    const y1 = Math.min(h, Math.ceil(y + r));
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return;

    const destImg = ctx.getImageData(x0, y0, bw, bh);
    const dd = destImg.data;

    const sw = src.width;
    const sh = src.height;
    const sx0 = Math.max(x0, 0);
    const sy0 = Math.max(y0, 0);
    const sx1 = Math.min(x1, sw);
    const sy1 = Math.min(y1, sh);
    let sd: Uint8ClampedArray | null = null;
    let sBw = 0;
    if (sx1 > sx0 && sy1 > sy0) {
      const sctx = src.getContext('2d', { willReadFrequently: true });
      if (sctx) {
        const srcImg = sctx.getImageData(sx0, sy0, sx1 - sx0, sy1 - sy0);
        sd = srcImg.data;
        sBw = sx1 - sx0;
      }
    }

    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (!inBrush(px, py, x, y)) continue;
        const di = ((py - y0) * bw + (px - x0)) * 4;
        // Ignorar huecos del archivo en modificación.
        if (dd[di + 3] < 8) continue;

        if (!sd || px < sx0 || py < sy0 || px >= sx1 || py >= sy1) {
          dd[di] = 0;
          dd[di + 1] = 0;
          dd[di + 2] = 0;
          dd[di + 3] = 0;
        } else {
          const si = ((py - sy0) * sBw + (px - sx0)) * 4;
          dd[di] = sd[si];
          dd[di + 1] = sd[si + 1];
          dd[di + 2] = sd[si + 2];
          dd[di + 3] = sd[si + 3];
        }
      }
    }
    ctx.putImageData(destImg, x0, y0);
  };

  /** Solo vacío: borrar píxeles del destino donde la fuente está vacía (borde duro). */
  const stampEmptyOnly = (ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number) => {
    const canvas = ctx.canvas;
    const w = canvas.width;
    const h = canvas.height;
    const r = brushSize;
    const x0 = Math.max(0, Math.floor(x - r));
    const y0 = Math.max(0, Math.floor(y - r));
    const x1 = Math.min(w, Math.ceil(x + r));
    const y1 = Math.min(h, Math.ceil(y + r));
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return;

    const destImg = ctx.getImageData(x0, y0, bw, bh);
    const dd = destImg.data;

    const sw = src.width;
    const sh = src.height;
    const sx0 = Math.max(x0, 0);
    const sy0 = Math.max(y0, 0);
    const sx1 = Math.min(x1, sw);
    const sy1 = Math.min(y1, sh);
    let sd: Uint8ClampedArray | null = null;
    let sBw = 0;
    if (sx1 > sx0 && sy1 > sy0) {
      const sctx = src.getContext('2d', { willReadFrequently: true });
      if (sctx) {
        const srcImg = sctx.getImageData(sx0, sy0, sx1 - sx0, sy1 - sy0);
        sd = srcImg.data;
        sBw = sx1 - sx0;
      }
    }

    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (!inBrush(px, py, x, y)) continue;
        const di = ((py - y0) * bw + (px - x0)) * 4;
        let srcEmpty = true;
        if (sd && px >= sx0 && py >= sy0 && px < sx1 && py < sy1) {
          const si = ((py - sy0) * sBw + (px - sx0)) * 4;
          srcEmpty = sd[si + 3] < 8;
        }
        if (srcEmpty) {
          dd[di] = 0;
          dd[di + 1] = 0;
          dd[di + 2] = 0;
          dd[di + 3] = 0;
        }
      }
    }
    ctx.putImageData(destImg, x0, y0);
  };

  /** Solo sobre vacío: pegar fuente opaca solo donde el destino está vacío (borde duro). */
  const stampFillEmpty = (ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number) => {
    const canvas = ctx.canvas;
    const w = canvas.width;
    const h = canvas.height;
    const r = brushSize;
    const x0 = Math.max(0, Math.floor(x - r));
    const y0 = Math.max(0, Math.floor(y - r));
    const x1 = Math.min(w, Math.ceil(x + r));
    const y1 = Math.min(h, Math.ceil(y + r));
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return;

    const destImg = ctx.getImageData(x0, y0, bw, bh);
    const dd = destImg.data;

    const sw = src.width;
    const sh = src.height;
    const sx0 = Math.max(x0, 0);
    const sy0 = Math.max(y0, 0);
    const sx1 = Math.min(x1, sw);
    const sy1 = Math.min(y1, sh);
    let sd: Uint8ClampedArray | null = null;
    let sBw = 0;
    if (sx1 > sx0 && sy1 > sy0) {
      const sctx = src.getContext('2d', { willReadFrequently: true });
      if (sctx) {
        const srcImg = sctx.getImageData(sx0, sy0, sx1 - sx0, sy1 - sy0);
        sd = srcImg.data;
        sBw = sx1 - sx0;
      }
    }
    if (!sd) return;

    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (!inBrush(px, py, x, y)) continue;
        if (px < sx0 || py < sy0 || px >= sx1 || py >= sy1) continue;
        const di = ((py - y0) * bw + (px - x0)) * 4;
        if (dd[di + 3] >= 8) continue; // solo sobre vacío del destino
        const si = ((py - sy0) * sBw + (px - sx0)) * 4;
        if (sd[si + 3] < 8) continue; // no pegar vacío de la fuente
        dd[di] = sd[si];
        dd[di + 1] = sd[si + 1];
        dd[di + 2] = sd[si + 2];
        dd[di + 3] = sd[si + 3];
      }
    }
    ctx.putImageData(destImg, x0, y0);
  };

  const stampDot = (ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number) => {
    // Variantes con máscara: píxel a píxel (borde duro). No usar clip()+destination-*:
    // el antialias del clip deja halos en el margen del pincel.
    if (emptyOnly) {
      stampEmptyOnly(ctx, src, x, y);
      return;
    }
    if (fillEmpty) {
      stampFillEmpty(ctx, src, x, y);
      return;
    }
    if (paintedOnly) {
      stampPaintedOnly(ctx, src, x, y);
      return;
    }

    ctx.save();
    ctx.beginPath();
    if (brushShape === 'circle') {
      ctx.arc(x, y, brushSize, 0, Math.PI * 2);
    } else {
      ctx.rect(x - brushSize, y - brushSize, brushSize * 2, brushSize * 2);
    }
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  };

  const eraseDot = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.beginPath();
    if (brushShape === 'circle') {
      ctx.arc(x, y, brushSize, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(x - brushSize, y - brushSize, brushSize * 2, brushSize * 2);
    }
    ctx.restore();
  };

  const paint = (e: React.MouseEvent, forceFirstPoint = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / zoom;
    const y = (e.clientY - rect.top) / zoom;
    setMousePos({ x, y });

    if (!isDrawingRef.current && !forceFirstPoint) {
      lastPos.current = null;
      return;
    }

    const scaleX = canvas.width / (rect.width / zoom);
    const scaleY = canvas.height / (rect.height / zoom);
    const currX = x * scaleX;
    const currY = y * scaleY;
    stampSource(ctx, currX, currY, forceFirstPoint ? null : lastPos.current);
    lastPos.current = { x: currX, y: currY };
  };

  const beginStroke = (e: React.MouseEvent) => {
    if (!strokeSavedRef.current) {
      pushHistory();
      strokeSavedRef.current = true;
    }
    isDrawingRef.current = true;
    paint(e, true);
  };

  const endStroke = () => {
    isDrawingRef.current = false;
    lastPos.current = null;
    strokeSavedRef.current = false;
  };

  const handleReset = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    pushHistory();
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sprite.img, 0, 0);
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const newImg = new Image();
    newImg.onload = () => onSave(sprite.id, newImg);
    newImg.src = canvas.toDataURL('image/png');
  };

  const picker = (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '1080px', height: 'auto', maxHeight: '92vh' }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Stamp size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem' }}>Reemplazar en: {sprite.name}</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        <div style={{ padding: '16px 20px', overflow: 'auto' }}>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.45 }}>
            Elegí el sprite fuente. Al pintar sobre <strong>{sprite.name}</strong>, esa zona se reemplaza con los píxeles de la misma coordenada del otro. <strong>Solo en pintado</strong> solo toca lo ya dibujado del destino; <strong>Solo vacío</strong> borra huecos de la fuente; <strong>Solo sobre vacío</strong> agrega lo dibujado solo en huecos del destino.
          </p>
          {others.length === 0 ? (
            <div className="empty-msg">Cargá al menos otro sprite para usarlo como fuente.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px' }}>
              {others.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setSourceId(s.id)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '10px',
                    height: 'auto',
                    textAlign: 'center',
                  }}
                >
                  <div className="checker-mini" style={{ width: '100%', height: '88px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', overflow: 'hidden' }}>
                    <SpriteThumb img={s.img} maxWidth={140} maxHeight={88} alt={s.name} />
                  </div>
                  <span style={{ fontSize: '0.7rem', wordBreak: 'break-all' }}>{s.name}</span>
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{s.img.width}×{s.img.height}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (!source) return picker;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <Stamp size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Reemplazar: {sprite.name}
            </h3>
            <span style={{
              fontSize: '0.7rem',
              color: brushMode === 'invert' ? '#ffcc00' : brushMode === 'erase' ? '#ff6b6b' : 'var(--text-muted)',
              flexShrink: 0,
            }}>
              {brushMode === 'invert' ? 'restaurando original' : brushMode === 'erase' ? 'goma' : `← ${source.name}`}
            </span>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        <div
          ref={workspaceRef}
          className={`eraser-workspace checker-mini ${isWhiteBg ? 'white-bg' : ''}`}
          style={{ overflow: 'auto' }}
          onScroll={onWorkspaceScroll}
        >
          <div style={{
            width: sprite.img.width * zoom,
            height: sprite.img.height * zoom,
            position: 'relative',
          }}>
            <div style={{
              position: 'absolute',
              left: 0,
              top: 0,
              cursor: 'none',
              width: sprite.img.width,
              height: sprite.img.height,
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
            }}>
              <canvas
                ref={canvasRef}
                onMouseDown={beginStroke}
                onMouseUp={endStroke}
                onMouseMove={(e) => paint(e)}
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMousePos({ x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom });
                }}
                onMouseLeave={() => {
                  endStroke();
                  setMousePos(null);
                }}
              />
              {mousePos && canvasRef.current && (
                <div className="brush-preview" style={{
                  left: mousePos.x,
                  top: mousePos.y,
                  width: brushSize * (canvasRef.current.offsetWidth / canvasRef.current.width) * 2,
                  height: brushSize * (canvasRef.current.offsetWidth / canvasRef.current.width) * 2,
                  borderRadius: brushShape === 'circle' ? '50%' : '0',
                  borderColor: brushMode === 'invert' ? '#ffcc00' : brushMode === 'erase' ? '#ff6b6b' : undefined,
                }} />
              )}
            </div>
          </div>
        </div>
        <div className="modal-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px' }}>
            <button className="btn btn-outline" onClick={() => setSourceId(null)} title="Elegir otro sprite fuente">
              Cambiar fuente
            </button>
            <button
              type="button"
              className={`btn ${brushMode === 'invert' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setBrushMode((m) => m === 'invert' ? 'replace' : 'invert')}
              title="Al pintar, restaura la zona original del primer sprite (deshace el reemplazo)"
              style={brushMode === 'invert' ? undefined : { borderColor: '#ffcc00', color: '#ffcc00' }}
            >
              <FlipHorizontal size={16} /> Invertir
            </button>
            <button
              type="button"
              className={`btn ${brushMode === 'erase' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setBrushMode((m) => m === 'erase' ? 'replace' : 'erase')}
              title="Borra la zona pintada (como la goma)"
              style={brushMode === 'erase' ? undefined : { borderColor: '#ff6b6b', color: '#ff6b6b' }}
            >
              <Eraser size={16} /> Goma
            </button>
            <div style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 14px' }}>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.75rem',
                  color: paintedOnly ? 'var(--accent)' : 'var(--text-light)',
                  cursor: 'pointer',
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                }}
                title="Solo reemplaza donde el destino ya está dibujado; ignora los huecos del archivo en modificación"
              >
                <input
                  type="checkbox"
                  checked={paintedOnly}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setPaintedOnly(on);
                    if (on) {
                      setEmptyOnly(false);
                      setFillEmpty(false);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                />
                Solo en pintado
              </label>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.75rem',
                  color: emptyOnly ? 'var(--accent)' : 'var(--text-light)',
                  cursor: 'pointer',
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                }}
                title="Solo borra donde la fuente está vacía; no modifica lo dibujado"
              >
                <input
                  type="checkbox"
                  checked={emptyOnly}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setEmptyOnly(on);
                    if (on) {
                      setPaintedOnly(false);
                      setFillEmpty(false);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                />
                Solo vacío
              </label>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.75rem',
                  color: fillEmpty ? 'var(--accent)' : 'var(--text-light)',
                  cursor: 'pointer',
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                }}
                title="Agrega lo dibujado de la fuente solo donde el destino está vacío"
              >
                <input
                  type="checkbox"
                  checked={fillEmpty}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setFillEmpty(on);
                    if (on) {
                      setPaintedOnly(false);
                      setEmptyOnly(false);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                />
                Solo sobre vacío
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 12px' }}>
            <div className="slider-item" style={{ flex: 1, marginBottom: 0, minWidth: '140px' }}>
              <div className="slider-label">
                <span><Search size={14} /> Zoom</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                  <input
                    type="number"
                    min={0.5}
                    max={8}
                    step={0.1}
                    value={Number(zoom.toFixed(1))}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!Number.isFinite(v)) return;
                      setZoom(Math.min(8, Math.max(0.5, v)));
                    }}
                    style={{
                      width: '48px', background: '#1a1a1a', border: '1px solid #333', color: 'white',
                      padding: '2px 4px', borderRadius: '4px', textAlign: 'right', fontSize: '0.75rem',
                    }}
                  />
                  x
                </span>
              </div>
              <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
            </div>
            <div className="slider-item" style={{ flex: 1, marginBottom: 0, minWidth: '140px' }}>
              <div className="slider-label">
                <span>Tamaño</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={brushSize}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!Number.isFinite(v)) return;
                      setBrushSize(Math.min(100, Math.max(1, v)));
                    }}
                    style={{
                      width: '48px', background: '#1a1a1a', border: '1px solid #333', color: 'white',
                      padding: '2px 4px', borderRadius: '4px', textAlign: 'right', fontSize: '0.75rem',
                    }}
                  />
                  px
                </span>
              </div>
              <input type="range" min="1" max="100" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} />
            </div>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <button className={`btn-ghost ${brushShape === 'circle' ? 'active' : ''}`} onClick={() => setBrushShape('circle')} title="Círculo">
                <Circle size={16} fill={brushShape === 'circle' ? 'currentColor' : 'none'} />
              </button>
              <button className={`btn-ghost ${brushShape === 'square' ? 'active' : ''}`} onClick={() => setBrushShape('square')} title="Cuadrado">
                <Square size={16} fill={brushShape === 'square' ? 'currentColor' : 'none'} />
              </button>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto', flexWrap: 'wrap' }}>
              <button className="btn btn-outline" onClick={undo} disabled={historyLen === 0} title="Ctrl+Z">
                <RotateCcw size={16} /> Deshacer
              </button>
              <button className="btn btn-outline" onClick={handleReset}>Reiniciar</button>
              <button className="btn btn-primary" style={{ paddingLeft: '24px', paddingRight: '24px' }} onClick={handleSave}>Guardar Cambios</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Copy a rectangle from another sprite and place it anywhere ---
interface CopyRectModalProps {
  sprite: SpriteData;
  sprites: SpriteData[];
  onSave: (id: string, newImg: HTMLImageElement) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

const COPY_RECT_PREFS_KEY = 'joa-copy-rect-prefs';

const CopyRectModal: React.FC<CopyRectModalProps> = ({ sprite, sprites, onSave, onClose, isWhiteBg }) => {
  const others = sprites.filter((s) => s.id !== sprite.id);
  const [sourceId, setSourceId] = useState<string | null>(() => {
    if (others.length === 1) return others[0].id;
    const lastName = loadPref<string>('joa-copy-rect-last-source', '');
    const remembered = others.find((s) => s.name === lastName);
    return remembered?.id ?? null;
  });
  const source = others.find((s) => s.id === sourceId) || null;

  type CropRect = { x: number; y: number; w: number; h: number };
  type CropHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se' | 'move';

  const [phase, setPhase] = useState<'select' | 'place'>('select');
  const [zoom, setZoom] = useState(() => clampNum(loadPref(`${COPY_RECT_PREFS_KEY}-zoom`, 1), 0.5, 8, 1));
  const [includeEmpty, setIncludeEmpty] = useState(() => loadPref<boolean>(`${COPY_RECT_PREFS_KEY}-empty`, false));
  const [previewOpacity, setPreviewOpacity] = useState(() => Math.round(clampNum(loadPref(`${COPY_RECT_PREFS_KEY}-preview`, 70), 0, 100, 70)));
  const [hidePreview, setHidePreview] = useState(false);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [draft, setDraft] = useState<CropRect | null>(null);
  const [destPos, setDestPos] = useState({ x: 0, y: 0 });
  const [historyLen, setHistoryLen] = useState(0);
  const [adjusting, setAdjusting] = useState(false);

  const sourceCanvasRef = useRef<HTMLCanvasElement>(null);
  const destCanvasRef = useRef<HTMLCanvasElement>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [cropPreview, setCropPreview] = useState<string | null>(null);
  const historyRef = useRef<ImageData[]>([]);
  const placeDragRef = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);
  const adjustRef = useRef<{
    mode: CropHandle | 'draw';
    startPx: number;
    startPy: number;
    startRect: CropRect;
  } | null>(null);

  const { workspaceRef, onWorkspaceScroll } = useRememberedScroll(
    phase === 'select' ? 'joa-copy-rect-src-scroll' : 'joa-copy-rect-dst-scroll',
    (phase === 'select' ? source?.name : sprite.name) || sprite.name,
    [phase]
  );
  useModalWheelControls({ zoom, setZoom, workspaceRef });

  useEffect(() => {
    savePref(`${COPY_RECT_PREFS_KEY}-zoom`, zoom);
    savePref(`${COPY_RECT_PREFS_KEY}-empty`, includeEmpty);
    savePref(`${COPY_RECT_PREFS_KEY}-preview`, previewOpacity);
  }, [zoom, includeEmpty, previewOpacity]);

  useEffect(() => {
    if (source) savePref('joa-copy-rect-last-source', source.name);
  }, [source]);

  useEffect(() => {
    const canvas = sourceCanvasRef.current;
    if (!canvas || !source) return;
    canvas.width = source.img.width;
    canvas.height = source.img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source.img, 0, 0);
  }, [source]);

  useEffect(() => {
    const canvas = destCanvasRef.current;
    if (!canvas) return;
    canvas.width = sprite.img.width;
    canvas.height = sprite.img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sprite.img, 0, 0);
    historyRef.current = [];
    setHistoryLen(0);
  }, [sprite, sourceId]);

  const rebuildCrop = (rect: CropRect) => {
    if (!source) return;
    const c = document.createElement('canvas');
    c.width = rect.w;
    c.height = rect.h;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source.img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    cropCanvasRef.current = c;
    setCropPreview(c.toDataURL('image/png'));
  };

  const sourceCoordsFromClient = (clientX: number, clientY: number) => {
    const canvas = sourceCanvasRef.current;
    if (!canvas || !source) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left) / zoom);
    const y = Math.floor((clientY - rect.top) / zoom);
    return {
      x: Math.max(0, Math.min(source.img.width - 1, x)),
      y: Math.max(0, Math.min(source.img.height - 1, y)),
    };
  };

  const clampCrop = (r: CropRect, maxW: number, maxH: number): CropRect => {
    let x1 = r.x;
    let y1 = r.y;
    let x2 = r.x + r.w - 1;
    let y2 = r.y + r.h - 1;
    if (x2 < x1) [x1, x2] = [x2, x1];
    if (y2 < y1) [y1, y2] = [y2, y1];
    x1 = Math.max(0, Math.min(maxW - 1, x1));
    y1 = Math.max(0, Math.min(maxH - 1, y1));
    x2 = Math.max(0, Math.min(maxW - 1, x2));
    y2 = Math.max(0, Math.min(maxH - 1, y2));
    return { x: x1, y: y1, w: Math.max(1, x2 - x1 + 1), h: Math.max(1, y2 - y1 + 1) };
  };

  const applyHandle = (start: CropRect, mode: CropHandle | 'draw', px: number, py: number, maxW: number, maxH: number): CropRect => {
    if (mode === 'draw') {
      return clampCrop({
        x: Math.min(start.x, px),
        y: Math.min(start.y, py),
        w: Math.abs(px - start.x) + 1,
        h: Math.abs(py - start.y) + 1,
      }, maxW, maxH);
    }
    let x1 = start.x;
    let y1 = start.y;
    let x2 = start.x + start.w - 1;
    let y2 = start.y + start.h - 1;
    if (mode === 'move') {
      const dx = px - adjustRef.current!.startPx;
      const dy = py - adjustRef.current!.startPy;
      const nx = Math.max(0, Math.min(maxW - start.w, start.x + dx));
      const ny = Math.max(0, Math.min(maxH - start.h, start.y + dy));
      return { x: nx, y: ny, w: start.w, h: start.h };
    }
    if (mode.includes('w')) x1 = px;
    if (mode.includes('e')) x2 = px;
    if (mode.includes('n')) y1 = py;
    if (mode.includes('s')) y2 = py;
    return clampCrop({ x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 }, maxW, maxH);
  };

  const beginAdjust = (mode: CropHandle | 'draw', clientX: number, clientY: number, startRect: CropRect) => {
    const p = sourceCoordsFromClient(clientX, clientY);
    adjustRef.current = { mode, startPx: p.x, startPy: p.y, startRect };
    setDraft(startRect);
    setAdjusting(true);
  };

  const onSelectDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!source) return;
    const p = sourceCoordsFromClient(e.clientX, e.clientY);
    if (crop && p.x >= crop.x && p.x < crop.x + crop.w && p.y >= crop.y && p.y < crop.y + crop.h) {
      beginAdjust('move', e.clientX, e.clientY, crop);
      return;
    }
    beginAdjust('draw', e.clientX, e.clientY, { x: p.x, y: p.y, w: 1, h: 1 });
  };

  const onHandleDown = (mode: CropHandle, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!crop) return;
    beginAdjust(mode, e.clientX, e.clientY, crop);
  };

  useEffect(() => {
    if (!adjusting || !source) return;
    const onMove = (e: MouseEvent) => {
      const adj = adjustRef.current;
      if (!adj) return;
      const p = sourceCoordsFromClient(e.clientX, e.clientY);
      setDraft(applyHandle(adj.startRect, adj.mode, p.x, p.y, source.img.width, source.img.height));
    };
    const onUp = (e: MouseEvent) => {
      const adj = adjustRef.current;
      adjustRef.current = null;
      setAdjusting(false);
      if (!adj) {
        setDraft(null);
        return;
      }
      const p = sourceCoordsFromClient(e.clientX, e.clientY);
      const next = applyHandle(adj.startRect, adj.mode, p.x, p.y, source.img.width, source.img.height);
      setCrop(next);
      rebuildCrop(next);
      setDraft(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [adjusting, source, zoom]);

  const goPlace = () => {
    if (!crop) return;
    setDestPos({
      x: Math.max(0, Math.min(sprite.img.width - crop.w, crop.x)),
      y: Math.max(0, Math.min(sprite.img.height - crop.h, crop.y)),
    });
    setPhase('place');
  };

  const onPlaceDown = (e: React.MouseEvent) => {
    if (!crop) return;
    const canvas = destCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / zoom;
    const my = (e.clientY - rect.top) / zoom;
    const inside =
      mx >= destPos.x && mx < destPos.x + crop.w &&
      my >= destPos.y && my < destPos.y + crop.h;
    if (!inside) {
      setDestPos({
        x: Math.round(mx - crop.w / 2),
        y: Math.round(my - crop.h / 2),
      });
      placeDragRef.current = { mx, my, ox: Math.round(mx - crop.w / 2), oy: Math.round(my - crop.h / 2) };
      return;
    }
    placeDragRef.current = { mx, my, ox: destPos.x, oy: destPos.y };
  };

  const onPlaceMove = (e: React.MouseEvent) => {
    if (!placeDragRef.current || !crop) return;
    const canvas = destCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / zoom;
    const my = (e.clientY - rect.top) / zoom;
    setDestPos({
      x: Math.round(placeDragRef.current.ox + (mx - placeDragRef.current.mx)),
      y: Math.round(placeDragRef.current.oy + (my - placeDragRef.current.my)),
    });
  };

  const onPlaceUp = () => {
    placeDragRef.current = null;
  };

  const pushHistory = () => {
    const canvas = destCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const next = [...historyRef.current, snapshot];
    if (next.length > 40) next.shift();
    historyRef.current = next;
    setHistoryLen(next.length);
  };

  const undo = () => {
    if (historyRef.current.length === 0) return;
    const snapshot = historyRef.current[historyRef.current.length - 1];
    historyRef.current = historyRef.current.slice(0, -1);
    setHistoryLen(historyRef.current.length);
    const canvas = destCanvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d', { willReadFrequently: true })!.putImageData(snapshot, 0, 0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        undo();
        return;
      }
      if (phase !== 'place' || !crop) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') { e.preventDefault(); setDestPos((p) => ({ ...p, x: p.x - step })); }
      if (e.key === 'ArrowRight') { e.preventDefault(); setDestPos((p) => ({ ...p, x: p.x + step })); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setDestPos((p) => ({ ...p, y: p.y - step })); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setDestPos((p) => ({ ...p, y: p.y + step })); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase, crop]);

  const stampCrop = () => {
    const canvas = destCanvasRef.current;
    const cropCanvas = cropCanvasRef.current;
    if (!canvas || !cropCanvas || !crop) return;
    pushHistory();
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = false;
    if (includeEmpty) {
      ctx.clearRect(destPos.x, destPos.y, crop.w, crop.h);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(cropCanvas, destPos.x, destPos.y);
  };

  const handleReset = () => {
    const canvas = destCanvasRef.current;
    if (!canvas) return;
    pushHistory();
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sprite.img, 0, 0);
  };

  const handleSave = () => {
    const canvas = destCanvasRef.current;
    if (!canvas) return;
    const newImg = new Image();
    newImg.onload = () => onSave(sprite.id, newImg);
    newImg.src = canvas.toDataURL('image/png');
  };

  const shownRect = draft || crop;

  const picker = (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '1080px', height: 'auto', maxHeight: '92vh' }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Crop size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem' }}>Copiar recorte en: {sprite.name}</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        <div style={{ padding: '16px 20px', overflow: 'auto' }}>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.45 }}>
            Elegí el sprite fuente. Después marcás un rectángulo exacto y lo colocás donde quieras sobre <strong>{sprite.name}</strong>.
          </p>
          {others.length === 0 ? (
            <div className="empty-msg">Cargá al menos otro sprite para usarlo como fuente.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px' }}>
              {others.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="btn btn-outline"
                  onClick={() => {
                    setSourceId(s.id);
                    setPhase('select');
                    setCrop(null);
                    setDraft(null);
                    setCropPreview(null);
                    cropCanvasRef.current = null;
                  }}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '10px',
                    height: 'auto',
                    textAlign: 'center',
                  }}
                >
                  <div className="checker-mini" style={{ width: '100%', height: '88px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', overflow: 'hidden' }}>
                    <SpriteThumb img={s.img} maxWidth={140} maxHeight={88} alt={s.name} />
                  </div>
                  <span style={{ fontSize: '0.7rem', wordBreak: 'break-all' }}>{s.name}</span>
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{s.img.width}×{s.img.height}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (!source) return picker;

  const viewImg = phase === 'select' ? source.img : sprite.img;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <Crop size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Copiar recorte: {sprite.name}
            </h3>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>
              {phase === 'select' ? `← recortar ${source.name}` : `colocar en ${sprite.name}`}
            </span>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        <div
          ref={workspaceRef}
          className={`eraser-workspace checker-mini ${isWhiteBg ? 'white-bg' : ''}`}
          style={{ overflow: 'auto' }}
          onScroll={onWorkspaceScroll}
        >
          <div style={{
            width: viewImg.width * zoom,
            height: viewImg.height * zoom,
            position: 'relative',
          }}>
            <div style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: viewImg.width,
              height: viewImg.height,
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
              cursor: phase === 'select' ? 'crosshair' : 'grab',
            }}>
              <canvas
                ref={sourceCanvasRef}
                onMouseDown={onSelectDown}
                style={{ display: phase === 'select' ? 'block' : 'none' }}
              />
              <canvas
                ref={destCanvasRef}
                onMouseDown={onPlaceDown}
                onMouseMove={onPlaceMove}
                onMouseUp={onPlaceUp}
                onMouseLeave={onPlaceUp}
                style={{ display: phase === 'place' ? 'block' : 'none' }}
              />
              {phase === 'select' && shownRect && (() => {
                const hs = Math.max(2, 8 / zoom);
                const edge = Math.max(2, 6 / zoom);
                const handleStyle = (extra: React.CSSProperties): React.CSSProperties => ({
                  position: 'absolute',
                  background: '#6b66ff',
                  boxShadow: '0 0 0 1px #fff',
                  pointerEvents: 'auto',
                  zIndex: 2,
                  ...extra,
                });
                return (
                  <div style={{
                    position: 'absolute',
                    left: shownRect.x,
                    top: shownRect.y,
                    width: shownRect.w,
                    height: shownRect.h,
                    border: '1px solid #6b66ff',
                    boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
                    pointerEvents: 'none',
                    imageRendering: 'pixelated',
                  }}>
                    <div onMouseDown={(e) => onHandleDown('n', e)} style={handleStyle({ left: hs, right: hs, top: -edge / 2, height: edge, cursor: 'ns-resize' })} />
                    <div onMouseDown={(e) => onHandleDown('s', e)} style={handleStyle({ left: hs, right: hs, bottom: -edge / 2, height: edge, cursor: 'ns-resize' })} />
                    <div onMouseDown={(e) => onHandleDown('w', e)} style={handleStyle({ top: hs, bottom: hs, left: -edge / 2, width: edge, cursor: 'ew-resize' })} />
                    <div onMouseDown={(e) => onHandleDown('e', e)} style={handleStyle({ top: hs, bottom: hs, right: -edge / 2, width: edge, cursor: 'ew-resize' })} />
                    <div onMouseDown={(e) => onHandleDown('nw', e)} style={handleStyle({ left: -hs / 2, top: -hs / 2, width: hs, height: hs, cursor: 'nwse-resize' })} />
                    <div onMouseDown={(e) => onHandleDown('ne', e)} style={handleStyle({ right: -hs / 2, top: -hs / 2, width: hs, height: hs, cursor: 'nesw-resize' })} />
                    <div onMouseDown={(e) => onHandleDown('sw', e)} style={handleStyle({ left: -hs / 2, bottom: -hs / 2, width: hs, height: hs, cursor: 'nesw-resize' })} />
                    <div onMouseDown={(e) => onHandleDown('se', e)} style={handleStyle({ right: -hs / 2, bottom: -hs / 2, width: hs, height: hs, cursor: 'nwse-resize' })} />
                  </div>
                );
              })()}
              {phase === 'place' && crop && (
                <div style={{
                  position: 'absolute',
                  left: destPos.x,
                  top: destPos.y,
                  width: crop.w,
                  height: crop.h,
                  outline: '1px solid #6b66ff',
                  outlineOffset: 0,
                  pointerEvents: 'none',
                  imageRendering: 'pixelated',
                }}>
                  {cropPreview && !hidePreview && previewOpacity > 0 && (
                    <img
                      src={cropPreview}
                      alt=""
                      draggable={false}
                      style={{
                        width: '100%',
                        height: '100%',
                        imageRendering: 'pixelated',
                        opacity: previewOpacity / 100,
                        display: 'block',
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="modal-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px' }}>
            <button className="btn btn-outline" onClick={() => { setSourceId(null); setPhase('select'); }}>
              Cambiar fuente
            </button>
            {phase === 'place' && (
              <button className="btn btn-outline" onClick={() => setPhase('select')}>
                Volver a recortar
              </button>
            )}
            {shownRect && (
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                {phase === 'select'
                  ? `Recorte ${shownRect.w}×${shownRect.h} en (${shownRect.x}, ${shownRect.y}) · Arrastrá los lados para ajustar`
                  : crop
                    ? `Pegar ${crop.w}×${crop.h} en (${destPos.x}, ${destPos.y})`
                    : ''}
              </span>
            )}
            {phase === 'place' && (
              <>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '0.75rem',
                    color: includeEmpty ? 'var(--accent)' : 'var(--text-light)',
                    cursor: 'pointer',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                  }}
                  title="Si está activo, el recorte también pisa con los píxeles vacíos de la fuente"
                >
                  <input
                    type="checkbox"
                    checked={includeEmpty}
                    onChange={(e) => setIncludeEmpty(e.target.checked)}
                    style={{ cursor: 'pointer' }}
                  />
                  Pegar vacío
                </label>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '0.75rem',
                    color: hidePreview ? 'var(--accent)' : 'var(--text-light)',
                    cursor: 'pointer',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                  }}
                  title="Oculta el recorte y deja solo el marco, para ver el destino"
                >
                  <input
                    type="checkbox"
                    checked={hidePreview}
                    onChange={(e) => setHidePreview(e.target.checked)}
                    style={{ cursor: 'pointer' }}
                  />
                  Ocultar recorte
                </label>
              </>
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 12px' }}>
            <div className="slider-item" style={{ flex: 1, marginBottom: 0, minWidth: '140px' }}>
              <div className="slider-label">
                <span><Search size={14} /> Zoom</span>
                <span>{zoom.toFixed(1)}x</span>
              </div>
              <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
            </div>
            {phase === 'place' && !hidePreview && (
              <div className="slider-item" style={{ flex: 1, marginBottom: 0, minWidth: '140px' }}>
                <div className="slider-label">
                  <span>Vista previa</span>
                  <span>{previewOpacity}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={previewOpacity}
                  onChange={(e) => setPreviewOpacity(parseInt(e.target.value, 10))}
                  title="Transparencia de lo que vas a pegar"
                />
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto', flexWrap: 'wrap' }}>
              {phase === 'select' ? (
                <button className="btn btn-primary" disabled={!crop} onClick={goPlace}>
                  Colocar recorte
                </button>
              ) : (
                <>
                  <button className="btn btn-outline" onClick={undo} disabled={historyLen === 0} title="Ctrl+Z">
                    <RotateCcw size={16} /> Deshacer
                  </button>
                  <button className="btn btn-outline" onClick={handleReset}>Reiniciar</button>
                  <button className="btn btn-outline" onClick={stampCrop} disabled={!crop} title="Pega el recorte en la posición actual (flechas para mover 1 px)">
                    Pegar
                  </button>
                  <button className="btn btn-primary" onClick={handleSave}>Guardar Cambios</button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Transform Modal Component ---
interface TransformModalProps {
  sprite: SpriteData;
  onSave: (id: string, updates: Partial<SpriteData>) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

const TransformModal: React.FC<TransformModalProps> = ({ sprite, onSave, onClose, isWhiteBg }) => {
  const [rotation, setRotation] = useState(sprite.rotation || 0);
  const [offsetX, setOffsetX] = useState(sprite.offsetX || 0);
  const [offsetY, setOffsetY] = useState(sprite.offsetY || 0);
  const [zoom, setZoom] = useState(() => clampNum(loadPref('joa-transform-zoom', 1), 0.5, 8, 1));
  useModalWheelControls({ zoom, setZoom });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const scX = (sprite.scale || 1) * (sprite.stretchX || 1) * 0.8 * zoom;
    const scY = (sprite.scale || 1) * (sprite.stretchY || 1) * 0.8 * zoom;
    const sw = sprite.img.width * scX;
    const sh = sprite.img.height * scY;
    
    canvas.width = 800;
    canvas.height = 800;
    ctx.clearRect(0, 0, 800, 800);
    ctx.imageSmoothingEnabled = false;

    ctx.save();
    ctx.translate(400 + offsetX * zoom, 400 + offsetY * zoom);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(sprite.img, -sw/2, -sh/2, sw, sh);
    ctx.restore();
  }, [sprite, rotation, offsetX, offsetY, zoom]);

  useEffect(() => {
    savePref('joa-transform-zoom', zoom);
  }, [zoom]);

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - offsetX * zoom, y: e.clientY - offsetY * zoom });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setOffsetX((e.clientX - dragStart.x) / zoom);
    setOffsetY((e.clientY - dragStart.y) / zoom);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <RotateCcw size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem' }}>Transformar: {sprite.name}</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        <div className={`eraser-workspace checker-mini ${isWhiteBg ? 'white-bg' : ''}`} 
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={() => setIsDragging(false)}
          onMouseLeave={() => setIsDragging(false)}
          style={{ cursor: isDragging ? 'grabbing' : 'grab', position: 'relative' }}
        >
           <canvas ref={canvasRef} />
           <div style={{ position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.7)', padding: '8px 16px', borderRadius: '20px', fontSize: '0.7rem', color: 'white', pointerEvents: 'none' }}>
             Arrastra para mover la imagen dentro del contenedor
           </div>
        </div>
        <div className="modal-footer" style={{ padding: '20px', background: 'var(--bg-panel)', borderTop: '1px solid var(--border)', gap: '24px' }}>
          <div className="slider-item" style={{ flex: 1, marginBottom: 0 }}>
            <div className="slider-label"><span><Search size={14} /> Zoom</span><span>{zoom.toFixed(1)}x</span></div>
            <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
          </div>
          <div className="slider-item" style={{ flex: 1, marginBottom: 0 }}>
            <div className="slider-label"><span>Rotación</span><span>{rotation}°</span></div>
            <input type="range" min="0" max="360" value={rotation} onChange={(e) => setRotation(parseInt(e.target.value))} />
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="btn btn-outline" onClick={() => { setRotation(0); setOffsetX(0); setOffsetY(0); setZoom(1); }}>Reiniciar</button>
            <button className="btn btn-primary" style={{ paddingLeft: '24px', paddingRight: '24px' }} onClick={() => onSave(sprite.id, { rotation, offsetX, offsetY })}>Guardar Cambios</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Stretch Modal Component ---
interface StretchModalProps {
  sprite: SpriteData;
  onSave: (id: string, updates: Partial<SpriteData>) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

const StretchModal: React.FC<StretchModalProps> = ({ sprite, onSave, onClose, isWhiteBg }) => {
  const [stretchX, setStretchX] = useState(sprite.stretchX || 1);
  const [stretchY, setStretchY] = useState(sprite.stretchY || 1);
  const [zoom, setZoom] = useState(() => clampNum(loadPref('joa-stretch-zoom', 1), 0.5, 8, 1));
  useModalWheelControls({ zoom, setZoom });
  
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    
    // Scale preview to fit 800x800 area
    const baseSc = (sprite.scale || 1) * 0.8 * zoom;
    const sw = sprite.img.width * baseSc * stretchX;
    const sh = sprite.img.height * baseSc * stretchY;
    
    canvas.width = 800;
    canvas.height = 800;
    ctx.clearRect(0, 0, 800, 800);
    ctx.imageSmoothingEnabled = false;

    ctx.save();
    ctx.translate(400, 400);
    ctx.drawImage(sprite.img, -sw/2, -sh/2, sw, sh);
    ctx.restore();
  }, [sprite, stretchX, stretchY, zoom]);

  useEffect(() => {
    savePref('joa-stretch-zoom', zoom);
  }, [zoom]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Maximize size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem' }}>Estirar: {sprite.name}</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        <div className={`eraser-workspace checker-mini ${isWhiteBg ? 'white-bg' : ''}`} style={{ overflow: 'auto' }}>
           <canvas ref={canvasRef} />
        </div>
        <div className="modal-footer" style={{ padding: '20px', background: 'var(--bg-panel)', borderTop: '1px solid var(--border)', gap: '24px' }}>
          <div className="slider-item" style={{ flex: 1, marginBottom: 0 }}>
            <div className="slider-label"><span>Ancho (X)</span><span>{stretchX.toFixed(2)}x</span></div>
            <input type="range" min="0.1" max="4" step="0.01" value={stretchX} onChange={(e) => setStretchX(parseFloat(e.target.value))} />
          </div>
          <div className="slider-item" style={{ flex: 1, marginBottom: 0 }}>
            <div className="slider-label"><span>Alto (Y)</span><span>{stretchY.toFixed(2)}x</span></div>
            <input type="range" min="0.1" max="4" step="0.01" value={stretchY} onChange={(e) => setStretchY(parseFloat(e.target.value))} />
          </div>
          <div className="slider-item" style={{ width: '120px', marginBottom: 0 }}>
            <div className="slider-label"><span>Zoom</span><span>{zoom.toFixed(1)}x</span></div>
            <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="btn btn-outline" onClick={() => { setStretchX(1); setStretchY(1); }}>Reset</button>
            <button className="btn btn-primary" style={{ paddingLeft: '24px', paddingRight: '24px' }} onClick={() => onSave(sprite.id, { stretchX, stretchY })}>Guardar Cambios</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Effect Mask Modal Component ---
interface EffectMaskSaveData {
  mode: 'rect' | 'brush';
  masks: Region[];
  brush: string | null;
}

interface EffectMaskModalProps {
  sprite: SpriteData;
  onSave: (id: string, data: EffectMaskSaveData) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

const EffectMaskModal: React.FC<EffectMaskModalProps> = ({ sprite, onSave, onClose, isWhiteBg }) => {
  const [toolMode, setToolMode] = useState<'rect' | 'brush'>(
    sprite.effectMaskMode || (sprite.effectMaskBrush ? 'brush' : 'rect')
  );
  const [masks, setMasks] = useState<Region[]>(sprite.effectMasks || []);
  const [brushSize, setBrushSize] = useState(() => Math.round(clampNum(loadPref('joa-effect-mask-brush', 16), 2, 64, 16)));
  const [zoom, setZoom] = useState(() => clampNum(loadPref('joa-effect-mask-zoom', 1), 0.5, 8, 1));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useModalWheelControls({ zoom, setZoom, brushSize, setBrushSize, brushMin: 2, brushMax: 64, workspaceRef });
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [currentRect, setCurrentRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [lastBrushPoint, setLastBrushPoint] = useState<{ x: number; y: number } | null>(null);
  const [brushTick, setBrushTick] = useState(0);

  useEffect(() => {
    if (!maskCanvasRef.current) {
      maskCanvasRef.current = document.createElement('canvas');
    }
    const maskCanvas = maskCanvasRef.current;
    maskCanvas.width = sprite.img.width;
    maskCanvas.height = sprite.img.height;
    const mctx = maskCanvas.getContext('2d')!;
    mctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    if (sprite.effectMaskBrush) {
      const img = new Image();
      img.onload = () => {
        mctx.drawImage(img, 0, 0);
        setBrushTick(t => t + 1);
      };
      img.src = sprite.effectMaskBrush;
    }
  }, [sprite.id, sprite.effectMaskBrush, sprite.img.width, sprite.img.height]);

  useEffect(() => {
    savePref('joa-effect-mask-zoom', zoom);
    savePref('joa-effect-mask-brush', brushSize);
  }, [zoom, brushSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!canvas || !maskCanvas) return;
    const ctx = canvas.getContext('2d')!;
    canvas.width = sprite.img.width;
    canvas.height = sprite.img.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sprite.img, 0, 0);

    if (toolMode === 'rect') {
      masks.forEach((m, idx) => {
        ctx.strokeStyle = '#6b66ff';
        ctx.lineWidth = 2 / zoom;
        ctx.strokeRect(m.x, m.y, m.w, m.h);
        ctx.fillStyle = 'rgba(107, 102, 255, 0.2)';
        ctx.fillRect(m.x, m.y, m.w, m.h);
        ctx.fillStyle = '#6b66ff';
        ctx.font = `${Math.max(10, 12 / zoom)}px sans-serif`;
        ctx.fillText(`${idx + 1}`, m.x + 4, m.y + 14 / zoom);
      });
      if (currentRect) {
        ctx.strokeStyle = '#00ffcc';
        ctx.setLineDash([5 / zoom, 5 / zoom]);
        ctx.strokeRect(currentRect.x, currentRect.y, currentRect.w, currentRect.h);
        ctx.setLineDash([]);
      }
    } else {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.drawImage(maskCanvas, 0, 0);
      ctx.restore();
      ctx.strokeStyle = '#6b66ff';
      ctx.lineWidth = 1 / zoom;
      ctx.strokeRect(0, 0, canvas.width, canvas.height);
    }
  }, [sprite, masks, zoom, currentRect, toolMode, brushTick]);

  const getCanvasCoords = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
    const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
    return { x: Math.max(0, Math.min(canvas.width - 1, x)), y: Math.max(0, Math.min(canvas.height - 1, y)) };
  };

  const paintBrushStroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const mctx = maskCanvasRef.current!.getContext('2d')!;
    mctx.strokeStyle = '#ffffff';
    mctx.fillStyle = '#ffffff';
    mctx.lineWidth = brushSize;
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    mctx.beginPath();
    mctx.moveTo(from.x, from.y);
    mctx.lineTo(to.x, to.y);
    mctx.stroke();
    mctx.beginPath();
    mctx.arc(to.x, to.y, brushSize / 2, 0, Math.PI * 2);
    mctx.fill();
    setBrushTick(t => t + 1);
  };

  const paintBrushDot = (coords: { x: number; y: number }) => {
    const mctx = maskCanvasRef.current!.getContext('2d')!;
    mctx.fillStyle = '#ffffff';
    mctx.beginPath();
    mctx.arc(coords.x, coords.y, brushSize / 2, 0, Math.PI * 2);
    mctx.fill();
    setBrushTick(t => t + 1);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const coords = getCanvasCoords(e);
    setIsDrawing(true);
    if (toolMode === 'rect') {
      setStartPoint(coords);
      setCurrentRect(null);
    } else {
      setLastBrushPoint(coords);
      paintBrushDot(coords);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing) return;
    const coords = getCanvasCoords(e);
    if (toolMode === 'rect' && startPoint) {
      setCurrentRect({
        x: Math.min(startPoint.x, coords.x),
        y: Math.min(startPoint.y, coords.y),
        w: Math.abs(coords.x - startPoint.x),
        h: Math.abs(coords.y - startPoint.y),
      });
    } else if (toolMode === 'brush' && lastBrushPoint) {
      paintBrushStroke(lastBrushPoint, coords);
      setLastBrushPoint(coords);
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (toolMode === 'rect' && isDrawing && startPoint) {
      const coords = getCanvasCoords(e);
      const finalRect = {
        x: Math.min(startPoint.x, coords.x),
        y: Math.min(startPoint.y, coords.y),
        w: Math.abs(coords.x - startPoint.x),
        h: Math.abs(coords.y - startPoint.y),
      };
      if (finalRect.w > 2 && finalRect.h > 2) {
        setMasks(prev => [...prev, {
          id: generateId(),
          label: `Área ${prev.length + 1}`,
          ...finalRect,
        }]);
      }
    }
    setIsDrawing(false);
    setStartPoint(null);
    setCurrentRect(null);
    setLastBrushPoint(null);
  };

  const deleteMask = (id: string) => setMasks(prev => prev.filter(m => m.id !== id));

  const clearAll = () => {
    if (toolMode === 'rect') {
      setMasks([]);
    } else {
      const mctx = maskCanvasRef.current!.getContext('2d')!;
      mctx.clearRect(0, 0, maskCanvasRef.current!.width, maskCanvasRef.current!.height);
      setBrushTick(t => t + 1);
    }
  };

  const handleSave = () => {
    if (toolMode === 'rect') {
      onSave(sprite.id, { mode: 'rect', masks, brush: null });
    } else {
      const brush = maskCanvasRef.current!.toDataURL('image/png');
      onSave(sprite.id, { mode: 'brush', masks: [], brush });
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content tagging-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Crop size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem' }}>Áreas de Efecto: {sprite.name}</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div className={`eraser-workspace checker-mini ${isWhiteBg ? 'white-bg' : ''}`} ref={workspaceRef} style={{ flex: 1, overflow: 'auto' }}>
            <div style={{
              width: sprite.img.width * zoom,
              height: sprite.img.height * zoom,
              position: 'relative',
            }}>
              <div style={{
                position: 'absolute',
                left: 0,
                top: 0,
                cursor: toolMode === 'brush' ? 'crosshair' : 'crosshair',
                width: sprite.img.width,
                height: sprite.img.height,
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
              }}>
              <canvas
                ref={canvasRef}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              />
              </div>
            </div>
            <div style={{ position: 'sticky', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.7)', padding: '8px 16px', borderRadius: '20px', fontSize: '0.7rem', color: 'white', pointerEvents: 'none', width: 'max-content', margin: '12px auto 0' }}>
              {toolMode === 'rect'
                ? 'Arrastra para añadir rectángulos. Los ajustes del panel solo afectan las zonas marcadas.'
                : 'Pinta sobre la imagen con el pincel. Ajusta el grosor en la barra inferior.'}
            </div>
          </div>
          <div className="tagging-sidebar" style={{ minWidth: '260px' }}>
            <div className="sidebar-section">
              <span className="section-title">Forma de Selección</span>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                <button
                  className={`btn btn-outline ${toolMode === 'rect' ? 'active' : ''}`}
                  style={{ flex: 1, justifyContent: 'center', fontSize: '0.65rem', borderColor: toolMode === 'rect' ? 'var(--accent)' : undefined, color: toolMode === 'rect' ? 'var(--accent)' : undefined }}
                  onClick={() => setToolMode('rect')}
                >
                  <Square size={14} /> Rectángulo
                </button>
                <button
                  className={`btn btn-outline ${toolMode === 'brush' ? 'active' : ''}`}
                  style={{ flex: 1, justifyContent: 'center', fontSize: '0.65rem', borderColor: toolMode === 'brush' ? 'var(--accent)' : undefined, color: toolMode === 'brush' ? 'var(--accent)' : undefined }}
                  onClick={() => setToolMode('brush')}
                >
                  <Brush size={14} /> Pincel
                </button>
              </div>
            </div>
            {toolMode === 'rect' ? (
              <div className="sidebar-section">
                <span className="section-title">Áreas Activas ({masks.length})</span>
                <div className="region-list">
                  {masks.map((m, idx) => (
                    <div key={m.id} className="region-item">
                      <div className="region-info">
                        <span className="region-label">Área {idx + 1}</span>
                        <span className="region-coords">{m.x},{m.y} {m.w}×{m.h}</span>
                      </div>
                      <button className="btn-ghost btn-danger" onClick={() => deleteMask(m.id)}><Trash2 size={12} /></button>
                    </div>
                  ))}
                  {masks.length === 0 && (
                    <div className="empty-msg">Arrastra sobre la imagen para crear la primera área</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="sidebar-section">
                <span className="section-title">Pincel</span>
                <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  Pinta libremente la zona donde quieres aplicar efectos. Usa <strong>Limpiar Todo</strong> para borrar el trazo.
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer" style={{ padding: '16px 20px', background: 'var(--bg-panel)', borderTop: '1px solid var(--border)', gap: '16px', flexWrap: 'wrap' }}>
          <div className="slider-item" style={{ flex: 1, minWidth: '140px', marginBottom: 0 }}>
            <div className="slider-label"><span><Search size={14} /> Zoom</span><span>{zoom.toFixed(1)}x</span></div>
            <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
          </div>
          {toolMode === 'brush' && (
            <div className="slider-item" style={{ flex: 1, minWidth: '140px', marginBottom: 0 }}>
              <div className="slider-label"><span><Brush size={14} /> Grosor</span><span>{brushSize}px</span></div>
              <input type="range" min="2" max="64" step="1" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} />
            </div>
          )}
          <div style={{ display: 'flex', gap: '12px', marginLeft: 'auto' }}>
            <button className="btn btn-outline" onClick={clearAll}>Limpiar Todo</button>
            <button className="btn btn-primary" style={{ paddingLeft: '24px', paddingRight: '24px' }} onClick={handleSave}>Guardar Áreas</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Tagging Modal Component ---
interface TaggingModalProps {
  sprite: SpriteData;
  onSave: (id: string, regions: Region[]) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

const TaggingModal: React.FC<TaggingModalProps> = ({ sprite, onSave, onClose, isWhiteBg }) => {
  const [regions, setRegions] = useState<Region[]>(sprite.regions || []);
  const [zoom, setZoom] = useState(() => clampNum(loadPref('joa-tagging-zoom', 1), 0.5, 8, 1));
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number, y: number } | null>(null);
  const [currentRect, setCurrentRect] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  useModalWheelControls({ zoom, setZoom, workspaceRef });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    canvas.width = sprite.img.width;
    canvas.height = sprite.img.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sprite.img, 0, 0);

    // Draw existing regions
    regions.forEach((r: Region) => {
      ctx.strokeStyle = '#ffcc00';
      ctx.lineWidth = 2 / zoom;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = 'rgba(255, 204, 0, 0.2)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
    });

    // Draw current drawing rect
    if (currentRect) {
      ctx.strokeStyle = '#00ffcc';
      ctx.setLineDash([5 / zoom, 5 / zoom]);
      ctx.strokeRect(currentRect.x, currentRect.y, currentRect.w, currentRect.h);
      ctx.setLineDash([]);
    }
  }, [sprite, regions, zoom, currentRect]);

  useEffect(() => {
    savePref('joa-tagging-zoom', zoom);
  }, [zoom]);

  const getCanvasCoords = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
    const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
    return { x, y };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const coords = getCanvasCoords(e);
    setIsDrawing(true);
    setStartPoint(coords);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing || !startPoint) return;
    const coords = getCanvasCoords(e);
    setCurrentRect({
      x: Math.min(startPoint.x, coords.x),
      y: Math.min(startPoint.y, coords.y),
      w: Math.abs(coords.x - startPoint.x),
      h: Math.abs(coords.y - startPoint.y)
    });
  };

  const handleMouseUp = () => {
    if (isDrawing && currentRect && currentRect.w > 2 && currentRect.h > 2) {
      const label = prompt('Nombre de la zona (ej: "Mano", "Hitbox"):', `Zona ${regions.length + 1}`);
      if (label) {
        const newRegion: Region = {
          id: generateId(),
          label,
          ...currentRect
        };
        setRegions([...regions, newRegion]);
      }
    }
    setIsDrawing(false);
    setStartPoint(null);
    setCurrentRect(null);
  };

  const deleteRegion = (id: string) => {
    setRegions(regions.filter(r => r.id !== id));
  };

  const jsonOutput = JSON.stringify(
    regions.map(({ label, x, y, w, h }: Region) => ({ label, x, y, w, h })), 
    null, 2
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content tagging-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <MapPin size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem' }}>Etiquetar Regiones: {sprite.name}</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div className={`eraser-workspace checker-mini ${isWhiteBg ? 'white-bg' : ''}`} ref={workspaceRef} style={{ flex: 1, overflow: 'auto' }}>
            <div style={{
              width: sprite.img.width * zoom,
              height: sprite.img.height * zoom,
              position: 'relative',
            }}>
              <div style={{
                position: 'absolute',
                left: 0,
                top: 0,
                cursor: 'crosshair',
                width: sprite.img.width,
                height: sprite.img.height,
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
              }}>
              <canvas 
                ref={canvasRef}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
              />
              </div>
            </div>
          </div>

          <div className="tagging-sidebar" style={{ minWidth: '300px' }}>
            <div className="sidebar-section">
              <span className="section-title">Zonas Registradas</span>
              <div className="region-list">
                {regions.map((r: Region) => (
                  <div key={r.id} className="region-item">
                    <div className="region-info">
                      <span className="region-label">{r.label}</span>
                      <span className="region-coords">{r.x},{r.y} {r.w}x{r.h}</span>
                    </div>
                    <button className="btn-ghost btn-danger" onClick={() => deleteRegion(r.id)}><Trash2 size={12} /></button>
                  </div>
                ))}
                {regions.length === 0 && <div className="empty-msg">Arrastra sobre la imagen para crear una zona</div>}
              </div>
            </div>

            <div className="sidebar-section json-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span className="section-title" style={{ marginBottom: 0 }}>JSON de Salida</span>
                <button className="btn-ghost" style={{ fontSize: '0.6rem' }} 
                  onClick={() => { navigator.clipboard.writeText(jsonOutput); alert('Copiado al portapapeles'); }}>
                  Copiar
                </button>
              </div>
              <pre className="json-pre">{jsonOutput}</pre>
            </div>
          </div>
        </div>

        <div className="modal-footer" style={{ padding: '16px 20px', background: 'var(--bg-panel)', borderTop: '1px solid var(--border)', gap: '24px' }}>
          <div className="slider-item" style={{ flex: 1, marginBottom: 0 }}>
            <div className="slider-label"><span><Search size={14} /> Zoom</span><span>{zoom.toFixed(1)}x</span></div>
            <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="btn btn-outline" onClick={() => { if(confirm('¿Limpiar todas las zonas?')) setRegions([]); }}>Limpiar Todo</button>
            <button className="btn btn-primary" style={{ paddingLeft: '24px', paddingRight: '24px' }} onClick={() => onSave(sprite.id, regions)}>Guardar Cambios</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Bucket Modal Component ---
interface BucketModalProps {
  sprite: SpriteData;
  onSave: (id: string, img: HTMLImageElement) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

type BucketMode = 'global' | 'contiguous' | 'precise';

type BucketPrefs = {
  zoom: number;
  replaceColor: string;
  mode: BucketMode;
  tolerance: number;
  paintEmpty: boolean;
};

const BUCKET_PREFS_KEY = 'joa-bucket-prefs';

const loadBucketPrefs = (): BucketPrefs => {
  const saved = loadPref<Partial<BucketPrefs>>(BUCKET_PREFS_KEY, {});
  const mode: BucketMode =
    saved.mode === 'precise' || saved.mode === 'contiguous' || saved.mode === 'global'
      ? saved.mode
      : 'global';
  return {
    zoom: clampNum(saved.zoom, 0.5, 8, 1),
    replaceColor: normalizeHexColor(saved.replaceColor, loadLastColor('#00ff00')) || '#00ff00',
    mode,
    tolerance: Math.round(clampNum(saved.tolerance, 0, 255, 0)),
    paintEmpty: saved.paintEmpty === true,
  };
};

const BucketModal: React.FC<BucketModalProps> = ({ sprite, onSave, onClose, isWhiteBg }) => {
  const [zoom, setZoom] = useState(() => loadBucketPrefs().zoom);
  const [replaceColor, setReplaceColor] = useState(() => loadBucketPrefs().replaceColor);
  const { workspaceRef, onWorkspaceScroll } = useRememberedScroll('joa-bucket-scroll', sprite.name);
  useModalWheelControls({ zoom, setZoom, workspaceRef });
  const [mode, setMode] = useState<BucketMode>(() => loadBucketPrefs().mode);
  const [tolerance, setTolerance] = useState(() => loadBucketPrefs().tolerance);
  const [paintEmpty, setPaintEmpty] = useState(() => loadBucketPrefs().paintEmpty);
  const [hoverColor, setHoverColor] = useState<number[] | null>(null);
  const [history, setHistory] = useState<ImageData[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = sprite.img.width;
    canvas.height = sprite.img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(sprite.img, 0, 0);
  }, [sprite]);

  useEffect(() => {
    savePref(BUCKET_PREFS_KEY, { zoom, replaceColor, mode, tolerance, paintEmpty });
    rememberLastColor(replaceColor);
  }, [zoom, replaceColor, mode, tolerance, paintEmpty]);

  const hexToRgb = (hex: string) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : null;
  };

  const colorDist = (
    r1: number, g1: number, b1: number, a1: number,
    r2: number, g2: number, b2: number, a2: number,
  ) => Math.max(
    Math.abs(r1 - r2),
    Math.abs(g1 - g2),
    Math.abs(b1 - b2),
    Math.abs(a1 - a2),
  );

  const commitChange = (newData: ImageData) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const oldData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setHistory(prev => {
      const arr = [...prev, oldData];
      if (arr.length > 20) arr.shift();
      return arr;
    });
    ctx.putImageData(newData, 0, 0);
  };

  const undo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.putImageData(prev, 0, 0);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / zoom);
    const y = Math.floor((e.clientY - rect.top) / zoom);
    
    if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const targetData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = targetData.data;

    const startIdx = (y * canvas.width + x) * 4;
    const tr = data[startIdx];
    const tg = data[startIdx+1];
    const tb = data[startIdx+2];
    const ta = data[startIdx+3];
    
    const repRGB = paintEmpty ? { r: 0, g: 0, b: 0 } : hexToRgb(replaceColor);
    if (!repRGB) return;

    if (paintEmpty) {
      if (ta < 8) return;
    } else if (tr === repRGB.r && tg === repRGB.g && tb === repRGB.b && ta === 255) {
      return;
    }

    const matchTol = Math.max(tolerance, 4);
    const EMPTY_A = 40;
    const PAINT_A = 160;
    const seedIsEmpty = ta < EMPTY_A;
    const seedIsNearWhite = ta >= 200 && tr >= 242 && tg >= 242 && tb >= 242;
    const seedIsHole = seedIsEmpty || seedIsNearWhite;

    const distToSeedAt = (i: number) => {
      if (seedIsEmpty && data[i + 3] < EMPTY_A) return 0;
      return colorDist(data[i], data[i + 1], data[i + 2], data[i + 3], tr, tg, tb, ta);
    };
    const isMatchAt = (i: number) => {
      const a = data[i + 3];
      if (seedIsHole) {
        // Hueco: el vacío cuenta aunque el clic haya sido en blanco opaco.
        if (a < EMPTY_A) return true;
        if (seedIsEmpty) return false;
        return distToSeedAt(i) <= matchTol;
      }
      if (a < 8) return false;
      return distToSeedAt(i) <= matchTol;
    };

    const paintAt = (i: number) => {
      if (paintEmpty) {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 0;
        return;
      }
      data[i] = repRGB.r;
      data[i + 1] = repRGB.g;
      data[i + 2] = repRGB.b;
      data[i + 3] = 255;
    };

    if (mode === 'global') {
      for (let i = 0; i < data.length; i += 4) {
        if (isMatchAt(i)) paintAt(i);
      }
    } else {
      const precise = mode === 'precise';
      const w = canvas.width;
      const h = canvas.height;
      const visited = new Uint8Array(w * h);
      const orthoOf = (pos: number) => {
        const cx = pos % w;
        const cy = (pos / w) | 0;
        return [
          cx > 0 ? pos - 1 : -1,
          cx + 1 < w ? pos + 1 : -1,
          cy > 0 ? pos - w : -1,
          cy + 1 < h ? pos + w : -1,
        ];
      };

      const stack = [y * w + x];
      visited[y * w + x] = 1;

      // 4-conectado: respeta contornos de pixel art.
      while (stack.length > 0) {
        const pos = stack.pop()!;
        paintAt(pos * 4);
        for (const np of orthoOf(pos)) {
          if (np < 0 || visited[np]) continue;
          if (!isMatchAt(np * 4)) continue;
          visited[np] = 1;
          stack.push(np);
        }
      }

      if (seedIsHole) {
        // Seguir por vacío / semi-vacío hasta tocar algo pintado (a >= PAINT_A).
        const grow: number[] = [];
        for (let p = 0; p < visited.length; p++) {
          if (visited[p]) grow.push(p);
        }
        while (grow.length > 0) {
          const pos = grow.pop()!;
          for (const np of orthoOf(pos)) {
            if (np < 0 || visited[np]) continue;
            if (data[np * 4 + 3] >= PAINT_A) continue;
            visited[np] = 1;
            paintAt(np * 4);
            grow.push(np);
          }
        }
      } else {
        // Recolor de pintura: solo come 1–2 px de vacío pegados al relleno y al dibujo.
        for (let pass = 0; pass < 2; pass++) {
          const extra: number[] = [];
          for (let pos = 0; pos < visited.length; pos++) {
            if (visited[pos]) continue;
            if (data[pos * 4 + 3] >= EMPTY_A) continue;
            let touchFill = false;
            let touchPaint = false;
            for (const np of orthoOf(pos)) {
              if (np < 0) continue;
              if (visited[np]) touchFill = true;
              else if (data[np * 4 + 3] >= PAINT_A) touchPaint = true;
            }
            if (touchFill && touchPaint) extra.push(pos);
          }
          if (extra.length === 0) break;
          for (const pos of extra) {
            visited[pos] = 1;
            paintAt(pos * 4);
          }
        }
      }

      if (precise) {
        // Integra semitransparentes / blur hasta el primer píxel 100% opaco.
        const grow: number[] = [];
        for (let p = 0; p < visited.length; p++) {
          if (visited[p]) grow.push(p);
        }
        while (grow.length > 0) {
          const pos = grow.pop()!;
          for (const np of orthoOf(pos)) {
            if (np < 0 || visited[np]) continue;
            if (data[np * 4 + 3] >= 255) continue;
            visited[np] = 1;
            paintAt(np * 4);
            grow.push(np);
          }
        }
      }
    }
    commitChange(targetData);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / zoom);
    const y = Math.floor((e.clientY - rect.top) / zoom);
    
    if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) {
      setHoverColor(null);
      return;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    if (pixel[3] > 0) {
      setHoverColor([pixel[0], pixel[1], pixel[2]]);
    } else {
      setHoverColor(null);
    }
  };

  const handleCompile = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const newImg = new Image();
    newImg.onload = () => onSave(sprite.id, newImg);
    newImg.src = canvas.toDataURL('image/png');
  };

  const handleReset = () => {
    if (!confirm('¿Seguro que quieres resetear los cambios de esta imagen?')) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sprite.originalImg || sprite.img, 0, 0);
    setHistory([]);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <PaintBucket size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem' }}>Balde de Pintura: {sprite.name}</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        
        <div
          ref={workspaceRef}
          className={`eraser-workspace checker-mini ${isWhiteBg ? 'white-bg' : ''}`}
          style={{ overflow: 'auto' }}
          onScroll={onWorkspaceScroll}
        >
           <div style={{
             width: sprite.img.width * zoom,
             height: sprite.img.height * zoom,
             position: 'relative'
           }}>
             <div style={{ 
               position: 'absolute',
               left: 0,
               top: 0,
               width: sprite.img.width,
               height: sprite.img.height,
               transform: `scale(${zoom})`,
               transformOrigin: 'top left',
               cursor: 'crosshair'
             }}>
               <canvas 
                ref={canvasRef}
                onClick={handleCanvasClick}
                onMouseMove={handleMouseMove}
                onMouseLeave={() => setHoverColor(null)}
               />
             </div>
           </div>
        </div>

        <div className="modal-footer" style={{ padding: '20px', background: 'var(--bg-panel)', borderTop: '1px solid var(--border)', gap: '24px', flexWrap: 'wrap' }}>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1 }}>
             <div className="slider-item" style={{ flex: 'none', width: '200px', marginBottom: 0 }}>
               <div className="slider-label"><span><Search size={14} /> Zoom</span><span>{zoom.toFixed(1)}x</span></div>
               <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
             </div>
             
             <div className="slider-item" style={{ flex: 'none', width: '220px', marginBottom: 0 }}>
                <div className="slider-label">
                  <span>Modo</span>
                </div>
                <select
                  className="input-small"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as BucketMode)}
                  style={{ width: '100%' }}
                  title={
                    mode === 'precise'
                      ? 'Igual que Contiguo, y sigue por píxeles semitransparentes hasta el primer opaco (alfa 255)'
                      : mode === 'contiguous'
                        ? 'Rellena la zona conectada hasta el borde del dibujo'
                        : 'Reemplaza ese color en todo el sprite'
                  }
                >
                   <option value="global">🎨 Todo (Global)</option>
                   <option value="contiguous">💧 Contiguo (Balde)</option>
                   <option value="precise">✦ Super precisa (opacidad)</option>
                </select>
             </div>
             
             <div className="slider-item" style={{ flex: 'none', width: '90px', marginBottom: 0 }}>
                <div className="slider-label">
                  <span>Tolerancia</span>
                  <span>{tolerance}</span>
                </div>
                <input type="range" min="0" max="100" value={Math.round((tolerance/255)*100)} onChange={(e) => setTolerance(Math.round(parseInt(e.target.value)*2.55))} />
             </div>
             
             <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="slider-label" style={{ marginBottom: 0 }}>Color Objetivo (Cursor)</span>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                   <div style={{ width: '24px', height: '24px', background: hoverColor ? `rgb(${hoverColor[0]},${hoverColor[1]},${hoverColor[2]})` : 'transparent', border: '1px solid var(--border)', borderRadius: '4px' }} />
                   <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{hoverColor ? `RGB(${hoverColor.join(',')})` : 'Ninguno'}</span>
                </div>
             </div>
             
             <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="slider-label" style={{ marginBottom: 0 }}>Color Nuevo</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="color"
                    value={replaceColor}
                    onChange={(e) => setReplaceColor(e.target.value)}
                    disabled={paintEmpty}
                    style={{ width: '40px', height: '32px', padding: 0, border: 'none', background: 'none', cursor: paintEmpty ? 'not-allowed' : 'pointer', opacity: paintEmpty ? 0.4 : 1 }}
                  />
                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '0.75rem',
                      color: paintEmpty ? 'var(--accent)' : 'var(--text-light)',
                      cursor: 'pointer',
                      userSelect: 'none',
                      whiteSpace: 'nowrap',
                    }}
                    title="El balde borra la zona y deja transparencia"
                  >
                    <input
                      type="checkbox"
                      checked={paintEmpty}
                      onChange={(e) => setPaintEmpty(e.target.checked)}
                      style={{ cursor: 'pointer' }}
                    />
                    Pintar vacío
                  </label>
                </div>
             </div>
          </div>

          <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
             <button className="btn btn-outline" onClick={undo} disabled={history.length === 0}><RotateCcw size={16} /> Deshacer</button>
             <button className="btn btn-outline" onClick={handleReset} style={{ color: 'var(--danger)', borderColor: 'rgba(255,100,100,0.2)' }}>Reset</button>
             <button className="btn btn-primary" onClick={handleCompile}><Save size={16} /> Guardar</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Paint Modal Component ---
interface PaintModalProps {
  sprite: SpriteData;
  onSave: (id: string, newImg: HTMLImageElement) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

type PaintPrefs = {
  zoom: number;
  brushSize: number;
  brushShape: 'circle' | 'square';
  paintColor: string;
  paintOpacity: number;
  brushSoftness: number;
  paintBehind: boolean;
  gridLock: boolean;
  showPixelGrid: boolean;
  ditherPattern: DitherPattern;
  ditherColorB: string;
  ditherEmpty: boolean;
  paletteLock: boolean;
};

type PaintGridOrigin = { x: number; y: number; size: number };

const paintGridMod = (n: number, m: number) => ((n % m) + m) % m;

const snapPaintGridCell = (px: number, py: number, origin: PaintGridOrigin) => {
  const { x: ox, y: oy, size } = origin;
  return {
    x: ox + Math.floor((px - ox) / size) * size,
    y: oy + Math.floor((py - oy) / size) * size,
  };
};

/** Recorre celdas (índices) entre dos puntos de la malla, sin saltarse ni repetir. */
const paintGridCellsOnLine = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { x: number; y: number }[] => {
  const cells: { x: number; y: number }[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  while (true) {
    cells.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return cells;
};

const PAINT_PREFS_KEY = 'joa-paint-prefs';

const loadPaintPrefs = (): PaintPrefs => {
  const saved = loadPref<Partial<PaintPrefs>>(PAINT_PREFS_KEY, {});
  return {
    zoom: clampNum(saved.zoom, 0.5, 8, 1),
    brushSize: Math.round(clampNum(saved.brushSize, 1, 100, 10)),
    brushShape: saved.brushShape === 'square' ? 'square' : 'circle',
    paintColor: normalizeHexColor(saved.paintColor, loadLastColor('#ff0000')) || '#ff0000',
    paintOpacity: Math.round(clampNum(saved.paintOpacity, 1, 100, 100)),
    brushSoftness: Math.round(clampNum(saved.brushSoftness, 0, 100, 0)),
    paintBehind: saved.paintBehind === true,
    gridLock: saved.gridLock === true,
    showPixelGrid: saved.showPixelGrid === true,
    ditherPattern: parseDitherPattern(saved.ditherPattern),
    ditherColorB: normalizeHexColor(saved.ditherColorB, '#000000') || '#000000',
    ditherEmpty: saved.ditherEmpty === true,
    paletteLock: saved.paletteLock === true,
  };
};

const PaintModal: React.FC<PaintModalProps> = ({ sprite, onSave, onClose, isWhiteBg }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [brushSize, setBrushSize] = useState(() => loadPaintPrefs().brushSize);
  const [brushShape, setBrushShape] = useState<'circle' | 'square'>(() => loadPaintPrefs().brushShape);
  const [paintColor, setPaintColor] = useState(() => loadPaintPrefs().paintColor);
  const [paintOpacity, setPaintOpacity] = useState(() => loadPaintPrefs().paintOpacity);
  const [brushSoftness, setBrushSoftness] = useState(() => loadPaintPrefs().brushSoftness);
  const [paintBehind, setPaintBehind] = useState(() => loadPaintPrefs().paintBehind);
  const [gridLock, setGridLock] = useState(() => loadPaintPrefs().gridLock);
  const [showPixelGrid, setShowPixelGrid] = useState(() => loadPaintPrefs().showPixelGrid);
  const [ditherPattern, setDitherPattern] = useState<DitherPattern>(() => loadPaintPrefs().ditherPattern);
  const [ditherColorB, setDitherColorB] = useState(() => loadPaintPrefs().ditherColorB);
  const [ditherEmpty, setDitherEmpty] = useState(() => loadPaintPrefs().ditherEmpty);
  const [paletteLock, setPaletteLock] = useState(() => loadPaintPrefs().paletteLock);
  const [palette, setPalette] = useState<string[]>([]);
  const [gridOrigin, setGridOrigin] = useState<PaintGridOrigin | null>(null);
  const [eyedropperMode, setEyedropperMode] = useState(false);
  const [zoom, setZoom] = useState(() => loadPaintPrefs().zoom);
  const [colorDraft, setColorDraft] = useState(() => loadPaintPrefs().paintColor);
  const [mousePos, setMousePos] = useState<{ x: number, y: number } | null>(null);
  const { workspaceRef, onWorkspaceScroll } = useRememberedScroll('joa-paint-scroll', sprite.name);
  const paintStageRef = useRef<HTMLDivElement>(null);
  useModalWheelControls({ zoom, setZoom, brushSize, setBrushSize, workspaceRef, contentRef: paintStageRef });
  const [historyLen, setHistoryLen] = useState(0);
  const lastPos = useRef<{ x: number, y: number } | null>(null);
  /** Historial local del lienzo de este modal (no toca el undo global ni otros sprites). */
  const historyRef = useRef<ImageData[]>([]);
  const strokeSavedRef = useRef(false);
  const isDrawingRef = useRef(false);
  /** Evita acumular alfa al pasar dos veces el mismo píxel en un mismo trazo semitransparente. */
  const strokePaintedRef = useRef<Set<string> | null>(null);
  const gridOriginRef = useRef<PaintGridOrigin | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    canvas.width = sprite.img.width;
    canvas.height = sprite.img.height;
    ctx.drawImage(sprite.img, 0, 0);
    historyRef.current = [];
    setHistoryLen(0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setPalette(extractPaletteFromImageData(data));
  }, [sprite]);

  useEffect(() => {
    savePref(PAINT_PREFS_KEY, {
      zoom, brushSize, brushShape, paintColor, paintOpacity, brushSoftness, paintBehind, gridLock,
      showPixelGrid, ditherPattern, ditherColorB, ditherEmpty, paletteLock,
    });
    rememberLastColor(paintColor);
    setColorDraft(paintColor);
  }, [zoom, brushSize, brushShape, paintColor, paintOpacity, brushSoftness, paintBehind, gridLock, showPixelGrid, ditherPattern, ditherColorB, ditherEmpty, paletteLock]);

  useEffect(() => {
    const size = Math.max(1, Math.round(brushSize));
    if (!gridLock || (gridOriginRef.current && gridOriginRef.current.size !== size)) {
      gridOriginRef.current = null;
      setGridOrigin(null);
    }
  }, [gridLock, brushSize]);

  const pushHistory = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const next = [...historyRef.current, snapshot];
    if (next.length > 40) next.shift();
    historyRef.current = next;
    setHistoryLen(next.length);
  };

  const undo = () => {
    if (historyRef.current.length === 0) return;
    const snapshot = historyRef.current[historyRef.current.length - 1];
    historyRef.current = historyRef.current.slice(0, -1);
    setHistoryLen(historyRef.current.length);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.putImageData(snapshot, 0, 0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        undo();
        return;
      }
      if (e.key.toLowerCase() === 'i' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        setEyedropperMode(v => !v);
      }
      if (e.key === 'Escape' && eyedropperMode) {
        setEyedropperMode(false);
      }
    };
    // Capture: intercepta antes que el Ctrl+Z global de la app.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [eyedropperMode]);

  const extractPalette = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setPalette(extractPaletteFromImageData(data));
  };

  const applyPaintColor = (raw: string, opts?: { addIfMissing?: boolean }) => {
    let hex = normalizeHexColor(raw, paintColor) || paintColor;
    if (opts?.addIfMissing) {
      setPalette((prev) => {
        if (prev.includes(hex)) return prev;
        return [hex, ...prev].slice(0, 64);
      });
      setPaintColor(hex);
      return;
    }
    if (paletteLock && palette.length > 0) {
      hex = nearestPaletteHex(hex, palette);
    }
    setPaintColor(hex);
  };

  const applyDitherColorB = (raw: string) => {
    let hex = normalizeHexColor(raw, ditherColorB) || ditherColorB;
    if (paletteLock && palette.length > 0) hex = nearestPaletteHex(hex, palette);
    setDitherColorB(hex);
  };

  const togglePaletteLock = () => {
    if (paletteLock) {
      setPaletteLock(false);
      return;
    }
    if (palette.length === 0) extractPalette();
    setPaletteLock(true);
  };

  useEffect(() => {
    if (!paletteLock || palette.length === 0) return;
    setPaintColor((c) => nearestPaletteHex(c, palette));
    setDitherColorB((c) => nearestPaletteHex(c, palette));
  }, [paletteLock, palette]);

  const sampleCanvasColor = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor((e.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)));
    const py = Math.floor((e.clientY - rect.top) * (canvas.height / Math.max(1, rect.height)));
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return;
    const { data } = ctx.getImageData(px, py, 1, 1);
    if (data[3] < 8) return; // vacío: no cambiar color
    const hex = rememberLastColor(rgbToHex(data[0], data[1], data[2]));
    if (hex) applyPaintColor(hex, { addIfMissing: paletteLock });
    setEyedropperMode(false);
  };

  const openScreenEyedropper = async () => {
    const EyeDropperCtor = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!EyeDropperCtor) {
      setEyedropperMode(true);
      return;
    }
    try {
      const result = await new EyeDropperCtor().open();
      const hex = rememberLastColor(result?.sRGBHex || '');
      if (hex) applyPaintColor(hex);
    } catch {
      // Cancelado por el usuario
    }
  };

  const paintCssColor = (hex = paintColor) =>
    hexToRgbaCss(normalizeHexColor(hex, '#ff0000') || '#ff0000', paintOpacity);

  const softScratchRef = useRef<HTMLCanvasElement | null>(null);
  const getSoftScratch = (w: number, h: number) => {
    const c = softScratchRef.current || document.createElement('canvas');
    softScratchRef.current = c;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return c;
  };

  const applyDitherStyle = (
    ctx: CanvasRenderingContext2D,
    ix: number,
    iy: number,
    colorA: string,
    colorB: string,
  ): boolean => {
    if (ditherPattern === 'off') {
      ctx.fillStyle = colorA;
      return true;
    }
    const pick = ditherPick(ix, iy, ditherPattern);
    if (pick === 'b' && ditherEmpty) return false;
    ctx.fillStyle = pick === 'b' ? colorB : colorA;
    return true;
  };

  /** Pinta duro en un buffer y aplica blur pareja (pérdida de definición general). */
  const stampHardThenBlur = (
    dest: CanvasRenderingContext2D,
    stampW: number,
    stampH: number,
    destX: number,
    destY: number,
    paintHard: (sctx: CanvasRenderingContext2D) => void,
  ) => {
    const blurR = brushBlurRadius(brushSoftness, Math.max(stampW, stampH) / 2);
    const pad = blurR * 2;
    const tw = Math.max(1, Math.ceil(stampW + pad * 2));
    const th = Math.max(1, Math.ceil(stampH + pad * 2));
    const tip = getSoftScratch(tw, th);
    const tctx = tip.getContext('2d', { willReadFrequently: true })!;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalCompositeOperation = 'source-over';
    tctx.clearRect(0, 0, tw, th);
    tctx.save();
    tctx.translate(pad, pad);
    paintHard(tctx);
    tctx.restore();
    if (blurR > 0) {
      const blurred = boxBlurImageData(tctx.getImageData(0, 0, tw, th), blurR);
      tctx.putImageData(blurred, 0, 0);
    }
    dest.drawImage(tip, Math.floor(destX) - pad, Math.floor(destY) - pad);
  };

  const stampBrush = (
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    painted: Set<string> | null,
    colorA: string,
    colorB: string,
  ) => {
    // Anclar al píxel: si el centro queda fraccionario, el cuadrado/círculo
    // cambia de márgenes entre clics en el "mismo" punto.
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    const r = brushSize;
    if (r <= 0) return;

    const paintHardAt = (target: CanvasRenderingContext2D, ox: number, oy: number, trackPixels: boolean) => {
      // Cobertura estable de exactamente 2r × 2r (enteros).
      const x0 = ox - r;
      const y0 = oy - r;
      const x1 = ox + r;
      const y1 = oy + r;
      const r2 = r * r;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (brushShape === 'circle') {
            const dx = x + 0.5 - ox;
            const dy = y + 0.5 - oy;
            if (dx * dx + dy * dy > r2) continue;
          }
          if (trackPixels && painted) {
            const ax = x - ox + cx;
            const ay = y - oy + cy;
            const pkey = `${ax},${ay}`;
            if (painted.has(pkey)) continue;
            painted.add(pkey);
          }
          if (!applyDitherStyle(target, x, y, colorA, colorB)) continue;
          target.fillRect(x, y, 1, 1);
        }
      }
    };

    if (brushSoftness <= 0) {
      paintHardAt(ctx, cx, cy, true);
      return;
    }

    const dabKey = `dab:${cx},${cy}`;
    if (painted) {
      if (painted.has(dabKey)) return;
      painted.add(dabKey);
    }

    const size = r * 2;
    stampHardThenBlur(ctx, size, size, cx - r, cy - r, (tctx) => {
      paintHardAt(tctx, r, r, false);
    });
  };

  const stampGridCell = (
    ctx: CanvasRenderingContext2D,
    cellX: number,
    cellY: number,
    origin: PaintGridOrigin,
    painted: Set<string> | null,
    colorA: string,
    colorB: string,
  ) => {
    const key = `${cellX},${cellY}`;
    if (painted) {
      if (painted.has(key)) return;
      painted.add(key);
    }
    const size = origin.size;
    const ix = Math.round((cellX - origin.x) / size);
    const iy = Math.round((cellY - origin.y) / size);

    const paintCellHard = (target: CanvasRenderingContext2D, ox: number, oy: number) => {
      if (!applyDitherStyle(target, ix, iy, colorA, colorB)) return;
      if (brushShape === 'circle') {
        const cx = ox + size / 2;
        const cy = oy + size / 2;
        const r2 = (size / 2) * (size / 2);
        for (let y = oy; y < oy + size; y++) {
          for (let x = ox; x < ox + size; x++) {
            const dx = x + 0.5 - cx;
            const dy = y + 0.5 - cy;
            if (dx * dx + dy * dy > r2) continue;
            target.fillRect(x, y, 1, 1);
          }
        }
        return;
      }
      target.fillRect(ox, oy, size, size);
    };

    if (brushSoftness <= 0) {
      paintCellHard(ctx, cellX, cellY);
      return;
    }

    stampHardThenBlur(ctx, size, size, cellX, cellY, (tctx) => {
      paintCellHard(tctx, 0, 0);
    });
  };

  const ensureGridOrigin = (px: number, py: number): PaintGridOrigin => {
    if (gridOriginRef.current) return gridOriginRef.current;
    const size = Math.max(1, Math.round(brushSize));
    const origin: PaintGridOrigin = {
      x: Math.floor(px) - Math.floor(size / 2),
      y: Math.floor(py) - Math.floor(size / 2),
      size,
    };
    gridOriginRef.current = origin;
    setGridOrigin(origin);
    return origin;
  };

  const draw = (e: React.MouseEvent, forceFirstPoint = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const rect = canvas.getBoundingClientRect();
    // Coordenada de píxel estable (sin subpíxeles → márgenes del dab no bailan).
    const currX = Math.floor((e.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)));
    const currY = Math.floor((e.clientY - rect.top) * (canvas.height / Math.max(1, rect.height)));

    setMousePos({ x: currX, y: currY });

    if (!isDrawingRef.current && !forceFirstPoint) {
      lastPos.current = null;
      return;
    }
    
    // destination-over: paint only shows through transparent / empty pixels
    ctx.globalCompositeOperation = paintBehind ? 'destination-over' : 'source-over';
    const colorA = paintCssColor();
    const colorB = paintCssColor(ditherColorB);
    ctx.fillStyle = colorA;
    const painted = strokePaintedRef.current;

    if (gridLock) {
      const origin = ensureGridOrigin(currX, currY);
      const cell = snapPaintGridCell(currX, currY, origin);
      const ix = Math.round((cell.x - origin.x) / origin.size);
      const iy = Math.round((cell.y - origin.y) / origin.size);
      if (lastPos.current && !forceFirstPoint) {
        const lx = Math.round((lastPos.current.x - origin.x) / origin.size);
        const ly = Math.round((lastPos.current.y - origin.y) / origin.size);
        for (const c of paintGridCellsOnLine(lx, ly, ix, iy)) {
          stampGridCell(ctx, origin.x + c.x * origin.size, origin.y + c.y * origin.size, origin, painted, colorA, colorB);
        }
      } else {
        stampGridCell(ctx, cell.x, cell.y, origin, painted, colorA, colorB);
      }
      lastPos.current = { x: cell.x, y: cell.y };
      return;
    }

    if (lastPos.current && !forceFirstPoint) {
      const dx = currX - lastPos.current.x;
      const dy = currY - lastPos.current.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(dist / Math.max(1, brushSize * 0.35)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        stampBrush(ctx, lastPos.current.x + dx * t, lastPos.current.y + dy * t, painted, colorA, colorB);
      }
    } else {
      stampBrush(ctx, currX, currY, painted, colorA, colorB);
    }
    lastPos.current = { x: currX, y: currY };
  };

  const beginStroke = (e: React.MouseEvent) => {
    if (eyedropperMode) {
      sampleCanvasColor(e);
      return;
    }
    if (!strokeSavedRef.current) {
      pushHistory();
      strokeSavedRef.current = true;
    }
    strokePaintedRef.current = (gridLock || paintOpacity < 100 || brushSoftness > 0) ? new Set() : null;
    isDrawingRef.current = true;
    draw(e, true);
  };

  const endStroke = () => {
    isDrawingRef.current = false;
    lastPos.current = null;
    strokePaintedRef.current = null;
    strokeSavedRef.current = false;
  };

  const handleReset = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    pushHistory();
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sprite.img, 0, 0);
    extractPalette();
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    const newImg = new Image();
    newImg.onload = () => onSave(sprite.id, newImg);
    newImg.src = dataUrl;
  };

  const ditherPreviewBg = () => {
    const a = paintCssColor();
    if (ditherPattern === 'off') return a;
    const b = ditherEmpty ? 'transparent' : paintCssColor(ditherColorB);
    return `repeating-conic-gradient(${a} 0% 25%, ${b} 0% 50%) 50% / 6px 6px`;
  };

  const cellGridOverlay: PaintGridOrigin | null = (() => {
    if (!gridLock) return null;
    if (gridOrigin) return gridOrigin;
    if (!mousePos) return null;
    const size = Math.max(1, Math.round(brushSize));
    return {
      x: Math.floor(mousePos.x) - Math.floor(size / 2),
      y: Math.floor(mousePos.y) - Math.floor(size / 2),
      size,
    };
  })();

  const statusBits = [
    gridLock ? (gridOrigin ? `Grilla ${gridOrigin.size}px` : 'Grilla: clic para anclar') : null,
    ditherPattern !== 'off' ? `Dither ${DITHER_OPTIONS.find((o) => o.id === ditherPattern)?.label}` : null,
    brushSoftness > 0 ? `Difuminar ${brushSoftness}%` : null,
    paletteLock ? `Paleta ${palette.length}` : null,
    paintBehind ? 'Detrás' : null,
  ].filter(Boolean) as string[];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content paint-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
            <Pencil size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem', margin: 0 }}>Pintar: {sprite.name}</h3>
            {statusBits.length > 0 && <span className="paint-status">{statusBits.join(' · ')}</span>}
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        <div
          ref={workspaceRef}
          className={`eraser-workspace paint-workspace checker-mini ${isWhiteBg ? 'white-bg' : ''}`}
          style={{ overflow: 'auto' }}
          onScroll={onWorkspaceScroll}
        >
           <div
             className="zoom-sizer"
             style={{
               width: sprite.img.width * zoom + 80,
               height: sprite.img.height * zoom + 80,
             }}
           >
           <div
             ref={paintStageRef}
             style={{
               width: sprite.img.width * zoom,
               height: sprite.img.height * zoom,
               position: 'relative',
               flex: '0 0 auto',
             }}
           >
             {showPixelGrid && zoom >= 4 && (
               <div
                 style={{
                   position: 'absolute',
                   left: 0,
                   top: 0,
                   width: sprite.img.width * zoom,
                   height: sprite.img.height * zoom,
                   pointerEvents: 'none',
                   backgroundImage: 'linear-gradient(to right, rgba(255,255,255,0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.14) 1px, transparent 1px)',
                   backgroundSize: `${zoom}px ${zoom}px`,
                   zIndex: 999,
                 }}
               />
             )}
             <div style={{ 
               position: 'absolute',
               left: 0,
               top: 0,
               cursor: eyedropperMode ? 'crosshair' : 'none', 
               width: sprite.img.width,
               height: sprite.img.height,
               transform: `scale(${zoom})`,
               transformOrigin: 'top left'
             }}>
             <canvas 
              ref={canvasRef}
              onMouseDown={beginStroke}
              onMouseUp={endStroke}
              onMouseMove={(e) => {
                if (eyedropperMode) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const mx = Math.floor((e.clientX - rect.left) * (e.currentTarget.width / Math.max(1, rect.width)));
                  const my = Math.floor((e.clientY - rect.top) * (e.currentTarget.height / Math.max(1, rect.height)));
                  setMousePos({ x: mx, y: my });
                  return;
                }
                draw(e);
              }}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const mx = Math.floor((e.clientX - rect.left) * (e.currentTarget.width / Math.max(1, rect.width)));
                const my = Math.floor((e.clientY - rect.top) * (e.currentTarget.height / Math.max(1, rect.height)));
                setMousePos({ x: mx, y: my });
              }}
              onMouseLeave={() => {
                endStroke();
                setMousePos(null);
              }}
             />
             {cellGridOverlay && (
               <div
                 style={{
                   position: 'absolute',
                   left: 0,
                   top: 0,
                   width: sprite.img.width,
                   height: sprite.img.height,
                   pointerEvents: 'none',
                   backgroundImage: 'linear-gradient(to right, rgba(255,255,255,0.28) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.28) 1px, transparent 1px)',
                   backgroundSize: `${cellGridOverlay.size}px ${cellGridOverlay.size}px`,
                   backgroundPosition: `${paintGridMod(cellGridOverlay.x, cellGridOverlay.size)}px ${paintGridMod(cellGridOverlay.y, cellGridOverlay.size)}px`,
                   zIndex: 1000,
                 }}
               />
             )}
             {mousePos && canvasRef.current && !eyedropperMode && (() => {
               const canvas = canvasRef.current!;
               const scale = canvas.offsetWidth / canvas.width;
               const previewBg = ditherPreviewBg();
               const isSoft = brushSoftness > 0;
               const blurPx = isSoft
                 ? Math.max(0.5, brushBlurRadius(brushSoftness, brushSize) * scale)
                 : 0;
               const shapeRadius = brushShape === 'circle' ? '50%' : '0';
               const renderPreview = (left: number, top: number, w: number, h: number) => (
                 <div
                   className={`brush-preview${isSoft ? ' is-soft' : ''}`}
                   style={{
                     left,
                     top,
                     width: w,
                     height: h,
                     borderColor: isSoft ? undefined : paintColor,
                     background: isSoft ? undefined : previewBg,
                     opacity: 1,
                     borderRadius: shapeRadius,
                   }}
                 >
                   {isSoft && (
                     <>
                       <div
                         className="brush-preview-soft-body"
                         style={{
                           background: previewBg,
                           borderRadius: shapeRadius,
                           filter: blurPx > 0 ? `blur(${blurPx}px)` : undefined,
                         }}
                       />
                       <div className="brush-preview-soft-center" />
                     </>
                   )}
                 </div>
               );
               if (gridLock) {
                 const size = gridOrigin?.size ?? Math.max(1, Math.round(brushSize));
                 const cell = gridOrigin
                   ? snapPaintGridCell(mousePos.x, mousePos.y, gridOrigin)
                   : {
                       x: Math.floor(mousePos.x) - Math.floor(size / 2),
                       y: Math.floor(mousePos.y) - Math.floor(size / 2),
                     };
                 return renderPreview(
                   cell.x + size / 2,
                   cell.y + size / 2,
                   size * scale,
                   size * scale,
                 );
               }
               return renderPreview(
                 mousePos.x,
                 mousePos.y,
                 brushSize * scale * 2,
                 brushSize * scale * 2,
               );
             })()}
             </div>
           </div>
           </div>
        </div>
        <div className="paint-dock">
          <div className="paint-dock-row">
            <div className="paint-dock-group">
              <span className="paint-dock-label">Color</span>
              <div className="paint-dock-controls">
                <input type="color" className="paint-swatch" value={paintColor} onChange={(e) => applyPaintColor(e.target.value)} title="Color A" />
                <input
                  type="text"
                  className="input-small"
                  value={colorDraft}
                  onChange={(e) => {
                    setColorDraft(e.target.value);
                    const hex = normalizeHexColor(e.target.value);
                    if (hex) applyPaintColor(hex);
                  }}
                  onBlur={() => setColorDraft(paintColor)}
                  style={{ width: '78px', textTransform: 'uppercase' }}
                />
                <button
                  type="button"
                  className={`btn-ghost ${eyedropperMode ? 'active' : ''}`}
                  title="Gotero: click para tomar color de la pantalla. Click derecho o I: tomar del sprite. Esc cancela."
                  onClick={openScreenEyedropper}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setEyedropperMode(v => !v);
                  }}
                  style={{
                    width: '32px',
                    height: '32px',
                    padding: 0,
                    borderColor: eyedropperMode ? 'var(--accent)' : undefined,
                    color: eyedropperMode ? 'var(--accent)' : undefined,
                  }}
                >
                  <Pipette size={16} />
                </button>
                {ditherPattern !== 'off' && (
                  <>
                    <input
                      type="color"
                      className="paint-swatch"
                      value={ditherColorB}
                      disabled={ditherEmpty}
                      onChange={(e) => applyDitherColorB(e.target.value)}
                      title="Color B del dither"
                    />
                    <button
                      type="button"
                      className={`paint-toggle ${ditherEmpty ? 'active' : ''}`}
                      onClick={() => setDitherEmpty(v => !v)}
                      title="Las celdas B quedan vacías (transparencia)"
                    >
                      Vacío
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="paint-dock-group grow">
              <div className="slider-label" style={{ marginBottom: 0 }}>
                <span>Pincel</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                  <input
                    type="number"
                    className="paint-num"
                    min={1}
                    max={100}
                    step={1}
                    value={brushSize}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!Number.isFinite(v)) return;
                      setBrushSize(Math.min(100, Math.max(1, v)));
                    }}
                  />
                  px
                </span>
              </div>
              <div className="paint-dock-controls">
                <input type="range" min="1" max="100" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} style={{ flex: 1, minWidth: '80px' }} />
                <button className={`btn-ghost ${brushShape === 'circle' ? 'active' : ''}`} onClick={() => setBrushShape('circle')} title="Círculo">
                  <Circle size={16} fill={brushShape === 'circle' ? 'currentColor' : 'none'} />
                </button>
                <button className={`btn-ghost ${brushShape === 'square' ? 'active' : ''}`} onClick={() => setBrushShape('square')} title="Cuadrado">
                  <Square size={16} fill={brushShape === 'square' ? 'currentColor' : 'none'} />
                </button>
              </div>
            </div>

            <div className="paint-dock-group" style={{ width: '120px' }}>
              <div className="slider-label" style={{ marginBottom: 0 }}>
                <span>Opacidad</span>
                <span>{paintOpacity}%</span>
              </div>
              <input
                type="range"
                min="1"
                max="100"
                value={paintOpacity}
                onChange={(e) => setPaintOpacity(parseInt(e.target.value, 10))}
                title="Opacidad del pincel (píxeles semitransparentes)"
              />
            </div>

            <div className="paint-dock-group" style={{ width: '130px' }}>
              <div className="slider-label" style={{ marginBottom: 0 }}>
                <span>Difuminar</span>
                <span>{brushSoftness}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={brushSoftness}
                onChange={(e) => setBrushSoftness(parseInt(e.target.value, 10))}
                title="Pérdida de definición pareja en todo el trazo (blur), no es opacidad ni borde suave de afuera hacia adentro"
              />
            </div>

            <div className="paint-dock-group" style={{ width: '140px' }}>
              <div className="slider-label" style={{ marginBottom: 0 }}>
                <span><Search size={12} /> Zoom</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                  <input
                    type="number"
                    className="paint-num"
                    min={0.5}
                    max={8}
                    step={0.1}
                    value={Number(zoom.toFixed(1))}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!Number.isFinite(v)) return;
                      setZoom(Math.min(8, Math.max(0.5, v)));
                    }}
                  />
                  x
                </span>
              </div>
              <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
            </div>

            <div className="paint-dock-actions">
              <button
                className="btn btn-outline"
                onClick={undo}
                disabled={historyLen === 0}
                title="Ctrl+Z — deshace el último trazo (solo este sprite)"
              >
                <RotateCcw size={16} /> Deshacer
              </button>
              <button className="btn btn-outline" onClick={handleReset}>Reiniciar</button>
              <button className="btn btn-primary" style={{ paddingLeft: '20px', paddingRight: '20px' }} onClick={handleSave}>Guardar</button>
            </div>
          </div>

          <div className="paint-dock-row">
            <div className="paint-dock-group">
              <span className="paint-dock-label">Modo</span>
              <div className="paint-dock-controls">
                <button
                  type="button"
                  className={`paint-toggle ${paintBehind ? 'active' : ''}`}
                  onClick={() => setPaintBehind(v => !v)}
                  title="Pintar solo en espacios vacíos (detrás del sprite)"
                >
                  <Layers size={14} />
                  Detrás
                </button>
                <button
                  type="button"
                  className={`paint-toggle ${gridLock ? 'active' : ''}`}
                  onClick={() => setGridLock(v => !v)}
                  title="Tras el primer clic, el pincel queda anclado a una malla del tamaño del pincel"
                >
                  <Grid size={14} />
                  {gridLock && gridOrigin ? `Grilla ${gridOrigin.size}px` : 'Grilla'}
                </button>
                <button
                  type="button"
                  className={`paint-toggle ${showPixelGrid ? 'active' : ''}`}
                  onClick={() => setShowPixelGrid(v => !v)}
                  title="Malla de 1 px del lienzo (se ve a zoom 4× o más)"
                >
                  Px
                </button>
              </div>
            </div>

            <div className="paint-dock-group">
              <span className="paint-dock-label">Dither</span>
              <div className="paint-seg" role="group" aria-label="Patrón de dither">
                {DITHER_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={ditherPattern === opt.id ? 'active' : ''}
                    title={opt.title}
                    onClick={() => setDitherPattern(opt.id)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="paint-dock-row">
            <div className="paint-dock-group grow">
              <span className="paint-dock-label">Paleta {palette.length > 0 ? `(${palette.length})` : ''}</span>
              <div className="paint-dock-controls">
                <button
                  type="button"
                  className={`paint-toggle ${paletteLock ? 'active' : ''}`}
                  onClick={togglePaletteLock}
                  title="Solo permite colores de la paleta. El gotero del sprite puede agregar; el de pantalla snapea."
                >
                  <Lock size={14} />
                  Lock
                </button>
                <button
                  type="button"
                  className="paint-toggle"
                  onClick={extractPalette}
                  title="Lee los colores del lienzo (los más usados, hasta 64)"
                >
                  Extraer
                </button>
                <div className="paint-palette" title="Clic: color A. Shift o clic derecho: color B">
                  {palette.length === 0 && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Sin colores — Extraer</span>
                  )}
                  {palette.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      className={`paint-palette-swatch${hex === paintColor ? ' active' : ''}${hex === ditherColorB && ditherPattern !== 'off' ? ' alt' : ''}`}
                      style={{ background: hex }}
                      title={`${hex.toUpperCase()} — clic A, Shift/derecho B`}
                      onClick={(e) => {
                        if (e.shiftKey) applyDitherColorB(hex);
                        else applyPaintColor(hex);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        applyDitherColorB(hex);
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Composite Modal Component ---
interface CompositePiece {
  id: string;
  img: HTMLImageElement;
  x: number;
  y: number;
}

interface CompositeModalProps {
  sprite: SpriteData;
  onSave: (id: string, newImg: HTMLImageElement) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
  canvasSize?: number;
}

const CompositeModal: React.FC<CompositeModalProps> = ({ sprite, onSave, onClose, isWhiteBg, canvasSize = 8192 }) => {
  const [pieces, setPieces] = useState<CompositePiece[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [pan] = useState({ x: Math.floor(canvasSize / 2), y: Math.floor(canvasSize / 2) }); 
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useModalWheelControls({
    zoom, setZoom, zoomMin: 0.1, zoomMax: 8, zoomStep: 0.05,
    workspaceRef, contentRef,
  });

  // Auto-fit zoom on mount
  useEffect(() => {
    if (workspaceRef.current) {
      const w = workspaceRef.current;
      const fitZoom = Math.min((w.clientWidth - 80) / canvasSize, (w.clientHeight - 80) / canvasSize);
      // Clamp between our slider min (0.1) and a max of 1 (don't over-zoom small canvases initially)
      const initialZoom = Math.max(0.1, Math.min(Number(fitZoom.toFixed(2)), 1));
      setZoom(initialZoom);
    }
  }, [canvasSize]);

  useEffect(() => {
    setPieces([{ id: 'base', img: sprite.img, x: -Math.floor(sprite.img.width/2), y: -Math.floor(sprite.img.height/2) }]);
    setSelectedId('base');
  }, [sprite]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    ctx.clearRect(0, 0, canvasSize, canvasSize);
    ctx.imageSmoothingEnabled = false;

    pieces.forEach(p => {
       ctx.drawImage(p.img, pan.x + p.x, pan.y + p.y);
       
       ctx.save();
       if (selectedId === p.id) {
         ctx.strokeStyle = '#6b66ff';
         ctx.lineWidth = 1;
         ctx.setLineDash([4, 2]);
       } else {
         ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
         ctx.lineWidth = 1;
         ctx.setLineDash([2, 4]);
       }
       ctx.strokeRect(pan.x + p.x - 1, pan.y + p.y - 1, p.img.width + 2, p.img.height + 2);
       ctx.restore();
    });
  }, [pieces, selectedId, pan]);

  const handleMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const scaleX = canvasRef.current!.width / rect.width;
    const scaleY = canvasRef.current!.height / rect.height;
    
    const cx = (e.clientX - rect.left) * scaleX - pan.x;
    const cy = (e.clientY - rect.top) * scaleY - pan.y;

    const tCanvas = document.createElement('canvas');
    tCanvas.width = 1; tCanvas.height = 1;
    const tCtx = tCanvas.getContext('2d', { willReadFrequently: true })!;

    let clickedId = null;
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      if (cx >= p.x && cx <= p.x + p.img.width && cy >= p.y && cy <= p.y + p.img.height) {
        tCtx.clearRect(0, 0, 1, 1);
        tCtx.drawImage(p.img, -(cx - p.x), -(cy - p.y));
        if (tCtx.getImageData(0, 0, 1, 1).data[3] > 0) {
          clickedId = p.id;
          break;
        }
      }
    }
    
    if (clickedId) {
      setSelectedId(clickedId);
      setIsDragging(true);
      const piece = pieces.find(p => p.id === clickedId)!;
      setDragStart({ x: (e.clientX - rect.left) * scaleX - piece.x, y: (e.clientY - rect.top) * scaleY - piece.y });
    } else {
      setSelectedId(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !selectedId) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const scaleX = canvasRef.current!.width / rect.width;
    const scaleY = canvasRef.current!.height / rect.height;

    const currentCx = (e.clientX - rect.left) * scaleX;
    const currentCy = (e.clientY - rect.top) * scaleY;
    
    const newX = Math.round(currentCx - dragStart.x);
    const newY = Math.round(currentCy - dragStart.y);
    setPieces(prev => prev.map(p => p.id === selectedId ? { ...p, x: newX, y: newY } : p));
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleAddFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    for (let i = 0; i < e.target.files.length; i++) {
      const file = e.target.files[i];
      if (!isProbablyImageFile(file)) continue;
      
      const img = await new Promise<HTMLImageElement>((res) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const image = new Image();
          image.onload = () => res(image);
          image.src = ev.target?.result as string;
        };
        reader.readAsDataURL(file);
      });

      const newId = generateId();
      setPieces(prev => [...prev, { id: newId, img: img, x: -Math.floor(img.width/2), y: -Math.floor(img.height/2) }]);
      setSelectedId(newId);
    }
    e.target.value = '';
  };

  const alignSelected = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const corner = e.target.value;
    if (!selectedId || !corner) return;
    
    setPieces(prev => prev.map(p => {
      if (p.id !== selectedId) return p;
      let newX = p.x;
      let newY = p.y;
      if (corner.includes('left')) newX = -pan.x;
      if (corner.includes('right')) newX = canvasSize - pan.x - p.img.width;
      if (corner.includes('top')) newY = -pan.y;
      if (corner.includes('bottom')) newY = canvasSize - pan.y - p.img.height;
      return { ...p, x: newX, y: newY };
    }));
    e.target.value = ""; // Reset to placeholder
  };

  const compileSave = () => {
    if (pieces.length === 0) return;
    
    const canvas = document.createElement('canvas');
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    pieces.forEach(p => {
      ctx.drawImage(p.img, pan.x + p.x, pan.y + p.y);
    });

    const newImg = new Image();
    newImg.onload = () => {
      onSave(sprite.id, newImg);
    };
    newImg.src = canvas.toDataURL('image/png');
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ width: '100vw', maxWidth: '100vw', height: '100vh', maxHeight: '100vh', display: 'flex', flexDirection: 'column', borderRadius: 0, border: 'none', margin: 0 }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Layers size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem' }}>Compositor: {sprite.name}</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        
        <div className="module-footer" style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)', gap: '12px', justifyContent: 'flex-start', padding: '12px', pointerEvents: 'auto' }}>
             <label className="btn btn-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.7rem', padding: '6px 12px', margin: 0 }}>
               <Plus size={14} /> Añadir Pieza
               <input type="file" hidden multiple accept="image/*" onChange={handleAddFile} />
             </label>
             {selectedId && (
               <>
                 <select 
                    className="select-input" 
                    style={{ fontSize: '0.7rem', padding: '4px 8px', margin: 0, width: 'auto' }} 
                    onChange={alignSelected}
                    value=""
                 >
                   <option value="" disabled>Alinear a...</option>
                   <option value="top-left">Esquina Superior Izquierda</option>
                   <option value="top-right">Esquina Superior Derecha</option>
                   <option value="bottom-left">Esquina Inferior Izquierda</option>
                   <option value="bottom-right">Esquina Inferior Derecha</option>
                 </select>
                 <button className="btn-ghost" style={{ padding: '6px' }} onClick={() => setPieces(p => p.filter(x => x.id !== selectedId))}><Trash2 size={14} /></button>
               </>
             )}
        </div>

        <div className={`eraser-workspace ${isWhiteBg ? 'white-bg' : ''}`} ref={workspaceRef} style={{ overflow: 'auto', position: 'relative', flex: 1, backgroundColor: 'var(--bg-window, #151515)' }}>
           <div ref={contentRef} className="checker-mini" style={{ position: 'relative', width: `${canvasSize * zoom}px`, height: `${canvasSize * zoom}px`, minWidth: `${canvasSize * zoom}px`, minHeight: `${canvasSize * zoom}px`, flexShrink: 0, margin: '20px', boxShadow: '0 0 40px rgba(0,0,0,0.8)', border: '1px solid rgba(255,255,255,0.1)' }}>
             <canvas 
               ref={canvasRef}
               style={{ width: '100%', height: '100%', cursor: isDragging ? 'grabbing' : 'grab', outline: 'none', display: 'block' }}
               onMouseDown={handleMouseDown}
               onMouseMove={handleMouseMove}
               onMouseUp={handleMouseUp}
               onMouseLeave={handleMouseUp}
             />
           </div>
           
           <div style={{ position: 'sticky', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.7)', padding: '8px 16px', borderRadius: '20px', fontSize: '0.7rem', color: 'white', pointerEvents: 'none', display: 'flex', gap: '16px', zIndex: 10, width: 'max-content', margin: 'auto' }}>
             <span>Click y arrastra cualquier pieza ({pieces.length} capas)</span>
           </div>
        </div>
        
        <div className="modal-footer" style={{ padding: '20px', background: 'var(--bg-panel)', borderTop: '1px solid var(--border)', display: 'flex', gap: '24px', alignItems: 'center' }}>
            <div className="slider-item" style={{ width: '200px', marginBottom: 0 }}>
              <div className="slider-label"><span><Search size={14} /> Zoom</span><span>{zoom.toFixed(2)}x</span></div>
              <input type="range" min="0.1" max="8" step="0.01" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
            </div>
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', gap: '12px' }}>
              <button className="btn btn-outline" onClick={onClose}>Cancelar</button>
              <button className="btn btn-primary" style={{ paddingLeft: '24px', paddingRight: '24px' }} onClick={compileSave}>Acoplar y Guardar</button>
            </div>
        </div>
      </div>
    </div>
  );
};

// --- Animation Modal Component ---
interface AnimFrame {
  id: string;
  img: HTMLImageElement;
  fileName: string;
  durationMs: number;
  scale?: number;
}

interface AnimationModalProps {
  onClose: () => void;
}

const AnimationModal: React.FC<AnimationModalProps> = ({ onClose }) => {
  const [frames, setFrames] = useState<AnimFrame[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrameIdx, setCurrentFrameIdx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [bgColor, setBgColor] = useState<'checker' | 'white' | 'black'>('checker');
  const [exportW, setExportW] = useState(0);
  const [exportH, setExportH] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previewContentRef = useRef<HTMLDivElement>(null);
  useModalWheelControls({ zoom, setZoom, workspaceRef, contentRef: previewContentRef });

  const requestRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const accumulatedMsRef = useRef<number>(0);
  
  const idxRef = useRef(currentFrameIdx);
  useEffect(() => { idxRef.current = currentFrameIdx; }, [currentFrameIdx]);
  const framesRef = useRef(frames);
  useEffect(() => { framesRef.current = frames; }, [frames]);

  useEffect(() => {
    if (!isPlaying || frames.length <= 1) {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      return;
    }

    accumulatedMsRef.current = 0;
    lastTimeRef.current = performance.now();

    const loop = (time: number) => {
      const dt = time - lastTimeRef.current;
      lastTimeRef.current = time;
      accumulatedMsRef.current += dt;
      
      const currentList = framesRef.current;
      if (currentList.length > 0) {
        const dur = currentList[idxRef.current]?.durationMs || 100;
        if (accumulatedMsRef.current >= dur) {
          accumulatedMsRef.current -= dur;
          setCurrentFrameIdx(prev => (prev + 1) % currentList.length);
        }
      }
      requestRef.current = requestAnimationFrame(loop);
    };

    requestRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(requestRef.current);
  }, [isPlaying, frames.length]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    
    let maxWidth = 200;
    let maxHeight = 200;
    frames.forEach(f => {
      const sc = f.scale || 1.0;
      maxWidth = Math.max(maxWidth, f.img.width * sc);
      maxHeight = Math.max(maxHeight, f.img.height * sc);
    });

    canvas.width = maxWidth;
    canvas.height = maxHeight;
    ctx.clearRect(0, 0, maxWidth, maxHeight);
    ctx.imageSmoothingEnabled = false;

    if (frames.length > 0 && frames[currentFrameIdx]) {
      const f = frames[currentFrameIdx];
      const sc = f.scale || 1.0;
      const fw = f.img.width * sc;
      const fh = f.img.height * sc;
      const dx = Math.floor((maxWidth - fw) / 2);
      const dy = Math.floor((maxHeight - fh) / 2);
      ctx.drawImage(f.img, dx, dy, fw, fh);
    }
  }, [frames, currentFrameIdx]);

  const handleAddFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const newFrames: AnimFrame[] = [];
    for (let i = 0; i < e.target.files.length; i++) {
      const file = e.target.files[i];
      if (!isProbablyImageFile(file)) continue;
      const img = await new Promise<HTMLImageElement>((res) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const image = new Image();
          image.onload = () => res(image);
          image.src = ev.target?.result as string;
        };
        reader.readAsDataURL(file);
      });
      newFrames.push({
        id: generateId(),
        img,
        fileName: file.name,
        durationMs: 100,
        scale: 1.0
      });
    }
    setFrames(prev => [...prev, ...newFrames]);
    e.target.value = '';
  };

  const updateDuration = (id: string, val: number) => {
    setFrames(prev => prev.map(f => f.id === id ? { ...f, durationMs: Math.max(10, val) } : f));
  };

  const updateScale = (id: string, val: number) => {
    setFrames(prev => prev.map(f => f.id === id ? { ...f, scale: Math.max(0.1, val) } : f));
  };

  const handleExportSpritesheet = async () => {
    if (frames.length === 0) return;
    const fileName = `joa_anim_spritesheet_${Date.now()}.png`;
    
    let autoWidth = 0;
    let autoHeight = 0;
    frames.forEach(f => {
      const sc = f.scale || 1.0;
      autoWidth = Math.max(autoWidth, Math.ceil(f.img.width * sc));
      autoHeight = Math.max(autoHeight, Math.ceil(f.img.height * sc));
    });

    const finalWidth = exportW > 0 ? exportW : autoWidth;
    const finalHeight = exportH > 0 ? exportH : autoHeight;

    const cols = Math.ceil(frames.length / 2);

    const canvas = document.createElement('canvas');
    canvas.width = finalWidth * cols;
    canvas.height = finalHeight * 2;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    frames.forEach((f, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);

      const sc = f.scale || 1.0;
      const fw = Math.ceil(f.img.width * sc);
      const fh = Math.ceil(f.img.height * sc);
      const cx = (finalWidth * col) + Math.floor((finalWidth - fw) / 2);
      const cy = (finalHeight * row) + Math.floor((finalHeight - fh) / 2);
      ctx.drawImage(f.img, cx, cy, fw, fh);
    });

    const blob = await new Promise<Blob>((res) => canvas.toBlob(res as any, 'image/png'));
    await saveBlobToDisk(blob, fileName, [{ name: 'PNG Image', extensions: ['png'] }]);
  };

  const removeFrame = (id: string) => {
    setFrames(prev => {
      const next = prev.filter(f => f.id !== id);
      if (currentFrameIdx >= next.length) setCurrentFrameIdx(Math.max(0, next.length - 1));
      if (next.length <= 1) setIsPlaying(false);
      return next;
    });
  };

  let bgClass = 'checker-mini';
  if (bgColor === 'white') bgClass = 'white-bg';
  if (bgColor === 'black') bgClass = 'black-bg';

  const previewSize = (() => {
    let maxWidth = 200;
    let maxHeight = 200;
    frames.forEach(f => {
      const sc = f.scale || 1.0;
      maxWidth = Math.max(maxWidth, f.img.width * sc);
      maxHeight = Math.max(maxHeight, f.img.height * sc);
    });
    return { w: maxWidth, h: maxHeight };
  })();

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 9999 }}>
      <div className="modal-content tagging-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Film size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem' }}>Previsualizador de Animación</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* VISOR PRINCIPAL */}
          <div ref={workspaceRef} className="eraser-workspace" style={{ flex: 1, overflow: 'auto', backgroundColor: 'var(--bg-window, #151515)', position: 'relative' }}>
             
             {frames.length === 0 ? (
                <div className="empty-msg" style={{ opacity: 0.5 }}>Añade frames en la barra lateral para ver la animación</div>
             ) : (
                <div ref={previewContentRef} className={bgClass} style={{ 
                                position: 'relative', 
                                boxShadow: '0 0 40px rgba(0,0,0,0.8)', 
                                border: '1px solid rgba(255,255,255,0.1)',
                                width: previewSize.w * zoom,
                                height: previewSize.h * zoom,
                                flexShrink: 0,
                              }}>
                  <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%', imageRendering: 'pixelated' }} />
                </div>
             )}

             <div style={{ position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '16px', background: 'rgba(0,0,0,0.8)', padding: '12px 24px', borderRadius: '30px' }}>
                <button className={`btn ${isPlaying ? 'btn-danger' : 'btn-primary'}`} 
                        disabled={frames.length <= 1}
                        onClick={() => setIsPlaying(!isPlaying)}
                        style={{ borderRadius: '20px', padding: '8px 24px' }}>
                  {isPlaying ? <><Pause size={18} /> Pausar</> : <><Play size={18} style={{ marginLeft: '2px' }} /> Reproducir</>}
                </button>
                <div style={{ width: '1px', background: 'var(--border)' }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Fondo:</span>
                  <button className={`btn-ghost ${bgColor === 'checker' ? 'active' : ''}`} onClick={() => setBgColor('checker')} style={{ padding: '4px', background: 'url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAOklEQVQYV2NkYGAwYkAD////ZwSxmBggnFzMwMDAGJvK///vPzMwMDCA5NgUkgxioEswE8Vl2PwkAQD9fQ0wR3kY/wAAAABJRU5ErkJggg==")' }} />
                  <button className={`btn-ghost ${bgColor === 'black' ? 'active' : ''}`} onClick={() => setBgColor('black')} style={{ padding: '4px', background: '#000' }} />
                  <button className={`btn-ghost ${bgColor === 'white' ? 'active' : ''}`} onClick={() => setBgColor('white')} style={{ padding: '4px', background: '#fff' }} />
                </div>
             </div>
          </div>

          {/* TIMELINE LATERAL */}
          <div className="tagging-sidebar" style={{ minWidth: '320px', display: 'flex', flexDirection: 'column' }}>
            <div className="sidebar-section" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '16px' }}>
               <label className="btn btn-outline" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', cursor: 'pointer', margin: 0 }}>
                 <Plus size={16} /> Añadir Frames (Archivos)
                 <input type="file" hidden multiple accept="image/*" onChange={handleAddFiles} />
               </label>
               {frames.length > 0 && (
                 <button className="btn btn-danger" style={{ marginTop: '8px', width: '100%' }} onClick={() => { if(confirm('¿Borrar todos los frames?')) { setFrames([]); setIsPlaying(false); } }}>
                   Limpiar Secuencia
                 </button>
               )}
            </div>

            <div className="sidebar-section" style={{ flex: 1, overflowY: 'auto' }}>
              <span className="section-title">Secuencia de Animación ({frames.length})</span>
              <div className="region-list">
                {frames.map((f, i) => (
                  <div key={f.id} className="region-item" style={{ background: currentFrameIdx === i ? 'rgba(107, 102, 255, 0.15)' : undefined, border: currentFrameIdx === i ? '1px solid var(--accent)' : '1px solid var(--border)' }}>
                    <div style={{ width: '40px', height: '40px', background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', overflow: 'hidden' }} className="checker-mini">
                      <SpriteThumb img={f.img} maxWidth={40} maxHeight={40} alt={f.fileName} />
                    </div>
                    <div className="region-info" style={{ flex: 1 }}>
                      <span className="region-label" style={{ fontSize: '0.7rem', wordBreak: 'break-all' }}>{i+1}. {f.fileName}</span>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Tiempo (ms):</span>
                          <input type="number" className="input-small" value={f.durationMs} onChange={(e) => updateDuration(f.id, parseInt(e.target.value) || 100)} style={{ width: '60px' }} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Scale (x):</span>
                          <input type="number" step="0.1" className="input-small" value={f.scale || 1.0} onChange={(e) => updateScale(f.id, parseFloat(e.target.value) || 1.0)} style={{ width: '60px' }} />
                        </div>
                      </div>
                    </div>
                    <button className="btn-ghost btn-danger" onClick={() => removeFrame(f.id)}><Trash2 size={12} /></button>
                  </div>
                ))}
                {frames.length === 0 && <div className="empty-msg">No hay frames cargados. Sube imágenes para crear la animación.</div>}
              </div>
            </div>
            
            <div className="sidebar-section" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Ancho final (0=Auto)</label>
                  <input type="number" className="input-small" style={{ width: '100%' }} value={exportW} onChange={e => setExportW(parseInt(e.target.value) || 0)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Alto final (0=Auto)</label>
                  <input type="number" className="input-small" style={{ width: '100%' }} value={exportH} onChange={e => setExportH(parseInt(e.target.value) || 0)} />
                </div>
              </div>
              <button className="btn btn-primary" onClick={handleExportSpritesheet} disabled={frames.length === 0} style={{ width: '100%', marginBottom: '16px', justifyContent: 'center' }}>
                <Save size={16} style={{ marginRight: '6px' }} /> Exportar Spritesheet
              </button>
              <div className="slider-item" style={{ marginBottom: 0 }}>
                <div className="slider-label"><span><Search size={14} /> Zoom del Visor</span><span>{zoom.toFixed(1)}x</span></div>
                <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Main App Component ---
const App: React.FC = () => {
  const [sprites, setSprites] = useState<SpriteData[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [gridZoom, setGridZoom] = useState(() => clampNum(loadPref('joa-grid-zoom', 1), 0.4, 3, 1));
  const [columnView, setColumnView] = useState(() => loadPref<boolean>(COLUMN_VIEW_KEY, false) === true);
  const [quadrantView, setQuadrantView] = useState(() => loadPref<boolean>(QUADRANT_VIEW_KEY, false) === true);
  const [gridSplitActive, setGridSplitActive] = useState(() => loadPref<boolean>(GRID_SPLIT_KEY, false) === true);
  const [spriteColumns, setSpriteColumns] = useState<SpriteColumn[]>(() => loadSpriteColumns());
  const [spriteRows, setSpriteRows] = useState<SpriteRow[]>(() => loadSpriteRows());
  const [collapsedColumnIds, setCollapsedColumnIds] = useState<string[]>(() => normalizeIdList(loadPref(COLLAPSED_COLUMNS_KEY, [])));
  const [collapsedRowIds, setCollapsedRowIds] = useState<string[]>(() => normalizeIdList(loadPref(COLLAPSED_ROWS_KEY, [])));
  const [rowLabelWidth, setRowLabelWidth] = useState(() =>
    Math.round(clampNum(loadPref(ROW_LABEL_WIDTH_KEY, ROW_LABEL_WIDTH_DEFAULT), ROW_LABEL_WIDTH_MIN, ROW_LABEL_WIDTH_MAX, ROW_LABEL_WIDTH_DEFAULT))
  );
  const [rowLabelsCollapsed, setRowLabelsCollapsed] = useState(() => loadPref<boolean>(ROW_LABELS_COLLAPSED_KEY, false) === true);
  const [isResizingRowLabels, setIsResizingRowLabels] = useState(false);
  const rowLabelResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [compareNumberSize, setCompareNumberSize] = useState(() =>
    Math.round(clampNum(loadPref(COMPARE_NUMBER_SIZE_KEY, 32), COMPARE_NUMBER_SIZE_MIN, COMPARE_NUMBER_SIZE_MAX, 32))
  );
  const [columnDragOverId, setColumnDragOverId] = useState<string | null>(null);
  const [columnPanning, setColumnPanning] = useState(false);
  const columnViewportRef = useRef<HTMLDivElement>(null);
  const columnBoardRef = useRef<HTMLDivElement>(null);
  const columnPanRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const cellImportTargetRef = useRef<{ columnId: string; rowId: string } | null>(null);
  const [eraserTargetId, setEraserTargetId] = useState<string | null>(null);
  const [ghostCompareTargetId, setGhostCompareTargetId] = useState<string | null>(null);
  const [replaceTargetId, setReplaceTargetId] = useState<string | null>(null);
  const [copyRectTargetId, setCopyRectTargetId] = useState<string | null>(null);
  const [pixelEditorTargetId, setPixelEditorTargetId] = useState<string | null>(null);
  const [transformTargetId, setTransformTargetId] = useState<string | null>(null);
  const [taggingTargetId, setTaggingTargetId] = useState<string | null>(null);
  const [effectMaskTargetId, setEffectMaskTargetId] = useState<string | null>(null);
  const [paintTargetId, setPaintTargetId] = useState<string | null>(null);
  const [bucketTargetId, setBucketTargetId] = useState<string | null>(null);
  const [stretchTargetId, setStretchTargetId] = useState<string | null>(null);
  const [compositeTarget, setCompositeTarget] = useState<{ id: string, size: number } | null>(null);
  const [showAnimationModal, setShowAnimationModal] = useState(false);
  const [quadrantPreviewIds, setQuadrantPreviewIds] = useState<string[]>([]);
  const [quadrantPicking, setQuadrantPicking] = useState(false);
  const [emptyCellMenu, setEmptyCellMenu] = useState<{ x: number; y: number; columnId: string; rowId: string } | null>(null);
  const anyModalOpen = !!(
    eraserTargetId || ghostCompareTargetId || replaceTargetId || copyRectTargetId || pixelEditorTargetId || transformTargetId ||
    taggingTargetId || effectMaskTargetId || paintTargetId || bucketTargetId ||
    stretchTargetId || compositeTarget || showAnimationModal || (quadrantPreviewIds.length > 0 && !quadrantPicking)
  );
  const quadrantBoard = columnView && quadrantView;
  const quadrantPreviewSprites = quadrantPreviewIds
    .map((id) => sprites.find((s) => s.id === id))
    .filter((s): s is SpriteData => !!s);
  const boardZoomMin = quadrantBoard ? 0.15 : columnView ? 0.25 : 0.5;
  const boardZoomMax = quadrantBoard ? 4 : columnView ? 3 : 2;
  useModalWheelControls({
    zoom: gridZoom,
    setZoom: setGridZoom,
    zoomMin: boardZoomMin,
    zoomMax: boardZoomMax,
    zoomStep: 0.1,
    enabled: !anyModalOpen,
    workspaceRef: columnView ? columnViewportRef : undefined,
    contentRef: columnView ? columnBoardRef : undefined,
  });

  const CONTROLS_MIN = 240;
  const CONTROLS_MAX = 720;
  const CONTROLS_DEFAULT = 340;
  const [controlsVisible, setControlsVisible] = useState(() => {
    try { return localStorage.getItem('joa-controls-visible') !== '0'; } catch { return true; }
  });
  const [controlsWidth, setControlsWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('joa-controls-width'));
      if (Number.isFinite(saved) && saved >= CONTROLS_MIN && saved <= CONTROLS_MAX) return saved;
    } catch { /* ignore */ }
    return CONTROLS_DEFAULT;
  });
  const [isResizingControls, setIsResizingControls] = useState(false);
  const controlsResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // --- UNDO SYSTEM ---
  const [history, setHistory] = useState<SpriteData[][]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const commitSprites = (newSprites: SpriteData[]) => {
    setSprites(newSprites);
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push([...newSprites.map((s: SpriteData) => ({...s, padding: {...s.padding}}))]);
    if (newHistory.length > 50) newHistory.shift();
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };

  const undo = () => {
    if (historyIndex <= 0) return;
    const prevIndex = historyIndex - 1;
    setSprites([...history[prevIndex]]);
    setHistoryIndex(prevIndex);
  };

  const redo = () => {
    if (historyIndex >= history.length - 1) return;
    const nextIndex = historyIndex + 1;
    setSprites([...history[nextIndex]]);
    setHistoryIndex(nextIndex);
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Modales con lienzo propio manejan su Ctrl+Z; no tocar el historial global.
      if (paintTargetId || bucketTargetId || pixelEditorTargetId || eraserTargetId || replaceTargetId || copyRectTargetId) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) redo(); else undo();
        e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        redo();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [historyIndex, history, paintTargetId, bucketTargetId, pixelEditorTargetId, eraserTargetId, replaceTargetId, copyRectTargetId]);

  // SUPR / Ctrl+C / Ctrl+V en la pantalla general (no en modales ni inputs).
  const spriteClipboardRef = useRef<SpriteData[]>([]);

  const uniqueSpriteName = (desired: string, used: Set<string>) => {
    if (!used.has(desired)) {
      used.add(desired);
      return desired;
    }
    const ext = desired.match(/\.[^.]+$/)?.[0] || '';
    const base = ext ? desired.slice(0, -ext.length) : desired;
    let n = 2;
    let candidate = `${base}_${n}${ext}`;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${base}_${n}${ext}`;
    }
    used.add(candidate);
    return candidate;
  };

  const snapshotSpritesForClipboard = (ids: string[]): SpriteData[] => {
    const idSet = new Set(ids);
    return sprites
      .filter((s) => idSet.has(s.id))
      .map((s) => ({
        ...s,
        padding: { ...s.padding },
        anchor: s.anchor ? { ...s.anchor } : null,
        regions: s.regions?.map((r) => ({ ...r })),
        effectMasks: s.effectMasks?.map((m) => ({ ...m })),
      }));
  };

  const duplicateClipboardSprites = (): SpriteData[] => {
    const usedNames = new Set(sprites.map((s) => s.name));
    return spriteClipboardRef.current.map((s) => {
      const ext = s.name.match(/\.[^.]+$/)?.[0] || '';
      const base = ext ? s.name.slice(0, -ext.length) : s.name;
      const name = uniqueSpriteName(`${base}_copia${ext}`, usedNames);
      return {
        ...s,
        id: generateId(),
        name,
        padding: { ...s.padding },
        anchor: s.anchor ? { ...s.anchor } : null,
        regions: s.regions?.map((r) => ({ ...r, id: generateId() })),
        effectMasks: s.effectMasks?.map((m) => ({ ...m, id: generateId() })),
      };
    });
  };

  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      if (anyModalOpen) return;
      if (isTypingTarget(e.target)) return;

      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (ctrl && key === 'c') {
        if (selection.length === 0) return;
        e.preventDefault();
        spriteClipboardRef.current = snapshotSpritesForClipboard(selection);
        return;
      }

      if (ctrl && key === 'v') {
        if (spriteClipboardRef.current.length === 0) return;
        e.preventDefault();
        const copies = duplicateClipboardSprites();
        if (copies.length === 0) return;
        commitSprites([...sprites, ...copies]);
        setSelection(copies.map((s) => s.id));
        return;
      }

      if (e.key !== 'Delete') return;
      if (selection.length === 0) return;
      e.preventDefault();
      const remove = new Set(selection);
      commitSprites(sprites.filter((s) => !remove.has(s.id)));
      if (referenceId && remove.has(referenceId)) setReferenceId(null);
      setSelection([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anyModalOpen, selection, sprites, referenceId, historyIndex, history]);

  useEffect(() => {
    try { localStorage.setItem('joa-controls-width', String(controlsWidth)); } catch { /* ignore */ }
  }, [controlsWidth]);

  useEffect(() => {
    try { localStorage.setItem('joa-controls-visible', controlsVisible ? '1' : '0'); } catch { /* ignore */ }
  }, [controlsVisible]);

  useEffect(() => {
    savePref('joa-grid-zoom', gridZoom);
  }, [gridZoom]);

  useEffect(() => {
    savePref(COLUMN_VIEW_KEY, columnView);
  }, [columnView]);

  useEffect(() => {
    savePref(GRID_SPLIT_KEY, gridSplitActive);
  }, [gridSplitActive]);

  useEffect(() => {
    savePref(QUADRANT_VIEW_KEY, quadrantView);
  }, [quadrantView]);

  useEffect(() => {
    if (!columnView) {
      setQuadrantPreviewIds([]);
      setQuadrantPicking(false);
    }
  }, [columnView]);

  useEffect(() => {
    if (!emptyCellMenu) return;
    const close = () => setEmptyCellMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [emptyCellMenu]);

  useEffect(() => {
    savePref(SPRITE_COLUMNS_KEY, spriteColumns);
  }, [spriteColumns]);

  useEffect(() => {
    savePref(SPRITE_ROWS_KEY, spriteRows);
  }, [spriteRows]);

  useEffect(() => {
    savePref(COLLAPSED_COLUMNS_KEY, collapsedColumnIds);
  }, [collapsedColumnIds]);

  useEffect(() => {
    savePref(COLLAPSED_ROWS_KEY, collapsedRowIds);
  }, [collapsedRowIds]);

  useEffect(() => {
    savePref(ROW_LABEL_WIDTH_KEY, rowLabelWidth);
  }, [rowLabelWidth]);

  useEffect(() => {
    savePref(ROW_LABELS_COLLAPSED_KEY, rowLabelsCollapsed);
  }, [rowLabelsCollapsed]);

  useEffect(() => {
    savePref(COMPARE_NUMBER_SIZE_KEY, compareNumberSize);
  }, [compareNumberSize]);

  useEffect(() => {
    if (!isResizingControls) return;
    const onMove = (e: MouseEvent) => {
      const start = controlsResizeRef.current;
      if (!start) return;
      const next = Math.min(CONTROLS_MAX, Math.max(CONTROLS_MIN, start.startWidth + (start.startX - e.clientX)));
      setControlsWidth(next);
    };
    const onUp = () => {
      controlsResizeRef.current = null;
      setIsResizingControls(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isResizingControls]);

  useEffect(() => {
    if (!isResizingRowLabels) return;
    const onMove = (e: MouseEvent) => {
      const start = rowLabelResizeRef.current;
      if (!start) return;
      const next = Math.round(Math.min(ROW_LABEL_WIDTH_MAX, Math.max(ROW_LABEL_WIDTH_MIN, start.startWidth + (e.clientX - start.startX))));
      setRowLabelWidth(next);
    };
    const onUp = () => {
      rowLabelResizeRef.current = null;
      setIsResizingRowLabels(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isResizingRowLabels]);
  const [targets, setTargets] = useState({ top: 100, bottom: 100, left: 100, right: 100 });
  const [contentNudgeStep, setContentNudgeStep] = useState(() => Math.round(clampNum(loadPref('joa-content-nudge-step', 1), 1, 512, 1)));
  useEffect(() => {
    savePref('joa-content-nudge-step', contentNudgeStep);
  }, [contentNudgeStep]);
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [workingFolder, setWorkingFolder] = useState<DesktopFolder | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [batchExportFormat, setBatchExportFormat] = useState<'png' | 'jpg' | 'dds' | null>(null);
  const [showGridlines, setShowGridlines] = useState(false);
  const [isWhiteBg, setIsWhiteBg] = useState(false);
  const [highlightedYs, setHighlightedYs] = useState<number[]>([]);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [draggedSpriteId, setDraggedSpriteId] = useState<string | null>(null);
  const [dragGhost, setDragGhost] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
    src: string;
    name: string;
  } | null>(null);
  const [draggedColumnId, setDraggedColumnId] = useState<string | null>(null);
  const [draggedRowId, setDraggedRowId] = useState<string | null>(null);
  const [rowDragOverId, setRowDragOverId] = useState<string | null>(null);
  const [cellDragOverKey, setCellDragOverKey] = useState<string | null>(null);
  const [splitDragOverBand, setSplitDragOverBand] = useState<'upper' | 'lower' | null>(null);
  // Pointer-drag (no HTML5): Chromium/Electron no entrega wheel durante DnD nativo.
  const spriteDragSessionRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    activated: boolean;
  } | null>(null);
  const suppressSpriteClickRef = useRef(false);
  const dragPointerPosRef = useRef({ x: 0, y: 0 });
  const spritesRef = useRef(sprites);
  spritesRef.current = sprites;
  const columnViewRef = useRef(columnView);
  columnViewRef.current = columnView;
  const gridSplitActiveRef = useRef(gridSplitActive);
  gridSplitActiveRef.current = gridSplitActive;
  const moveSpriteToCellRef = useRef<(spriteId: string, columnId: string, rowId: string, beforeId?: string | null) => void>(() => {});
  const commitSpritesRef = useRef(commitSprites);
  commitSpritesRef.current = commitSprites;
  const compareCellKeyRef = useRef((columnId: string, rowId: string) => `${columnId}::${rowId}`);

  // Scroll con rueda + auto-scroll en bordes mientras se arrastra un sprite.
  useEffect(() => {
    if (!draggedSpriteId) return;
    const EDGE = 56;
    const MAX_SPEED = 28;
    let raf = 0;

    const scrollFromWheel = (e: WheelEvent) => {
      if (e.shiftKey || e.altKey) return;
      const el = columnViewportRef.current;
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      el.scrollLeft += e.deltaX * scale;
      el.scrollTop += e.deltaY * scale;
    };

    const edgeTick = () => {
      const el = columnViewportRef.current;
      if (!el) {
        raf = 0;
        return;
      }
      const { x, y } = dragPointerPosRef.current;
      const rect = el.getBoundingClientRect();
      let dx = 0;
      let dy = 0;
      if (y < rect.top + EDGE) dy = -MAX_SPEED * (1 - Math.max(0, y - rect.top) / EDGE);
      else if (y > rect.bottom - EDGE) dy = MAX_SPEED * (1 - Math.max(0, rect.bottom - y) / EDGE);
      if (x < rect.left + EDGE) dx = -MAX_SPEED * (1 - Math.max(0, x - rect.left) / EDGE);
      else if (x > rect.right - EDGE) dx = MAX_SPEED * (1 - Math.max(0, rect.right - x) / EDGE);
      if (dx || dy) {
        el.scrollLeft += dx;
        el.scrollTop += dy;
        raf = requestAnimationFrame(edgeTick);
      } else {
        raf = 0;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      dragPointerPosRef.current = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(edgeTick);
    };

    window.addEventListener('wheel', scrollFromWheel, { passive: false, capture: true });
    window.addEventListener('pointermove', onPointerMove, true);
    raf = requestAnimationFrame(edgeTick);
    return () => {
      window.removeEventListener('wheel', scrollFromWheel, { capture: true });
      window.removeEventListener('pointermove', onPointerMove, true);
      cancelAnimationFrame(raf);
    };
  }, [draggedSpriteId]);

  const getSpriteColumnId = (s: SpriteData) => {
    const id = s.columnId;
    if (id && id !== DEFAULT_SPRITE_COLUMN_ID && spriteColumns.some((c) => c.id === id)) return id;
    return DEFAULT_SPRITE_COLUMN_ID;
  };

  const getSpriteRowId = (s: SpriteData) => {
    const id = s.rowId;
    if (id && id !== DEFAULT_SPRITE_ROW_ID && spriteRows.some((r) => r.id === id)) return id;
    return DEFAULT_SPRITE_ROW_ID;
  };

  const compareCellKey = (columnId: string, rowId: string) => `${columnId}::${rowId}`;
  compareCellKeyRef.current = compareCellKey;

  const ungroupedColumn: SpriteColumn = { id: DEFAULT_SPRITE_COLUMN_ID, name: 'Sin grupo' };
  /** Columnas con grupo (sin «Sin grupo»): la matriz no debe heredar el alto de la pila sin agrupar. */
  const boardSpriteColumns: SpriteColumn[] = spriteColumns;
  const visibleSpriteColumns: SpriteColumn[] = [ungroupedColumn, ...spriteColumns];

  const syncSpritesToBoardOrder = () => {
    const ordered = buildSpritesInBoardOrder(sprites, spriteRows, spriteColumns);
    if (!spritesOrderMatches(ordered, sprites)) commitSprites(ordered);
  };

  const toggleColumnView = () => {
    if (columnView) syncSpritesToBoardOrder();
    setColumnView((v) => !v);
  };

  const moveSpriteToCell = (spriteId: string, columnId: string, rowId: string, beforeId?: string | null) => {
    const item = sprites.find((s) => s.id === spriteId);
    if (!item) return;
    const without = sprites.filter((s) => s.id !== spriteId);
    const moved: SpriteData = {
      ...item,
      columnId: columnId === DEFAULT_SPRITE_COLUMN_ID ? undefined : columnId,
      rowId: rowId === DEFAULT_SPRITE_ROW_ID ? undefined : rowId,
    };
    let insertAt = without.length;
    if (beforeId) {
      const idx = without.findIndex((s) => s.id === beforeId);
      if (idx >= 0) insertAt = idx;
    } else {
      let last = -1;
      without.forEach((s, i) => {
        if (getSpriteColumnId(s) === columnId && getSpriteRowId(s) === rowId) last = i;
      });
      insertAt = last + 1;
    }
    commitSprites([...without.slice(0, insertAt), moved, ...without.slice(insertAt)]);
  };
  moveSpriteToCellRef.current = moveSpriteToCell;

  const addSpriteColumn = () => {
    const n = spriteColumns.length + 1;
    setSpriteColumns((cols) => [...cols, { id: generateId(), name: `Columna ${n}` }]);
  };

  const renameSpriteColumn = (id: string, name: string) => {
    setSpriteColumns((cols) => cols.map((c) => (c.id === id ? { ...c, name } : c)));
  };

  const removeSpriteColumn = (id: string) => {
    if (id === DEFAULT_SPRITE_COLUMN_ID) return;
    setSpriteColumns((cols) => cols.filter((c) => c.id !== id));
    setCollapsedColumnIds((ids) => ids.filter((x) => x !== id));
    const affected = sprites.some((s) => s.columnId === id);
    if (affected) {
      commitSprites(sprites.map((s) => (s.columnId === id ? { ...s, columnId: undefined } : s)));
    }
  };

  const moveColumn = (columnId: string, beforeId: string) => {
    if (columnId === DEFAULT_SPRITE_COLUMN_ID || columnId === beforeId) return;
    setSpriteColumns((cols) => {
      const item = cols.find((c) => c.id === columnId);
      if (!item) return cols;
      const without = cols.filter((c) => c.id !== columnId);
      if (beforeId === DEFAULT_SPRITE_COLUMN_ID) return [item, ...without];
      const idx = without.findIndex((c) => c.id === beforeId);
      if (idx < 0) return [...without, item];
      return [...without.slice(0, idx), item, ...without.slice(idx)];
    });
  };

  const addSpriteRow = () => {
    const n = spriteRows.length + 1;
    setSpriteRows((rows) => [...rows, { id: generateId(), name: `Fila ${n}` }]);
  };

  const renameSpriteRow = (id: string, name: string) => {
    setSpriteRows((rows) => rows.map((r) => (r.id === id ? { ...r, name } : r)));
  };

  const removeSpriteRow = (id: string) => {
    if (id === DEFAULT_SPRITE_ROW_ID) return;
    setSpriteRows((rows) => rows.filter((r) => r.id !== id));
    setCollapsedRowIds((ids) => ids.filter((x) => x !== id));
    const affected = sprites.some((s) => s.rowId === id);
    if (affected) {
      commitSprites(sprites.map((s) => (s.rowId === id ? { ...s, rowId: undefined } : s)));
    }
  };

  const moveRow = (rowId: string, beforeId: string) => {
    if (rowId === DEFAULT_SPRITE_ROW_ID || rowId === beforeId) return;
    setSpriteRows((rows) => {
      const def = rows.find((r) => r.id === DEFAULT_SPRITE_ROW_ID) || { id: DEFAULT_SPRITE_ROW_ID, name: 'Sin fila' };
      const item = rows.find((r) => r.id === rowId);
      if (!item) return rows;
      const rest = rows.filter((r) => r.id !== DEFAULT_SPRITE_ROW_ID && r.id !== rowId);
      if (beforeId === DEFAULT_SPRITE_ROW_ID) return [def, item, ...rest];
      const idx = rest.findIndex((r) => r.id === beforeId);
      if (idx < 0) return [def, ...rest, item];
      return [def, ...rest.slice(0, idx), item, ...rest.slice(idx)];
    });
  };

  const isColumnCollapsed = (id: string) => collapsedColumnIds.includes(id);
  const isRowCollapsed = (id: string) => collapsedRowIds.includes(id);
  const toggleColumnCollapsed = (id: string) => setCollapsedColumnIds((ids) => toggleIdInList(ids, id));
  const toggleRowCollapsed = (id: string) => setCollapsedRowIds((ids) => toggleIdInList(ids, id));
  const allColumnsCollapsed =
    visibleSpriteColumns.length > 0 && visibleSpriteColumns.every((c) => isColumnCollapsed(c.id));
  const allRowsCollapsed = spriteRows.length > 0 && spriteRows.every((r) => isRowCollapsed(r.id));

  const isColumnPanTarget = (el: EventTarget | null) => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.closest('.sprite-module')) return false;
    if (el.closest('button, input, textarea, a, .sprite-column-header, .column-row-label, .column-board-corner, .row-label-resize-handle, .ungrouped-rail')) return false;
    return true;
  };

  const beginRowLabelResize = (e: React.MouseEvent) => {
    if (rowLabelsCollapsed) return;
    e.preventDefault();
    e.stopPropagation();
    rowLabelResizeRef.current = { startX: e.clientX, startWidth: rowLabelWidth };
    setIsResizingRowLabels(true);
  };

  const renderRowLabelResizeHandle = () => rowLabelsCollapsed ? null : (
    <div
      className="row-label-resize-handle"
      title="Arrastrar para cambiar el ancho de los nombres · Doble clic para restablecer"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={beginRowLabelResize}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setRowLabelWidth(ROW_LABEL_WIDTH_DEFAULT);
      }}
    />
  );

  const openQuadrantPreview = (id: string) => {
    setQuadrantPreviewIds((prev) => {
      if (prev.length === 0) return [id];
      if (prev[0] === id) return prev;
      return [prev[0], id];
    });
    setQuadrantPicking(false);
  };

  const browseQuadrantPreview = (id: string) => {
    setQuadrantPreviewIds((prev) => {
      if (prev.length <= 1) return [id];
      const other = prev[1];
      if (!other || other === id) return [id];
      return [id, other];
    });
    setQuadrantPicking(false);
  };

  const quadrantPreviewNeighbors = (() => {
    const empty = { prev: null as string | null, next: null as string | null, up: null as string | null, down: null as string | null };
    const currentId = quadrantPreviewIds[0];
    if (!currentId) return empty;
    const order: { id: string; col: string; row: string }[] = [];
    for (const row of spriteRows) {
      for (const col of visibleSpriteColumns) {
        for (const s of sprites) {
          if (getSpriteColumnId(s) === col.id && getSpriteRowId(s) === row.id) {
            order.push({ id: s.id, col: col.id, row: row.id });
          }
        }
      }
    }
    const i = order.findIndex((x) => x.id === currentId);
    if (i < 0 || order.length < 2) return empty;
    const n = order.length;
    const cur = order[i];
    const colIds = visibleSpriteColumns.map((c) => c.id);
    const rowIds = spriteRows.map((r) => r.id);
    const cIdx = colIds.indexOf(cur.col);
    const rIdx = rowIds.indexOf(cur.row);
    const firstInCell = (ci: number, ri: number) =>
      order.find((x) => x.col === colIds[ci] && x.row === rowIds[ri])?.id ?? null;
    let up: string | null = null;
    let down: string | null = null;
    if (cIdx >= 0 && rIdx >= 0 && rowIds.length > 1) {
      for (let step = 1; step < rowIds.length; step++) {
        if (!up) up = firstInCell(cIdx, (rIdx - step + rowIds.length) % rowIds.length);
        if (!down) down = firstInCell(cIdx, (rIdx + step) % rowIds.length);
      }
      if (up === currentId) up = null;
      if (down === currentId) down = null;
    }
    return {
      prev: order[(i - 1 + n) % n].id,
      next: order[(i + 1) % n].id,
      up,
      down,
    };
  })();

  const resolveSpriteDropTarget = (clientX: number, clientY: number, draggedId: string) => {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (const node of stack) {
      if (!(node instanceof Element)) continue;
      if (node.closest('.sprite-drag-ghost')) continue;
      const card = node.closest('[data-sprite-card]') as HTMLElement | null;
      if (card?.dataset.spriteId && card.dataset.spriteId !== draggedId) {
        const band = card.dataset.splitBand;
        return {
          kind: 'sprite' as const,
          spriteId: card.dataset.spriteId,
          columnId: card.dataset.dropColumn || undefined,
          rowId: card.dataset.dropRow || undefined,
          splitBand: band === 'upper' || band === 'lower' ? band : undefined,
        };
      }
      const cell = node.closest('[data-sprite-cell]') as HTMLElement | null;
      if (cell?.dataset.columnId && cell?.dataset.rowId) {
        return {
          kind: 'cell' as const,
          columnId: cell.dataset.columnId,
          rowId: cell.dataset.rowId,
        };
      }
      const zone = node.closest('[data-split-zone]') as HTMLElement | null;
      const zoneBand = zone?.dataset.splitZone;
      if (zoneBand === 'upper' || zoneBand === 'lower') {
        return {
          kind: 'split' as const,
          splitBand: zoneBand,
        };
      }
    }
    return null;
  };

  const applySplitBand = (s: SpriteData, band: 'upper' | 'lower'): SpriteData => (
    band === 'lower' ? { ...s, belowSplit: true } : { ...s, belowSplit: undefined }
  );

  const moveSpriteInDefaultGrid = (
    draggedId: string,
    opts: { beforeId?: string; splitBand?: 'upper' | 'lower' },
  ) => {
    const list = spritesRef.current;
    const oldIndex = list.findIndex((sp) => sp.id === draggedId);
    if (oldIndex < 0) return;
    const next = [...list];
    const [moved] = next.splice(oldIndex, 1);
    let updated = moved;
    if (opts.splitBand) {
      updated = applySplitBand(moved, opts.splitBand);
    } else if (opts.beforeId && gridSplitActiveRef.current) {
      const target = list.find((sp) => sp.id === opts.beforeId);
      if (target) updated = applySplitBand(moved, target.belowSplit ? 'lower' : 'upper');
    }

    if (opts.beforeId) {
      const insertAt = next.findIndex((sp) => sp.id === opts.beforeId);
      if (insertAt < 0) next.push(updated);
      else next.splice(insertAt, 0, updated);
    } else if (opts.splitBand === 'upper') {
      let lastUpper = -1;
      for (let i = 0; i < next.length; i++) {
        if (!next[i].belowSplit) lastUpper = i;
      }
      if (lastUpper < 0) next.unshift(updated);
      else next.splice(lastUpper + 1, 0, updated);
    } else if (opts.splitBand === 'lower') {
      next.push(updated);
    } else {
      next.splice(Math.min(oldIndex, next.length), 0, updated);
    }
    commitSpritesRef.current(next);
  };

  const endSpritePointerDrag = (clientX: number, clientY: number, activated: boolean, draggedId: string) => {
    spriteDragSessionRef.current = null;
    if (!activated) {
      setDragGhost(null);
      setSplitDragOverBand(null);
      return;
    }
    suppressSpriteClickRef.current = true;
    const target = resolveSpriteDropTarget(clientX, clientY, draggedId);
    if (target) {
      if (columnViewRef.current) {
        if (target.kind === 'sprite' && target.columnId) {
          moveSpriteToCellRef.current(
            draggedId,
            target.columnId,
            target.rowId || DEFAULT_SPRITE_ROW_ID,
            target.spriteId,
          );
        } else if (target.kind === 'cell') {
          moveSpriteToCellRef.current(draggedId, target.columnId, target.rowId);
        }
      } else if (target.kind === 'sprite') {
        const band = target.splitBand === 'upper' || target.splitBand === 'lower'
          ? target.splitBand
          : undefined;
        moveSpriteInDefaultGrid(draggedId, {
          beforeId: target.spriteId,
          splitBand: gridSplitActiveRef.current ? band : undefined,
        });
      } else if (target.kind === 'split' && gridSplitActiveRef.current) {
        const band = target.splitBand === 'upper' || target.splitBand === 'lower'
          ? target.splitBand
          : undefined;
        if (band) moveSpriteInDefaultGrid(draggedId, { splitBand: band });
      }
    }
    setDraggedSpriteId(null);
    setDragGhost(null);
    setColumnDragOverId(null);
    setCellDragOverKey(null);
    setSplitDragOverBand(null);
    window.setTimeout(() => {
      suppressSpriteClickRef.current = false;
    }, 0);
  };

  const renderSpriteCard = (s: SpriteData, dropColumnId?: string, dropRowId?: string, splitBand?: 'upper' | 'lower') => (
    <div
      key={s.id}
      data-sprite-card=""
      data-sprite-id={s.id}
      data-drop-column={dropColumnId || ''}
      data-drop-row={dropRowId || ''}
      data-split-band={splitBand || ''}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest('input, textarea, button, a')) return;
        // Anchor crosshair and similar interactive bits stop their own propagation.
        const rect = e.currentTarget.getBoundingClientRect();
        const session = {
          id: s.id,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          offsetX: e.clientX - rect.left,
          offsetY: e.clientY - rect.top,
          width: rect.width,
          height: rect.height,
          activated: false,
          ghostSrc: '' as string,
        };
        spriteDragSessionRef.current = session;
        dragPointerPosRef.current = { x: e.clientX, y: e.clientY };

        const onMove = (ev: PointerEvent) => {
          if (ev.pointerId !== session.pointerId) return;
          dragPointerPosRef.current = { x: ev.clientX, y: ev.clientY };
          const dist = Math.hypot(ev.clientX - session.startX, ev.clientY - session.startY);
          if (!session.activated) {
            if (dist < 8) return;
            session.activated = true;
            session.ghostSrc = imageToPreviewDataUrl(s.img);
            setDraggedSpriteId(session.id);
            setDragGhost({
              x: ev.clientX - session.offsetX,
              y: ev.clientY - session.offsetY,
              w: session.width,
              h: session.height,
              src: session.ghostSrc,
              name: s.name,
            });
          } else {
            setDragGhost({
              x: ev.clientX - session.offsetX,
              y: ev.clientY - session.offsetY,
              w: session.width,
              h: session.height,
              src: session.ghostSrc,
              name: s.name,
            });
            const target = resolveSpriteDropTarget(ev.clientX, ev.clientY, session.id);
            if (target?.kind === 'cell') {
              setCellDragOverKey(compareCellKeyRef.current(target.columnId, target.rowId));
              setSplitDragOverBand(null);
            } else if (target?.kind === 'sprite' && target.columnId && target.rowId) {
              setCellDragOverKey(compareCellKeyRef.current(target.columnId, target.rowId));
              setSplitDragOverBand(null);
            } else if (target?.kind === 'sprite' && (target.splitBand === 'upper' || target.splitBand === 'lower')) {
              setCellDragOverKey(null);
              setSplitDragOverBand(target.splitBand);
            } else if (target?.kind === 'split' && (target.splitBand === 'upper' || target.splitBand === 'lower')) {
              setCellDragOverKey(null);
              setSplitDragOverBand(target.splitBand);
            } else {
              setCellDragOverKey(null);
              setSplitDragOverBand(null);
            }
          }
        };

        const onUp = (ev: PointerEvent) => {
          if (ev.pointerId !== session.pointerId) return;
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          window.removeEventListener('pointercancel', onUp, true);
          endSpritePointerDrag(ev.clientX, ev.clientY, session.activated, session.id);
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onUp, true);
      }}
      onClickCapture={(e) => {
        if (!suppressSpriteClickRef.current) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        opacity: draggedSpriteId === s.id ? 0.4 : 1,
        cursor: draggedSpriteId === s.id ? 'grabbing' : quadrantBoard ? 'zoom-in' : 'grab',
        transition: 'opacity 0.2s ease',
        position: 'relative',
        touchAction: 'none',
      }}
    >
      <SpriteModule
        sprite={s}
        isSelected={selection.includes(s.id)}
        isReference={referenceId === s.id}
        onToggleSelect={toggleSelect}
        onSetReference={(id) => setReferenceId(id)}
        onRemove={(id) => {
          const next = sprites.filter((x: SpriteData) => x.id !== id);
          commitSprites(next);
          if (referenceId === id) setReferenceId(null);
        }}
        onSetAnchor={(id, x, y) => {
          const next = sprites.map((item: SpriteData) => item.id === id ? { ...item, anchor: { x, y } } : item);
          commitSprites(next);
        }}
        onOpenEraser={(id) => setEraserTargetId(id)}
        onOpenGhostCompare={(id) => setGhostCompareTargetId(id)}
        onOpenReplace={(id) => setReplaceTargetId(id)}
        onOpenCopyRect={(id) => setCopyRectTargetId(id)}
        onOpenPixelEditor={(id) => setPixelEditorTargetId(id)}
        onOpenTransform={(id) => setTransformTargetId(id)}
        onOpenTagging={(id) => setTaggingTargetId(id)}
        onOpenPaint={(id) => setPaintTargetId(id)}
        onOpenBucket={(id) => setBucketTargetId(id)}
        onOpenStretch={(id) => setStretchTargetId(id)}
        onOpenComposite={(id, size) => setCompositeTarget({ id, size: size || 8192 })}
        onExport={handleExportSprite}
        onFocusResolution={focusSpriteResolution}
        isWhiteBg={isWhiteBg}
        quadrantView={quadrantBoard}
        onOpenQuadrantPreview={columnView ? openQuadrantPreview : undefined}
        onUpdateSprite={(id, updates) => {
          const next = sprites.map((item: SpriteData) => item.id === id ? { ...item, ...updates } : item);
          commitSprites(next);
        }}
      />
    </div>
  );

  const linkedFolderName = workingFolder?.name || dirHandle?.name || null;
  const hasLinkedFolder = !!(workingFolder || dirHandle);

  const handleFiles = async (
    rawFiles: FileList | File[],
    targetCell?: { columnId: string; rowId: string } | null,
  ) => {
    const files = Array.from(rawFiles);
    const newSprites: SpriteData[] = [];
    const importErrors: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file || !isProbablyImageFile(file)) continue;
      let img: HTMLImageElement;
      try {
        img = await loadImageFromFileReader(file);
        if (isLikelyJpegFile(file) || shouldNormalizeOnImport(file)) {
          img = await normalizeImportedImage(img);
        } else {
          await ensureImageDecoded(img);
        }
      } catch (err) {
        console.error(`Import ${file.name}:`, err);
        importErrors.push(file.name);
        continue;
      }
      const imgW = img.naturalWidth || img.width;
      const imgH = img.naturalHeight || img.height;
      let finalName = file.name;
      let counter = 1;
      const baseName = file.name.replace(/\.[^/.]+$/, "");
      const extension = file.name.match(/\.[^/.]+$/)?.[0] || "";
      const nameExists = (n: string) => sprites.some((s: SpriteData) => s.name === n) || newSprites.some(s => s.name === n);
      while (nameExists(finalName)) {
        finalName = `${baseName}_${counter}${extension}`;
        counter++;
      }

      newSprites.push({ 
        id: generateId(), 
        name: finalName, 
        img, 
        originalImg: img,
        scale: 1,
        rotation: 0,
        offsetX: 0,
        offsetY: 0,
        flipH: false,
        flipV: false,
        regions: [],
        padding: { top: 0, bottom: 0, left: 0, right: 0 },
        anchor: { x: Math.floor(imgW / 2), y: Math.floor(imgH / 2) },
        pixelation: 1,
        brightness: 100,
        contrast: 100,
        saturation: 100,
        hue: 0,
        opacity: 100,
        tintColor: '#000000',
        tintOpacity: 0,
        columnId: targetCell && targetCell.columnId !== DEFAULT_SPRITE_COLUMN_ID ? targetCell.columnId : undefined,
        rowId: targetCell && targetCell.rowId !== DEFAULT_SPRITE_ROW_ID ? targetCell.rowId : undefined,
        belowSplit: gridSplitActive && !targetCell ? true : undefined,
      });
    }
    if (newSprites.length > 0) {
      const merged = [...sprites, ...newSprites];
      commitSprites(merged);
      setSelection(newSprites.map((s: SpriteData) => s.id));
    }
    if (importErrors.length > 0) {
      alert(`No se pudieron importar: ${importErrors.join(', ')}`);
    } else if (files.length > 0 && newSprites.length === 0) {
      alert('No se pudo importar ninguna imagen. Probá PNG/JPG/WEBP o arrastrá los archivos a la grilla.');
    }
  };

  const closeSpriteEditors = () => {
    setEraserTargetId(null);
    setGhostCompareTargetId(null);
    setReplaceTargetId(null);
    setCopyRectTargetId(null);
    setPixelEditorTargetId(null);
    setTransformTargetId(null);
    setTaggingTargetId(null);
    setEffectMaskTargetId(null);
    setPaintTargetId(null);
    setBucketTargetId(null);
    setStretchTargetId(null);
    setCompositeTarget(null);
    setShowAnimationModal(false);
    setQuadrantPreviewIds([]);
    setQuadrantPicking(false);
  };

  const applyLoadedProject = (loaded: LoadedJoaProject) => {
    closeSpriteEditors();
    setSpriteColumns(loaded.columns);
    setSpriteRows(loaded.rows);
    setCollapsedColumnIds(loaded.collapsedColumns);
    setCollapsedRowIds(loaded.collapsedRows);
    setRowLabelWidth(loaded.rowLabelWidth);
    setRowLabelsCollapsed(loaded.rowLabelsCollapsed);
    setColumnView(loaded.columnView);
    setReferenceId(loaded.referenceId);
    setSelection([]);
    const orderedSprites = buildSpritesInBoardOrder(loaded.sprites, loaded.rows, loaded.columns);
    setSprites(orderedSprites);
    setHistory([orderedSprites.map((s) => ({ ...s, padding: { ...s.padding } }))]);
    setHistoryIndex(0);
  };

  const openProjectFile = async (file: File) => {
    if (!file) return;
    if (file.size === 0) {
      alert('El archivo está vacío (0 bytes). El guardado falló: volvé a guardar el proyecto desde la app.');
      return;
    }
    if (sprites.length > 0) {
      const ok = window.confirm('Abrir el proyecto reemplaza los sprites, columnas y filas actuales. ¿Continuar?');
      if (!ok) return;
    }
    setIsSaving(true);
    try {
      applyLoadedProject(await loadJoaProjectFromBlob(file));
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'No se pudo abrir el proyecto.');
    } finally {
      setIsSaving(false);
    }
  };

  const saveProject = async () => {
    if (sprites.length === 0) return;
    const suggestedName = 'JOA_proyecto.joa';
    const dest = await openSaveDestination(suggestedName, [
      { name: 'Proyecto JOA', extensions: ['joa', 'zip'] },
    ]);
    if (!dest) return;
    setIsSaving(true);
    try {
      const zip = new JSZip();
      const metas: JoaProjectSpriteMeta[] = [];
      const pngOpts = { compression: 'STORE' as const };
      for (const s of sprites) {
        const separate = !!(s.originalImg && s.originalImg !== s.img);
        const mainPng = await imageToProjectPngBlob(s.img);
        const mainPath = `images/${s.id}.png`;
        zip.file(mainPath, await mainPng.arrayBuffer(), pngOpts);
        let originalPath: string | undefined;
        if (separate && s.originalImg) {
          const origPng = await imageToProjectPngBlob(s.originalImg);
          originalPath = `images/${s.id}.original.png`;
          zip.file(originalPath, await origPng.arrayBuffer(), pngOpts);
        }
        metas.push(spriteToProjectMeta(s, separate, mainPath, originalPath));
      }
      const project: JoaProjectFile = {
        version: JOA_PROJECT_VERSION,
        kind: JOA_PROJECT_KIND,
        savedAt: new Date().toISOString(),
        columnView,
        columns: spriteColumns,
        rows: spriteRows,
        collapsedColumns: collapsedColumnIds,
        collapsedRows: collapsedRowIds,
        rowLabelWidth,
        rowLabelsCollapsed,
        referenceId,
        sprites: metas,
      };
      zip.file('project.json', JSON.stringify(project, null, 2));
      const zipData = await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
        compressionOptions: { level: 1 },
        streamFiles: true,
      });
      if (!zipData || zipData.byteLength < MIN_ZIP_BYTES) {
        throw new Error('El proyecto generado quedó vacío. Si hay muchos sprites, probá de nuevo o exportá por partes.');
      }
      const blob = new Blob([zipData.slice() as BlobPart], { type: 'application/zip' });
      await writeBlobWithFallback(dest, blob, suggestedName);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'No se pudo guardar el proyecto.');
    } finally {
      setIsSaving(false);
    }
  };

  const openProjectPicker = async () => {
    const desktop = getDesktop();
    if (desktop) {
      try {
        const items = await desktop.pickOpenFiles({
          title: 'Abrir proyecto JOA',
          multiple: false,
          filters: [{ name: 'Proyecto JOA', extensions: ['joa', 'zip'] }],
        });
        if (items.length === 0) return;
        await openProjectFile(filesFromDesktopOpen(items)[0]);
      } catch (err) {
        console.error(err);
      }
      return;
    }

    const files = await pickProjectFile(dirHandle);
    if (files === null) {
      document.getElementById('project-up')?.click();
      return;
    }
    if (files[0]) await openProjectFile(files[0]);
  };

  const handleDroppedFiles = (rawFiles: FileList | File[]) => {
    const files = Array.from(rawFiles);
    const projectFiles = files.filter((f) => isJoaProjectFileName(f.name));
    const imageFiles = files.filter((f) => isProbablyImageFile(f));
    if (projectFiles.length > 0 && imageFiles.length === 0) {
      void openProjectFile(projectFiles[0]);
      return;
    }
    void handleFiles(files);
  };

  const importIntoCell = async (columnId: string, rowId: string) => {
    if (quadrantPicking) return;
    const target = { columnId, rowId };
    const desktop = getDesktop();
    if (desktop) {
      try {
        const items = await desktop.pickOpenFiles({
          title: 'Importar sprite',
          multiple: false,
        });
        if (items.length === 0) return;
        await handleFiles(filesFromDesktopOpen(items), target);
      } catch (err) {
        console.error(err);
      }
      return;
    }
    const files = await pickImageFiles(false, dirHandle);
    if (files === null) {
      cellImportTargetRef.current = target;
      document.getElementById('cell-up')?.click();
      return;
    }
    if (files.length === 0) return;
    await handleFiles(files, target);
  };

  const openImportFiles = async () => {
    const desktop = getDesktop();
    if (desktop) {
      try {
        const items = await desktop.pickOpenFiles({
          title: 'Importar lote de imágenes',
          multiple: true,
        });
        if (items.length === 0) return;
        const folder = await desktop.getWorkingFolder();
        if (folder) setWorkingFolder(folder);
        await handleFiles(filesFromDesktopOpen(items));
      } catch (err) {
        console.error(err);
      }
      return;
    }

    const files = await pickImageFiles(true, dirHandle);
    if (files === null) {
      document.getElementById('grid-up')?.click();
      return;
    }
    if (files.length === 0) return;
    await handleFiles(files);
  };

  const openSliceFile = async () => {
    const desktop = getDesktop();
    if (desktop) {
      try {
        const items = await desktop.pickOpenFiles({
          title: 'Cortar spritesheet',
          multiple: false,
        });
        if (items.length === 0) return;
        const folder = await desktop.getWorkingFolder();
        if (folder) setWorkingFolder(folder);
        await handleSliceFile(filesFromDesktopOpen(items)[0]);
      } catch (err) {
        console.error(err);
      }
      return;
    }

    const files = await pickImageFiles(false, dirHandle);
    if (files === null) {
      document.getElementById('slice-up')?.click();
      return;
    }
    if (files[0]) await handleSliceFile(files[0]);
  };

  const handleSliceFile = async (file: File) => {
    if (!file || !isProbablyImageFile(file)) return;
    const cols = promptLastInt(
      LAST_SLICE_COLS_KEY,
      '¿En cuántas columnas (cortes verticales) deseas dividir la imagen?',
      1,
      { min: 1, max: 1024, invalidMessage: 'Número de columnas inválido' },
    );
    if (cols === null) return;

    const rows = promptLastInt(
      LAST_SLICE_ROWS_KEY,
      '¿En cuántas filas (cortes horizontales) deseas dividir la imagen?',
      1,
      { min: 1, max: 1024, invalidMessage: 'Número de filas o columnas inválido' },
    );
    if (rows === null) return;

    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const image = new Image();
        image.onload = () => res(image);
        image.onerror = rej;
        image.src = e.target?.result as string;
      };
      reader.readAsDataURL(file);
    });

    const sliceWidth = Math.floor(img.width / cols);
    const sliceHeight = Math.floor(img.height / rows);
    if (sliceWidth === 0 || sliceHeight === 0) {
      alert('La imagen es demasiado pequeña para cortarse en tantas partes.');
      return;
    }

    const newSprites: SpriteData[] = [];
    const baseName = file.name.replace(/\.[^/.]+$/, ""); // Remove extension
    
    const canvas = document.createElement('canvas');
    canvas.width = sliceWidth;
    canvas.height = sliceHeight;
    const ctx = canvas.getContext('2d')!;

    let counter = 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.clearRect(0, 0, sliceWidth, sliceHeight);
        ctx.drawImage(img, c * sliceWidth, r * sliceHeight, sliceWidth, sliceHeight, 0, 0, sliceWidth, sliceHeight);
        
        const sliceImg = await new Promise<HTMLImageElement>((res, rej) => {
          const image = new Image();
          image.onload = () => res(image);
          image.onerror = rej;
          image.src = canvas.toDataURL('image/png');
        });

        newSprites.push({
          id: generateId(),
          name: `${baseName}_frame_${counter}.png`,
          img: sliceImg,
          originalImg: sliceImg,
          scale: 1,
          rotation: 0,
          offsetX: 0,
          offsetY: 0,
          flipH: false,
          flipV: false,
          regions: [],
          padding: { top: 0, bottom: 0, left: 0, right: 0 },
          anchor: { x: Math.floor(sliceWidth / 2), y: Math.floor(sliceHeight / 2) },
          pixelation: 1,
          brightness: 100,
          contrast: 100,
          saturation: 100,
          hue: 0,
          opacity: 100,
          tintColor: '#000000',
          tintOpacity: 0,
          belowSplit: gridSplitActive ? true : undefined,
        });
        counter++;
      }
    }

    if (newSprites.length > 0) {
      const merged = [...sprites, ...newSprites];
      commitSprites(merged);
      setSelection(newSprites.map((s: SpriteData) => s.id));
    }
  };

  const toggleSelect = (id: string, multi: boolean) => {
    if (multi) {
      setSelection(prev => {
        const newSel = prev.includes(id) ? prev.filter((i: string) => i !== id) : [...prev, id];
        if (!newSel.includes(id) && referenceId === id) setReferenceId(null);
        return newSel;
      });
    } else {
      setSelection([id]);
    }
  };

  const focusSpriteResolution = (id: string) => {
    setSelection([id]);
    setQuadrantPreviewIds([]);
    setQuadrantPicking(false);
    setControlsVisible(true);
    window.setTimeout(() => {
      const el = document.getElementById('joa-res-width') as HTMLInputElement | null;
      if (!el || el.disabled) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.focus();
      el.select();
    }, 80);
  };

  const updateDirHandle = (handle: FileSystemDirectoryHandle | null) => {
    setDirHandle(handle);
    void saveWorkingDirHandle(handle);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const desktop = getDesktop();
      if (desktop) {
        const folder = await desktop.getWorkingFolder();
        if (!cancelled && folder) setWorkingFolder(folder);
        return;
      }
      const saved = await loadWorkingDirHandle();
      if (!cancelled && saved) setDirHandle(saved);
    })();
    return () => { cancelled = true; };
  }, []);

  const selectDirectory = async () => {
    const desktop = getDesktop();
    if (desktop) {
      try {
        const folder = await desktop.pickFolder();
        if (folder) setWorkingFolder(folder);
      } catch (err) {
        console.error('Directory selection failed:', err);
      }
      return;
    }
    try {
      const handle = await (window as any).showDirectoryPicker({
        id: WORKING_PICKER_ID,
        mode: 'readwrite',
        startIn: dirHandle || undefined,
      });
      updateDirHandle(handle);
    } catch (err) {
      console.error('Directory selection failed:', err);
    }
  };

  const overwriteAll = async () => {
    const desktop = getDesktop();
    if (desktop) {
      let folder = workingFolder || await desktop.getWorkingFolder();
      if (!folder) {
        folder = await desktop.pickFolder();
        if (!folder) return;
        setWorkingFolder(folder);
      }
      setIsSaving(true);
      try {
        const files: { name: string; data: ArrayBuffer }[] = [];
        for (const s of sprites) {
          const canvas = renderSpriteToCanvas(s, true);
          const blob = await canvasToPngBlob(canvas);
          if (!blob.size) throw new Error(`No se pudo generar PNG de «${s.name}».`);
          files.push({
            name: sanitizeExportFileName(s.name, '.png'),
            data: await arrayBufferFromBlob(blob),
          });
        }
        await desktop.writeFilesToFolder(folder.path, files);
        alert('Se sobrescribieron los originales como PNG.');
      } catch (err) {
        console.error('Overwrite failed:', err);
        alert(err instanceof Error ? err.message : 'Error al sobrescribir archivos.');
      } finally {
        setIsSaving(false);
      }
      return;
    }

    if (!dirHandle) return;
    if (!(await ensureHandlePermission(dirHandle, 'readwrite'))) {
      alert('No hay permiso de escritura sobre la carpeta vinculada. Volvé a vincularla.');
      return;
    }
    setIsSaving(true);
    try {
      for (const s of sprites) {
        const canvas = renderSpriteToCanvas(s, true);
        const blob = await canvasToPngBlob(canvas);
        if (!blob.size) throw new Error(`No se pudo generar PNG de «${s.name}».`);
        const fileName = sanitizeExportFileName(s.name, '.png');
        const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      }
      alert('Se sobrescribieron los originales como PNG.');
    } catch (err) {
      console.error('Overwrite failed:', err);
      alert('Error al sobrescribir. Asegúrate de dar permisos de escritura.');
    } finally {
      setIsSaving(false);
    }
  };

  const updateBulkScale = (val: number) => {
    const next = sprites.map((s: SpriteData) => selection.includes(s.id) ? { ...s, scale: val } : s);
    commitSprites(next);
  };

  const updateBulkWidth = (val: number) => {
    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id)) return s;
      const newScale = val / s.img.width;
      return { ...s, scale: newScale };
    });
    commitSprites(next);
  };

  const updateBulkHeight = (val: number) => {
    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id)) return s;
      const newScale = val / s.img.height;
      return { ...s, scale: newScale };
    });
    commitSprites(next);
  };

  const updateBulkInternalScale = (val: number) => {
    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id)) return s;
      const stretchX = s.stretchX || 1;
      const stretchY = s.stretchY || 1;
      const currScX = (s.scale || 1) * stretchX;
      const currScY = (s.scale || 1) * stretchY;
      const currW = s.img.width * currScX;
      const currH = s.img.height * currScY;
      
      const newScX = val * stretchX;
      const newScY = val * stretchY;
      const newW = s.img.width * newScX;
      const newH = s.img.height * newScY;
      
      const diffW = currW - newW;
      const diffH = currH - newH;
      
      return { 
        ...s, 
        scale: val,
        padding: {
          left: s.padding.left + diffW / 2,
          right: s.padding.right + diffW / 2,
          top: s.padding.top + diffH / 2,
          bottom: s.padding.bottom + diffH / 2
        }
      };
    });
    commitSprites(next);
  };

  const updateBulkInternalWidth = (val: number) => {
    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id)) return s;
      const stretchX = s.stretchX || 1;
      const stretchY = s.stretchY || 1;
      const currScX = (s.scale || 1) * stretchX;
      const currScY = (s.scale || 1) * stretchY;
      const currW = s.img.width * currScX;
      const currH = s.img.height * currScY;
      
      const newScale = val / (s.img.width * stretchX);
      const newScX = newScale * stretchX;
      const newScY = newScale * stretchY;
      const newW = s.img.width * newScX;
      const newH = s.img.height * newScY;
      
      const diffW = currW - newW;
      const diffH = currH - newH;
      
      return { 
        ...s, 
        scale: newScale,
        padding: {
          left: s.padding.left + diffW / 2,
          right: s.padding.right + diffW / 2,
          top: s.padding.top + diffH / 2,
          bottom: s.padding.bottom + diffH / 2
        }
      };
    });
    commitSprites(next);
  };

  const updateBulkInternalHeight = (val: number) => {
    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id)) return s;
      const stretchX = s.stretchX || 1;
      const stretchY = s.stretchY || 1;
      const currScX = (s.scale || 1) * stretchX;
      const currScY = (s.scale || 1) * stretchY;
      const currW = s.img.width * currScX;
      const currH = s.img.height * currScY;
      
      const newScale = val / (s.img.height * stretchY);
      const newScX = newScale * stretchX;
      const newScY = newScale * stretchY;
      const newW = s.img.width * newScX;
      const newH = s.img.height * newScY;
      
      const diffW = currW - newW;
      const diffH = currH - newH;
      
      return { 
        ...s, 
        scale: newScale,
        padding: {
          left: s.padding.left + diffW / 2,
          right: s.padding.right + diffW / 2,
          top: s.padding.top + diffH / 2,
          bottom: s.padding.bottom + diffH / 2
        }
      };
    });
    commitSprites(next);
  };

  const updateBulkStretchX = (val: number) => {
    const next = sprites.map((s: SpriteData) => selection.includes(s.id) ? { ...s, stretchX: val } : s);
    commitSprites(next);
  };

  const updateBulkStretchY = (val: number) => {
    const next = sprites.map((s: SpriteData) => selection.includes(s.id) ? { ...s, stretchY: val } : s);
    commitSprites(next);
  };

  const applyReferenceScale = () => {
    const ref = sprites.find((s: SpriteData) => s.id === referenceId);
    if (!ref) return;
    const refW = ref.img.width * (ref.scale || 1);
    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id) || s.id === referenceId) return s;
      const newScale = refW / s.img.width;
      return { ...s, scale: newScale };
    });
    commitSprites(next);
  };

  const applyReferenceFrame = () => {
    const ref = sprites.find((s: SpriteData) => s.id === referenceId);
    if (!ref) return;

    const refSc = ref.scale || 1;
    const refSX = ref.stretchX || 1;
    const refSY = ref.stretchY || 1;
    const refScX = refSc * refSX;
    const refScY = refSc * refSY;
    const refContentW = ref.img.width * refScX;
    const refContentH = ref.img.height * refScY;
    const refW = refContentW + ref.padding.left + ref.padding.right;
    const refH = refContentH + ref.padding.top + ref.padding.bottom;

    const refAnchorX = ref.anchor?.x ?? ref.img.width / 2;
    const refAnchorY = ref.anchor?.y ?? ref.img.height / 2;
    const refDLeft = ref.padding.left + refAnchorX * refScX;
    const refDTop = ref.padding.top + refAnchorY * refScY;
    const refDRight = ref.padding.right + (refContentW - refAnchorX * refScX);
    const refDBottom = ref.padding.bottom + (refContentH - refAnchorY * refScY);

    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id) || s.id === referenceId) return s;

      const stretchX = s.stretchX || 1;
      const stretchY = s.stretchY || 1;
      const baseW = s.img.width * stretchX;
      const baseH = s.img.height * stretchY;

      const targetScale = Math.min(refW / baseW, refH / baseH);
      const contentW = baseW * targetScale;
      const contentH = baseH * targetScale;

      const anchorX = s.anchor?.x ?? s.img.width / 2;
      const anchorY = s.anchor?.y ?? s.img.height / 2;

      let padLeft = refDLeft - anchorX * targetScale * stretchX;
      let padTop = refDTop - anchorY * targetScale * stretchY;
      let padRight = refDRight - (contentW - anchorX * targetScale * stretchX);
      let padBottom = refDBottom - (contentH - anchorY * targetScale * stretchY);

      if (padLeft < 0 || padRight < 0 || padTop < 0 || padBottom < 0) {
        const diffW = refW - contentW;
        const diffH = refH - contentH;
        padLeft = Math.max(0, Math.floor(diffW / 2));
        padRight = Math.max(0, diffW - padLeft);
        padTop = Math.max(0, Math.floor(diffH / 2));
        padBottom = Math.max(0, diffH - padTop);
      }

      return {
        ...s,
        scale: targetScale,
        padding: {
          left: Math.round(padLeft),
          right: Math.round(padRight),
          top: Math.round(padTop),
          bottom: Math.round(padBottom),
        },
      };
    });
    commitSprites(next);
  };
  const autoMaximizeInternal = () => {
    if (selection.length === 0) return;
    
    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id)) return s;

      const canvas = document.createElement('canvas');
      canvas.width = s.img.width;
      canvas.height = s.img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return s;
      ctx.drawImage(s.img, 0, 0);
      const data = ctx.getImageData(0, 0, s.img.width, s.img.height).data;

      let minX = s.img.width, minY = s.img.height, maxX = 0, maxY = 0;
      let hasPixels = false;
      for (let y = 0; y < s.img.height; y++) {
        for (let x = 0; x < s.img.width; x++) {
          const alpha = data[(y * s.img.width + x) * 4 + 3];
          if (alpha > 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            hasPixels = true;
          }
        }
      }

      if (!hasPixels) return s;

      const boxW = (maxX + 1) - minX;
      const boxH = (maxY + 1) - minY;

      const stretchX = s.stretchX || 1;
      const stretchY = s.stretchY || 1;
      const currScale = s.scale || 1;

      const totalW = (s.img.width * currScale * stretchX) + s.padding.left + s.padding.right;
      const totalH = (s.img.height * currScale * stretchY) + s.padding.top + s.padding.bottom;

      const visibleW = boxW * currScale * stretchX;
      const visibleH = boxH * currScale * stretchY;

      if (visibleW === 0 || visibleH === 0 || totalW <= 0 || totalH <= 0) return s;

      const M = Math.min(totalW / visibleW, totalH / visibleH);

      const newScale = currScale * M;
      const newImgW = s.img.width * newScale * stretchX;
      const newImgH = s.img.height * newScale * stretchY;

      const newContentW = boxW * newScale * stretchX;
      const newContentH = boxH * newScale * stretchY;

      const newContentLeft = (totalW - newContentW) / 2;
      const newContentTop = (totalH - newContentH) / 2;

      const newPaddingLeft = newContentLeft - (minX * newScale * stretchX);
      const newPaddingRight = totalW - newImgW - newPaddingLeft;

      const newPaddingTop = newContentTop - (minY * newScale * stretchY);
      const newPaddingBottom = totalH - newImgH - newPaddingTop;

      return {
        ...s,
        scale: newScale,
        padding: {
          left: newPaddingLeft,
          right: newPaddingRight,
          top: newPaddingTop,
          bottom: newPaddingBottom
        }
      };
    });
    
    commitSprites(next);
  };

  const removeBlackBackground = async (img: HTMLImageElement, threshold: number): Promise<HTMLImageElement> => {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;

      const w = canvas.width;
      const h = canvas.height;
      
      const isBlack = (idx: number) => {
        return data[idx] <= threshold && data[idx + 1] <= threshold && data[idx + 2] <= threshold && data[idx + 3] > 0;
      };

      const stack: number[] = [];
      
      for (let x = 0; x < w; x++) {
        const top = (0 * w + x) * 4;
        if (isBlack(top)) stack.push(top);
        
        const bottom = ((h - 1) * w + x) * 4;
        if (isBlack(bottom)) stack.push(bottom);
      }
      for (let y = 0; y < h; y++) {
        const left = (y * w + 0) * 4;
        if (isBlack(left)) stack.push(left);
        
        const right = (y * w + w - 1) * 4;
        if (isBlack(right)) stack.push(right);
      }

      while (stack.length > 0) {
        const idx = stack.pop()!;
        if (data[idx + 3] === 0) continue;
        
        data[idx + 3] = 0;

        const pixelIndex = idx / 4;
        const x = pixelIndex % w;
        const y = Math.floor(pixelIndex / w);

        if (x > 0) {
          const left = idx - 4;
          if (data[left + 3] > 0 && isBlack(left)) stack.push(left);
        }
        if (x < w - 1) {
          const right = idx + 4;
          if (data[right + 3] > 0 && isBlack(right)) stack.push(right);
        }
        if (y > 0) {
          const top = idx - w * 4;
          if (data[top + 3] > 0 && isBlack(top)) stack.push(top);
        }
        if (y < h - 1) {
          const bottom = idx + w * 4;
          if (data[bottom + 3] > 0 && isBlack(bottom)) stack.push(bottom);
        }
      }

      ctx.putImageData(imgData, 0, 0);
      const newImg = new Image();
      newImg.onload = () => resolve(newImg);
      newImg.src = canvas.toDataURL('image/png');
    });
  };

  /** Quita todo píxel negro (umbral), aunque esté cerrado por otros colores. */
  const removeBlackBackgroundPrecise = async (img: HTMLImageElement, threshold: number): Promise<HTMLImageElement> => {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i + 3] > 0 &&
          data[i] <= threshold &&
          data[i + 1] <= threshold &&
          data[i + 2] <= threshold
        ) {
          data[i + 3] = 0;
        }
      }
      ctx.putImageData(imgData, 0, 0);
      const newImg = new Image();
      newImg.onload = () => resolve(newImg);
      newImg.src = canvas.toDataURL('image/png');
    });
  };

  const removeTextBulk = async () => {
    if (selection.length === 0) return;

    const tol = promptLastInt(
      LAST_REMOVE_TEXT_TOL_KEY,
      'Quitar letras: detecta watermarks y etiquetas (blanco/negro/gris) separadas del dibujo principal. Tolerancia 0–100 (0 = solo blanco/negro puro):',
      20,
      { min: 0, max: 100, invalidMessage: 'Tolerancia inválida.' },
    );
    if (tol === null) return;

    setIsSaving(true);
    try {
      const next = [...sprites];
      let changed = false;
      for (let i = 0; i < next.length; i++) {
        if (selection.includes(next[i].id)) {
          const src = next[i].originalImg || next[i].img;
          const newImg = await removeTextSmart(src, tol);
          next[i] = { ...next[i], img: newImg, originalImg: newImg };
          changed = true;
        }
      }
      if (changed) commitSprites(next);
    } catch (e) {
      console.error(e);
      alert('Hubo un error quitando letras de las imágenes.');
    } finally {
      setIsSaving(false);
    }
  };

  const removeBackgroundBulk = async (mode: 'smart' | 'precise' = 'smart') => {
    if (selection.length === 0) return;

    const tol = promptLastInt(
      mode === 'precise' ? LAST_BG_BLACK_PRECISE_TOL_KEY : LAST_BG_BLACK_SMART_TOL_KEY,
      mode === 'precise'
        ? 'Negro preciso: borra TODO píxel negro (aunque esté cerrado). Tolerancia 0–100 (0 = solo negro absoluto):'
        : 'Fondo inteligente: solo negro conectado al borde. Tolerancia 0–100 (0 = solo negro absoluto):',
      5,
      { min: 0, max: 255, invalidMessage: 'Tolerancia inválida.' },
    );
    if (tol === null) return;

    setIsSaving(true);
    
    try {
      const next = [...sprites];
      let changed = false;
      for (let i = 0; i < next.length; i++) {
        if (selection.includes(next[i].id)) {
          const src = next[i].originalImg || next[i].img;
          const newImg = mode === 'precise'
            ? await removeBlackBackgroundPrecise(src, tol)
            : await removeBlackBackground(src, tol);
          next[i] = { ...next[i], img: newImg, originalImg: newImg };
          changed = true;
        }
      }
      
      if (changed) {
        commitSprites(next);
      }
    } catch (e) {
      console.error(e);
      alert('Hubo un error procesando las imágenes.');
    } finally {
      setIsSaving(false);
    }
  };
  const flipHorizontalBulk = async () => {
    if (selection.length === 0) return;
    
    setIsSaving(true);
    try {
      const next = [...sprites];
      let changed = false;
      for (let i = 0; i < next.length; i++) {
        if (selection.includes(next[i].id)) {
          const s = next[i];
          const img = s.originalImg || s.img;
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d')!;
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0);
          
          const newImg = await new Promise<HTMLImageElement>((resolve) => {
            const temp = new Image();
            temp.onload = () => resolve(temp);
            temp.src = canvas.toDataURL('image/png');
          });
          
          next[i] = { ...s, img: newImg, originalImg: newImg };
          changed = true;
        }
      }
      
      if (changed) {
        commitSprites(next);
      }
    } catch (e) {
      console.error(e);
      alert('Hubo un error volteando las imágenes.');
    } finally {
      setIsSaving(false);
    }
  };

  const applyAlignment = () => {
    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id) || !s.anchor) return s;
      const sc = s.scale || 1;
      return {
        ...s,
        padding: {
          top: targets.top - s.anchor.y * sc,
          bottom: targets.bottom - (s.img.height * sc - s.anchor.y * sc),
          left: targets.left - s.anchor.x * sc,
          right: targets.right - (s.img.width * sc - s.anchor.x * sc)
        }
      };
    });
    commitSprites(next);
  };

  const applyReferenceAlignment = () => {
    const ref = sprites.find(s => s.id === referenceId);
    if (!ref || !ref.anchor) return;

    const refSc = ref.scale || 1;
    const refDLeft = ref.padding.left + ref.anchor.x * refSc * (ref.stretchX || 1);
    const refDTop = ref.padding.top + ref.anchor.y * refSc * (ref.stretchY || 1);
    const refDRight = ref.padding.right + (ref.img.width * refSc * (ref.stretchX || 1) - ref.anchor.x * refSc * (ref.stretchX || 1));
    const refDBottom = ref.padding.bottom + (ref.img.height * refSc * (ref.stretchY || 1) - ref.anchor.y * refSc * (ref.stretchY || 1));

    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id) || s.id === referenceId || !s.anchor) return s;
      
      const sc = s.scale || 1;
      const sSX = s.stretchX || 1;
      const sSY = s.stretchY || 1;

      return {
        ...s,
        padding: {
          left: refDLeft - s.anchor.x * sc * sSX,
          top: refDTop - s.anchor.y * sc * sSY,
          right: refDRight - (s.img.width * sc * sSX - s.anchor.x * sc * sSX),
          bottom: refDBottom - (s.img.height * sc * sSY - s.anchor.y * sc * sSY)
        }
      };
    });
    commitSprites(next);
  };

  const updateBulkPadding = (side: keyof Padding, val: number) => {
     const next = sprites.map((s: SpriteData) => selection.includes(s.id) ? { ...s, padding: { ...s.padding, [side]: val } } : s);
     commitSprites(next);
  };

  /** Mueve el dibujo dentro del envase (dx/dy en px). Full no cambia: solo redistribuye padding. */
  const nudgeSelectedContent = (dx: number, dy: number) => {
    if ((!dx && !dy) || selection.length === 0) return;
    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id)) return s;
      return {
        ...s,
        padding: {
          left: s.padding.left + dx,
          right: s.padding.right - dx,
          top: s.padding.top + dy,
          bottom: s.padding.bottom - dy,
        },
      };
    });
    commitSprites(next);
  };

  const updateBulkPixelation = (val: number) => {
    const next = sprites.map((s: SpriteData) => selection.includes(s.id) ? { ...s, pixelation: val } : s);
    commitSprites(next);
  };

  const updateBulkFilter = (prop: keyof SpriteData, val: number | string | undefined) => {
    const next = sprites.map((s: SpriteData) => selection.includes(s.id) ? { ...s, [prop]: val } : s);
    commitSprites(next);
  };

  const applyReferenceFilters = () => {
    const ref = sprites.find((s: SpriteData) => s.id === referenceId);
    if (!ref) return;
    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id) || s.id === referenceId) return s;
      return { 
        ...s, 
        brightness: ref.brightness ?? 100,
        contrast: ref.contrast ?? 100,
        saturation: ref.saturation ?? 100,
        hue: ref.hue ?? 0,
        opacity: ref.opacity ?? 100,
        opacityMode: ref.opacityMode ?? 'absolute',
        grayscale: ref.grayscale ?? 0,
        sepia: ref.sepia ?? 0,
        invert: ref.invert ?? 0,
        blur: ref.blur ?? 0,
        exposure: ref.exposure ?? 100,
        highlights: ref.highlights ?? 100,
        posterize: ref.posterize,
        outlineColor: ref.outlineColor,
        outlineWidth: ref.outlineWidth,
        outlineStyle: ref.outlineStyle ?? 'smooth',
        greenHueShift: ref.greenHueShift,
        greenSaturation: ref.greenSaturation,
        greenOpacity: ref.greenOpacity,
        blackHueShift: ref.blackHueShift,
        blackSaturation: ref.blackSaturation,
        blackOpacity: ref.blackOpacity,
        whiteHueShift: ref.whiteHueShift,
        whiteSaturation: ref.whiteSaturation,
        whiteOpacity: ref.whiteOpacity,
        handDrawn: ref.handDrawn ?? 0,
        pencilDrawn: ref.pencilDrawn ?? 0,
        shadowX: ref.shadowX,
        shadowY: ref.shadowY,
        shadowBlur: ref.shadowBlur,
        shadowColor: ref.shadowColor,
        glowIntensity: ref.glowIntensity,
        glowColor: ref.glowColor,
        tintColor: ref.tintColor,
        tintOpacity: ref.tintOpacity
      };
    });
    commitSprites(next);
  };

  /**
   * Tamaño del “píxel de arte” del dibujo (no la resolución del archivo).
   * - MAE: mayor N donde promediar bloques N×N casi no cambia la imagen (upscale limpio)
   * - Runs: longitud típica entre cambios fuertes de color (pixel art grueso nativo)
   */
  const detectIntrinsicPixelSize = (img: HTMLImageElement): number => {
    const w = img.width;
    const h = img.height;
    if (w < 2 || h < 2) return 1;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 1;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);

    const maxN = Math.min(48, Math.floor(Math.min(w, h) / 3));

    /** Error medio al reemplazar cada bloque N×N por su color promedio. */
    const maeForN = (n: number): number => {
      let err = 0;
      let count = 0;
      for (let by = 0; by + n <= h; by += n) {
        for (let bx = 0; bx + n <= w; bx += n) {
          let r = 0;
          let g = 0;
          let b = 0;
          let op = 0;
          for (let dy = 0; dy < n; dy++) {
            for (let dx = 0; dx < n; dx++) {
              const i = ((by + dy) * w + (bx + dx)) * 4;
              if (data[i + 3] < 12) continue;
              r += data[i];
              g += data[i + 1];
              b += data[i + 2];
              op++;
            }
          }
          if (op < n * n * 0.35) continue;
          r = (r / op) | 0;
          g = (g / op) | 0;
          b = (b / op) | 0;
          for (let dy = 0; dy < n; dy++) {
            for (let dx = 0; dx < n; dx++) {
              const i = ((by + dy) * w + (bx + dx)) * 4;
              if (data[i + 3] < 12) continue;
              err += Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b);
              count++;
            }
          }
        }
      }
      return count ? err / (count * 3) : 999;
    };

    /** Upscale / grilla limpia: el mayor N con error bajo al promediar. */
    const detectByMae = (): number => {
      const T = 8;
      for (let n = maxN; n >= 2; n--) {
        if (maeForN(n) <= T) return n;
      }
      return 1;
    };

    /**
     * Grosor visual del trazo: longitud típica de tramos entre saltos fuertes de color.
     * Tolera ruido interno en rellenos; mide el tamaño de las manchas del pixel art.
     */
    const detectByStrongRuns = (): number => {
      const strongDiff = (i: number, j: number) =>
        Math.abs(data[i] - data[j]) +
          Math.abs(data[i + 1] - data[j + 1]) +
          Math.abs(data[i + 2] - data[j + 2]) >
        45;

      const runs: number[] = [];
      const push = (len: number) => {
        if (len >= 1) runs.push(Math.min(len, maxN * 2));
      };

      const rowStep = Math.max(1, Math.floor(h / 60));
      for (let y = 0; y < h; y += rowStep) {
        let x = 0;
        while (x < w) {
          const i0 = (y * w + x) * 4;
          if (data[i0 + 3] < 12) {
            x++;
            continue;
          }
          let len = 1;
          while (x + len < w) {
            const iPrev = (y * w + x + len - 1) * 4;
            const i1 = (y * w + x + len) * 4;
            if (data[i1 + 3] < 12 || strongDiff(iPrev, i1)) break;
            len++;
          }
          push(len);
          x += len;
        }
      }

      const colStep = Math.max(1, Math.floor(w / 60));
      for (let x = 0; x < w; x += colStep) {
        let y = 0;
        while (y < h) {
          const i0 = (y * w + x) * 4;
          if (data[i0 + 3] < 12) {
            y++;
            continue;
          }
          let len = 1;
          while (y + len < h) {
            const iPrev = ((y + len - 1) * w + x) * 4;
            const i1 = ((y + len) * w + x) * 4;
            if (data[i1 + 3] < 12 || strongDiff(iPrev, i1)) break;
            len++;
          }
          push(len);
          y += len;
        }
      }

      if (runs.length < 24) return 1;
      runs.sort((a, b) => a - b);
      // ~percentil 35: tamaño típico de mancha, sin inflar por planos enormes de piel.
      return Math.max(1, Math.min(maxN, runs[Math.floor(runs.length * 0.35)] || 1));
    };

    const byMae = detectByMae();
    const byRuns = detectByStrongRuns();
    // Ambas estiman el mismo concepto; nos quedamos con la señal más gruesa fiable.
    return Math.max(byMae, byRuns);
  };

  /** Tamaño visual de un píxel de arte sobre el canvas ya escalado. */
  const getVisualArtPixelSize = (sprite: SpriteData): number => {
    const base = detectIntrinsicPixelSize(sprite.img);
    const scale = sprite.scale || 1;
    const p = sprite.pixelation || 1;
    if (p > 1) return p;
    return Math.max(1, base * scale);
  };

  const applyReferencePixelation = () => {
    const ref = sprites.find((s: SpriteData) => s.id === referenceId);
    if (!ref) return;

    const targetVisual = getVisualArtPixelSize(ref);
    const goal = Math.max(1, Math.round(targetVisual));

    if (goal <= 1) {
      // REF ya es detalle ~1px: no hay grilla más gruesa que aplicar.
      return;
    }

    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id) || s.id === referenceId) return s;

      const natural = Math.max(1, detectIntrinsicPixelSize(s.img) * (s.scale || 1));

      // Ya tan grueso (o más) que la REF.
      if (natural >= goal * 0.85) {
        return { ...s, pixelation: 1 };
      }

      // Más detallado → llevar a la grilla visual medida en la REF.
      return { ...s, pixelation: goal };
    });
    commitSprites(next);
  };

  const handleExportSprite = async (id: string, format: 'png' | 'jpg' | 'ico' | 'dds' = 'png') => {
    const s = sprites.find((x: SpriteData) => x.id === id);
    if (!s) {
      alert('No se encontró el sprite a exportar.');
      return;
    }
    if (!s.img || !s.img.width || !s.img.height) {
      alert('El sprite no tiene imagen válida para exportar.');
      return;
    }

    const finalExt =
      format === 'ico' ? '.ico'
      : format === 'dds' ? '.dds'
      : format === 'jpg' ? '.jpg'
      : '.png';
    const defaultName = sanitizeExportFileName(s.name, finalExt);
    const filters =
      format === 'ico' ? [{ name: 'Icon File', extensions: ['ico'] }]
      : format === 'dds' ? [{ name: 'DDS Texture (BC7)', extensions: ['dds'] }]
      : format === 'jpg' ? [{ name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }]
      : [{ name: 'PNG Image', extensions: ['png'] }];

    // El diálogo tiene que abrirse con el gesto del click, antes de generar el archivo.
    let dest: SaveDestination | null = null;
    try {
      dest = await openSaveDestination(defaultName, filters);
    } catch (err) {
      console.error(err);
      dest = downloadDestination(defaultName);
    }
    if (!dest) return; // canceló

    setIsSaving(true);
    try {
      const canvas = renderSpriteToCanvas(s, true);
      if (!canvas.width || !canvas.height) {
        throw new Error('El canvas de exportación quedó vacío.');
      }

      let blob: Blob;

      if (format === 'dds') {
        const dds = await canvasToBc7Dds(canvas);
        if (!dds || (dds instanceof ArrayBuffer ? dds.byteLength === 0 : (dds as Uint8Array).byteLength === 0)) {
          throw new Error('La conversión DDS BC7 devolvió un archivo vacío.');
        }
        blob = new Blob([dds], { type: 'application/octet-stream' });
      } else if (format === 'jpg') {
        blob = await canvasToJpegBlob(canvas);
        if (!blob.size) throw new Error('La exportación JPG quedó vacía.');
      } else {
        const pngBlob = await canvasToPngBlob(canvas);

        if (format === 'ico') {
          const sizes = [256, 128, 64, 48, 32, 16];
          const entries: { size: number; buf: Uint8Array }[] = [];

          for (const size of sizes) {
            const c = document.createElement('canvas');
            c.width = size;
            c.height = size;
            const cx = c.getContext('2d');
            if (!cx) continue;
            cx.imageSmoothingEnabled = false;

            const scale = Math.min(size / canvas.width, size / canvas.height);
            const dw = Math.max(1, Math.floor(canvas.width * scale));
            const dh = Math.max(1, Math.floor(canvas.height * scale));
            const dx = Math.floor((size - dw) / 2);
            const dy = Math.floor((size - dh) / 2);
            cx.drawImage(canvas, dx, dy, dw, dh);

            try {
              const b = await canvasToPngBlob(c);
              entries.push({ size, buf: new Uint8Array(await b.arrayBuffer()) });
            } catch {
              // Si un tamaño falla, seguimos con los demás.
            }
          }

          if (entries.length === 0) {
            // Mejor un PNG que nada: el usuario pidió exportar.
            const pngName = sanitizeExportFileName(s.name, '.png');
            if (!forceDownloadBlob(pngBlob, pngName)) {
              throw new Error('No se pudo armar el ICO ni descargar el PNG de respaldo.');
            }
            alert('No se pudo armar el ICO. Se descargó un PNG de respaldo.');
            return;
          }

          const header = new Uint8Array(6);
          header[0] = 0; header[1] = 0; header[2] = 1; header[3] = 0;
          header[4] = entries.length & 0xff; header[5] = (entries.length >> 8) & 0xff;

          let currentOffset = 6 + 16 * entries.length;
          const directory = new Uint8Array(16 * entries.length);

          for (let i = 0; i < entries.length; i++) {
            const { size, buf } = entries[i];
            const w = size >= 256 ? 0 : size;
            const h = size >= 256 ? 0 : size;
            const dirOffset = i * 16;
            directory[dirOffset + 0] = w;
            directory[dirOffset + 1] = h;
            directory[dirOffset + 2] = 0;
            directory[dirOffset + 3] = 0;
            directory[dirOffset + 4] = 1;
            directory[dirOffset + 5] = 0;
            directory[dirOffset + 6] = 32;
            directory[dirOffset + 7] = 0;

            const len = buf.length;
            directory[dirOffset + 8] = len & 0xff;
            directory[dirOffset + 9] = (len >> 8) & 0xff;
            directory[dirOffset + 10] = (len >> 16) & 0xff;
            directory[dirOffset + 11] = (len >> 24) & 0xff;

            directory[dirOffset + 12] = currentOffset & 0xff;
            directory[dirOffset + 13] = (currentOffset >> 8) & 0xff;
            directory[dirOffset + 14] = (currentOffset >> 16) & 0xff;
            directory[dirOffset + 15] = (currentOffset >> 24) & 0xff;

            currentOffset += len;
          }

          const icoData = new Uint8Array(currentOffset);
          icoData.set(header, 0);
          icoData.set(directory, 6);

          let dataOffset = 6 + 16 * entries.length;
          for (let i = 0; i < entries.length; i++) {
            icoData.set(entries[i].buf, dataOffset);
            dataOffset += entries[i].buf.length;
          }

          blob = new Blob([icoData], { type: 'image/x-icon' });
        } else {
          blob = pngBlob;
        }
      }

      if (!blob || blob.size === 0) {
        throw new Error('El archivo a exportar quedó vacío.');
      }

      const result = await writeBlobWithFallback(dest, blob, defaultName);
      if (result === 'failed') return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Error al exportar${format === 'dds' ? ' DDS BC7' : format === 'ico' ? ' ICO' : format === 'jpg' ? ' JPG' : ' PNG'}:\n${msg}`);
    } finally {
      setIsSaving(false);
    }
  };

  const exportGridSpritesheet = async () => {
    if (sprites.length === 0) return;

    const cols = promptLastInt(
      LAST_EXPORT_STRIP_COLS_KEY,
      '¿Cuántas columnas deseas para el spritesheet al exportar?',
      10,
      { min: 1, max: 1024, invalidMessage: 'Número de filas o columnas inválido.' },
    );
    if (cols === null) return;

    const rows = promptLastInt(
      LAST_EXPORT_STRIP_ROWS_KEY,
      '¿Cuántas filas deseas para el spritesheet al exportar?',
      1,
      { min: 1, max: 1024, invalidMessage: 'Número de filas o columnas inválido.' },
    );
    if (rows === null) return;

    const includeGrid = await confirmLastBool(
      LAST_EXPORT_STRIP_GRID_KEY,
      '¿Deseas dibujar una cuadrícula guía sobre las imágenes exportadas?',
      false,
      { yes: 'Sí, con guía', no: 'No', title: 'Exportar como Tira' },
    );

    setIsSaving(true);
    let maxW = 0;
    let maxH = 0;
    
    // First pass to determine cell dimensions
    const processedCanvases: HTMLCanvasElement[] = [];

    for (const s of sprites) {
      const canvas = renderSpriteToCanvas(s, true);
      maxW = Math.max(maxW, canvas.width);
      maxH = Math.max(maxH, canvas.height);
      processedCanvases.push(canvas);
    }

    const compiledCanvas = document.createElement('canvas');
    compiledCanvas.width = maxW * cols;
    compiledCanvas.height = maxH * rows;
    const ctx = compiledCanvas.getContext('2d')!;

    for (let i = 0; i < processedCanvases.length && i < rows * cols; i++) {
        const c = i % cols;
        const r = Math.floor(i / cols);
        const cellCanvas = processedCanvases[i];
        
        const dx = (c * maxW) + Math.floor((maxW - cellCanvas.width) / 2);
        const dy = (r * maxH) + Math.floor((maxH - cellCanvas.height) / 2);
        
        ctx.drawImage(cellCanvas, dx, dy);
        
        if (includeGrid) {
            ctx.strokeStyle = 'rgba(0,0,0,0.4)';
            ctx.lineWidth = 1;
            ctx.strokeRect(c * maxW + 0.5, r * maxH + 0.5, maxW - 1, maxH - 1);
        }
    }

    const blob = await new Promise<Blob | null>(resolve => compiledCanvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      setIsSaving(false);
      return;
    }

    try {
      await saveBlobToDisk(blob, 'spritesheet_export.png', [{ name: 'PNG Image', extensions: ['png'] }]);
    } catch (err) {
      console.error(err);
    }
    setIsSaving(false);
  };

  const spriteNameToPng = (name: string) => name.replace(/\.[^.]+$/i, '') + '.png';
  const spriteNameToJpg = (name: string) => name.replace(/\.[^.]+$/i, '') + '.jpg';

  const exportBatch = async (format: 'png' | 'jpg' | 'dds', destination: 'zip' | 'folder') => {
    if (sprites.length === 0) return;
    setBatchExportFormat(null);
    setIsSaving(true);
    try {
      const desktop = getDesktop();
      const zip = destination === 'zip' ? new JSZip() : null;
      let directory: FileSystemDirectoryHandle | null = null;
      let desktopFolder: DesktopFolder | null = null;

      if (destination === 'folder') {
        if (desktop) {
          // Mostrar siempre el navegador nativo. La carpeta recordada es solo
          // el punto de partida; el usuario confirma o cambia el destino.
          desktopFolder = await desktop.pickFolder();
          if (!desktopFolder) return;
          setWorkingFolder(desktopFolder);
        } else {
          if (!('showDirectoryPicker' in window)) {
            throw new Error('Este navegador no permite elegir carpetas. Usá la opción ZIP o abrí la herramienta en Chrome/Edge.');
          }
          directory = await (window as any).showDirectoryPicker({
            id: WORKING_PICKER_ID,
            mode: 'readwrite',
            startIn: dirHandle || undefined,
          });
          if (directory && await ensureHandlePermission(directory, 'readwrite')) {
            updateDirHandle(directory);
          }
        }
      }

      const desktopFiles: { name: string; data: ArrayBuffer }[] = [];

      for (const s of sprites) {
        const canvas = renderSpriteToCanvas(s, true);
        const fileName =
          format === 'dds' ? spriteNameToDds(s.name)
          : format === 'jpg' ? spriteNameToJpg(s.name)
          : spriteNameToPng(s.name);
        let content: Blob | ArrayBuffer;

        if (format === 'dds') {
          content = await canvasToBc7Dds(canvas);
        } else if (format === 'jpg') {
          const jpeg = await canvasToJpegBlob(canvas);
          if (!jpeg.size) throw new Error(`No se pudo generar ${fileName}.`);
          content = jpeg;
        } else {
          const png = await canvasToPngBlob(canvas);
          if (!png.size) throw new Error(`No se pudo generar ${fileName}.`);
          content = png;
        }

        if (zip) {
          zip.file(fileName, content);
        } else if (desktop && desktopFolder) {
          desktopFiles.push({
            name: fileName,
            data: content instanceof ArrayBuffer ? content : await arrayBufferFromBlob(content),
          });
        } else if (directory) {
          const fileHandle = await directory.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(content);
          await writable.close();
        }

        await new Promise((r) => setTimeout(r, 0));
      }

      if (desktop && desktopFolder && desktopFiles.length > 0) {
        await desktop.writeFilesToFolder(desktopFolder.path, desktopFiles);
      }

      if (zip) {
        const blob = await zip.generateAsync({ type: 'blob' });
        await saveBlobToDisk(
          blob,
          `joa_batch_${format}_${Date.now()}.zip`,
          [{ name: 'ZIP Archive', extensions: ['zip'] }]
        );
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Error al exportar ${format.toUpperCase()}:\n${msg}`);
    } finally {
      setIsSaving(false);
    }
  };

  const firstSelected = sprites.find(s => s.id === selection[0]);
  const selectedWithMask = sprites.filter(s => selection.includes(s.id) && hasActiveEffectMask(s));

  return (
    <div className={`layout${quadrantBoard ? ' is-quadrant-board' : ''}`}>
      {/* TOP BAR */}
      <header className="top-bar">
        <div className="logo-group">
          <h1 style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', rowGap: '6px' }}>
            <span style={{
              fontSize: '1.1rem',
              fontWeight: 800,
              background: 'linear-gradient(135deg, #fff, #888)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              marginRight: '4px',
            }}>
              JOA Engine
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginRight: '8px', fontWeight: 600 }}>SYNC v6</span>
            <label style={{ marginLeft: '8px', fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', cursor: 'pointer', fontWeight: 'normal', color: 'var(--text-muted)', userSelect: 'none' }}>
              <input type="checkbox" checked={showGridlines} onChange={(e) => setShowGridlines(e.target.checked)} style={{ marginRight: '6px', cursor: 'pointer' }} />
              Guías
            </label>
            <label
              style={{
                marginLeft: '12px',
                fontSize: '0.7rem',
                display: columnView ? 'none' : 'inline-flex',
                alignItems: 'center',
                cursor: 'pointer',
                fontWeight: 'normal',
                color: gridSplitActive ? 'var(--accent)' : 'var(--text-muted)',
                userSelect: 'none',
              }}
              title="Divide la grilla en dos. Con Separar activo, todo lo que importes va debajo de la línea."
            >
              <input type="checkbox" checked={gridSplitActive} onChange={(e) => setGridSplitActive(e.target.checked)} style={{ marginRight: '6px', cursor: 'pointer' }} />
              Separar
            </label>
            <label style={{ marginLeft: '12px', fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', cursor: 'pointer', fontWeight: 'normal', color: 'var(--text-muted)', userSelect: 'none' }}>
              <input type="checkbox" checked={isWhiteBg} onChange={(e) => setIsWhiteBg(e.target.checked)} style={{ marginRight: '6px', cursor: 'pointer' }} />
              Fondo Blanco
            </label>
            <span style={{ marginLeft: '12px', height: '20px', width: '1px', background: 'var(--border)', display: 'inline-block', flexShrink: 0 }} />
            <label style={{ marginLeft: '12px', fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: '8px', fontWeight: 'normal', color: 'var(--text-muted)', userSelect: 'none' }}>
              Visualización
              <input
                type="range"
                min={boardZoomMin}
                max={boardZoomMax}
                step={0.05}
                value={gridZoom}
                onChange={(e) => setGridZoom(parseFloat(e.target.value))}
                style={{ width: '90px', cursor: 'pointer' }}
                title={columnView
                  ? `${gridZoom.toFixed(2)}x — Shift + rueda sobre el tablero para zoom al cursor. Arrastrá el fondo para moverte.`
                  : `${gridZoom.toFixed(1)}x — Shift + rueda para zoom`}
              />
              <span style={{ minWidth: '2.2em', color: 'var(--text-main)', fontWeight: 600 }}>{gridZoom.toFixed(columnView ? 2 : 1)}x</span>
            </label>
            <button
              type="button"
              className={`btn-ghost ${columnView ? 'active' : ''}`}
              onClick={toggleColumnView}
              title="Tabla de comparación: columnas compartidas por las mismas filas"
              style={{
                marginLeft: '8px',
                width: 'auto',
                padding: '4px 8px',
                gap: '6px',
                fontSize: '0.7rem',
                fontWeight: 600,
                border: '1px solid var(--border)',
                borderColor: columnView ? 'var(--accent)' : undefined,
                color: columnView ? 'var(--accent)' : undefined,
              }}
            >
              <Columns2 size={14} />
              Columnas
            </button>
            {columnView && (
              <button
                type="button"
                className={`btn-ghost ${quadrantView ? 'active' : ''}`}
                onClick={() => {
                  setQuadrantView((v) => {
                    const next = !v;
                    if (next) setControlsVisible(false);
                    else setGridZoom((z) => Math.min(3, Math.max(0.25, z)));
                    return next;
                  });
                }}
                title="Oculta nombres, herramientas y paneles: solo cuadrantes alineados para comparar"
                style={{
                  marginLeft: '6px',
                  width: 'auto',
                  padding: '4px 8px',
                  gap: '6px',
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  border: '1px solid var(--border)',
                  borderColor: quadrantView ? 'var(--accent)' : undefined,
                  color: quadrantView ? 'var(--accent)' : undefined,
                }}
              >
                <Maximize2 size={14} />
                Cuadrantes
              </button>
            )}
            <label style={{ marginLeft: '10px', fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: '8px', fontWeight: 'normal', color: 'var(--text-muted)', userSelect: 'none' }} title="Tamaño del número de cada sprite">
              <Hash size={14} />
              Números
              <input
                type="range"
                min={COMPARE_NUMBER_SIZE_MIN}
                max={COMPARE_NUMBER_SIZE_MAX}
                step={1}
                value={compareNumberSize}
                onChange={(e) => setCompareNumberSize(parseInt(e.target.value, 10))}
                style={{ width: '90px', cursor: 'pointer' }}
              />
              <span style={{ minWidth: '2.4em', color: 'var(--text-main)', fontWeight: 600 }}>{compareNumberSize}px</span>
            </label>
            <button
              type="button"
              className={`btn-ghost ${controlsVisible ? 'active' : ''}`}
              onClick={() => setControlsVisible((v) => !v)}
              title={controlsVisible ? 'Contraer el panel de opciones' : 'Expandir el panel de opciones'}
              style={{
                marginLeft: '6px',
                width: 'auto',
                padding: '4px 8px',
                gap: '6px',
                fontSize: '0.7rem',
                fontWeight: 600,
                border: '1px solid var(--border)',
                borderColor: controlsVisible ? 'var(--accent)' : undefined,
                color: controlsVisible ? 'var(--accent)' : undefined,
              }}
            >
              {controlsVisible ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
              Opciones
            </button>
          </h1>
        </div>
        <div className="top-actions">
           <button className="btn btn-outline" onClick={() => setShowAnimationModal(true)}>
             <Film size={16} /> Probar Animación
           </button>
           <div style={{ height: '24px', width: '1px', background: 'var(--border)', margin: '0 2px', flexShrink: 0 }} />
           <button className="btn btn-outline" onClick={() => setSelection(sprites.map((s: SpriteData) => s.id))}>
             <CheckSquare size={16} /> Todos
           </button>
           <button className="btn btn-danger" onClick={() => { 
             const next = sprites.filter((s: SpriteData) => !selection.includes(s.id));
             commitSprites(next);
             setSelection([]); 
           }}>
             <Trash2 size={16} /> Eliminar
           </button>
           <div style={{ height: '24px', width: '1px', background: 'var(--border)', margin: '0 2px', flexShrink: 0 }} />
           <button className="btn btn-outline" onClick={openProjectPicker} disabled={isSaving} title="Abre un .joa o .zip con columnas e imágenes">
             <FolderOpen size={16} /> Abrir proyecto
           </button>
           <button className="btn btn-outline" onClick={saveProject} disabled={sprites.length === 0 || isSaving} title="Guarda sprites, columnas y originales en un solo archivo">
             <Save size={16} /> Guardar proyecto
           </button>
           <button className="btn btn-primary" onClick={openImportFiles}>
             <Plus size={16} /> Importar Lote
           </button>
           <button className="btn btn-primary" onClick={openSliceFile}>
             <Scissors size={16} /> Cortar Spritesheet
           </button>
           <button className="btn btn-outline" onClick={exportGridSpritesheet} disabled={sprites.length === 0}>
             <Grid size={16} /> Exportar como Tira
           </button>
           <input type="file" id="grid-up" hidden multiple accept="image/*" onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = ''; }} />
           <input type="file" id="cell-up" hidden accept="image/*" onChange={(e) => {
             const cell = cellImportTargetRef.current;
             cellImportTargetRef.current = null;
             if (e.target.files && cell) void handleFiles(e.target.files, cell);
             e.target.value = '';
           }} />
           <input type="file" id="slice-up" hidden accept="image/*" onChange={(e) => { if (e.target.files && e.target.files[0]) handleSliceFile(e.target.files[0]); e.target.value = ''; }} />
           <input type="file" id="project-up" hidden accept=".joa,.zip,application/zip" onChange={(e) => { if (e.target.files && e.target.files[0]) openProjectFile(e.target.files[0]); e.target.value = ''; }} />
           <div style={{ height: '24px', width: '1px', background: 'var(--border)', margin: '0 2px', flexShrink: 0 }} />
           <button className="btn btn-outline" onClick={() => setBatchExportFormat('png')} disabled={sprites.length === 0 || isSaving}>
             <Archive size={16} /> Exportar PNG
           </button>
           <button className="btn btn-outline" onClick={() => setBatchExportFormat('jpg')} disabled={sprites.length === 0 || isSaving}>
             <Archive size={16} /> Exportar JPG
           </button>
           <button className="btn btn-outline" onClick={() => setBatchExportFormat('dds')} disabled={sprites.length === 0 || isSaving} title="Exporta BC7 DDS reales con mipmaps completos, alfa straight y recorte de verde del juego">
             <Layers size={16} /> {isSaving ? 'Exportando…' : 'Exportar DDS'}
           </button>
        </div>
      </header>

      <div className="main-content"
        onMouseMove={(e) => {
          if (draggingIndex !== null) {
            const container = document.querySelector('.grid-container');
            if (container) {
              const rect = container.getBoundingClientRect();
              const scroll = container.scrollTop;
              const newY = e.clientY - rect.top + scroll;
              setHighlightedYs(prev => prev.map((y, i) => i === draggingIndex ? newY : y));
            }
          }
        }}
        onMouseUp={() => setDraggingIndex(null)}
        onMouseLeave={() => setDraggingIndex(null)}
      >
        {showGridlines && (
          <div className="left-ruler" onClick={(e) => {
            if (draggingIndex !== null) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const container = document.querySelector('.grid-container');
            const scroll = container?.scrollTop || 0;
            const newY = e.clientY - rect.top + scroll;
            setHighlightedYs(prev => [...prev, newY]);
          }}>
            {/* Tick marks every 50px */}
            {Array.from({ length: 100 }).map((_, i) => (
              <div key={i} className="ruler-tick" style={{ top: i * 50 }}>
                <span>{i * 50}</span>
              </div>
            ))}
          </div>
        )}
        <div
          ref={columnViewportRef}
          className={`grid-container${columnView ? ' column-board-viewport' : ''}${columnPanning ? ' is-panning' : ''}`}
          style={{ position: 'relative', flex: 1, '--compare-num-size': `${compareNumberSize}px` } as React.CSSProperties}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            if (draggedSpriteId) return;
            e.preventDefault();
            handleDroppedFiles(e.dataTransfer.files);
          }}
          onPointerDown={(e) => {
            if (!columnView || e.button !== 0 || draggedSpriteId || isResizingRowLabels) return;
            if (!isColumnPanTarget(e.target)) return;
            const el = columnViewportRef.current;
            if (!el) return;
            columnPanRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
            setColumnPanning(true);
            el.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const pan = columnPanRef.current;
            const el = columnViewportRef.current;
            if (!pan || !el) return;
            el.scrollLeft = pan.sl - (e.clientX - pan.x);
            el.scrollTop = pan.st - (e.clientY - pan.y);
          }}
          onPointerUp={() => {
            columnPanRef.current = null;
            setColumnPanning(false);
          }}
          onPointerCancel={() => {
            columnPanRef.current = null;
            setColumnPanning(false);
          }}
        >
          {showGridlines && <div className="grid-overlay" />}
          {showGridlines && highlightedYs.map((y, idx) => (
            <div key={idx} className="active-guide-line" style={{ top: y }} 
              onMouseDown={(e) => { e.stopPropagation(); setDraggingIndex(idx); }}
              onDoubleClick={() => setHighlightedYs(prev => prev.filter((_, i) => i !== idx))}
              title="Doble clic para quitar, arrastrar para mover" 
            />
          ))}
          {sprites.length === 0 ? (
            <div className="empty-state">
               <label className="dropzone-full" style={{ background: 'rgba(107, 102, 255, 0.02)' }}>
                  <FolderSync size={48} color="#6b66ff" />
                  <h2 style={{ marginTop: '16px' }}>Sincronización Directa de Archivos</h2>
                  <p>Carga tus sprites y reemplaza los originales en tu disco con un solo clic.</p>
                  <p style={{ marginTop: '8px', opacity: 0.75 }}>También podés abrir un proyecto .joa para recuperar columnas e imágenes.</p>
               </label>
            </div>
          ) : columnView ? (
            <div
              className="column-board-sizer"
              style={{
                '--sprite-col-w': `${Math.max(quadrantBoard ? 56 : 180, 280 * gridZoom)}px`,
                '--sprite-row-label-w': `${rowLabelsCollapsed ? ROW_LABEL_WIDTH_COLLAPSED : rowLabelWidth}px`,
              } as React.CSSProperties}
            >
              <div className="column-board-layout">
                {(() => {
                  const col = ungroupedColumn;
                  const ungroupedCollapsed = isColumnCollapsed(col.id);
                  const ungroupedCount = sprites.filter((s) => getSpriteColumnId(s) === col.id).length;
                  return (
                    <aside className={`ungrouped-rail${ungroupedCollapsed ? ' is-collapsed' : ''}`}>
                      <div className={`sprite-column-header column-board-head ungrouped-rail-head${ungroupedCollapsed ? ' is-collapsed' : ''}`}>
                        <button
                          type="button"
                          className="btn-ghost collapse-toggle"
                          title={ungroupedCollapsed ? 'Expandir Sin grupo' : 'Contraer Sin grupo'}
                          onClick={() => toggleColumnCollapsed(col.id)}
                        >
                          {ungroupedCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        </button>
                        <span className="sprite-column-title">{col.name}</span>
                        <span className="sprite-column-count">{ungroupedCount}</span>
                      </div>
                      {!ungroupedCollapsed && (
                        <div className="ungrouped-rail-body">
                          {spriteRows.map((row) => {
                            const cellSprites = sprites.filter(
                              (s) => getSpriteColumnId(s) === col.id && getSpriteRowId(s) === row.id
                            );
                            const key = compareCellKey(col.id, row.id);
                            const rowCollapsed = isRowCollapsed(row.id);
                            if (rowCollapsed && cellSprites.length === 0) return null;
                            return (
                              <div key={`ug-${row.id}`} className="ungrouped-rail-section">
                                {spriteRows.length > 1 && (
                                  <div className="ungrouped-rail-row-caption">
                                    {row.name}{cellSprites.length > 0 ? ` · ${cellSprites.length}` : ''}
                                  </div>
                                )}
                                <div
                                  data-sprite-cell=""
                                  data-column-id={col.id}
                                  data-row-id={row.id}
                                  className={`sprite-cell is-ungrouped${cellSprites.length === 0 ? ' is-empty' : ''}${cellDragOverKey === key ? ' drag-over' : ''}${rowCollapsed ? ' is-collapsed-row' : ''}`}
                                  onDragOver={(e) => {
                                    if (!draggedSpriteId && !Array.from(e.dataTransfer.types).includes('Files')) return;
                                    e.preventDefault();
                                    e.stopPropagation();
                                    e.dataTransfer.dropEffect = draggedSpriteId ? 'move' : 'copy';
                                    setCellDragOverKey(key);
                                  }}
                                  onDragLeave={(e) => {
                                    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                                    setCellDragOverKey((k) => (k === key ? null : k));
                                  }}
                                  onDrop={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (draggedSpriteId) {
                                      moveSpriteToCell(draggedSpriteId, col.id, row.id);
                                    } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                      void handleFiles(e.dataTransfer.files, { columnId: col.id, rowId: row.id });
                                    }
                                    setDraggedSpriteId(null);
                                    setCellDragOverKey(null);
                                  }}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (rowCollapsed || cellSprites.length > 0 || quadrantPicking) return;
                                    setEmptyCellMenu({
                                      x: Math.max(8, Math.min(e.clientX, window.innerWidth - 200)),
                                      y: Math.max(8, Math.min(e.clientY, window.innerHeight - 80)),
                                      columnId: col.id,
                                      rowId: row.id,
                                    });
                                  }}
                                >
                                  {!rowCollapsed && cellSprites.map((s) => renderSpriteCard(s, col.id, row.id))}
                                  {rowCollapsed && cellSprites.length > 0 && (
                                    <div className="sprite-cell-hint">{cellSprites.length}</div>
                                  )}
                                  {!rowCollapsed && cellSprites.length === 0 && draggedSpriteId && (
                                    <div className="sprite-cell-hint">Soltá acá</div>
                                  )}
                                  {!rowCollapsed && cellSprites.length === 0 && !draggedSpriteId && !quadrantPicking && (
                                    <button
                                      type="button"
                                      className="sprite-cell-import"
                                      title="Importar sprite a Sin grupo"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void importIntoCell(col.id, row.id);
                                      }}
                                    >
                                      <Plus size={18} />
                                      <span>Importar</span>
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </aside>
                  );
                })()}
              <div
                ref={columnBoardRef}
                className={`column-board${rowLabelsCollapsed ? ' is-gutter-collapsed' : ''}${isResizingRowLabels ? ' is-resizing-labels' : ''}${quadrantBoard ? ' is-quadrant' : ''}`}
                style={{
                  '--sprite-col-w': `${Math.max(quadrantBoard ? 56 : 180, 280 * gridZoom)}px`,
                  '--sprite-row-label-w': `${rowLabelsCollapsed ? ROW_LABEL_WIDTH_COLLAPSED : rowLabelWidth}px`,
                  gridTemplateColumns: `${rowLabelsCollapsed ? ROW_LABEL_WIDTH_COLLAPSED : rowLabelWidth}px ${boardSpriteColumns.map((c) => isColumnCollapsed(c.id) ? '42px' : 'var(--sprite-col-w)').join(' ')}${quadrantBoard ? '' : ' min-content'}`,
                } as React.CSSProperties}
              >
                <div className={`column-board-corner${rowLabelsCollapsed ? ' is-gutter-collapsed' : ''}`}>
                  <button
                    type="button"
                    className="btn-ghost collapse-toggle"
                    title={rowLabelsCollapsed ? 'Expandir nombres de filas' : 'Contraer nombres de filas'}
                    onClick={() => setRowLabelsCollapsed((v) => !v)}
                  >
                    {rowLabelsCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
                  </button>
                  {!rowLabelsCollapsed && (
                    <>
                      <button
                        type="button"
                        className="btn-ghost collapse-toggle"
                        title={allColumnsCollapsed ? 'Expandir todas las columnas' : 'Contraer todas las columnas'}
                        onClick={() => setCollapsedColumnIds(allColumnsCollapsed ? [] : boardSpriteColumns.map((c) => c.id))}
                      >
                        <Columns2 size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn-ghost collapse-toggle"
                        title={allRowsCollapsed ? 'Expandir todas las filas' : 'Contraer todas las filas'}
                        onClick={() => setCollapsedRowIds(allRowsCollapsed ? [] : spriteRows.map((r) => r.id))}
                      >
                        <Rows3 size={14} />
                      </button>
                    </>
                  )}
                  {renderRowLabelResizeHandle()}
                </div>
                {boardSpriteColumns.map((col) => {
                  const isDefault = col.id === DEFAULT_SPRITE_COLUMN_ID;
                  const count = sprites.filter((s) => getSpriteColumnId(s) === col.id).length;
                  const colCollapsed = isColumnCollapsed(col.id);
                  return (
                    <div
                      key={`head-${col.id}`}
                      className={`sprite-column-header column-board-head${columnDragOverId === col.id ? ' drag-over' : ''}${colCollapsed ? ' is-collapsed' : ''}`}
                      draggable={!isDefault}
                      title={isDefault ? undefined : 'Arrastrá para reordenar columnas'}
                      onDragStart={(e) => {
                        if (isDefault) return;
                        if ((e.target as HTMLElement).closest('input, button')) {
                          e.preventDefault();
                          return;
                        }
                        setDraggedColumnId(col.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragOver={(e) => {
                        if (!draggedColumnId) return;
                        e.preventDefault();
                        e.stopPropagation();
                        e.dataTransfer.dropEffect = 'move';
                        setColumnDragOverId(col.id);
                      }}
                      onDragLeave={(e) => {
                        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                        setColumnDragOverId((id) => (id === col.id ? null : id));
                      }}
                      onDrop={(e) => {
                        if (!draggedColumnId) return;
                        e.preventDefault();
                        e.stopPropagation();
                        moveColumn(draggedColumnId, col.id);
                        setDraggedColumnId(null);
                        setColumnDragOverId(null);
                      }}
                      onDragEnd={() => {
                        setDraggedColumnId(null);
                        setColumnDragOverId(null);
                      }}
                    >
                      <button
                        type="button"
                        className="btn-ghost collapse-toggle"
                        title={colCollapsed ? 'Expandir columna' : 'Contraer columna'}
                        onClick={() => toggleColumnCollapsed(col.id)}
                      >
                        {colCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      </button>
                      {colCollapsed || isDefault ? (
                        <span className="sprite-column-title">{col.name}</span>
                      ) : (
                        <input
                          value={col.name}
                          onChange={(e) => renameSpriteColumn(col.id, e.target.value)}
                          onPointerDown={(e) => e.stopPropagation()}
                          draggable={false}
                        />
                      )}
                      <span className="sprite-column-count">{count}</span>
                      {!isDefault && !colCollapsed && (
                        <button
                          type="button"
                          className="btn-ghost"
                          title="Borrar columna (los sprites vuelven a Sin grupo)"
                          onClick={() => removeSpriteColumn(col.id)}
                          style={{ width: 28, height: 28, color: '#ff6b6b' }}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
                {!quadrantBoard && (
                <button type="button" className="sprite-column-add is-header" onClick={addSpriteColumn}>
                  <Plus size={16} />
                  Nueva columna
                </button>
                )}

                {spriteRows.map((row) => {
                  const isDefaultRow = row.id === DEFAULT_SPRITE_ROW_ID;
                  const rowCount = sprites.filter((s) => getSpriteRowId(s) === row.id).length;
                  const rowCollapsed = isRowCollapsed(row.id);
                  return (
                    <React.Fragment key={row.id}>
                      <div
                        className={`column-row-label${rowDragOverId === row.id ? ' drag-over' : ''}${rowCollapsed ? ' is-collapsed' : ''}${rowLabelsCollapsed ? ' is-gutter-collapsed' : ''}`}
                        draggable={!isDefaultRow}
                        title={isDefaultRow ? undefined : 'Arrastrá para reordenar filas'}
                        onDragStart={(e) => {
                          if (isDefaultRow) return;
                          if ((e.target as HTMLElement).closest('input, button')) {
                            e.preventDefault();
                            return;
                          }
                          setDraggedRowId(row.id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragOver={(e) => {
                          if (!draggedRowId) return;
                          e.preventDefault();
                          e.stopPropagation();
                          e.dataTransfer.dropEffect = 'move';
                          setRowDragOverId(row.id);
                        }}
                        onDragLeave={(e) => {
                          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                          setRowDragOverId((id) => (id === row.id ? null : id));
                        }}
                        onDrop={(e) => {
                          if (!draggedRowId) return;
                          e.preventDefault();
                          e.stopPropagation();
                          moveRow(draggedRowId, row.id);
                          setDraggedRowId(null);
                          setRowDragOverId(null);
                        }}
                        onDragEnd={() => {
                          setDraggedRowId(null);
                          setRowDragOverId(null);
                        }}
                      >
                        <button
                          type="button"
                          className="btn-ghost collapse-toggle"
                          title={rowCollapsed ? 'Expandir fila' : 'Contraer fila'}
                          onClick={() => toggleRowCollapsed(row.id)}
                        >
                          {rowCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        </button>
                        {rowLabelsCollapsed ? null : rowCollapsed ? (
                          <span className="sprite-column-title">{row.name}</span>
                        ) : (
                          <input
                            value={row.name}
                            onChange={(e) => renameSpriteRow(row.id, e.target.value)}
                            onPointerDown={(e) => e.stopPropagation()}
                            draggable={false}
                          />
                        )}
                        {!rowLabelsCollapsed && <span className="sprite-column-count">{rowCount}</span>}
                        {!isDefaultRow && !rowCollapsed && !rowLabelsCollapsed && (
                          <button
                            type="button"
                            className="btn-ghost"
                            title="Borrar fila (los sprites vuelven a Sin fila)"
                            onClick={() => removeSpriteRow(row.id)}
                            style={{ width: 28, height: 28, color: '#ff6b6b' }}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                        {renderRowLabelResizeHandle()}
                      </div>
                      {boardSpriteColumns.map((col) => {
                        const cellSprites = sprites.filter(
                          (s) => getSpriteColumnId(s) === col.id && getSpriteRowId(s) === row.id
                        );
                        const key = compareCellKey(col.id, row.id);
                        const colCollapsed = isColumnCollapsed(col.id);
                        const cellCollapsed = rowCollapsed || colCollapsed;
                        return (
                          <div
                            key={key}
                            data-sprite-cell=""
                            data-column-id={col.id}
                            data-row-id={row.id}
                            className={`sprite-cell${cellSprites.length === 0 ? ' is-empty' : ''}${cellDragOverKey === key ? ' drag-over' : ''}${rowDragOverId === row.id ? ' row-active' : ''}${rowCollapsed ? ' is-collapsed-row' : ''}${colCollapsed ? ' is-collapsed-col' : ''}`}
                            onDragOver={(e) => {
                              if (!draggedSpriteId && !Array.from(e.dataTransfer.types).includes('Files')) return;
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = draggedSpriteId ? 'move' : 'copy';
                              setCellDragOverKey(key);
                            }}
                            onDragLeave={(e) => {
                              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                              setCellDragOverKey((k) => (k === key ? null : k));
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (draggedSpriteId) {
                                moveSpriteToCell(draggedSpriteId, col.id, row.id);
                              } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                void handleFiles(e.dataTransfer.files, { columnId: col.id, rowId: row.id });
                              }
                              setDraggedSpriteId(null);
                              setCellDragOverKey(null);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (cellCollapsed || cellSprites.length > 0 || quadrantPicking) return;
                              setEmptyCellMenu({
                                x: Math.max(8, Math.min(e.clientX, window.innerWidth - 200)),
                                y: Math.max(8, Math.min(e.clientY, window.innerHeight - 80)),
                                columnId: col.id,
                                rowId: row.id,
                              });
                            }}
                          >
                            {!cellCollapsed && cellSprites.map((s) => renderSpriteCard(s, col.id, row.id))}
                            {cellCollapsed && cellSprites.length > 0 && (
                              <div className="sprite-cell-hint">{cellSprites.length}</div>
                            )}
                            {!cellCollapsed && cellSprites.length === 0 && draggedSpriteId && (
                              <div className="sprite-cell-hint">Soltá acá</div>
                            )}
                            {!cellCollapsed && cellSprites.length === 0 && !draggedSpriteId && !quadrantPicking && (
                              <button
                                type="button"
                                className="sprite-cell-import"
                                title="Importar sprite a este cuadrante"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void importIntoCell(col.id, row.id);
                                }}
                              >
                                <Plus size={18} />
                                <span>Importar</span>
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {!quadrantBoard && <div className={`column-board-row-end${rowCollapsed ? ' is-collapsed-row' : ''}`} />}
                    </React.Fragment>
                  );
                })}

                {!quadrantBoard && (
                  <button type="button" className="column-row-add" onClick={addSpriteRow}>
                    <Rows3 size={18} />
                    Nueva fila
                  </button>
                )}
              </div>
              </div>
            </div>
          ) : (
            (() => {
              const gridCols = { gridTemplateColumns: `repeat(auto-fill, minmax(${280 * gridZoom}px, 1fr))` } as React.CSSProperties;
              if (!gridSplitActive) {
                return (
                  <div className="sprite-grid" style={gridCols}>
                    {sprites.map((s: SpriteData) => renderSpriteCard(s))}
                  </div>
                );
              }
              const upperSprites = sprites.filter((s) => !s.belowSplit);
              const lowerSprites = sprites.filter((s) => !!s.belowSplit);
              return (
                <div className="sprite-grid-split">
                  <div
                    className={`sprite-grid${splitDragOverBand === 'upper' ? ' split-drag-over' : ''}`}
                    style={gridCols}
                    data-split-zone="upper"
                  >
                    {upperSprites.length === 0 ? (
                      <div className="sprite-grid-split-empty">
                        Soltá sprites acá (grupo superior)
                      </div>
                    ) : (
                      upperSprites.map((s: SpriteData) => renderSpriteCard(s, undefined, undefined, 'upper'))
                    )}
                  </div>
                  <div className="sprite-grid-split-bar" role="separator" aria-label="Separador de grupos">
                    <span className="sprite-grid-split-bar-line" />
                    <span className="sprite-grid-split-bar-label">Grupo inferior · nuevas importaciones</span>
                    <span className="sprite-grid-split-bar-line" />
                  </div>
                  <div
                    className={`sprite-grid sprite-grid-lower${splitDragOverBand === 'lower' ? ' split-drag-over' : ''}`}
                    style={gridCols}
                    data-split-zone="lower"
                  >
                    {lowerSprites.length === 0 ? (
                      <div className="sprite-grid-split-empty">
                        Soltá sprites acá · también van las nuevas importaciones
                      </div>
                    ) : (
                      lowerSprites.map((s: SpriteData) => renderSpriteCard(s, undefined, undefined, 'lower'))
                    )}
                  </div>
                </div>
              );
            })()
          )}
        </div>

        {/* RIGHT CONTROLS */}
        <aside
          className={`controls-panel${controlsVisible ? '' : ' is-collapsed'}${isResizingControls ? ' is-resizing' : ''}`}
          style={{ '--controls-width': `${controlsWidth}px`, width: controlsVisible ? controlsWidth : 40, cursor: controlsVisible ? undefined : 'pointer' } as React.CSSProperties}
          aria-expanded={controlsVisible}
          onClick={() => { if (!controlsVisible) setControlsVisible(true); }}
        >
          <div
            className="controls-resize-handle"
            title="Arrastrar para cambiar el ancho · Doble clic para restablecer"
            onMouseDown={(e) => {
              e.preventDefault();
              controlsResizeRef.current = { startX: e.clientX, startWidth: controlsWidth };
              setIsResizingControls(true);
            }}
            onDoubleClick={() => setControlsWidth(CONTROLS_DEFAULT)}
          />
          <div className="controls-panel-header">
            <span>Opciones</span>
            <button
              type="button"
              className="controls-collapse-btn"
              title={controlsVisible ? 'Contraer panel' : 'Expandir panel'}
              onClick={() => setControlsVisible((v) => !v)}
            >
              {controlsVisible ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              {controlsVisible ? 'Contraer' : null}
            </button>
          </div>
          <div className="card">
            <span className="card-title">Áreas de Efecto</span>
            <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.4 }}>
              Define una o más zonas del sprite. Los ajustes del panel solo se aplican dentro de esas áreas, y únicamente sobre píxeles con dibujo (se ignoran los vacíos).
            </p>
            {selectedWithMask.length > 0 && (
              <div style={{ fontSize: '0.65rem', color: '#6b66ff', marginBottom: '8px', textAlign: 'center' }}>
                {selectedWithMask.length} sprite(s) con áreas activas
              </div>
            )}
            <button
              className="btn btn-primary"
              style={{ width: '100%', marginBottom: '8px' }}
              disabled={selection.length === 0}
              onClick={() => {
                if (selection.length === 0) return;
                setEffectMaskTargetId(selection[0]);
              }}
            >
              <Crop size={16} /> Seleccionar Áreas
            </button>
            <button
              className="btn btn-outline"
              style={{ width: '100%' }}
              disabled={selection.length === 0}
              onClick={() => {
                const next = sprites.map(s =>
                  selection.includes(s.id) ? { ...s, effectMasks: [], effectMaskBrush: null, effectMaskMode: 'rect' as const } : s
                );
                commitSprites(next);
              }}
            >
              Quitar Áreas (Seleccionados)
            </button>
          </div>

          <div className="card">
            <span className="card-title">Sincronización Local</span>
            <div className="sync-indicator">
               <div className={`sync-dot ${hasLinkedFolder ? 'active' : ''}`} />
               <span>{hasLinkedFolder ? `Sincronizado: ${linkedFolderName}` : 'Sin carpeta seleccionada'}</span>
            </div>
            {!hasLinkedFolder ? (
              <button className="btn btn-outline" style={{ width: '100%' }} onClick={selectDirectory}>
                <FolderSync size={16} /> Vincular Carpeta
              </button>
            ) : (
              <>
                <button className="btn btn-danger" style={{ width: '100%' }} onClick={overwriteAll} disabled={isSaving || sprites.length === 0}>
                  {isSaving ? 'Guardando...' : <><Save size={16} /> Sobrescribir Originales</>}
                </button>
                <button className="btn btn-outline" style={{ width: '100%', marginTop: '8px' }} onClick={selectDirectory} disabled={isSaving}>
                  <FolderSync size={16} /> Cambiar Carpeta
                </button>
              </>
            )}
            {hasLinkedFolder && (
              <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '8px', textAlign: 'center' }}>
                <AlertTriangle size={10} style={{ marginRight: '4px' }} /> 
                Guarda PNG en la carpeta. Si el original era JPG, se crea un .png (el .jpg no se borra).
              </p>
            )}
          </div>

          <div className="card">
            <span className="card-title">Alineación por Ancla</span>
            <div className="alignment-grid">
               {(['top', 'bottom', 'left', 'right'] as const).map(side => (
                 <div key={side} className="slider-item">
                    <span style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{side}</span>
                     <input type="number" className="input-small" style={{ width: '100%' }}
                      value={targets[side]} onChange={(e) => setTargets({...targets, [side]: parseInt(e.target.value) || 0})} 
                    />
                 </div>
               ))}
            </div>
            <button className="btn btn-primary" style={{ marginTop: '16px', width: '100%' }} onClick={applyAlignment} disabled={selection.length === 0}>
               <Target size={16} /> Aplicar Alineación
            </button>
            <button className="btn btn-outline" style={{ marginTop: '8px', width: '100%' }} onClick={autoMaximizeInternal} disabled={selection.length === 0}>
               <Maximize size={16} /> Auto-Maximizar a los Márgenes
            </button>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button
                className="btn btn-outline"
                style={{ flex: 1, minWidth: 0, fontSize: '0.7rem', padding: '8px 6px', whiteSpace: 'normal', lineHeight: 1.25 }}
                onClick={() => removeBackgroundBulk('smart')}
                disabled={selection.length === 0}
                title="Solo negro conectado al borde del canvas (no toca huecos cerrados)"
              >
                <Eraser size={14} /> Fondo Negro Inteligente
              </button>
              <button
                className="btn btn-outline"
                style={{ flex: 1, minWidth: 0, fontSize: '0.7rem', padding: '8px 6px', whiteSpace: 'normal', lineHeight: 1.25 }}
                onClick={() => removeBackgroundBulk('precise')}
                disabled={selection.length === 0}
                title="Borra todo píxel negro bajo la tolerancia, aunque esté rodeado de otros colores"
              >
                <Eraser size={14} /> Negro Preciso
              </button>
            </div>
            <button
              className="btn btn-outline"
              style={{ marginTop: '8px', width: '100%', fontSize: '0.72rem', whiteSpace: 'normal', lineHeight: 1.25 }}
              onClick={removeTextBulk}
              disabled={selection.length === 0}
              title="Detecta watermarks y etiquetas de texto separadas del sprite (bandas superior/inferior, blanco/negro/gris)"
            >
              <Type size={14} /> Quitar Letras Inteligente
            </button>
            <button className="btn btn-outline" style={{ marginTop: '8px', width: '100%' }} onClick={flipHorizontalBulk} disabled={selection.length === 0}>
               <FlipHorizontal size={16} /> Voltear Horizontalmente
            </button>
            <button className="btn btn-outline" style={{ marginTop: '8px', width: '100%', borderColor: referenceId ? '#ffcc00' : undefined, color: referenceId ? '#ffcc00' : undefined }} 
              onClick={applyReferenceScale} disabled={!referenceId || selection.length === 0}>
               <FolderSync size={16} /> Igualar Resolución
            </button>
            <button className="btn btn-outline" style={{ marginTop: '8px', width: '100%', borderColor: referenceId ? '#ffcc00' : undefined, color: referenceId ? '#ffcc00' : undefined }} 
              onClick={applyReferenceFrame} disabled={!referenceId || selection.length === 0}>
               <Maximize size={16} /> Igualar Envase (Por Margen)
            </button>
            <button className="btn btn-outline" style={{ marginTop: '8px', width: '100%', borderColor: referenceId ? '#ffcc00' : undefined, color: referenceId ? '#ffcc00' : undefined }} 
              onClick={applyReferenceAlignment} disabled={!referenceId || selection.length === 0}>
               <Save size={16} /> Alinear por Referencia
            </button>

            <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
              <span className="card-title" style={{ display: 'block', marginBottom: '6px' }}>Recolocar contenido</span>
              <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '10px', lineHeight: 1.4 }}>
                Desplaza el dibujo de los seleccionados dentro del envase (arriba/abajo/izquierda/derecha) sin cambiar la resolución Full.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 34px)',
                    gridTemplateRows: 'repeat(3, 34px)',
                    gap: '4px',
                    justifyItems: 'center',
                    alignItems: 'center',
                  }}
                >
                  <span />
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ width: '34px', height: '34px', padding: 0 }}
                    title="Subir contenido"
                    disabled={selection.length === 0}
                    onClick={() => nudgeSelectedContent(0, -contentNudgeStep)}
                  >
                    <ArrowUp size={16} />
                  </button>
                  <span />
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ width: '34px', height: '34px', padding: 0 }}
                    title="Mover a la izquierda"
                    disabled={selection.length === 0}
                    onClick={() => nudgeSelectedContent(-contentNudgeStep, 0)}
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>px</span>
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ width: '34px', height: '34px', padding: 0 }}
                    title="Mover a la derecha"
                    disabled={selection.length === 0}
                    onClick={() => nudgeSelectedContent(contentNudgeStep, 0)}
                  >
                    <ArrowRight size={16} />
                  </button>
                  <span />
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ width: '34px', height: '34px', padding: 0 }}
                    title="Bajar contenido"
                    disabled={selection.length === 0}
                    onClick={() => nudgeSelectedContent(0, contentNudgeStep)}
                  >
                    <ArrowDown size={16} />
                  </button>
                  <span />
                </div>
                <div style={{ flex: 1 }}>
                  <div className="slider-label" style={{ marginBottom: '4px' }}>
                    <span>Paso</span>
                    <span>{contentNudgeStep}px</span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    max={512}
                    className="input-small"
                    style={{ width: '100%' }}
                    value={contentNudgeStep}
                    disabled={selection.length === 0}
                    onChange={(e) => setContentNudgeStep(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <span className="card-title">Ajuste Dinámico - Dimensiones</span>
            <div className="slider-group">
              <div className="slider-item">
                <div className="slider-label"><span>Escala</span><span>{firstSelected ? (firstSelected.scale || 1).toFixed(2) : 1}x</span></div>
                <input type="range" min="0.1" max="4" step="0.01" value={firstSelected ? (firstSelected.scale || 1) : 1}
                  onChange={(e) => updateBulkScale(parseFloat(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
                <div className="slider-item" style={{ marginBottom: 0 }}>
                  <div className="slider-label"><span>Ancho (px)</span></div>
                  <input
                    id="joa-res-width"
                    type="number"
                    step="1"
                    style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', color: 'white', padding: '4px', borderRadius: '4px' }}
                    value={firstSelected ? Math.round(firstSelected.img.width * (firstSelected.scale || 1)) : 0}
                    onChange={(e) => updateBulkWidth(parseInt(e.target.value) || 0)} disabled={selection.length === 0}
                  />
                </div>
                <div className="slider-item" style={{ marginBottom: 0 }}>
                  <div className="slider-label"><span>Alto (px)</span></div>
                  <input type="number" step="1" style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', color: 'white', padding: '4px', borderRadius: '4px' }}
                    value={firstSelected ? Math.round(firstSelected.img.height * (firstSelected.scale || 1) * (firstSelected.stretchY || 1)) : 0}
                    onChange={(e) => updateBulkHeight(parseInt(e.target.value) || 0)} disabled={selection.length === 0}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div className="slider-item">
                  <div className="slider-label"><span>Estirar H</span><span>{firstSelected ? (firstSelected.stretchX || 1).toFixed(2) : '1.00'}x</span></div>
                  <input type="range" min="0.1" max="4" step="0.01" value={firstSelected ? (firstSelected.stretchX || 1) : 1}
                    onChange={(e) => updateBulkStretchX(parseFloat(e.target.value))} disabled={selection.length === 0}
                  />
                </div>
                <div className="slider-item">
                  <div className="slider-label"><span>Estirar V</span><span>{firstSelected ? (firstSelected.stretchY || 1).toFixed(2) : '1.00'}x</span></div>
                  <input type="range" min="0.1" max="4" step="0.01" value={firstSelected ? (firstSelected.stretchY || 1) : 1}
                    onChange={(e) => updateBulkStretchY(parseFloat(e.target.value))} disabled={selection.length === 0}
                  />
                </div>
              </div>
              {(['top', 'right', 'bottom', 'left'] as const).map(side => (
                <div key={side} className="slider-item">
                  <div className="slider-label"><span>{side}</span><span>{firstSelected ? firstSelected.padding[side] : 0}px</span></div>
                  <input type="range" min="-1000" max="1000" value={firstSelected ? firstSelected.padding[side] : 0}
                    onChange={(e) => updateBulkPadding(side, parseInt(e.target.value))} disabled={selection.length === 0}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <span className="card-title">Ajuste Dinámico - Escala Interna (Conserva Envase)</span>
            <div className="slider-group">
              <div className="slider-item">
                <div className="slider-label"><span>Escala Interna</span><span>{firstSelected ? (firstSelected.scale || 1).toFixed(2) : 1}x</span></div>
                <input type="range" min="0.1" max="4" step="0.01" value={firstSelected ? (firstSelected.scale || 1) : 1}
                  onChange={(e) => updateBulkInternalScale(parseFloat(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
                <div className="slider-item" style={{ marginBottom: 0 }}>
                  <div className="slider-label"><span>Ancho Interno (px)</span></div>
                  <input type="number" step="1" style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', color: 'white', padding: '4px', borderRadius: '4px' }}
                    value={firstSelected ? Math.round(firstSelected.img.width * (firstSelected.scale || 1) * (firstSelected.stretchX || 1)) : 0}
                    onChange={(e) => updateBulkInternalWidth(parseInt(e.target.value) || 0)} disabled={selection.length === 0}
                  />
                </div>
                <div className="slider-item" style={{ marginBottom: 0 }}>
                  <div className="slider-label"><span>Alto Interno (px)</span></div>
                  <input type="number" step="1" style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', color: 'white', padding: '4px', borderRadius: '4px' }}
                    value={firstSelected ? Math.round(firstSelected.img.height * (firstSelected.scale || 1) * (firstSelected.stretchY || 1)) : 0}
                    onChange={(e) => updateBulkInternalHeight(parseInt(e.target.value) || 0)} disabled={selection.length === 0}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <span className="card-title">Ajuste Dinámico - Efectos</span>
            <div className="slider-group">
              <div className="slider-item">
                <div className="slider-label"><span>Pixelación</span><span>{firstSelected ? (firstSelected.pixelation || 1) : 1}px</span></div>
                <input type="range" min="1" max="100" value={firstSelected ? (firstSelected.pixelation || 1) : 1}
                  onChange={(e) => updateBulkPixelation(parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Dibujo a Mano</span><span>{firstSelected ? (firstSelected.handDrawn ?? 0) : 0}%</span></div>
                <input type="range" min="0" max="100" value={firstSelected ? (firstSelected.handDrawn ?? 0) : 0}
                  onChange={(e) => updateBulkFilter('handDrawn', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Dibujo a Lápiz</span><span>{firstSelected ? (firstSelected.pencilDrawn ?? 0) : 0}%</span></div>
                <input type="range" min="0" max="100" value={firstSelected ? (firstSelected.pencilDrawn ?? 0) : 0}
                  onChange={(e) => updateBulkFilter('pencilDrawn', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Profundidad (Bits)</span><span>{firstSelected && firstSelected.posterize && firstSelected.posterize > 0 ? `${firstSelected.posterize} niveles` : 'Off'}</span></div>
                <input type="range" min="0" max="64" value={firstSelected ? (firstSelected.posterize || 0) : 0}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    updateBulkFilter('posterize', val === 0 ? undefined : val);
                  }} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Brillo</span><span>{firstSelected ? (firstSelected.brightness ?? 100) : 100}%</span></div>
                <input type="range" min="0" max="200" value={firstSelected ? (firstSelected.brightness ?? 100) : 100}
                  onChange={(e) => updateBulkFilter('brightness', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Contraste</span><span>{firstSelected ? (firstSelected.contrast ?? 100) : 100}%</span></div>
                <input type="range" min="0" max="200" value={firstSelected ? (firstSelected.contrast ?? 100) : 100}
                  onChange={(e) => updateBulkFilter('contrast', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Saturación</span><span>{firstSelected ? (firstSelected.saturation ?? 100) : 100}%</span></div>
                <input type="range" min="0" max="200" value={firstSelected ? (firstSelected.saturation ?? 100) : 100}
                  onChange={(e) => updateBulkFilter('saturation', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Color</span><span>{firstSelected ? (firstSelected.hue ?? 0) : 0}°</span></div>
                <input
                  type="range"
                  className="range-hue"
                  min="0"
                  max="360"
                  value={firstSelected ? (firstSelected.hue ?? 0) : 0}
                  onChange={(e) => updateBulkFilter('hue', parseInt(e.target.value))}
                  disabled={selection.length === 0}
                  title="Barra de matiz (tono)"
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Tono Verdes</span><span>{firstSelected ? (firstSelected.greenHueShift ?? 0) : 0}º</span></div>
                <input type="range" min="-180" max="180" value={firstSelected ? (firstSelected.greenHueShift ?? 0) : 0}
                  onChange={(e) => updateBulkFilter('greenHueShift', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Saturación Verdes</span><span>{firstSelected ? (firstSelected.greenSaturation ?? 100) : 100}%</span></div>
                <input type="range" min="0" max="200" value={firstSelected ? (firstSelected.greenSaturation ?? 100) : 100}
                  onChange={(e) => updateBulkFilter('greenSaturation', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Opacidad Verdes</span><span>{firstSelected ? (firstSelected.greenOpacity ?? 100) : 100}%</span></div>
                <input type="range" min="0" max="100" value={firstSelected ? (firstSelected.greenOpacity ?? 100) : 100}
                  onChange={(e) => updateBulkFilter('greenOpacity', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Tono Negros</span><span>{firstSelected ? (firstSelected.blackHueShift ?? 0) : 0}º</span></div>
                <input type="range" min="-180" max="180" value={firstSelected ? (firstSelected.blackHueShift ?? 0) : 0}
                  onChange={(e) => updateBulkFilter('blackHueShift', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Saturación Negros</span><span>{firstSelected ? (firstSelected.blackSaturation ?? 100) : 100}%</span></div>
                <input type="range" min="0" max="200" value={firstSelected ? (firstSelected.blackSaturation ?? 100) : 100}
                  onChange={(e) => updateBulkFilter('blackSaturation', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Opacidad Negros</span><span>{firstSelected ? (firstSelected.blackOpacity ?? 100) : 100}%</span></div>
                <input type="range" min="0" max="100" value={firstSelected ? (firstSelected.blackOpacity ?? 100) : 100}
                  onChange={(e) => updateBulkFilter('blackOpacity', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Tono Blancos</span><span>{firstSelected ? (firstSelected.whiteHueShift ?? 0) : 0}º</span></div>
                <input type="range" min="-180" max="180" value={firstSelected ? (firstSelected.whiteHueShift ?? 0) : 0}
                  onChange={(e) => updateBulkFilter('whiteHueShift', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Saturación Blancos</span><span>{firstSelected ? (firstSelected.whiteSaturation ?? 100) : 100}%</span></div>
                <input type="range" min="0" max="200" value={firstSelected ? (firstSelected.whiteSaturation ?? 100) : 100}
                  onChange={(e) => updateBulkFilter('whiteSaturation', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Opacidad Blancos</span><span>{firstSelected ? (firstSelected.whiteOpacity ?? 100) : 100}%</span></div>
                <input type="range" min="0" max="100" value={firstSelected ? (firstSelected.whiteOpacity ?? 100) : 100}
                  onChange={(e) => updateBulkFilter('whiteOpacity', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label">
                  <span>Opacidad</span>
                  <span>{firstSelected ? (firstSelected.opacity ?? 100) : 100}%</span>
                </div>
                <input type="range" min="0" max="100" value={firstSelected ? (firstSelected.opacity ?? 100) : 100}
                  onChange={(e) => updateBulkFilter('opacity', parseInt(e.target.value))} disabled={selection.length === 0}
                />
                <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                  <button
                    type="button"
                    className={`btn btn-outline ${(firstSelected?.opacityMode ?? 'absolute') === 'absolute' ? 'active' : ''}`}
                    style={{
                      flex: 1, fontSize: '0.65rem', padding: '4px 6px',
                      borderColor: (firstSelected?.opacityMode ?? 'absolute') === 'absolute' ? 'var(--accent)' : undefined,
                      color: (firstSelected?.opacityMode ?? 'absolute') === 'absolute' ? 'var(--accent)' : undefined,
                    }}
                    onClick={() => updateBulkFilter('opacityMode', 'absolute')}
                    disabled={selection.length === 0}
                    title="Opacidad uniforme en toda la zona"
                  >
                    Absoluta
                  </button>
                  <button
                    type="button"
                    className={`btn btn-outline ${firstSelected?.opacityMode === 'radial' ? 'active' : ''}`}
                    style={{
                      flex: 1, fontSize: '0.65rem', padding: '4px 6px',
                      borderColor: firstSelected?.opacityMode === 'radial' ? 'var(--accent)' : undefined,
                      color: firstSelected?.opacityMode === 'radial' ? 'var(--accent)' : undefined,
                    }}
                    onClick={() => updateBulkFilter('opacityMode', 'radial')}
                    disabled={selection.length === 0}
                    title="Desde el centro de la imagen: más opaco al centro, más transparente hacia los bordes (solo en la zona)"
                  >
                    Progresiva
                  </button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div className="slider-item">
                  <div className="slider-label"><span>Gris</span><span>{firstSelected ? (firstSelected.grayscale ?? 0) : 0}%</span></div>
                  <input type="range" min="0" max="100" value={firstSelected ? (firstSelected.grayscale ?? 0) : 0}
                    onChange={(e) => updateBulkFilter('grayscale', parseInt(e.target.value))} disabled={selection.length === 0}
                  />
                </div>
                <div className="slider-item">
                  <div className="slider-label"><span>Sepia</span><span>{firstSelected ? (firstSelected.sepia ?? 0) : 0}%</span></div>
                  <input type="range" min="0" max="100" value={firstSelected ? (firstSelected.sepia ?? 0) : 0}
                    onChange={(e) => updateBulkFilter('sepia', parseInt(e.target.value))} disabled={selection.length === 0}
                  />
                </div>
                <div className="slider-item">
                  <div className="slider-label"><span>Invertir</span><span>{firstSelected ? (firstSelected.invert ?? 0) : 0}%</span></div>
                  <input type="range" min="0" max="100" value={firstSelected ? (firstSelected.invert ?? 0) : 0}
                    onChange={(e) => updateBulkFilter('invert', parseInt(e.target.value))} disabled={selection.length === 0}
                  />
                </div>
                <div className="slider-item">
                  <div className="slider-label"><span>Blur (px)</span><span>{firstSelected ? (firstSelected.blur ?? 0) : 0}</span></div>
                  <input type="range" min="0" max="20" value={firstSelected ? (firstSelected.blur ?? 0) : 0}
                    onChange={(e) => updateBulkFilter('blur', parseInt(e.target.value))} disabled={selection.length === 0}
                  />
                </div>
                <div className="slider-item">
                  <div className="slider-label"><span>Exposición</span><span>{firstSelected ? (firstSelected.exposure ?? 100) : 100}%</span></div>
                  <input type="range" min="0" max="200" value={firstSelected ? (firstSelected.exposure ?? 100) : 100}
                    onChange={(e) => updateBulkFilter('exposure', parseInt(e.target.value))} disabled={selection.length === 0}
                  />
                </div>
                <div className="slider-item">
                  <div className="slider-label"><span>Luces</span><span>{firstSelected ? (firstSelected.highlights ?? 100) : 100}%</span></div>
                  <input type="range" min="0" max="200" value={firstSelected ? (firstSelected.highlights ?? 100) : 100}
                    onChange={(e) => updateBulkFilter('highlights', parseInt(e.target.value))} disabled={selection.length === 0}
                  />
                </div>
              </div>

              {/* Tinte Group */}
              <div style={{ background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '8px', marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span style={{ fontSize: '0.65rem', fontWeight: 'bold', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Tinte / Base Color</span>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', alignItems: 'center' }}>
                  <div className="slider-item" style={{ marginBottom: 0 }}>
                    <div className="slider-label"><span>Intensidad (%)</span><span>{firstSelected?.tintOpacity || 0}%</span></div>
                    <input type="range" min="0" max="100" value={firstSelected?.tintOpacity || 0}
                      onChange={(e) => updateBulkFilter('tintOpacity', parseInt(e.target.value))} disabled={selection.length === 0}
                    />
                  </div>
                  <input type="color" value={firstSelected?.tintColor || '#000000'} 
                    onChange={(e) => updateBulkFilter('tintColor', e.target.value)} disabled={selection.length === 0}
                    style={{ width: '24px', height: '24px', padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                </div>
              </div>

              {/* Layer Effects Group */}
              <div style={{ background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '8px', marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span style={{ fontSize: '0.65rem', fontWeight: 'bold', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Contorno y Capas</span>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', alignItems: 'center' }}>
                  <div className="slider-item" style={{ marginBottom: 0 }}>
                    <div className="slider-label"><span>Contorno (p)</span><span>{firstSelected?.outlineWidth || 0}px</span></div>
                    <input type="range" min="0" max="10" step="0.01" value={firstSelected?.outlineWidth || 0}
                      onChange={(e) => updateBulkFilter('outlineWidth', parseFloat(e.target.value))} disabled={selection.length === 0}
                    />
                    <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                      <button
                        type="button"
                        className={`btn btn-outline ${(firstSelected?.outlineStyle ?? 'smooth') === 'smooth' ? 'active' : ''}`}
                        style={{
                          flex: 1, fontSize: '0.65rem', padding: '4px 6px',
                          borderColor: (firstSelected?.outlineStyle ?? 'smooth') === 'smooth' ? 'var(--accent)' : undefined,
                          color: (firstSelected?.outlineStyle ?? 'smooth') === 'smooth' ? 'var(--accent)' : undefined,
                        }}
                        onClick={() => updateBulkFilter('outlineStyle', 'smooth')}
                        disabled={selection.length === 0}
                        title="Contorno limpio (suave)"
                      >
                        Limpio
                      </button>
                      <button
                        type="button"
                        className={`btn btn-outline ${firstSelected?.outlineStyle === 'pixel' ? 'active' : ''}`}
                        style={{
                          flex: 1, fontSize: '0.65rem', padding: '4px 6px',
                          borderColor: firstSelected?.outlineStyle === 'pixel' ? 'var(--accent)' : undefined,
                          color: firstSelected?.outlineStyle === 'pixel' ? 'var(--accent)' : undefined,
                        }}
                        onClick={() => updateBulkFilter('outlineStyle', 'pixel')}
                        disabled={selection.length === 0}
                        title="Contorno pixelado: respeta la grilla de pixelación del sprite"
                      >
                        Pixelado
                      </button>
                    </div>
                  </div>
                  <input type="color" value={firstSelected?.outlineColor || '#ffffff'} 
                    onChange={(e) => updateBulkFilter('outlineColor', e.target.value)} disabled={selection.length === 0}
                    style={{ width: '24px', height: '24px', padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', alignItems: 'center' }}>
                  <div className="slider-item" style={{ marginBottom: 0 }}>
                    <div className="slider-label"><span>Resplandor</span><span>{firstSelected?.glowIntensity || 0}px</span></div>
                    <input type="range" min="0" max="50" value={firstSelected?.glowIntensity || 0}
                      onChange={(e) => updateBulkFilter('glowIntensity', parseInt(e.target.value))} disabled={selection.length === 0}
                    />
                  </div>
                  <input type="color" value={firstSelected?.glowColor || '#6b66ff'} 
                    onChange={(e) => updateBulkFilter('glowColor', e.target.value)} disabled={selection.length === 0}
                    style={{ width: '24px', height: '24px', padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                </div>

                <div className="slider-item" style={{ marginBottom: 0 }}>
                  <div className="slider-label"><span>Sombra (X, Y, Blur)</span></div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '4px' }}>
                    <input type="number" value={firstSelected?.shadowX || 0} onChange={(e) => updateBulkFilter('shadowX', parseInt(e.target.value))} style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', color: 'white', fontSize: '0.7rem' }} />
                    <input type="number" value={firstSelected?.shadowY || 0} onChange={(e) => updateBulkFilter('shadowY', parseInt(e.target.value))} style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', color: 'white', fontSize: '0.7rem' }} />
                    <input type="number" value={firstSelected?.shadowBlur || 0} onChange={(e) => updateBulkFilter('shadowBlur', parseInt(e.target.value))} style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', color: 'white', fontSize: '0.7rem' }} />
                    <input type="color" value={firstSelected?.shadowColor || '#000000'} onChange={(e) => updateBulkFilter('shadowColor', e.target.value)} style={{ width: '16px', height: '16px', padding: 0, border: 'none' }} />
                  </div>
                </div>
              </div>
              <button className="btn btn-outline" style={{ marginTop: '8px', width: '100%', borderColor: referenceId ? '#ffcc00' : undefined, color: referenceId ? '#ffcc00' : undefined }} 
                onClick={applyReferenceFilters} disabled={!referenceId || selection.length === 0}>
                 <Droplets size={16} /> Igualar Efectos
              </button>
              <button className="btn btn-outline" style={{ marginTop: '8px', width: '100%', borderColor: referenceId ? '#ffcc00' : undefined, color: referenceId ? '#ffcc00' : undefined }} 
                onClick={applyReferencePixelation} disabled={!referenceId || selection.length === 0}
                title="Iguala el tamaño del píxel de arte del dibujo (no la resolución del archivo) al de la referencia">
                 <Grid size={16} /> Igualar Pixelación
              </button>
            </div>
          </div>

        </aside>
      </div>

      {batchExportFormat && (
        <div className="modal-overlay" onClick={() => setBatchExportFormat(null)}>
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(440px, calc(100vw - 32px))', height: 'auto' }}
          >
            <div className="modal-header">
              <div>
                <h3 style={{ fontSize: '1rem' }}>Exportar lote {batchExportFormat.toUpperCase()}</h3>
                <p style={{ marginTop: '5px', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                  Elegí cómo querés guardar los {sprites.length} sprites.
                </p>
              </div>
              <button className="btn-ghost" onClick={() => setBatchExportFormat(null)}>
                <Trash2 size={16} />
              </button>
            </div>
            <div style={{ padding: '20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <button
                className="btn btn-outline"
                onClick={() => exportBatch(batchExportFormat, 'zip')}
                style={{ minHeight: '92px', flexDirection: 'column', gap: '10px' }}
              >
                <Archive size={24} />
                <span>Descargar ZIP</span>
                <small style={{ color: 'var(--text-muted)', fontWeight: 400 }}>Un solo archivo comprimido</small>
              </button>
              <button
                className="btn btn-primary"
                onClick={() => exportBatch(batchExportFormat, 'folder')}
                style={{ minHeight: '92px', flexDirection: 'column', gap: '10px' }}
              >
                <FolderSync size={24} />
                <span>Elegir carpeta</span>
                <small style={{ color: 'rgba(255,255,255,0.75)', fontWeight: 400 }}>
                  {workingFolder
                    ? `Abre por defecto en ${workingFolder.name}`
                    : 'Archivos sueltos en la carpeta'}
                </small>
              </button>
            </div>
          </div>
        </div>
      )}

      {emptyCellMenu && createPortal(
        <div
          className="tools-dropdown is-context"
          style={{ left: emptyCellMenu.x, top: emptyCellMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="dropdown-item"
            onClick={() => {
              const cell = emptyCellMenu;
              setEmptyCellMenu(null);
              void importIntoCell(cell.columnId, cell.rowId);
            }}
          >
            <Plus size={12} /> Importar sprite
          </button>
        </div>,
        document.body
      )}

      {quadrantPreviewSprites.length > 0 && (
        <QuadrantPreviewOverlay
          sprites={quadrantPreviewSprites}
          picking={quadrantPicking}
          isWhiteBg={isWhiteBg}
          compareNumberSize={compareNumberSize}
          neighbors={quadrantPreviewNeighbors}
          onBrowse={browseQuadrantPreview}
          onClose={() => {
            setQuadrantPreviewIds([]);
            setQuadrantPicking(false);
          }}
          onStartPick={() => setQuadrantPicking(true)}
          onCancelPick={() => setQuadrantPicking(false)}
          onRemove={(id) => setQuadrantPreviewIds((ids) => ids.filter((x) => x !== id))}
        />
      )}

      {eraserTargetId && (
        <EraserModal 
          sprite={sprites.find(s => s.id === eraserTargetId)!} 
          onClose={() => setEraserTargetId(null)}
          isWhiteBg={isWhiteBg}
          onSave={(id: string, newImg: HTMLImageElement) => {
            const next = sprites.map((s: SpriteData) => s.id === id ? { ...s, img: newImg } : s);
            commitSprites(next);
            setEraserTargetId(null);
          }}
        />
      )}
      {ghostCompareTargetId && (
        <GhostCompareModal
          sprite={sprites.find(s => s.id === ghostCompareTargetId)!}
          sprites={sprites}
          onChangeSprite={(next) => {
            commitSprites(sprites.map((s) => (s.id === next.id ? next : s)));
          }}
          onClose={() => setGhostCompareTargetId(null)}
          isWhiteBg={isWhiteBg}
        />
      )}
      {replaceTargetId && (
        <ReplaceBrushModal
          sprite={sprites.find(s => s.id === replaceTargetId)!}
          sprites={sprites}
          onClose={() => setReplaceTargetId(null)}
          isWhiteBg={isWhiteBg}
          onSave={(id: string, newImg: HTMLImageElement) => {
            const next = sprites.map((s: SpriteData) => s.id === id ? { ...s, img: newImg } : s);
            commitSprites(next);
            setReplaceTargetId(null);
          }}
        />
      )}
      {copyRectTargetId && (
        <CopyRectModal
          sprite={sprites.find(s => s.id === copyRectTargetId)!}
          sprites={sprites}
          onClose={() => setCopyRectTargetId(null)}
          isWhiteBg={isWhiteBg}
          onSave={(id: string, newImg: HTMLImageElement) => {
            const next = sprites.map((s: SpriteData) => s.id === id ? { ...s, img: newImg } : s);
            commitSprites(next);
            setCopyRectTargetId(null);
          }}
        />
      )}
      {pixelEditorTargetId && (
        <PixelEditorModal
          sprite={sprites.find(s => s.id === pixelEditorTargetId)!}
          onClose={() => setPixelEditorTargetId(null)}
          isWhiteBg={isWhiteBg}
          onSave={(id: string, newImg: HTMLImageElement) => {
            const next = sprites.map((s: SpriteData) => s.id === id ? { ...s, img: newImg, originalImg: newImg } : s);
            commitSprites(next);
            setPixelEditorTargetId(null);
          }}
        />
      )}
      {transformTargetId && (
        <TransformModal 
          sprite={sprites.find(s => s.id === transformTargetId)!} 
          onClose={() => setTransformTargetId(null)}
          isWhiteBg={isWhiteBg}
          onSave={(id: string, updates: Partial<SpriteData>) => {
            const next = sprites.map((s: SpriteData) => s.id === id ? { ...s, ...updates } : s);
            commitSprites(next);
            setTransformTargetId(null);
          }}
        />
      )}
      {effectMaskTargetId && (
        <EffectMaskModal
          sprite={sprites.find(s => s.id === effectMaskTargetId)!}
          onClose={() => setEffectMaskTargetId(null)}
          isWhiteBg={isWhiteBg}
          onSave={(id: string, data: EffectMaskSaveData) => {
            const next = sprites.map(s => s.id === id ? {
              ...s,
              effectMaskMode: data.mode,
              effectMasks: data.mode === 'rect' ? data.masks : [],
              effectMaskBrush: data.mode === 'brush' ? data.brush : null,
            } : s);
            commitSprites(next);
            setEffectMaskTargetId(null);
          }}
        />
      )}
      {taggingTargetId && (
        <TaggingModal 
          sprite={sprites.find(s => s.id === taggingTargetId)!} 
          onClose={() => setTaggingTargetId(null)}
          isWhiteBg={isWhiteBg}
          onSave={(id: string, regions: Region[]) => {
            const next = sprites.map(s => s.id === id ? { ...s, regions } : s);
            commitSprites(next);
            setTaggingTargetId(null);
          }}
        />
      )}
      {bucketTargetId && (
        <BucketModal 
          sprite={sprites.find(s => s.id === bucketTargetId)!} 
          onClose={() => setBucketTargetId(null)}
          isWhiteBg={isWhiteBg}
          onSave={(id: string, newImg: HTMLImageElement) => {
            const next = sprites.map(s => s.id === id ? { ...s, img: newImg } : s);
            commitSprites(next);
            setBucketTargetId(null);
          }}
        />
      )}
      {paintTargetId && (
        <PaintModal 
          sprite={sprites.find(s => s.id === paintTargetId)!} 
          onClose={() => setPaintTargetId(null)}
          isWhiteBg={isWhiteBg}
          onSave={(id: string, newImg: HTMLImageElement) => {
            const next = sprites.map(s => s.id === id ? { ...s, img: newImg } : s);
            commitSprites(next);
            setPaintTargetId(null);
          }}
        />
      )}
      {stretchTargetId && (
        <StretchModal 
          sprite={sprites.find(s => s.id === stretchTargetId)!} 
          onClose={() => setStretchTargetId(null)}
          isWhiteBg={isWhiteBg}
          onSave={(id: string, updates: Partial<SpriteData>) => {
            const next = sprites.map(s => s.id === id ? { ...s, ...updates } : s);
            commitSprites(next);
            setStretchTargetId(null);
          }}
        />
      )}
      {compositeTarget && (
        <CompositeModal 
          sprite={sprites.find(s => s.id === compositeTarget.id)!} 
          onClose={() => setCompositeTarget(null)}
          isWhiteBg={isWhiteBg}
          canvasSize={compositeTarget.size}
          onSave={(id: string, newImg: HTMLImageElement) => {
            const next = sprites.map(s => s.id === id ? { ...s, img: newImg, anchor: { x: Math.floor(newImg.width/2), y: Math.floor(newImg.height/2) } } : s);
            commitSprites(next);
            setCompositeTarget(null);
          }}
        />
      )}
      {showAnimationModal && (
        <AnimationModal onClose={() => setShowAnimationModal(false)} />
      )}
      {dragGhost && (
        <div
          className="sprite-drag-ghost"
          style={{
            left: dragGhost.x,
            top: dragGhost.y,
            width: dragGhost.w,
            height: dragGhost.h,
          }}
        >
          <img src={dragGhost.src} alt={dragGhost.name} draggable={false} />
        </div>
      )}
    </div>
  );
};

export default App;
