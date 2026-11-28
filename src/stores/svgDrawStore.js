import { create } from 'zustand';
import {
  buildSvgDocument,
  elementToSvgMarkup as serializeElementToSvgMarkup,
} from '../services/svgBuilder';

// ---------------------------------------------------------------------------
// SVG drawing store
//
// Holds the drawing state for the SVG space drawing canvas: the active tool,
// per-tool color/size settings, committed elements plus the in-progress draft
// element, undo/redo history and the canvas size. Also serializes the element
// list into SVG syntax so the overlay can render a live syntax preview.
// ---------------------------------------------------------------------------

export const SVG_DRAW_TOOLS = ['pencil', 'rect', 'circle', 'line', 'text'];

// Per-tool defaults. For shapes/lines `size` is the stroke width, for text it
// is the font size (px). Colors default to white so they read on dark planes.
const DEFAULT_TOOL_SETTINGS = {
  pencil: { color: '#ffffff', size: 3 },
  rect: { color: '#ffffff', size: 2 },
  circle: { color: '#ffffff', size: 2 },
  line: { color: '#ffffff', size: 2 },
  text: { color: '#ffffff', size: 18 },
};

const DEFAULT_CANVAS_SIZE = { width: 960, height: 540 };

let nextElementId = 1;
function makeElementId() {
  return `el-${Date.now().toString(36)}-${nextElementId++}`;
}

// ---------------------------------------------------------------------------
// Serialization
//
// All SVG serialization lives in the canonical svgBuilder service
// (src/services/svgBuilder.js). The store re-exports the per-element helper
// for API stability; full documents come from buildSvgDocument via
// getSvgString below.
// ---------------------------------------------------------------------------

export function elementToSvgMarkup(el) {
  return serializeElementToSvgMarkup(el);
}

// Full-document serialization (getSvgString) delegates to the canonical
// svgBuilder service, so the saved SVG file is byte-for-byte what getSvgString
// and the overlay's live syntax preview produce.

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useSvgDrawStore = create((set, get) => ({
  // Current tool: 'pencil' | 'rect' | 'circle' | 'line' | 'text'
  tool: 'pencil',

  // Per-tool color/size, so switching tools keeps each tool's last settings.
  toolSettings: { ...DEFAULT_TOOL_SETTINGS },

  // Committed drawing elements (see elementToSvgMarkup for shapes).
  elements: [],

  // In-progress element while dragging, or null.
  draft: null,

  // Undo/redo stacks (each entry is a previous `elements` array).
  history: [],
  future: [],

  // Logical canvas size the SVG viewBox is derived from.
  canvasSize: { ...DEFAULT_CANVAS_SIZE },

  // --- tool / settings ----------------------------------------------------

  setTool: (tool) => {
    if (!SVG_DRAW_TOOLS.includes(tool)) return;
    // Switching tools cancels any half-drawn element.
    set({ tool, draft: null });
  },

  setToolColor: (tool, color) => {
    if (!SVG_DRAW_TOOLS.includes(tool) || !color) return;
    set((state) => ({
      toolSettings: {
        ...state.toolSettings,
        [tool]: { ...state.toolSettings[tool], color },
      },
    }));
  },

  setToolSize: (tool, size) => {
    if (!SVG_DRAW_TOOLS.includes(tool)) return;
    const n = Number(size);
    if (!Number.isFinite(n) || n <= 0) return;
    set((state) => ({
      toolSettings: {
        ...state.toolSettings,
        [tool]: { ...state.toolSettings[tool], size: n },
      },
    }));
  },

  setCanvasSize: (width, height) => {
    const w = Math.max(1, Math.round(Number(width) || DEFAULT_CANVAS_SIZE.width));
    const h = Math.max(1, Math.round(Number(height) || DEFAULT_CANVAS_SIZE.height));
    set({ canvasSize: { width: w, height: h } });
  },

  // --- drawing ------------------------------------------------------------

  // Start a new draft element at [x, y] using the current tool's settings.
  beginElement: (x, y) => {
    const { tool, toolSettings } = get();
    const settings = toolSettings[tool];
    const id = makeElementId();
    let draft = null;
    switch (tool) {
      case 'pencil':
        draft = { id, type: 'pencil', points: [[x, y]], color: settings.color, strokeWidth: settings.size };
        break;
      case 'rect':
        draft = { id, type: 'rect', x, y, width: 0, height: 0, color: settings.color, strokeWidth: settings.size };
        break;
      case 'circle':
        draft = { id, type: 'circle', cx: x, cy: y, r: 0, color: settings.color, strokeWidth: settings.size };
        break;
      case 'line':
        draft = { id, type: 'line', x1: x, y1: y, x2: x, y2: y, color: settings.color, strokeWidth: settings.size };
        break;
      case 'text':
        // Text is placed via a text input in the overlay, not dragged.
        return null;
      default:
        return null;
    }
    set({ draft });
    return id;
  },

  // Extend the current draft to [x, y].
  updateDraft: (x, y) => {
    const { draft } = get();
    if (!draft) return;
    let next = draft;
    switch (draft.type) {
      case 'pencil':
        next = { ...draft, points: [...draft.points, [x, y]] };
        break;
      case 'rect':
        next = {
          ...draft,
          x: Math.min(draft.x, x),
          y: Math.min(draft.y, y),
          width: Math.abs(x - draft.x),
          height: Math.abs(y - draft.y),
        };
        break;
      case 'circle':
        next = { ...draft, r: Math.max(1, Math.hypot(x - draft.cx, y - draft.cy)) };
        break;
      case 'line':
        next = { ...draft, x2: x, y2: y };
        break;
      default:
        return;
    }
    set({ draft: next });
  },

  // Commit the draft into `elements` (pushes undo history). Tiny/no-op shapes
  // (accidental clicks) are discarded.
  commitDraft: () => {
    const { draft, elements, history } = get();
    if (!draft) return;
    // Discard stray clicks: pencil dots, zero-size shapes, unmoved lines.
    const isTrivial =
      (draft.type === 'pencil' && draft.points.length < 2) ||
      (draft.type === 'rect' && (draft.width === 0 || draft.height === 0)) ||
      (draft.type === 'circle' && draft.r === 0) ||
      (draft.type === 'line' && draft.x1 === draft.x2 && draft.y1 === draft.y2);
    if (isTrivial) {
      set({ draft: null });
      return;
    }
    set({
      elements: [...elements, { ...draft, id: makeElementId() }],
      history: [...history, elements],
      future: [],
      draft: null,
    });
  },

  cancelDraft: () => set({ draft: null }),

  // Commit a text element placed at [x, y] (baseline y).
  addTextElement: (x, y, text) => {
    if (!text || !String(text).trim()) return;
    const { toolSettings, elements, history } = get();
    const el = {
      id: makeElementId(),
      type: 'text',
      x,
      y,
      text: String(text),
      color: toolSettings.text.color,
      fontSize: toolSettings.text.size,
    };
    set({
      elements: [...elements, el],
      history: [...history, elements],
      future: [],
    });
  },

  deleteElement: (id) => {
    const { elements, history } = get();
    if (!elements.some((el) => el.id === id)) return;
    set({
      elements: elements.filter((el) => el.id !== id),
      history: [...history, elements],
      future: [],
    });
  },

  // --- history ------------------------------------------------------------

  undo: () => {
    const { elements, history, future } = get();
    if (!history.length) return;
    const prev = history[history.length - 1];
    set({
      elements: prev,
      history: history.slice(0, -1),
      future: [elements, ...future],
      draft: null,
    });
  },

  redo: () => {
    const { elements, history, future } = get();
    if (!future.length) return;
    const next = future[0];
    set({
      elements: next,
      history: [...history, elements],
      future: future.slice(1),
      draft: null,
    });
  },

  clearAll: () => {
    const { elements, history } = get();
    if (!elements.length) {
      set({ draft: null });
      return;
    }
    set({
      elements: [],
      history: [...history, elements],
      future: [],
      draft: null,
    });
  },

  // --- serialization --------------------------------------------------------

  // Elements to serialize: committed + current draft (live preview).
  getDrawableElements: () => {
    const { elements, draft } = get();
    return draft ? [...elements, draft] : elements;
  },

  getSvgString: () => {
    const { getDrawableElements, canvasSize } = get();
    return buildSvgDocument(getDrawableElements(), canvasSize);
  },
}));

export default useSvgDrawStore;
