// ---------------------------------------------------------------------------
// svgPlaneService — save flow for SVG space drawings.
//
// Turns the SvgDrawOverlay2D canvas (svgDrawStore elements + in-progress
// draft) into a persisted scene object:
//   1. serialize the drawing to a standalone SVG document (svgBuilder)
//   2. upload it through the backend storage API (storageService)
//   3. create an `svg_plane` object via objectsStore, positioned on the
//      shared grid anchored in front of the camera (svgPlaneLayoutService)
//
// Grid anchoring: the FIRST plane of a space is placed in front of the
// camera and its position is persisted on the object as `svgGridOrigin`.
// Every later save reads that origin back from the existing planes and lays
// out the next free slot (8 per row, wrapping to a row underneath), so the
// grid stays coherent across sessions without recomputing the anchor.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import useSvgDrawStore from '../stores/svgDrawStore';
import useObjectsStore from '../stores/objectsStore';
import useAuthStore from '../stores/authStore';
import useSpaceManagerStore from '../stores/spaceManagerStore';
import { buildSvgDocument } from './svgBuilder';
import { uploadSvgToStorage } from './storageService';
import {
  SVG_PLANE_OBJECT_TYPE,
  nextSvgPlaneIndex,
  svgPlanePosition,
} from './svgPlaneLayoutService';

// Distance in front of the camera for the first plane — matches the default
// object distance in objectsStore.handleCreateObject.
const SAVE_DISTANCE = 75;
// Fallback anchor when no camera is reachable (mirrors objectsStore).
const FALLBACK_ORIGIN = [0, 0, -75];

// Resolve the camera the same way objectsStore does (orbit controls global;
// the DOM overlay has no R3F cameraRef). Returns [x, y, z].
function positionInFrontOfCamera() {
  const camera = window.orbitControls?.object;
  if (!camera) return FALLBACK_ORIGIN;
  const cameraPos = new THREE.Vector3();
  camera.getWorldPosition(cameraPos);
  const direction = new THREE.Vector3(0, 0, -1);
  direction.applyQuaternion(camera.quaternion);
  return [
    cameraPos.x + direction.x * SAVE_DISTANCE,
    cameraPos.y + direction.y * SAVE_DISTANCE,
    cameraPos.z + direction.z * SAVE_DISTANCE,
  ];
}

// Recover the grid anchor persisted on previously saved planes (the lowest
// index wins). Returns null when the space has no planes yet.
function resolveGridOrigin(objects) {
  let origin = null;
  let bestIndex = Infinity;
  (Array.isArray(objects) ? objects : []).forEach((obj) => {
    if (obj?.type !== SVG_PLANE_OBJECT_TYPE) return;
    const idx = Number(obj.svgGridIndex);
    const order = Number.isFinite(idx) && idx >= 0 ? idx : Infinity;
    if (Array.isArray(obj.svgGridOrigin) && order < bestIndex) {
      origin = obj.svgGridOrigin;
      bestIndex = order;
    }
  });
  return origin;
}

/**
 * Save the current drawing as an SVG plane object.
 *
 * @param {object} [options]
 * @param {string} [options.fileName] Optional storage file name (defaults to
 *   a generated uuid .svg inside uploadSvgToStorage).
 * @returns {Promise<{id: string, svgUrl: string, index: number,
 *   position: number[], elementCount: number}>}
 * @throws Error with a user-facing message when the drawing is empty, the
 *   user/space context is missing, the upload fails, or the object cannot be
 *   created. Callers surface the message (e.g. via notify).
 */
export async function saveSvgPlane({ fileName } = {}) {
  const { elements, draft, canvasSize } = useSvgDrawStore.getState();
  const committed = draft ? [...elements, draft] : elements;
  if (!committed.length) {
    throw new Error('Nothing to save — the drawing is empty.');
  }

  // Snapshot through the canonical serializer so the saved file is exactly
  // what the overlay's live preview showed.
  const svg = buildSvgDocument(committed, canvasSize);

  const user = useAuthStore.getState().user;
  const spaceId =
    useSpaceManagerStore.getState().currentSpaceId || window.currentSpaceId;
  if (!user || !spaceId) {
    throw new Error('Open a space (and sign in) before saving a drawing.');
  }

  // Upload first: if storage fails, no half-saved object is created.
  const svgUrl = await uploadSvgToStorage(svg, user.uid, spaceId, fileName);

  // Grid slot + anchor (first plane anchors in front of the camera; later
  // planes reuse the persisted origin so the grid never drifts).
  const objects = useObjectsStore.getState().objects || [];
  const index = nextSvgPlaneIndex(objects);
  const origin = resolveGridOrigin(objects) || positionInFrontOfCamera();
  const position = svgPlanePosition(index, origin);

  const storeCreate = useObjectsStore.getState().handleCreateObject;
  const id = storeCreate(SVG_PLANE_OBJECT_TYPE, position, user, spaceId, null, {
    svgUrl,
    svgGridIndex: index,
    svgGridOrigin: origin,
    svgCanvasSize: {
      width: canvasSize.width,
      height: canvasSize.height,
    },
    svgElementCount: committed.length,
  });
  if (!id) {
    throw new Error('Could not create the SVG plane object.');
  }

  return { id, svgUrl, index, position, elementCount: committed.length };
}
