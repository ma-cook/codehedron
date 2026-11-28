import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import useSvgDrawStore from '../stores/svgDrawStore';
import { buildSvgDocument } from '../services/svgBuilder';

// ---------------------------------------------------------------------------
// SvgDrawOverlay2D — drawing panel for SVG spaces.
//
// Floating panel (right side) with:
//   - tool buttons: pencil, rect, circle, line, text
//   - per-tool color picker (react-colorful) + preset swatches
//   - per-tool size control (stroke width for shapes, font size for text)
//   - drawing canvas with live rendering of committed elements + draft
//   - undo / redo / clear
//   - live SVG syntax preview of the current drawing
// ---------------------------------------------------------------------------

const TOOLS = [
  { key: 'pencil', glyph: '✏️', label: 'Pencil' },
  { key: 'rect', glyph: '▭', label: 'Rectangle' },
  { key: 'circle', glyph: '◯', label: 'Circle' },
  { key: 'line', glyph: '╱', label: 'Line' },
  { key: 'text', glyph: 'T', label: 'Text' },
];

const PRESET_COLORS = [
  '#ffffff', '#000000', '#ff4d4f', '#ffa940',
  '#ffd666', '#52c41a', '#40a9ff', '#b197fc',
];

// Displayed canvas width (px); height follows the logical aspect ratio.
const CANVAS_DISPLAY_WIDTH = 520;

const SIZE_RANGE = {
  stroke: { min: 1, max: 16, step: 1 },
  text: { min: 8, max: 72, step: 1 },
};

function renderSvgElement(el, isDraft) {
  const opacity = isDraft ? 0.85 : 1;
  switch (el.type) {
    case 'pencil':
      return (
        <polyline
          key={el.id}
          points={el.points.map((p) => `${p[0]},${p[1]}`).join(' ')}
          fill="none"
          stroke={el.color}
          strokeWidth={el.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={opacity}
        />
      );
    case 'rect':
      return (
        <rect
          key={el.id}
          x={el.x}
          y={el.y}
          width={el.width}
          height={el.height}
          fill="none"
          stroke={el.color}
          strokeWidth={el.strokeWidth}
          opacity={opacity}
        />
      );
    case 'circle':
      return (
        <circle
          key={el.id}
          cx={el.cx}
          cy={el.cy}
          r={el.r}
          fill="none"
          stroke={el.color}
          strokeWidth={el.strokeWidth}
          opacity={opacity}
        />
      );
    case 'line':
      return (
        <line
          key={el.id}
          x1={el.x1}
          y1={el.y1}
          x2={el.x2}
          y2={el.y2}
          stroke={el.color}
          strokeWidth={el.strokeWidth}
          strokeLinecap="round"
          opacity={opacity}
        />
      );
    case 'text':
      return (
        <text
          key={el.id}
          x={el.x}
          y={el.y}
          fill={el.color}
          fontSize={el.fontSize}
          fontFamily="sans-serif"
          opacity={opacity}
        >
          {el.text}
        </text>
      );
    default:
      return null;
  }
}

const SvgDrawOverlay2D = () => {
  // Store slices (narrow selectors keep redraws cheap while drawing).
  const tool = useSvgDrawStore((s) => s.tool);
  const toolSettings = useSvgDrawStore((s) => s.toolSettings);
  const elements = useSvgDrawStore((s) => s.elements);
  const draft = useSvgDrawStore((s) => s.draft);
  const canvasSize = useSvgDrawStore((s) => s.canvasSize);
  const historyLen = useSvgDrawStore((s) => s.history.length);
  const futureLen = useSvgDrawStore((s) => s.future.length);

  const setTool = useSvgDrawStore((s) => s.setTool);
  const setToolColor = useSvgDrawStore((s) => s.setToolColor);
  const setToolSize = useSvgDrawStore((s) => s.setToolSize);
  const beginElement = useSvgDrawStore((s) => s.beginElement);
  const updateDraft = useSvgDrawStore((s) => s.updateDraft);
  const commitDraft = useSvgDrawStore((s) => s.commitDraft);
  const addTextElement = useSvgDrawStore((s) => s.addTextElement);
  const undo = useSvgDrawStore((s) => s.undo);
  const redo = useSvgDrawStore((s) => s.redo);
  const clearAll = useSvgDrawStore((s) => s.clearAll);

  // Local UI state
  const [colorPopopen, setColorPopopen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [textPlacement, setTextPlacement] = useState(null); // { x, y, value }

  const svgRef = useRef(null);

  const settings = toolSettings[tool];
  const isTextTool = tool === 'text';
  const sizeRange = isTextTool ? SIZE_RANGE.text : SIZE_RANGE.stroke;

  const scale = CANVAS_DISPLAY_WIDTH / canvasSize.width;
  const displayHeight = Math.round(canvasSize.height * scale);

  // Live SVG syntax: committed + in-progress draft, serialized through the
  // canonical svgBuilder so the preview is exactly what gets saved.
  const svgSyntax = useMemo(
    () => buildSvgDocument(draft ? [...elements, draft] : elements, canvasSize),
    [elements, draft, canvasSize]
  );

  // --- pointer handling -----------------------------------------------------

  const toCanvasPoint = useCallback(
    (clientX, clientY) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return [0, 0];
      const x = (clientX - rect.left) / scale;
      const y = (clientY - rect.top) / scale;
      return [
        Math.max(0, Math.min(canvasSize.width, x)),
        Math.max(0, Math.min(canvasSize.height, y)),
      ];
    },
    [scale, canvasSize.width, canvasSize.height]
  );

  const handlePointerDown = useCallback(
    (e) => {
      setColorPopopen(false);
      const [x, y] = toCanvasPoint(e.clientX, e.clientY);
      if (isTextTool) {
        setTextPlacement({ x, y, value: '' });
        return;
      }
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDragging(true);
      beginElement(x, y);
    },
    [toCanvasPoint, isTextTool, beginElement]
  );

  const handlePointerMove = useCallback(
    (e) => {
      if (!dragging) return;
      const [x, y] = toCanvasPoint(e.clientX, e.clientY);
      updateDraft(x, y);
    },
    [dragging, toCanvasPoint, updateDraft]
  );

  const handlePointerUp = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    commitDraft();
  }, [dragging, commitDraft]);

  // --- text tool ------------------------------------------------------------

  const commitTextPlacement = useCallback(() => {
    if (!textPlacement) return;
    addTextElement(textPlacement.x, textPlacement.y, textPlacement.value);
    setTextPlacement(null);
  }, [textPlacement, addTextElement]);

  const handleTextKeyDown = useCallback(
    (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        commitTextPlacement();
      } else if (e.key === 'Escape') {
        setTextPlacement(null);
      }
    },
    [commitTextPlacement]
  );

  // --- keyboard shortcuts (undo/redo) ---------------------------------------

  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  // --- render helpers ---------------------------------------------------------

  const renderToolButton = ({ key, glyph, label }) => (
    <button
      key={key}
      type="button"
      className={`svg-draw-tool-btn${tool === key ? ' is-active' : ''}`}
      onClick={() => {
        setColorPopopen(false);
        setTextPlacement(null);
        setTool(key);
      }}
      title={label}
      aria-label={label}
      aria-pressed={tool === key}
    >
      {glyph}
    </button>
  );

  return (
    <div className="svg-draw-overlay">
      <div className="svg-draw-toolbar">
        <div className="svg-draw-tools">{TOOLS.map(renderToolButton)}</div>
        <div className="svg-draw-history">
          <button
            type="button"
            className="svg-draw-tool-btn"
            onClick={undo}
            disabled={historyLen === 0}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            ↩
          </button>
          <button
            type="button"
            className="svg-draw-tool-btn"
            onClick={redo}
            disabled={futureLen === 0}
            title="Redo (Ctrl+Y)"
            aria-label="Redo"
          >
            ↪
          </button>
          <button
            type="button"
            className="svg-draw-tool-btn svg-draw-clear"
            onClick={clearAll}
            disabled={elements.length === 0}
            title="Clear drawing"
            aria-label="Clear drawing"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="svg-draw-settings">
        <div className="svg-draw-color-wrap">
          <button
            type="button"
            className="svg-draw-color-swatch"
            style={{ background: settings.color }}
            onClick={() => setColorPopopen((v) => !v)}
            title={`Color for ${tool} tool`}
            aria-label={`Color for ${tool} tool`}
          />
          {colorPopopen && (
            <div
              className="svg-draw-color-popover"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <HexColorPicker
                color={settings.color}
                onChange={(color) => setToolColor(tool, color)}
              />
              <div className="svg-draw-color-presets">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`svg-draw-preset${c.toLowerCase() === settings.color.toLowerCase() ? ' is-active' : ''}`}
                    style={{ background: c }}
                    onClick={() => setToolColor(tool, c)}
                    title={c}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
        <label className="svg-draw-size">
          <span className="svg-draw-size-label">
            {isTextTool ? 'Font' : 'Stroke'} {settings.size}
          </span>
          <input
            type="range"
            min={sizeRange.min}
            max={sizeRange.max}
            step={sizeRange.step}
            value={settings.size}
            onChange={(e) => setToolSize(tool, e.target.value)}
            aria-label={`${isTextTool ? 'Font size' : 'Stroke width'} for ${tool} tool`}
          />
        </label>
      </div>

      <div className="svg-draw-canvas-wrap">
        <svg
          ref={svgRef}
          className="svg-draw-canvas"
          width={CANVAS_DISPLAY_WIDTH}
          height={displayHeight}
          viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
          style={{ cursor: isTextTool ? 'text' : 'crosshair', touchAction: 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <rect
            x={0}
            y={0}
            width={canvasSize.width}
            height={canvasSize.height}
            fill="rgba(255,255,255,0.02)"
          />
          {elements.map((el) => renderSvgElement(el, false))}
          {draft && renderSvgElement(draft, true)}
        </svg>
        {textPlacement && (
          <input
            className="svg-draw-text-input"
            autoFocus
            type="text"
            value={textPlacement.value}
            style={{
              left: textPlacement.x * scale,
              top: (textPlacement.y - toolSettings.text.size * 0.9) * scale,
              height: toolSettings.text.size * 1.2 * scale,
              fontSize: toolSettings.text.size * scale,
              color: toolSettings.text.color,
            }}
            onChange={(e) =>
              setTextPlacement((p) => ({ ...p, value: e.target.value }))
            }
            onKeyDown={handleTextKeyDown}
            onBlur={commitTextPlacement}
            placeholder="type…"
          />
        )}
      </div>

      <div className="svg-draw-syntax">
        <div className="svg-draw-syntax-header">
          <span>SVG</span>
          <span className="svg-draw-syntax-meta">
            {elements.length} element{elements.length === 1 ? '' : 's'}
          </span>
        </div>
        <pre
          className="svg-draw-code"
          onDoubleClick={() => navigator.clipboard?.writeText(svgSyntax)}
          title="Double-click to copy"
        >
          {svgSyntax}
        </pre>
      </div>
    </div>
  );
};

export default SvgDrawOverlay2D;
