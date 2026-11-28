// ---------------------------------------------------------------------------
// svgBuilder — drawing-to-SVG serializer for SVG spaces.
//
// Converts the SVG draw store's canvas tool edits (the element list produced
// by SvgDrawOverlay2D: pencil strokes, rect/circle/line shapes, text) into
// standalone SVG file content that can be saved through the storage API and
// re-parsed later for playback.
//
// This module is the single source of truth for the SVG document that reaches
// storage. The draw store's live syntax preview delegates its `getSvgString`
// to `buildSvgDocument`, so what the user previews is byte-for-byte what gets
// saved. The module is pure (no imports, no DOM) so it also runs in tests and
// workers.
//
// Element schema (see src/stores/svgDrawStore.js):
//   pencil: { id, type:'pencil', points:[[x,y],...], color, strokeWidth }
//   rect:   { id, type:'rect',   x, y, width, height,      color, strokeWidth }
//   circle: { id, type:'circle', cx, cy, r,                color, strokeWidth }
//   line:   { id, type:'line',   x1, y1, x2, y2,            color, strokeWidth }
//   text:   { id, type:'text',   x, y, text,                color, fontSize }
// ---------------------------------------------------------------------------

export const SVG_XMLNS = 'http://www.w3.org/2000/svg';

// Matches the draw store's default canvas so serialization never invents a
// different viewBox than the editor drew against.
export const DEFAULT_SVG_CANVAS_SIZE = { width: 960, height: 540 };

const DEFAULT_PRECISION = 2;
const DEFAULT_STROKE_WIDTH = 1;
const DEFAULT_FONT_SIZE = 18;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

// Round to `precision` decimals to keep saved files compact and stable.
function round(n, precision = DEFAULT_PRECISION) {
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** precision;
  return Math.round(n * factor) / factor;
}

// Escape a value for use both in attribute values and text content.
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Clamp a canvas size to finite, positive integers.
export function sanitizeCanvasSize(size) {
  const src = size && typeof size === 'object' ? size : {};
  const width = Math.max(1, Math.round(num(src.width, DEFAULT_SVG_CANVAS_SIZE.width)));
  const height = Math.max(1, Math.round(num(src.height, DEFAULT_SVG_CANVAS_SIZE.height)));
  return { width, height };
}

// Element ids are generated as `el-...` (safe XML names). Only ids matching a
// conservative pattern are embedded; anything else is dropped rather than
// producing invalid markup.
function safeElementId(id) {
  return typeof id === 'string' && /^[\w:.-]+$/.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Element -> SVG markup
// ---------------------------------------------------------------------------

/**
 * Serialize one drawing element to its SVG markup, or '' if the element is
 * unusable (null, unknown type, or degenerate geometry such as a zero-radius
 * circle). `options.precision` controls coordinate rounding,
 * `options.includeElementIds` embeds the editor element id as `data-el-id`
 * (default true) so a saved drawing can be re-edited without losing identity.
 */
export function elementToSvgMarkup(el, options = {}) {
  if (!el || typeof el !== 'object') return '';
  const precision = Number.isFinite(options.precision)
    ? options.precision
    : DEFAULT_PRECISION;
  const includeElementId = options.includeElementId !== false;
  const r = (n) => round(num(n), precision);
  const idAttr = includeElementId && safeElementId(el.id)
    ? ` data-el-id="${safeElementId(el.id)}"`
    : '';

  switch (el.type) {
    case 'pencil': {
      const points = (Array.isArray(el.points) ? el.points : [])
        .map((p) => (Array.isArray(p) ? [num(p[0]), num(p[1])] : [num(p?.x), num(p?.y)]))
        .map(([x, y]) => `${r(x)},${r(y)}`)
        .join(' ');
      if (!points) return '';
      const strokeWidth = Math.max(0.1, num(el.strokeWidth, DEFAULT_STROKE_WIDTH));
      return `<polyline points="${points}" fill="none" stroke="${escapeXml(el.color || '#000')}" stroke-width="${r(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"${idAttr} />`;
    }
    case 'rect': {
      // Normalize negative/zero extents so the saved geometry is always valid.
      let x = num(el.x);
      let y = num(el.y);
      let width = num(el.width);
      let height = num(el.height);
      if (width < 0) {
        x += width;
        width = -width;
      }
      if (height < 0) {
        y += height;
        height = -height;
      }
      if (width <= 0 || height <= 0) return '';
      const strokeWidth = Math.max(0.1, num(el.strokeWidth, DEFAULT_STROKE_WIDTH));
      return `<rect x="${r(x)}" y="${r(y)}" width="${r(width)}" height="${r(height)}" fill="none" stroke="${escapeXml(el.color || '#000')}" stroke-width="${r(strokeWidth)}"${idAttr} />`;
    }
    case 'circle': {
      const radius = num(el.r);
      if (radius <= 0) return '';
      const strokeWidth = Math.max(0.1, num(el.strokeWidth, DEFAULT_STROKE_WIDTH));
      return `<circle cx="${r(el.cx)}" cy="${r(el.cy)}" r="${r(radius)}" fill="none" stroke="${escapeXml(el.color || '#000')}" stroke-width="${r(strokeWidth)}"${idAttr} />`;
    }
    case 'line': {
      const isPoint = num(el.x1) === num(el.x2) && num(el.y1) === num(el.y2);
      if (isPoint) return '';
      const strokeWidth = Math.max(0.1, num(el.strokeWidth, DEFAULT_STROKE_WIDTH));
      return `<line x1="${r(el.x1)}" y1="${r(el.y1)}" x2="${r(el.x2)}" y2="${r(el.y2)}" stroke="${escapeXml(el.color || '#000')}" stroke-width="${r(strokeWidth)}" stroke-linecap="round"${idAttr} />`;
    }
    case 'text': {
      const text = el.text == null ? '' : String(el.text);
      if (!text.trim()) return '';
      const fontSize = Math.max(1, num(el.fontSize, DEFAULT_FONT_SIZE));
      return `<text x="${r(el.x)}" y="${r(el.y)}" fill="${escapeXml(el.color || '#000')}" font-size="${r(fontSize)}" font-family="sans-serif"${idAttr}>${escapeXml(text)}</text>`;
    }
    default:
      return '';
  }
}

/**
 * Serialize an element list to the SVG document body (one element per line,
 * indented). Unknown/unusable elements are skipped.
 */
export function elementsToSvgBody(elements, options = {}) {
  const list = Array.isArray(elements) ? elements : [];
  const indent = typeof options.indent === 'string' ? options.indent : '  ';
  const lines = list
    .map((el) => elementToSvgMarkup(el, options))
    .filter(Boolean)
    .map((markup) => indent + markup);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

/**
 * Build a complete standalone SVG document from drawing elements.
 *
 * @param {Array} elements - Drawing elements (canvas tool edits) from the
 *   SVG draw store.
 * @param {{width:number, height:number}} [canvasSize] - Logical canvas the
 *   drawing was made against; becomes the viewBox + intrinsic size.
 * @param {Object} [options]
 * @param {string|null} [options.background] - Optional background fill color
 *   (e.g. '#0b1020'); omit/undefined keeps the SVG transparent.
 * @param {number} [options.precision] - Coordinate decimal places (default 2).
 * @param {boolean} [options.includeElementIds=true] - Embed editor element ids
 *   as `data-el-id` attributes so saved drawings stay re-editable.
 * @param {boolean} [options.includeXmlDeclaration=false] - Prepend the XML
 *   declaration for strict XML consumers.
 * @param {string} [options.title] - Optional accessible `<title>` element.
 * @returns {string} Full SVG file content.
 */
export function buildSvgDocument(elements, canvasSize, options = {}) {
  const { width, height } = sanitizeCanvasSize(canvasSize);
  const precision = Number.isFinite(options.precision)
    ? options.precision
    : DEFAULT_PRECISION;
  const includeElementIds = options.includeElementId !== false;
  const opts = { precision, includeElementId: includeElementIds };

  const body = elementsToSvgBody(elements, opts);
  const backgroundRect = options.background
    ? `\n  <rect x="0" y="0" width="${round(width, precision)}" height="${round(height, precision)}" fill="${escapeXml(options.background)}" />`
    : '';
  const titleEl = options.title
    ? `\n  <title>${escapeXml(options.title)}</title>`
    : '';

  const declaration = options.includeXmlDeclaration
    ? '<?xml version="1.0" encoding="UTF-8"?>\n'
    : '';

  return `${declaration}<svg xmlns="${SVG_XMLNS}" viewBox="0 0 ${round(width, precision)} ${round(height, precision)}" width="${round(width, precision)}" height="${round(height, precision)}">${titleEl}${backgroundRect}\n${body || ''}\n</svg>`;
}

// ---------------------------------------------------------------------------
// Small utilities for the save flow
// ---------------------------------------------------------------------------

/**
 * Byte size of serialized content (UTF-8). Works in browser and Node.
 */
export function estimateSvgByteSize(content) {
  if (typeof content !== 'string') return 0;
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(content).length;
  }
  return content.length;
}

/**
 * Timestamped file name for saving a drawing, e.g.
 * `svg-drawing-2025-01-15-1432-a1b2.svg`.
 */
export function makeSvgFileName(now = new Date(), prefix = 'svg-drawing') {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${stamp}-${rand}.svg`;
}
