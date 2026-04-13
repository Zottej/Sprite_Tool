import React, { useState, useRef, useEffect } from 'react';
import { 
  Trash2, Plus, Archive, CheckSquare, Square, 
  Target, FolderSync, Save, AlertTriangle, Eraser, RotateCcw, Search, MapPin, Pencil, MoreHorizontal, FlipHorizontal, FlipVertical, Droplets, Grid, Circle, Maximize, Layers
} from 'lucide-react';
import JSZip from 'jszip';

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
}

const getSpriteFilter = (sprite: SpriteData, isExport = false) => {
  const b = sprite.brightness ?? 100;
  const c = sprite.contrast ?? 100;
  const s = sprite.saturation ?? 100;
  const o = sprite.opacity ?? 100;
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
  
  if (sprite.outlineColor && sprite.outlineWidth) {
    const w = sprite.outlineWidth;
    const oc = sprite.outlineColor;
    filter += ` drop-shadow(${w}px 0 0 ${oc}) drop-shadow(-${w}px 0 0 ${oc}) drop-shadow(0 ${w}px 0 ${oc}) drop-shadow(0 -${w}px 0 ${oc})`;
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

const generateId = () => {
  try { return crypto.randomUUID(); } catch (e) { return Math.random().toString(36).substring(2, 15) + Date.now().toString(36); }
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
  onOpenTransform: (id: string) => void;
  onOpenTagging: (id: string) => void;
  onOpenPaint: (id: string) => void;
  onOpenStretch: (id: string) => void;
  onOpenComposite: (id: string, size?: number) => void;
  onUpdateSprite: (id: string, updates: Partial<SpriteData>) => void;
  isReference?: boolean;
  isWhiteBg?: boolean;
}

const SpriteModule: React.FC<SpriteModuleProps> = ({ sprite, isSelected, onToggleSelect, onRemove, onSetAnchor, onSetReference, onOpenEraser, onOpenTransform, onOpenTagging, onOpenPaint, onOpenStretch, onOpenComposite, onUpdateSprite, isReference, isWhiteBg }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const { img, padding } = sprite;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.imageSmoothingEnabled = false;
    
    const scX = (sprite.scale || 1) * (sprite.stretchX || 1);
    const scY = (sprite.scale || 1) * (sprite.stretchY || 1);
    const sw = img.width * scX;
    const sh = img.height * scY;
    const w = sw + padding.left + padding.right;
    const h = sh + padding.top + padding.bottom;

    canvas.width = w * window.devicePixelRatio;
    canvas.height = h * window.devicePixelRatio;
    canvas.style.width = `100%`;
    canvas.style.height = `100%`;
    canvas.style.objectFit = 'contain';
    canvas.style.imageRendering = 'pixelated';

    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    
    ctx.filter = getSpriteFilter(sprite);

    if (sprite.pixelation && sprite.pixelation > 1) {
      const p = sprite.pixelation;
      const tw = Math.max(1, Math.floor(sw / p));
      const th = Math.max(1, Math.floor(sh / p));
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = tw;
      tempCanvas.height = th;
      const tctx = tempCanvas.getContext('2d')!;
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(img, 0, 0, tw, th);
      ctx.drawImage(tempCanvas, 0, 0, tw, th, padding.left, padding.top, sw, sh);
    } else {
      ctx.save();
      const ox = sprite.offsetX || 0;
      const oy = sprite.offsetY || 0;
      const rot = (sprite.rotation || 0) * Math.PI / 180;
      
      const hSign = sprite.flipH ? -1 : 1;
      const vSign = sprite.flipV ? -1 : 1;
      
      ctx.translate(padding.left + sw/2 + ox, padding.top + sh/2 + oy);
      ctx.rotate(rot);
      ctx.scale(hSign, vSign);
      ctx.drawImage(img, -sw/2, -sh/2, sw, sh);
      ctx.restore();
    }
    ctx.filter = 'none';
  }, [sprite]);


  const [isDragging, setIsDragging] = useState(false);
  const [showTools, setShowTools] = useState(false);

  useEffect(() => {
    if (!showTools) return;
    const clickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowTools(false);
      }
    };
    window.addEventListener('mousedown', clickOutside);
    return () => window.removeEventListener('mousedown', clickOutside);
  }, [showTools]);

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

  return (
    <div className={`sprite-module ${isSelected ? 'selected' : ''} ${isReference ? 'reference' : ''}`} 
         onClick={(e) => {
           if (e.shiftKey || e.ctrlKey || e.metaKey) {
             onToggleSelect(sprite.id, true);
           } else {
             onToggleSelect(sprite.id, false);
           }
         }}>
      <div className="module-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isSelected ? <CheckSquare size={14} color="#6b66ff" /> : <Square size={14} color="var(--text-muted)" />}
          <span className="module-title">{sprite.name}</span>
        </div>
        <div style={{ display: 'flex', gap: '4px', position: 'relative' }}>
          <button className={`btn-ghost ${showTools ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowTools(!showTools); }}
            title="Herramientas"
          >
            <MoreHorizontal size={14} />
          </button>
          
          {showTools && (
            <div className="tools-dropdown" ref={dropdownRef} onClick={e => e.stopPropagation()}>
              <button className="dropdown-item" onClick={(e) => { e.stopPropagation(); onOpenPaint(sprite.id); setShowTools(false); }}>
                <Pencil size={12} /> Pintar
              </button>
              <button className="dropdown-item" onClick={(e) => { e.stopPropagation(); onOpenTagging(sprite.id); setShowTools(false); }}>
                <MapPin size={12} /> Zonas (Tags)
              </button>
              <button className="dropdown-item" onClick={(e) => { e.stopPropagation(); onOpenTransform(sprite.id); setShowTools(false); }}>
                <RotateCcw size={12} /> Transformar
              </button>
              <button className="dropdown-item" onClick={(e) => { e.stopPropagation(); onOpenEraser(sprite.id); setShowTools(false); }}>
                <Eraser size={12} /> Goma (Borrador)
              </button>
              <button className="dropdown-item" onClick={(e) => { e.stopPropagation(); onOpenStretch(sprite.id); setShowTools(false); }}>
                <Maximize size={12} /> Estirar (Resize)
              </button>
              <button className="dropdown-item" onClick={(e) => { 
                e.stopPropagation(); 
                const sizeStr = prompt('¿Tamaño del lienzo de trabajo (en píxeles)?', Math.max(8192, sprite.img.width, sprite.img.height).toString());
                if (sizeStr && !isNaN(parseInt(sizeStr))) {
                    onOpenComposite(sprite.id, parseInt(sizeStr)); 
                }
                setShowTools(false);
              }}>
                <Layers size={12} /> Componer (Collage)
              </button>
              <div style={{ height: '1px', background: 'var(--border)', margin: '4px 0' }} />
              <button className="dropdown-item" onClick={(e) => { 
                e.stopPropagation(); 
                onUpdateSprite(sprite.id, { flipH: !sprite.flipH });
              }}>
                <FlipHorizontal size={12} /> Invertir Horizontal
              </button>
              <button className="dropdown-item" onClick={(e) => { 
                e.stopPropagation(); 
                onUpdateSprite(sprite.id, { flipV: !sprite.flipV });
              }}>
                <FlipVertical size={12} /> Invertir Vertical
              </button>
            </div>
          )}

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
      
      <div className={`module-canvas-area checker-mini ${isWhiteBg ? 'white-bg' : ''}`}>
        <canvas ref={canvasRef} />
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
      </div>

      <div className="module-footer">
        <span className="badge">Res: {(sprite.img.width * (sprite.scale || 1) * (sprite.stretchX || 1)).toFixed(0)}×{(sprite.img.height * (sprite.scale || 1) * (sprite.stretchY || 1)).toFixed(0)}</span>
        <span className="badge badge-accent">
          Full: {(sprite.img.width * (sprite.scale || 1) * (sprite.stretchX || 1) + sprite.padding.left + sprite.padding.right).toFixed(0)}×{(sprite.img.height * (sprite.scale || 1) * (sprite.stretchY || 1) + sprite.padding.top + sprite.padding.bottom).toFixed(0)}
        </span>
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

const EraserModal: React.FC<EraserModalProps> = ({ sprite, onSave, onClose, isWhiteBg }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [brushSize, setBrushSize] = useState(20);
  const [brushShape, setBrushShape] = useState<'circle' | 'square'>('circle');
  const [zoom, setZoom] = useState(1);
  const [isDrawing, setIsDrawing] = useState(false);
  const [mousePos, setMousePos] = useState<{ x: number, y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    canvas.width = sprite.img.width;
    canvas.height = sprite.img.height;
    ctx.drawImage(sprite.img, 0, 0);
  }, [sprite]);

  const erase = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d')!;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / zoom;
    const y = (e.clientY - rect.top) / zoom;

    setMousePos({ x, y });

    if (!isDrawing) return;

    const scaleX = canvas.width / (rect.width / zoom);
    const scaleY = canvas.height / (rect.height / zoom);
    
    ctx.globalCompositeOperation = 'destination-out';
    if (brushShape === 'circle') {
      ctx.beginPath();
      ctx.arc(x * scaleX, y * scaleY, brushSize, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(x * scaleX - brushSize, y * scaleY - brushSize, brushSize * 2, brushSize * 2);
    }
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
        <div className={`eraser-workspace checker-mini ${isWhiteBg ? 'white-bg' : ''}`} style={{ overflow: 'auto' }}>
           <div style={{ 
             position: 'relative', 
             cursor: 'none', 
             display: 'flex', 
             alignItems: 'center', 
             justifyContent: 'center',
             width: 'fit-content',
             height: 'fit-content',
             margin: 'auto',
             transform: `scale(${zoom})`,
             transformOrigin: 'center center'
           }}>
             <canvas 
              ref={canvasRef}
              onMouseDown={() => setIsDrawing(true)}
              onMouseUp={() => setIsDrawing(false)}
              onMouseMove={erase}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setMousePos({ x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom });
              }}
              onMouseLeave={() => {
                setIsDrawing(false);
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
        <div className="modal-footer" style={{ padding: '20px', background: 'var(--bg-panel)', borderTop: '1px solid var(--border)', gap: '24px' }}>
          <div className="slider-item" style={{ flex: 1, marginBottom: 0 }}>
            <div className="slider-label"><span><Search size={14} /> Zoom</span><span>{zoom.toFixed(1)}x</span></div>
            <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
          </div>
          <div className="slider-item" style={{ flex: 1, marginBottom: 0 }}>
            <div className="slider-label"><span>Tamaño de Goma</span><span>{brushSize}px</span></div>
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
            <button className="btn btn-outline" onClick={handleReset}>Reiniciar</button>
            <button className="btn btn-primary" style={{ paddingLeft: '24px', paddingRight: '24px' }} onClick={handleSave}>Guardar Cambios</button>
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
  const [zoom, setZoom] = useState(1);
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
  const [zoom, setZoom] = useState(1);
  
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
            <input type="range" min="0.1" max="4" step="0.05" value={stretchX} onChange={(e) => setStretchX(parseFloat(e.target.value))} />
          </div>
          <div className="slider-item" style={{ flex: 1, marginBottom: 0 }}>
            <div className="slider-label"><span>Alto (Y)</span><span>{stretchY.toFixed(2)}x</span></div>
            <input type="range" min="0.1" max="4" step="0.05" value={stretchY} onChange={(e) => setStretchY(parseFloat(e.target.value))} />
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

// --- Tagging Modal Component ---
interface TaggingModalProps {
  sprite: SpriteData;
  onSave: (id: string, regions: Region[]) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

const TaggingModal: React.FC<TaggingModalProps> = ({ sprite, onSave, onClose, isWhiteBg }) => {
  const [regions, setRegions] = useState<Region[]>(sprite.regions || []);
  const [zoom, setZoom] = useState(1);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number, y: number } | null>(null);
  const [currentRect, setCurrentRect] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

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
              position: 'relative', 
              cursor: 'crosshair',
              width: 'fit-content',
              height: 'fit-content',
              margin: 'auto',
              transform: `scale(${zoom})`,
              transformOrigin: 'center center'
            }}>
              <canvas 
                ref={canvasRef}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
              />
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

// --- Paint Modal Component ---
interface PaintModalProps {
  sprite: SpriteData;
  onSave: (id: string, newImg: HTMLImageElement) => void;
  onClose: () => void;
  isWhiteBg?: boolean;
}

const PaintModal: React.FC<PaintModalProps> = ({ sprite, onSave, onClose, isWhiteBg }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [brushSize, setBrushSize] = useState(10);
  const [paintColor, setPaintColor] = useState('#ff0000');
  const [zoom, setZoom] = useState(1);
  const [isDrawing, setIsDrawing] = useState(false);
  const [mousePos, setMousePos] = useState<{ x: number, y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    canvas.width = sprite.img.width;
    canvas.height = sprite.img.height;
    ctx.drawImage(sprite.img, 0, 0);
  }, [sprite]);

  const draw = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d')!;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / zoom;
    const y = (e.clientY - rect.top) / zoom;

    setMousePos({ x, y });

    if (!isDrawing) return;

    const scaleX = canvas.width / (rect.width / zoom);
    const scaleY = canvas.height / (rect.height / zoom);
    
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = paintColor;
    ctx.beginPath();
    ctx.arc(x * scaleX, y * scaleY, brushSize, 0, Math.PI * 2);
    ctx.fill();
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    const newImg = new Image();
    newImg.onload = () => onSave(sprite.id, newImg);
    newImg.src = dataUrl;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Pencil size={18} color="var(--accent)" />
            <h3 style={{ fontSize: '1rem' }}>Pintar: {sprite.name}</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}><Trash2 size={16} /></button>
        </div>
        <div className={`eraser-workspace checker-mini ${isWhiteBg ? 'white-bg' : ''}`} style={{ overflow: 'auto' }}>
           <div style={{ 
             position: 'relative', 
             cursor: 'none', 
             display: 'flex', 
             alignItems: 'center', 
             justifyContent: 'center',
             width: 'fit-content',
             height: 'fit-content',
             margin: 'auto',
             transform: `scale(${zoom})`,
             transformOrigin: 'center center'
           }}>
             <canvas 
              ref={canvasRef}
              onMouseDown={() => setIsDrawing(true)}
              onMouseUp={() => setIsDrawing(false)}
              onMouseMove={draw}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setMousePos({ x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom });
              }}
              onMouseLeave={() => {
                setIsDrawing(false);
                setMousePos(null);
              }}
             />
             {mousePos && canvasRef.current && (
               <div className="brush-preview" style={{
                 left: mousePos.x,
                 top: mousePos.y,
                 width: brushSize * (canvasRef.current.offsetWidth / canvasRef.current.width) * 2,
                 height: brushSize * (canvasRef.current.offsetWidth / canvasRef.current.width) * 2,
                 borderColor: paintColor
               }} />
             )}
           </div>
        </div>
        <div className="modal-footer" style={{ padding: '20px', background: 'var(--bg-panel)', borderTop: '1px solid var(--border)', gap: '24px' }}>
          <div className="slider-item" style={{ width: '150px', marginBottom: 0 }}>
             <div className="slider-label"><span>Color</span></div>
             <div style={{ display: 'flex', gap: '8px' }}>
                <input type="color" value={paintColor} onChange={(e) => setPaintColor(e.target.value)} style={{ width: '40px', height: '32px', padding: 0, border: 'none', background: 'none' }} />
                <input type="text" className="input-small" value={paintColor} onChange={(e) => setPaintColor(e.target.value)} style={{ flex: 1, textTransform: 'uppercase' }} />
             </div>
          </div>
          <div className="slider-item" style={{ flex: 1, marginBottom: 0 }}>
            <div className="slider-label"><span><Search size={14} /> Zoom</span><span>{zoom.toFixed(1)}x</span></div>
            <input type="range" min="0.5" max="8" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
          </div>
          <div className="slider-item" style={{ flex: 1, marginBottom: 0 }}>
            <div className="slider-label"><span>Tamaño de Pincel</span><span>{brushSize}px</span></div>
            <input type="range" min="1" max="100" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} />
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="btn btn-outline" onClick={() => {
              const ctx = canvasRef.current?.getContext('2d');
              if(ctx) {
                ctx.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height);
                ctx.drawImage(sprite.img, 0, 0);
              }
            }}>Reiniciar</button>
            <button className="btn btn-primary" style={{ paddingLeft: '24px', paddingRight: '24px' }} onClick={handleSave}>Guardar Cambios</button>
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
      if (!file.type.startsWith('image/')) continue;
      
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
           <div className="checker-mini" style={{ position: 'relative', width: `${canvasSize * zoom}px`, height: `${canvasSize * zoom}px`, minWidth: `${canvasSize * zoom}px`, minHeight: `${canvasSize * zoom}px`, flexShrink: 0, margin: '20px auto', boxShadow: '0 0 40px rgba(0,0,0,0.8)', border: '1px solid rgba(255,255,255,0.1)' }}>
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
              <input type="range" min="0.1" max="8" step="0.05" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
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

// --- Main App Component ---
const App: React.FC = () => {
  const [sprites, setSprites] = useState<SpriteData[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [gridZoom, setGridZoom] = useState(1);
  const [eraserTargetId, setEraserTargetId] = useState<string | null>(null);
  const [transformTargetId, setTransformTargetId] = useState<string | null>(null);
  const [taggingTargetId, setTaggingTargetId] = useState<string | null>(null);
  const [paintTargetId, setPaintTargetId] = useState<string | null>(null);
  const [stretchTargetId, setStretchTargetId] = useState<string | null>(null);
  const [compositeTarget, setCompositeTarget] = useState<{ id: string, size: number } | null>(null);

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
  }, [historyIndex, history]);
  const [targets, setTargets] = useState({ top: 100, bottom: 100, left: 100, right: 100 });
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [showGridlines, setShowGridlines] = useState(false);
  const [isWhiteBg, setIsWhiteBg] = useState(false);
  const [highlightedYs, setHighlightedYs] = useState<number[]>([]);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  useEffect(() => {
  }, []);

  const handleFiles = async (files: FileList | File[]) => {
    const newSprites: SpriteData[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file || !file.type.startsWith('image/')) continue;
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
      newSprites.push({ 
        id: generateId(), 
        name: file.name, 
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
        anchor: { x: Math.floor(img.width / 2), y: Math.floor(img.height / 2) },
        pixelation: 1,
        brightness: 100,
        contrast: 100,
        saturation: 100,
        hue: 0,
        opacity: 100
      });
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

  const selectDirectory = async () => {
    try {
      const handle = await (window as any).showDirectoryPicker();
      setDirHandle(handle);
    } catch (err) {
      console.error('Directory selection failed:', err);
    }
  };

  const overwriteAll = async () => {
    if (!dirHandle) return;
    setIsSaving(true);
    try {
      for (const s of sprites) {
        const canvas = document.createElement('canvas');
        const scX = (s.scale || 1) * (s.stretchX || 1);
        const scY = (s.scale || 1) * (s.stretchY || 1);
        const sw = s.img.width * scX;
        const sh = s.img.height * scY;
        canvas.width = sw + s.padding.left + s.padding.right;
        canvas.height = sh + s.padding.top + s.padding.bottom;
        const ctx = canvas.getContext('2d')!;
        ctx.imageSmoothingEnabled = false;
        
        ctx.filter = getSpriteFilter(s, true);

        const rot = (s.rotation || 0) * Math.PI / 180;
        const ox = s.offsetX || 0;
        const oy = s.offsetY || 0;

        const hSign = s.flipH ? -1 : 1;
        const vSign = s.flipV ? -1 : 1;

        if (s.pixelation && s.pixelation > 1) {
          const p = s.pixelation;
          const tw = Math.max(1, Math.floor(sw / p));
          const th = Math.max(1, Math.floor(sh / p));
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = tw;
          tempCanvas.height = th;
          const tctx = tempCanvas.getContext('2d')!;
          tctx.imageSmoothingEnabled = false;
          tctx.drawImage(s.img, 0, 0, tw, th);

          ctx.save();
          ctx.translate(s.padding.left + sw/2 + ox, s.padding.top + sh/2 + oy);
          ctx.rotate(rot);
          ctx.scale(hSign, vSign);
          ctx.drawImage(tempCanvas, 0, 0, tw, th, -sw/2, -sh/2, sw, sh);
          ctx.restore();
        } else {
          ctx.save();
          ctx.translate(s.padding.left + sw/2 + ox, s.padding.top + sh/2 + oy);
          ctx.rotate(rot);
          ctx.scale(hSign, vSign);
          ctx.drawImage(s.img, -sw/2, -sh/2, sw, sh);
          ctx.restore();
        }
        ctx.filter = 'none';

        if (s.posterize && s.posterize >= 2) {
          const idata = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const d = idata.data;
          const steps = s.posterize;
          const factor = 255 / (steps - 1);
          for (let i = 0; i < d.length; i += 4) {
            if (d[i+3] === 0) continue;
            d[i] = Math.round((d[i] / 255) * (steps - 1)) * factor;
            d[i+1] = Math.round((d[i+1] / 255) * (steps - 1)) * factor;
            d[i+2] = Math.round((d[i+2] / 255) * (steps - 1)) * factor;
          }
          ctx.putImageData(idata, 0, 0);
        }
        
        const blob = await new Promise<Blob>(res => canvas.toBlob(res as any, 'image/png'));
        const fileHandle = await dirHandle.getFileHandle(s.name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      }
      alert('¡Todos los archivos originales han sido reemplazados con éxito!');
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
        grayscale: ref.grayscale ?? 0,
        sepia: ref.sepia ?? 0,
        invert: ref.invert ?? 0,
        blur: ref.blur ?? 0,
        exposure: ref.exposure ?? 100,
        highlights: ref.highlights ?? 100,
        posterize: ref.posterize,
        outlineColor: ref.outlineColor,
        outlineWidth: ref.outlineWidth,
        shadowX: ref.shadowX,
        shadowY: ref.shadowY,
        shadowBlur: ref.shadowBlur,
        shadowColor: ref.shadowColor,
        glowIntensity: ref.glowIntensity,
        glowColor: ref.glowColor
      };
    });
    commitSprites(next);
  };

  const detectIntrinsicPixelSize = (img: HTMLImageElement): number => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 1;
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    const getGcd = (a: number, b: number): number => {
      while (b) { a %= b; [a, b] = [b, a]; }
      return a;
    };

    let resultGcd = 0;
    const sampleRows = [Math.floor(canvas.height / 2), Math.floor(canvas.height / 4), Math.floor(3 * canvas.height / 4)];
    
    sampleRows.forEach(row => {
      let run = 1;
      for (let x = 1; x < canvas.width; x++) {
        const idx1 = (row * canvas.width + (x - 1)) * 4;
        const idx2 = (row * canvas.width + x) * 4;
        const same = data[idx1] === data[idx2] && data[idx1+1] === data[idx2+1] && data[idx1+2] === data[idx2+2] && data[idx1+3] === data[idx2+3];
        if (same) {
          run++;
        } else {
          if (run > 0 && data[idx1+3] > 0) { // Only count non-transparent runs
            resultGcd = resultGcd === 0 ? run : getGcd(resultGcd, run);
          }
          run = 1;
        }
      }
    });

    return resultGcd || 1;
  };

  const applyReferencePixelation = () => {
    const ref = sprites.find((s: SpriteData) => s.id === referenceId);
    if (!ref) return;
    
    const refBase = detectIntrinsicPixelSize(ref.img);
    const refTarget = refBase * (ref.scale || 1) * (ref.pixelation || 1);

    const next = sprites.map((s: SpriteData) => {
      if (!selection.includes(s.id) || s.id === referenceId) return s;
      const sBase = detectIntrinsicPixelSize(s.img);
      const sTargetPixelation = refTarget / (sBase * (s.scale || 1));
      return { 
        ...s, 
        pixelation: Math.max(1, Math.round(sTargetPixelation))
      };
    });
    commitSprites(next);
  };

  const exportZip = async () => {
    const zip = new JSZip();
    for (const s of sprites) {
      const canvas = document.createElement('canvas');
      const scX = (s.scale || 1) * (s.stretchX || 1);
      const scY = (s.scale || 1) * (s.stretchY || 1);
      const sw = s.img.width * scX;
      const sh = s.img.height * scY;
      canvas.width = sw + s.padding.left + s.padding.right;
      canvas.height = sh + s.padding.top + s.padding.bottom;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.filter = getSpriteFilter(s, true);

      const rot = (s.rotation || 0) * Math.PI / 180;
      const ox = s.offsetX || 0;
      const oy = s.offsetY || 0;

      const hSign = s.flipH ? -1 : 1;
      const vSign = s.flipV ? -1 : 1;

      if (s.pixelation && s.pixelation > 1) {
          const p = s.pixelation;
          const tw = Math.max(1, Math.floor(sw / p));
          const th = Math.max(1, Math.floor(sh / p));
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = tw;
          tempCanvas.height = th;
          const tctx = tempCanvas.getContext('2d')!;
          tctx.imageSmoothingEnabled = false;
          tctx.drawImage(s.img, 0, 0, tw, th);

          ctx.save();
          ctx.translate(s.padding.left + sw/2 + ox, s.padding.top + sh/2 + oy);
          ctx.rotate(rot);
          ctx.scale(hSign, vSign);
          ctx.drawImage(tempCanvas, 0, 0, tw, th, -sw/2, -sh/2, sw, sh);
          ctx.restore();
      } else {
          ctx.save();
          ctx.translate(s.padding.left + sw/2 + ox, s.padding.top + sh/2 + oy);
          ctx.rotate(rot);
          ctx.scale(hSign, vSign);
          ctx.drawImage(s.img, -sw/2, -sh/2, sw, sh);
          ctx.restore();
      }
      ctx.filter = 'none';

      if (s.posterize && s.posterize >= 2) {
        const idata = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = idata.data;
        const steps = s.posterize;
        const factor = 255 / (steps - 1);
        for (let i = 0; i < d.length; i += 4) {
          if (d[i+3] === 0) continue;
          d[i] = Math.round((d[i] / 255) * (steps - 1)) * factor;
          d[i+1] = Math.round((d[i+1] / 255) * (steps - 1)) * factor;
          d[i+2] = Math.round((d[i+2] / 255) * (steps - 1)) * factor;
        }
        ctx.putImageData(idata, 0, 0);
      }
      
      const blob = await new Promise<Blob>(res => canvas.toBlob(res as any, 'image/png'));
      zip.file(s.name, blob);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `joa_batch_${Date.now()}.zip`;
    link.click();
  };

  const firstSelected = sprites.find(s => s.id === selection[0]);

  return (
    <div className="layout">
      {/* TOP BAR */}
      <header className="top-bar">
        <div className="logo-group">
          <h1 style={{ display: 'flex', alignItems: 'center' }}>
            JOA Engine <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginLeft: '4px' }}>SYNC v6</span>
            <label style={{ marginLeft: '16px', fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', cursor: 'pointer', fontWeight: 'normal', color: 'var(--text-muted)', userSelect: 'none' }}>
              <input type="checkbox" checked={showGridlines} onChange={(e) => setShowGridlines(e.target.checked)} style={{ marginRight: '6px', cursor: 'pointer' }} />
              Guías
            </label>
            <label style={{ marginLeft: '12px', fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', cursor: 'pointer', fontWeight: 'normal', color: 'var(--text-muted)', userSelect: 'none' }}>
              <input type="checkbox" checked={isWhiteBg} onChange={(e) => setIsWhiteBg(e.target.checked)} style={{ marginRight: '6px', cursor: 'pointer' }} />
              Fondo Blanco
            </label>
          </h1>
        </div>
        <div className="top-actions">
           <button className="btn btn-primary" onClick={() => document.getElementById('grid-up')?.click()}>
             <Plus size={16} /> Importar Lote
           </button>
           <input type="file" id="grid-up" hidden multiple accept="image/*" onChange={(e) => e.target.files && handleFiles(e.target.files)} />
           <div style={{ height: '24px', width: '1px', background: 'var(--border)', margin: '0 8px' }} />
           <button className="btn btn-outline" onClick={exportZip} disabled={sprites.length === 0}>
             <Archive size={16} /> Exportar ZIP
           </button>
        </div>
      </header>

      <div className="main-content" style={{ position: 'relative', display: 'flex' }}
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
        <div className="grid-container" style={{ position: 'relative', flex: 1 }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}>
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
               </label>
            </div>
          ) : (
            <div className="sprite-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${280 * gridZoom}px, 1fr))` }}>
              {sprites.map((s: SpriteData) => (
                <SpriteModule key={s.id} sprite={s} 
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
                  onOpenTransform={(id) => setTransformTargetId(id)}
                  onOpenTagging={(id) => setTaggingTargetId(id)}
                  onOpenPaint={(id) => setPaintTargetId(id)}
                  onOpenStretch={(id) => setStretchTargetId(id)}
                  onOpenComposite={(id, size) => setCompositeTarget({ id, size: size || 8192 })}
                  isWhiteBg={isWhiteBg}
                  onUpdateSprite={(id, updates) => {
                    const next = sprites.map((s: SpriteData) => s.id === id ? { ...s, ...updates } : s);
                    commitSprites(next);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* RIGHT CONTROLS */}
        <aside className="controls-panel">
          <div className="card">
            <span className="card-title">Sincronización Local</span>
            <div className="sync-indicator">
               <div className={`sync-dot ${dirHandle ? 'active' : ''}`} />
               <span>{dirHandle ? `Sincronizado: ${dirHandle.name}` : 'Sin carpeta seleccionada'}</span>
            </div>
            {!dirHandle ? (
              <button className="btn btn-outline" style={{ width: '100%' }} onClick={selectDirectory}>
                <FolderSync size={16} /> Vincular Carpeta
              </button>
            ) : (
              <button className="btn btn-danger" style={{ width: '100%' }} onClick={overwriteAll} disabled={isSaving || sprites.length === 0}>
                {isSaving ? 'Guardando...' : <><Save size={16} /> Sobrescribir Originales</>}
              </button>
            )}
            {dirHandle && (
              <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '8px', textAlign: 'center' }}>
                <AlertTriangle size={10} style={{ marginRight: '4px' }} /> 
                Esto reemplazará los archivos en tu disco inmediatamente.
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
            <button className="btn btn-outline" style={{ marginTop: '8px', width: '100%', borderColor: referenceId ? '#ffcc00' : undefined, color: referenceId ? '#ffcc00' : undefined }} 
              onClick={applyReferenceScale} disabled={!referenceId || selection.length === 0}>
               <FolderSync size={16} /> Igualar Resolución
            </button>
            <button className="btn btn-outline" style={{ marginTop: '8px', width: '100%', borderColor: referenceId ? '#ffcc00' : undefined, color: referenceId ? '#ffcc00' : undefined }} 
              onClick={applyReferenceAlignment} disabled={!referenceId || selection.length === 0}>
               <Save size={16} /> Alinear por Referencia
            </button>
          </div>

          <div className="card">
            <span className="card-title">Ajuste Dinámico - Dimensiones</span>
            <div className="slider-group">
              <div className="slider-item">
                <div className="slider-label"><span>Escala</span><span>{firstSelected ? (firstSelected.scale || 1).toFixed(2) : 1}x</span></div>
                <input type="range" min="0.1" max="4" step="0.05" value={firstSelected ? (firstSelected.scale || 1) : 1}
                  onChange={(e) => updateBulkScale(parseFloat(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
                <div className="slider-item" style={{ marginBottom: 0 }}>
                  <div className="slider-label"><span>Ancho (px)</span></div>
                  <input type="number" step="1" style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', color: 'white', padding: '4px', borderRadius: '4px' }}
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
                  <input type="range" min="0.1" max="4" step="0.05" value={firstSelected ? (firstSelected.stretchX || 1) : 1}
                    onChange={(e) => updateBulkStretchX(parseFloat(e.target.value))} disabled={selection.length === 0}
                  />
                </div>
                <div className="slider-item">
                  <div className="slider-label"><span>Estirar V</span><span>{firstSelected ? (firstSelected.stretchY || 1).toFixed(2) : '1.00'}x</span></div>
                  <input type="range" min="0.1" max="4" step="0.05" value={firstSelected ? (firstSelected.stretchY || 1) : 1}
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
            <span className="card-title">Ajuste Dinámico - Efectos</span>
            <div className="slider-group">
              <div className="slider-item">
                <div className="slider-label"><span>Pixelación</span><span>{firstSelected ? (firstSelected.pixelation || 1) : 1}px</span></div>
                <input type="range" min="1" max="100" value={firstSelected ? (firstSelected.pixelation || 1) : 1}
                  onChange={(e) => updateBulkPixelation(parseInt(e.target.value))} disabled={selection.length === 0}
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
                <div className="slider-label"><span>Tono (Hue)</span><span>{firstSelected ? (firstSelected.hue ?? 0) : 0}º</span></div>
                <input type="range" min="0" max="360" value={firstSelected ? (firstSelected.hue ?? 0) : 0}
                  onChange={(e) => updateBulkFilter('hue', parseInt(e.target.value))} disabled={selection.length === 0}
                />
              </div>
              <div className="slider-item">
                <div className="slider-label"><span>Opacidad</span><span>{firstSelected ? (firstSelected.opacity ?? 100) : 100}%</span></div>
                <input type="range" min="0" max="100" value={firstSelected ? (firstSelected.opacity ?? 100) : 100}
                  onChange={(e) => updateBulkFilter('opacity', parseInt(e.target.value))} disabled={selection.length === 0}
                />
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

              {/* Layer Effects Group */}
              <div style={{ background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '8px', marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span style={{ fontSize: '0.65rem', fontWeight: 'bold', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Contorno y Capas</span>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', alignItems: 'center' }}>
                  <div className="slider-item" style={{ marginBottom: 0 }}>
                    <div className="slider-label"><span>Contorno (p)</span><span>{firstSelected?.outlineWidth || 0}px</span></div>
                    <input type="range" min="0" max="10" value={firstSelected?.outlineWidth || 0}
                      onChange={(e) => updateBulkFilter('outlineWidth', parseInt(e.target.value))} disabled={selection.length === 0}
                    />
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
                onClick={applyReferencePixelation} disabled={!referenceId || selection.length === 0}>
                 <Grid size={16} /> Igualar Pixelación
              </button>
            </div>
          </div>

          <div className="card">
            <span className="card-title">Visualización</span>
            <input type="range" min="0.5" max="2" step="0.1" value={gridZoom} onChange={(e) => setGridZoom(parseFloat(e.target.value))} />
          </div>

          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <button className="btn btn-outline" onClick={() => setSelection(sprites.map((s: SpriteData) => s.id))}><CheckSquare size={16} /> Todos</button>
            <button className="btn btn-danger" onClick={() => { 
              const next = sprites.filter((s: SpriteData) => !selection.includes(s.id));
              commitSprites(next);
              setSelection([]); 
            }}><Trash2 size={16} /> Eliminar</button>
          </div>
        </aside>
      </div>

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
    </div>
  );
};

export default App;
