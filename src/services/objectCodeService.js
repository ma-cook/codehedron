/**
 * objectCodeService.js
 *
 * Resolves the source code that belongs to a given 3D object.
 *
 * Precedence:
 *   1. Inline-attached code (associateCodeWithObject / manual attach) on the
 *      object's metadata.
 *   2. Raw repo contents in the code store, indexed by codeFilePath.
 *   3. Chunked repo entries in the content store (`repo:<path>`), re-joined
 *      via joinChunks.
 *   4. Storage-uploaded .svg documents (SVG plane objects): metadata.svgUrl is
 *      surfaced as a virtual `uploads/<name>.svg` path and fetched through the
 *      authenticated storage API, so drawn planes are editable like any other
 *      code file.
 *
 * When merfolkData carries a per-symbol startLine/endLine range, the resolved
 * text is sliced to exactly that symbol's code; otherwise the whole file is
 * returned so the viewer never shows an empty panel.
 */
import useCodeStore from '../stores/codeStore';
import useDiagramStore from '../stores/diagramStore';
import { getContentStore } from './context/contentStore';
import { joinChunks } from './context/chunkIndex';
import { fetchFileContent } from './githubRepoService';
import { fetchStoredMarkdown } from './storageService';

const CONTENT_ID_PREFIX = 'repo:';
const inFlightCodeFetches = new Map();

/** True for virtual storage paths (`uploads/….svg`) and repo .svg files. */
export const isSvgPath = (filePath) => /\.svg$/i.test(String(filePath || ''));

/**
 * True for storage-relative paths (`uploads/...`) served by our backend
 * storage API — these are NOT on GitHub and must never be fetched there.
 */
export const isStoragePath = (filePath) => String(filePath || '').startsWith('uploads/');

/**
 * True for SVG plane objects — drawings saved from the SVG canvas. They carry
 * their document as a storage upload (`metadata.svgUrl`) rather than a repo
 * file, so their code resolves to a virtual `uploads/<name>.svg` path.
 */
export function isSvgPlaneObject(objectData) {
  const url = objectData?.metadata?.svgUrl;
  return typeof url === 'string' && url.length > 0;
}

/**
 * Map a storage URL (`{API_BASE}/api/storage/uploads/x.svg`, or a bare
 * `uploads/x.svg` path) to the storage-relative path used as the object's
 * virtual code file path. Returns '' when the URL is not a recognizable
 * storage path.
 */
export function storagePathFromSvgUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return '';
  const marker = '/api/storage/';
  const idx = url.indexOf(marker);
  if (idx !== -1) return url.slice(idx + marker.length).split('?')[0];
  const bare = url.match(/(?:^|\/)(uploads\/[^\s?#]+\.svg)/i);
  return bare ? bare[1] : '';
}

/**
 * Uploaded SVG documents may carry an XML prolog or trailing whitespace — the
 * editable surface is the `<svg>…</svg>` document itself.
 */
export function extractSvgDocument(text) {
  if (typeof text !== 'string') return text;
  const start = text.indexOf('<svg');
  const end = text.lastIndexOf('</svg>');
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + '</svg>'.length);
}

/** Extract the svg document only when the path is an .svg file. */
const extractForPath = (filePath, text) =>
  isSvgPath(filePath) ? extractSvgDocument(text) : text;

/** Slice `{line, col}`-agnostic text by 1-based inclusive line range. */
const sliceRange = (text, startLine, endLine) => {
  const start = startLine != null ? Number(startLine) : NaN;
  const end = endLine != null ? Number(endLine) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
    return text;
  }
  const lines = text.split('\n');
  return lines.slice(start - 1, end).join('\n');
};

export const sliceCodeRange = sliceRange;

export function getCachedFullFileContent(filePath) {
  if (!filePath) return null;
  const raw = useCodeStore.getState().repoFileContents?.[filePath];
  if (typeof raw === 'string') return raw;

  const contentStore = getContentStore();
  const entry = contentStore.getEntry(`${CONTENT_ID_PREFIX}${filePath}`);
  if (entry?.chunks?.length > 0) {
    return joinChunks(entry.chunks);
  }
  return null;
}

export async function ensureFullFileContent(filePath, repoContext) {
  if (!filePath) return null;

  const cached = getCachedFullFileContent(filePath);
  if (cached != null) return cached;

  // Storage-backed files (SVG plane uploads) are not on GitHub — fetch the
  // document through the authenticated storage API (used by the code
  // workspace's save flow to rebuild the full file for review).
  if (isStoragePath(filePath)) {
    const text = await fetchStoredMarkdown(filePath);
    if (typeof text === 'string' && text.length > 0) {
      const doc = extractForPath(filePath, text);
      useCodeStore.getState().cacheRepoFileContent(filePath, doc);
      return doc;
    }
    return null;
  }

  const { owner, repoName, branch } = resolveRepoCoordinates(repoContext);
  if (!owner || !repoName) return null;

  const ref = repoContext?.commitSha || branch || undefined;
  const text = await fetchFileContent(owner, repoName, filePath, undefined, ref);
  if (typeof text === 'string') {
    const doc = extractForPath(filePath, text);
    useCodeStore.getState().cacheRepoFileContent(filePath, doc);
    return doc;
  }
  return null;
}

export function buildEditedFullFile({
  fullContent,
  displayedContent,
  editedContent,
  startLine,
  endLine,
}) {
  if (typeof fullContent !== 'string') return null;

  const eol = fullContent.includes('\r\n') ? '\r\n' : '\n';
  const full = fullContent.replace(/\r\n/g, '\n');
  const displayed = (displayedContent ?? '').replace(/\r\n/g, '\n');
  const edited = (editedContent ?? '').replace(/\r\n/g, '\n');
  const restoreEol = (value) => (eol === '\r\n' ? value.replace(/\n/g, '\r\n') : value);

  if (displayed === full) {
    return restoreEol(edited);
  }

  if (displayed.length > 0) {
    const occurrences = [];
    let index = full.indexOf(displayed);
    while (index !== -1) {
      occurrences.push(index);
      index = full.indexOf(displayed, index + 1);
    }

    if (occurrences.length > 0) {
      const start = Number(startLine);
      const targetLine = Number.isFinite(start) && start > 0 ? start - 1 : 0;
      const bestIndex = occurrences.reduce((best, candidate) => {
        const bestLine = full.slice(0, best).split('\n').length - 1;
        const candidateLine = full.slice(0, candidate).split('\n').length - 1;
        return Math.abs(candidateLine - targetLine) < Math.abs(bestLine - targetLine)
          ? candidate
          : best;
      }, occurrences[0]);
      return restoreEol(
        full.slice(0, bestIndex) + edited + full.slice(bestIndex + displayed.length)
      );
    }

    return null;
  }

  const start = Number(startLine);
  const end = Number(endLine);
  if (Number.isFinite(start) && Number.isFinite(end) && start >= 1 && end >= start) {
    const lines = full.split('\n');
    const next = [
      ...lines.slice(0, start - 1),
      ...edited.split('\n'),
      ...lines.slice(end),
    ].join('\n');
    return restoreEol(next);
  }

  return null;
}

/**
 * Resolve the code location for an object with the full precedence chain:
 *   1. The object's own merfolkData/metadata (parsed/inline association).
 *   2. The live diagram graph, indexed by merfolkData.nodeId — so objects that
 *      were created before the parser emitted codeFilePath (or whose symbols
 *      the scanner left without a codeFilePath block) still resolve their code
 *      on reload / re-hydration, because the freshly parsed graph node carries
 *      the association.
 * Returns `{ filePath, startLine, endLine, nodeId }` — empty filePath means no
 * association exists anywhere.
 */
export function resolveCodeInfo(objectData, nodeCodeIndex) {
  let filePath = objectData?.merfolkData?.codeFilePath || objectData?.metadata?.codeFilePath || '';
  let startLine = objectData?.merfolkData?.startLine;
  let endLine = objectData?.merfolkData?.endLine;

  // SVG plane objects keep their document as a storage upload; surface it as a
  // virtual `uploads/<name>.svg` path so the code workspace and the chat AI's
  // read/edit tools address it like any other code file.
  if (!filePath && isSvgPlaneObject(objectData)) {
    filePath = storagePathFromSvgUrl(objectData.metadata.svgUrl);
  }

  if (!filePath) {
    const nodeId = objectData?.merfolkData?.nodeId;
    if (nodeId) {
      const lookup = nodeCodeIndex ?? useDiagramStore.getState().nodeCodeIndex;
      const resolved = lookup?.get(nodeId);
      if (resolved?.codeFilePath) {
        filePath = resolved.codeFilePath;
        if (startLine == null) startLine = resolved.startLine;
        if (endLine == null) endLine = resolved.endLine;
      }
    }
  }

  return { filePath, startLine, endLine };
}

/** @param {import('../stores/objectsStore').ObjectData} objectData */
export function getCodeForObject(objectData) {
  if (!objectData) return null;

  const attached = objectData.metadata?.code;
  if (typeof attached === 'string' && attached.length > 0) {
    return attached;
  }

  const { filePath, startLine, endLine } = resolveCodeInfo(objectData);
  if (!filePath) return null;

  const range = {
    startLine: startLine ?? objectData.merfolkData?.startLine,
    endLine: endLine ?? objectData.merfolkData?.endLine,
  };

  const raw = useCodeStore.getState().repoFileContents?.[filePath];
  if (typeof raw === 'string' && raw.length > 0) {
    return sliceRange(extractForPath(filePath, raw), range.startLine, range.endLine);
  }

  const contentStore = getContentStore();
  const entry = contentStore.getEntry(`${CONTENT_ID_PREFIX}${filePath}`);
  if (entry?.chunks?.length > 0) {
    return sliceRange(extractForPath(filePath, joinChunks(entry.chunks)), range.startLine, range.endLine);
  }

  return null;
}

function resolveRepoCoordinates(repoContext) {
  const store = useCodeStore.getState();
  const repo = repoContext?.repo || store.selectedRepo;
  const owner =
    repo?.owner?.login ??
    (typeof repo?.owner === 'string' ? repo.owner : repo?.full_name?.split('/')[0]) ??
    store.repoOwner;
  const repoName =
    repo?.name ??
    repo?.full_name?.split('/')[1] ??
    store.repoName;
  const branch =
    repo?.default_branch ??
    repo?.branch ??
    store.selectedBranch;
  return { owner, repoName, branch };
}

export async function ensureObjectCodeAvailable(objectData, repoContext) {
  if (!objectData) return null;

  const available = getCodeForObject(objectData);
  if (available != null) return available;

  const {
    filePath,
    startLine,
    endLine,
  } = resolveCodeInfo(objectData);
  if (!filePath) return null;

  // Storage-backed files (SVG plane uploads) are not on GitHub — fetch the
  // document through the authenticated storage API and cache it under the
  // virtual path so subsequent reads and the chat AI's tools find it.
  if (isStoragePath(filePath)) {
    const storageKey = `storage:${filePath}`;
    if (inFlightCodeFetches.has(storageKey)) return inFlightCodeFetches.get(storageKey);
    const storageTask = (async () => {
      const text = await fetchStoredMarkdown(filePath);
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('SVG content is unavailable');
      }
      const doc = extractForPath(filePath, text);
      useCodeStore.getState().cacheRepoFileContent(filePath, doc);
      return sliceRange(
        doc,
        startLine ?? objectData.merfolkData?.startLine,
        endLine ?? objectData.merfolkData?.endLine
      );
    })();
    inFlightCodeFetches.set(storageKey, storageTask);
    try {
      return await storageTask;
    } finally {
      inFlightCodeFetches.delete(storageKey);
    }
  }

  const { owner, repoName, branch } = resolveRepoCoordinates(repoContext);
  if (!owner || !repoName) {
    throw new Error('Repository context is unavailable');
  }

  const ref = repoContext?.commitSha || branch || undefined;
  const key = `${owner}/${repoName}@${ref || 'default'}:${filePath}`;
  if (inFlightCodeFetches.has(key)) return inFlightCodeFetches.get(key);

  const task = (async () => {
    const text = await fetchFileContent(owner, repoName, filePath, undefined, ref);
    if (typeof text === 'string') {
      const doc = extractForPath(filePath, text);
      useCodeStore.getState().cacheRepoFileContent(filePath, doc);
      return sliceRange(
        doc,
        startLine ?? objectData.merfolkData?.startLine,
        endLine ?? objectData.merfolkData?.endLine
      );
    }
    throw new Error('Code content is unavailable');
  })();

  inFlightCodeFetches.set(key, task);
  try {
    return await task;
  } finally {
    inFlightCodeFetches.delete(key);
  }
}

/**
 * True whenever the object has inline code or a resolvable source file path.
 * The file body is fetched lazily by the code window, so the button does not
 * wait for the repository corpus to be hydrated.
 */
export function objectHasCode(objectData, codeStoreState) {
  if (!objectData) return false;
  if (typeof objectData.metadata?.code === 'string' && objectData.metadata.code.length > 0) {
    return true;
  }
  if (isSvgPlaneObject(objectData)) return true;
  return !!resolveCodeInfo(objectData, codeStoreState?.nodeCodeIndex).filePath;
}