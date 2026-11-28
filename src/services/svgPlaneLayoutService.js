// ---------------------------------------------------------------------------
// svgPlaneLayoutService — spatial layout for saved SVG plane objects.
//
// Saved SVG drawings become `svg_plane` objects arranged in a world-space
// grid: 8 planes per row, laid out left to right; when a row fills, the next
// plane wraps to a new row underneath (y decreases), so the grid grows toward
// the lower field of view without ever overlapping the anchor plane.
//
// The grid is anchored at an origin point (in front of the camera at first
// save — see svgPlaneService) and addressed by a compact integer index:
// plane i sits at column (i % 8), row floor(i / 8). Slots are recycled
// compactly when planes are deleted, so the grid never develops holes.
//
// This module is pure (no imports, no DOM, no store access) so the layout is
// testable and the save flow stays free of grid arithmetic.
// ---------------------------------------------------------------------------

// Object type used for saved SVG drawings (persisted via objectsStore
// extraData; rendered by the SVG plane renderer).
export const SVG_PLANE_OBJECT_TYPE = 'svg_plane';

// Grid shape: 8 planes per row before wrapping to a new row underneath.
export const SVG_PLANES_PER_ROW = 8;

// World-unit spacing between plane centers (columns) and between rows.
// Rows step downward (negative y) so wrapped rows appear underneath.
export const SVG_PLANE_SPACING_X = 100;
export const SVG_PLANE_SPACING_Y = 70;

// True if the object is a saved SVG drawing plane.
export function isSvgPlaneObject(obj) {
  return !!obj && obj.type === SVG_PLANE_OBJECT_TYPE;
}

// Grid cell for a plane index: column grows right, row grows downward.
export function svgPlaneCell(index) {
  const i = Math.max(0, Math.floor(Number(index) || 0));
  return {
    col: i % SVG_PLANES_PER_ROW,
    row: Math.floor(i / SVG_PLANES_PER_ROW),
  };
}

// Offset [dx, dy, dz] from the grid origin for a plane index. Row 0 sits at
// the origin; each wrapped row sits underneath it (negative y).
export function svgPlaneOffset(index) {
  const { col, row } = svgPlaneCell(index);
  return [col * SVG_PLANE_SPACING_X, -row * SVG_PLANE_SPACING_Y, 0];
}

// Absolute world position [x, y, z] for plane `index` on a grid anchored at
// `origin` ([x, y, z]).
export function svgPlanePosition(index, origin) {
  const [dx, dy, dz] = svgPlaneOffset(index);
  const base = Array.isArray(origin) ? origin : [0, 0, 0];
  return [
    (Number(base[0]) || 0) + dx,
    (Number(base[1]) || 0) + dy,
    (Number(base[2]) || 0) + dz,
  ];
}

// All saved SVG planes in a space (filters an objects list).
export function collectSvgPlanes(objects) {
  return (Array.isArray(objects) ? objects : []).filter(isSvgPlaneObject);
}

// Grid indices currently occupied. Prefers the stored `svgGridIndex` (written
// at save time); falls back to the plane's list order so objects saved without
// an index still occupy a slot and are never overwritten.
export function usedSvgPlaneIndices(planes) {
  const used = new Set();
  (Array.isArray(planes) ? planes : []).forEach((plane, order) => {
    const idx = Number(plane?.svgGridIndex);
    used.add(Number.isFinite(idx) && idx >= 0 ? Math.floor(idx) : order);
  });
  return used;
}

// Next free grid index: the smallest unused slot, so deleting a plane lets a
// later save reuse its cell instead of leaving a hole in the grid.
export function nextSvgPlaneIndex(objects) {
  const used = usedSvgPlaneIndices(collectSvgPlanes(objects));
  let index = 0;
  while (used.has(index)) index += 1;
  return index;
}

// Convenience: world position for the next plane on a grid anchored at
// `origin`, given the space's current objects.
export function nextSvgPlanePosition(objects, origin) {
  return svgPlanePosition(nextSvgPlaneIndex(objects), origin);
}
