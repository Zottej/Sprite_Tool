import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Save, Trash2, Type, Upload, X } from 'lucide-react';
import {
  buildPixelFontTtf,
  imageElementToImageData,
} from './bitmapToTtf';
import { describeGlyphChar, guessGlyphChar } from './guessGlyphChar';

export type FontMakerSeed = {
  id: string;
  name: string;
  img: HTMLImageElement;
};

type GlyphRow = {
  id: string;
  name: string;
  img: HTMLImageElement;
  char: string;
  thumbUrl: string;
};

type FontMakerModalProps = {
  seedSprites?: FontMakerSeed[];
  onSaveTtf: (blob: Blob, fileName: string) => Promise<boolean>;
  onClose: () => void;
};

const FONT_PREFS_KEY = 'joa-font-maker-prefs';

type FontMakerPrefs = {
  familyName: string;
  styleName: string;
  letterSpacing: number;
  descenderPx: number;
  previewText: string;
};

const loadPrefs = (): FontMakerPrefs => {
  try {
    const raw = localStorage.getItem(FONT_PREFS_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<FontMakerPrefs>) : {};
    return {
      familyName: typeof saved.familyName === 'string' && saved.familyName ? saved.familyName : 'JOA Pixel',
      styleName: typeof saved.styleName === 'string' && saved.styleName ? saved.styleName : 'Regular',
      letterSpacing: Number.isFinite(saved.letterSpacing) ? Math.max(0, Number(saved.letterSpacing)) : 0,
      descenderPx: Number.isFinite(saved.descenderPx) ? Math.max(0, Number(saved.descenderPx)) : 0,
      previewText: typeof saved.previewText === 'string' && saved.previewText
        ? saved.previewText
        : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789 !?.',
    };
  } catch {
    return {
      familyName: 'JOA Pixel',
      styleName: 'Regular',
      letterSpacing: 0,
      descenderPx: 0,
      previewText: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789 !?.',
    };
  }
};

const loadImageFromFile = (file: File): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`No se pudo leer ${file.name}`));
    };
    img.src = url;
  });

const rowFromSeed = (seed: FontMakerSeed): GlyphRow => {
  const canvas = document.createElement('canvas');
  canvas.width = seed.img.naturalWidth || seed.img.width;
  canvas.height = seed.img.naturalHeight || seed.img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(seed.img, 0, 0);
  return {
    id: `seed-${seed.id}-${Math.random().toString(36).slice(2, 8)}`,
    name: seed.name,
    img: seed.img,
    char: guessGlyphChar(seed.name) ?? '',
    thumbUrl: canvas.toDataURL('image/png'),
  };
};

export const FontMakerModal: React.FC<FontMakerModalProps> = ({
  seedSprites,
  onSaveTtf,
  onClose,
}) => {
  const prefs0 = loadPrefs();
  const [glyphs, setGlyphs] = useState<GlyphRow[]>(() =>
    (seedSprites ?? []).map(rowFromSeed),
  );
  const [familyName, setFamilyName] = useState(prefs0.familyName);
  const [styleName, setStyleName] = useState(prefs0.styleName);
  const [letterSpacing, setLetterSpacing] = useState(prefs0.letterSpacing);
  const [descenderPx, setDescenderPx] = useState(prefs0.descenderPx);
  const [previewText, setPreviewText] = useState(prefs0.previewText);
  const [unitsPerEmDraft, setUnitsPerEmDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewFace, setPreviewFace] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewCssRef = useRef<HTMLStyleElement | null>(null);

  useEffect(() => {
    localStorage.setItem(
      FONT_PREFS_KEY,
      JSON.stringify({ familyName, styleName, letterSpacing, descenderPx, previewText }),
    );
  }, [familyName, styleName, letterSpacing, descenderPx, previewText]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewCssRef.current?.remove();
  }, [previewUrl]);

  const maxGlyphH = useMemo(
    () => (glyphs.length ? Math.max(...glyphs.map((g) => g.img.naturalHeight || g.img.height)) : 16),
    [glyphs],
  );

  const mappedCount = glyphs.filter((g) => [...g.char].length > 0).length;
  const dupes = useMemo(() => {
    const counts = new Map<number, number>();
    for (const g of glyphs) {
      const ch = [...g.char][0];
      if (!ch) continue;
      const cp = ch.codePointAt(0)!;
      counts.set(cp, (counts.get(cp) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([cp]) => cp);
  }, [glyphs]);

  const addFiles = async (files: FileList | File[]) => {
    setError(null);
    const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name));
    if (list.length === 0) {
      setError('No encontré imágenes en la selección.');
      return;
    }
    const next: GlyphRow[] = [];
    for (const file of list) {
      try {
        const img = await loadImageFromFile(file);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d')!;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);
        next.push({
          id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          img,
          char: guessGlyphChar(file.name) ?? '',
          thumbUrl: canvas.toDataURL('image/png'),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al importar');
      }
    }
    setGlyphs((prev) => [...prev, ...next]);
  };

  const pullSeed = () => {
    if (!seedSprites?.length) return;
    setGlyphs((prev) => [...prev, ...seedSprites.map(rowFromSeed)]);
  };

  const setChar = (id: string, raw: string) => {
    const ch = [...raw].length ? [...raw][0] : '';
    setGlyphs((prev) => prev.map((g) => (g.id === id ? { ...g, char: ch } : g)));
  };

  const autoDetectOne = (id: string, name: string): boolean => {
    const gch = guessGlyphChar(name);
    if (gch === null) return false;
    setChar(id, gch);
    return true;
  };

  const autoDetectAll = (onlyEmpty: boolean) => {
    const prev = glyphs;
    let filled = 0;
    let failed = 0;
    const next = prev.map((g) => {
      if (onlyEmpty && [...g.char].length > 0) return g;
      const gch = guessGlyphChar(g.name);
      if (gch === null) {
        failed += 1;
        return g;
      }
      filled += 1;
      return { ...g, char: [...gch][0] ?? '' };
    });
    setGlyphs(next);
    if (filled === 0) {
      setError(
        failed > 0 || prev.length > 0
          ? 'No pude deducir caracteres desde los nombres. Probá A.png, letter_A, char_65, U+0041, space…'
          : 'No hay glifos para autodetectar.',
      );
    } else {
      setError(null);
    }
  };

  const removeGlyph = (id: string) => {
    setGlyphs((prev) => prev.filter((g) => g.id !== id));
  };

  const buildBuffer = (): ArrayBuffer => {
    const unitsRaw = unitsPerEmDraft.trim();
    const unitsPerEm = unitsRaw ? Math.max(1, Math.round(parseFloat(unitsRaw))) : undefined;
    if (unitsRaw && !Number.isFinite(unitsPerEm)) {
      throw new Error('Altura EM inválida.');
    }
    const inputs = glyphs
      .filter((g) => [...g.char].length > 0)
      .map((g) => ({
        char: [...g.char][0],
        imageData: imageElementToImageData(g.img),
      }));
    return buildPixelFontTtf(inputs, {
      familyName,
      styleName,
      unitsPerEm,
      descenderPx,
      letterSpacing,
    });
  };

  const refreshPreview = () => {
    setError(null);
    try {
      const buf = buildBuffer();
      const blob = new Blob([buf], { type: 'font/ttf' });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = URL.createObjectURL(blob);
      const face = `joa-font-preview-${Date.now()}`;
      let style = previewCssRef.current;
      if (!style) {
        style = document.createElement('style');
        document.head.appendChild(style);
        previewCssRef.current = style;
      }
      style.textContent = `
        @font-face {
          font-family: '${face}';
          src: url('${url}') format('truetype');
          font-display: block;
        }
      `;
      setPreviewUrl(url);
      setPreviewFace(face);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo generar la vista previa');
      setPreviewFace(null);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const buf = buildBuffer();
      const safe = (familyName || 'font').replace(/[^\w\-]+/g, '_');
      const blob = new Blob([buf], { type: 'font/ttf' });
      const ok = await onSaveTtf(blob, `${safe}.ttf`);
      if (!ok) setError('Exportación cancelada o fallida.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al exportar TTF');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content font-maker-modal"
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
        }}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Type size={18} color="var(--accent)" />
              <h3 style={{ fontSize: '1rem', margin: 0 }}>Crear fuente TTF</h3>
            </div>
            <p className="font-maker-banner">
              Flujo aparte del padder: acá armás glifos → caracteres → un `.ttf` para el juego (como Alkhemikal).
              No modifica ni exporta los sprites del tablero.
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose} title="Cerrar">
            <X size={16} />
          </button>
        </div>

        <div className="font-maker-body">
          <aside className="font-maker-side">
            <label className="font-maker-field">
              <span>Nombre de familia</span>
              <input value={familyName} onChange={(e) => setFamilyName(e.target.value)} />
            </label>
            <label className="font-maker-field">
              <span>Estilo</span>
              <input value={styleName} onChange={(e) => setStyleName(e.target.value)} />
            </label>
            <label className="font-maker-field">
              <span>Altura EM (px)</span>
              <input
                type="number"
                min={1}
                max={512}
                placeholder={`auto (${maxGlyphH})`}
                value={unitsPerEmDraft}
                onChange={(e) => setUnitsPerEmDraft(e.target.value)}
                title="Vacío = altura del glifo más alto. Para pixel-perfect usá ese valor al dibujar texto en el juego."
              />
            </label>
            <label className="font-maker-field">
              <span>Espaciado extra (px)</span>
              <input
                type="number"
                min={0}
                max={64}
                value={letterSpacing}
                onChange={(e) => setLetterSpacing(Math.max(0, parseInt(e.target.value, 10) || 0))}
              />
            </label>
            <label className="font-maker-field">
              <span>Descender (px bajo baseline)</span>
              <input
                type="number"
                min={0}
                max={128}
                value={descenderPx}
                onChange={(e) => setDescenderPx(Math.max(0, parseInt(e.target.value, 10) || 0))}
              />
            </label>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <button type="button" className="btn btn-outline" onClick={() => fileInputRef.current?.click()}>
                <Upload size={14} /> Importar glifos…
              </button>
              {!!seedSprites?.length && (
                <button type="button" className="btn btn-outline" onClick={pullSeed} title="Copia la selección actual del padder como glifos (no los vincula)">
                  <Plus size={14} /> Traer selección ({seedSprites.length})
                </button>
              )}
              <button
                type="button"
                className="btn btn-outline"
                disabled={glyphs.length === 0}
                onClick={() => autoDetectAll(true)}
                title="Completa la tecla según el nombre del archivo en los glifos sin mapear"
              >
                Autodetectar vacíos
              </button>
              <input
                ref={fileInputRef}
                type="file"
                hidden
                multiple
                accept="image/*"
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>

            <p className="font-maker-hint">
              Tip: Windows no distingue `A.png` de `a.png`. Usá `A_mayus` / `a_minus`, `upper_A` / `lower_A`, o `char_65` / `char_97`.
              {mappedCount > 0 && (
                <> · {mappedCount}/{glyphs.length} con carácter</>
              )}
            </p>
            {dupes.length > 0 && (
              <p className="font-maker-warn">
                Caracteres duplicados: se exporta solo el primero de cada uno
                ({dupes.map((cp) => String.fromCodePoint(cp)).join(' ')}).
              </p>
            )}
            {error && <p className="font-maker-warn">{error}</p>}
          </aside>

          <section className="font-maker-main">
            {glyphs.length === 0 ? (
              <div className="font-maker-empty">
                Arrastrá imágenes de letras acá, o usá Importar glifos.
                {!!seedSprites?.length && ' También podés traer la selección del tablero.'}
              </div>
            ) : (
              <div className="font-maker-grid">
                {glyphs.map((g) => {
                  const ch = [...g.char][0] ?? '';
                  const guessed = !ch && guessGlyphChar(g.name);
                  return (
                    <div key={g.id} className={`font-maker-card${ch ? '' : ' is-unmapped'}`}>
                      <div className="font-maker-thumb checker-mini">
                        <img src={g.thumbUrl} alt={g.name} />
                      </div>
                      <div className="font-maker-card-meta">
                        <span className="font-maker-name" title={g.name}>{g.name}</span>
                        <span className="font-maker-size">
                          {g.img.naturalWidth || g.img.width}×{g.img.naturalHeight || g.img.height}
                        </span>
                        <label className="font-maker-char-row">
                          <span>Tecla</span>
                          <input
                            value={ch}
                            maxLength={2}
                            placeholder={guessed || '?'}
                            onChange={(e) => setChar(g.id, e.target.value)}
                            title="Carácter Unicode que representa esta imagen"
                          />
                          <span className="font-maker-char-desc">{describeGlyphChar(ch)}</span>
                        </label>
                        {!ch && (
                          <button
                            type="button"
                            className="btn-ghost"
                            style={{ width: 'auto', padding: '2px 6px', fontSize: '0.7rem' }}
                            onClick={() => {
                              if (!autoDetectOne(g.id, g.name)) {
                                setError(`No pude deducir la tecla de “${g.name}”.`);
                              } else {
                                setError(null);
                              }
                            }}
                          >
                            Autodetectar
                          </button>
                        )}
                        {ch === '' && (
                          <button
                            type="button"
                            className="btn-ghost"
                            style={{ width: 'auto', padding: '2px 6px', fontSize: '0.7rem' }}
                            onClick={() => setChar(g.id, ' ')}
                          >
                            = espacio
                          </button>
                        )}
                      </div>
                      <button type="button" className="btn-ghost font-maker-remove" onClick={() => removeGlyph(g.id)} title="Quitar">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="font-maker-preview-block">
              <div className="slider-label" style={{ marginBottom: 6 }}>
                <span>Vista previa</span>
                <button type="button" className="btn-ghost" style={{ width: 'auto', padding: '2px 8px' }} onClick={refreshPreview} disabled={mappedCount === 0}>
                  Actualizar
                </button>
              </div>
              <textarea
                className="font-maker-preview-input"
                rows={3}
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
              />
              <div
                className="font-maker-preview-out checker-mini"
                style={previewFace ? { fontFamily: `'${previewFace}', monospace`, fontSize: maxGlyphH } : undefined}
              >
                {previewFace ? previewText : 'Generá la fuente (Actualizar) para previsualizar.'}
              </div>
            </div>
          </section>
        </div>

        <div className="modal-footer" style={{ padding: '14px 20px', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Exporta un TrueType usable en `assets/fonts/` · EM sugerido: {maxGlyphH}px
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancelar</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || mappedCount === 0}
              onClick={() => { void handleExport(); }}
            >
              <Save size={16} /> {busy ? 'Exportando…' : 'Exportar .ttf'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
