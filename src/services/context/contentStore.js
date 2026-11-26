import { chunkText, extractKeywords, joinChunks, MAX_INDEXED_FILE_CHARS } from './chunkIndex';
import { saveContentStore, loadContentStore, clearContentStorePersistence } from './contentStorePersistence';
import { notifyRepoContentChanged } from './repoContentSignal';

export const ContentCategory = {
  REPO_FILE: 'repo_file',
  SCENE_CONTEXT: 'scene_context',
  PLAN: 'plan',
};

const CHUNK_CONFIGS = {
  [ContentCategory.REPO_FILE]: { chunkSize: 3000, overlap: 300 },
  [ContentCategory.SCENE_CONTEXT]: { chunkSize: 1500, overlap: 150 },
  [ContentCategory.PLAN]: { chunkSize: 2500, overlap: 250 },
};

export class ContentStore {
  constructor() {
    this.entries = new Map();
    this.invertedIndex = new Map();
    this.totalChunks = 0;
    this._hydrated = false;
    this._hydratePromise = null;
    // Incremental persistence: ids of entries changed (or removed) since the
    // last IndexedDB save. saveContentStore drains these on its debounce, so
    // an edit only ever rewrites ONE entry's chunks instead of serializing and
    // re-writing the entire store (4135+ chunk texts) on the main thread —
    // that whole-store write was a multi-hundred-ms main-thread block firing
    // ~2s after every edit, which froze the tab while the LLM streamed.
    this._dirtyIds = new Set();
    this._removedIds = new Set();
  }

  async _ensureHydrated() {
    if (this._hydrated) return;
    if (this._hydratePromise) return this._hydratePromise;
    this._hydratePromise = (async () => {
      const saved = await loadContentStore();
      if (saved) {
        this.entries = saved.entries;
        this.invertedIndex = saved.invertedIndex;
        this.totalChunks = saved.totalChunks;
        // Heal stores persisted before the chunk-ID fix: entries whose chunk
        // ids do not conform to `${entry.id}:chunk-N` were written by the old
        // bare-id scheme, whose flat-map collisions bled text BETWEEN files
        // (measured: fragments of .gitignore surfacing inside other files'
        // reads). Re-chunk from the joined text — content is preserved (the
        // model repairs polluted text), the ID scheme is normalized so the
        // bleed mechanism is gone, and the keyword index is rebuilt.
        let healed = 0;
        const healedSync = [];
        for (const [id, entry] of this.entries) {
          const prefix = `${id}:chunk-`;
          const conforming = Array.isArray(entry.chunks)
            && entry.chunks.length > 0
            && entry.chunks.every((c) => typeof c.id === 'string' && c.id.startsWith(prefix));
          if (conforming) continue;
          // Collect the old (non-conforming) chunk ids: base64Store's chunk
          // map may hold them from the persisted pre-heal store and must be
          // cleaned once the healed chunks are in place.
          const oldChunkIds = Array.isArray(entry.chunks) ? entry.chunks.map((c) => c.id) : [];
          const config = CHUNK_CONFIGS[entry.category] || { chunkSize: 2000, overlap: 200 };
          const content = joinChunks(entry.chunks);
          entry.chunks = content.length > MAX_INDEXED_FILE_CHARS
            ? [{
                id: `${id}:chunk-0`,
                text: content,
                startIndex: 0,
                endIndex: content.length,
                keywords: [],
                charCount: content.length,
                oversized: true,
              }]
            : chunkText(content, { ...config, idPrefix: id });
          healedSync.push({ oldChunkIds, entry });
          this._dirtyIds.add(id);
          healed++;
        }
        if (healed > 0) {
          // Healed chunk ids changed — rebuild the keyword index from scratch.
          this.invertedIndex = new Map();
          this.totalChunks = 0;
          for (const [, entry] of this.entries) {
            this.totalChunks += entry.chunks.length;
            for (const chunk of entry.chunks) {
              for (const kw of chunk.keywords) {
                if (!this.invertedIndex.has(kw)) this.invertedIndex.set(kw, new Set());
                this.invertedIndex.get(kw).add(chunk.id);
              }
            }
          }
          this._persist();
          // Sync base64Store's chunk map: it may have been hydrated from the
          // persisted (pre-heal) chunk store, whose ids no longer match the
          // healed entry — lookups would miss and fall into the linear scan
          // for every read/edit.
          for (const { oldChunkIds, entry } of healedSync) {
            for (const oldId of oldChunkIds) this.encodedChunks.delete(oldId);
            for (const chunk of entry.chunks) {
              this.encodedChunks.set(chunk.id, {
                text: chunk.text,
                meta: {
                  entryId: entry.id,
                  sourcePath: entry.sourcePath,
                  category: entry.category,
                  keywords: chunk.keywords,
                  charCount: chunk.charCount,
                  byteSize: chunk.text.length,
                  startIndex: chunk.startIndex,
                  endIndex: chunk.endIndex,
                },
              });
            }
          }
          console.warn(`[ContentStore] Healed ${healed} pre-fix entries with non-conforming chunk IDs (keyword index rebuilt)`);
        }
        console.log(`[ContentStore] Hydrated from IndexedDB: ${this.entries.size} entries, ${this.totalChunks} chunks`);
      }
      this._hydrated = true;
      notifyRepoContentChanged();
    })();
    return this._hydratePromise;
  }

  upsert(id, category, content, metadata = {}) {
    const existing = this.entries.get(id);
    if (existing) {
      this._removeFromIndex(existing);
      this.totalChunks -= existing.chunks.length;
    }

    const config = CHUNK_CONFIGS[category] || { chunkSize: 2000, overlap: 200 };
    // Oversized file (e.g. an MB-scale binary/generated blob): keep one raw
    // chunk with no keywords instead of chunking. Chunking a multi-MB file is
    // a multi-second synchronous block — in the worker it hangs the worker's
    // message loop, on the main thread it freezes the UI. Full-text scans skip
    // oversized chunks, so search coverage is unaffected.
    const chunks = content.length > MAX_INDEXED_FILE_CHARS
      ? [{
          id: `${id}:chunk-0`,
          text: content,
          startIndex: 0,
          endIndex: content.length,
          keywords: [],
          charCount: content.length,
          oversized: true,
        }]
      : chunkText(content, { ...config, idPrefix: id });

    const entry = {
      id,
      category,
      chunks,
      sourcePath: metadata.sourcePath || id,
      tags: metadata.tags || [],
      lastUpdated: Date.now(),
      totalChars: content.length,
    };

    for (const chunk of chunks) {
      for (const keyword of chunk.keywords) {
        if (!this.invertedIndex.has(keyword)) {
          this.invertedIndex.set(keyword, new Set());
        }
        this.invertedIndex.get(keyword).add(chunk.id);
      }
    }

    this.entries.set(id, entry);
    this.totalChunks += chunks.length;
    this._dirtyIds.add(id);
    this._removedIds.delete(id);
    this._persist();
    notifyRepoContentChanged();
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (entry) {
      this._removeFromIndex(entry);
      this.totalChunks -= entry.chunks.length;
      this.entries.delete(id);
      this._dirtyIds.delete(id);
      this._removedIds.add(id);
      this._persist();
      notifyRepoContentChanged();
    }
  }

  clear() {
    this.entries.clear();
    this.invertedIndex.clear();
    this.totalChunks = 0;
    this._dirtyIds.clear();
    this._removedIds.clear();
    clearContentStorePersistence().catch(() => {});
    notifyRepoContentChanged();
  }

  hydrate(serializedEntries, serializedInvertedIndex, totalChunks) {
    this.entries.clear();
    this.invertedIndex.clear();
    for (const [id, entry] of serializedEntries) {
      this.entries.set(id, entry);
    }
    for (const [keyword, chunkIds] of serializedInvertedIndex) {
      this.invertedIndex.set(keyword, new Set(chunkIds));
    }
    this.totalChunks = totalChunks;
    this._hydrated = true;
    // The entries were just read back from persistence (or were built in
    // memory from a fresh scan) — no need to write them all back.
    this._dirtyIds.clear();
    this._removedIds.clear();
    this._persist();
    notifyRepoContentChanged();
  }

  /**
   * Merge worker-computed entries into the existing store without clearing it.
   * Same-id entries replace their old chunks and index rows (mirroring upsert).
   * Inverted index rows are rebuilt from each entry's chunk keywords, so the
   * worker only needs to send entries. totalChunks is reconciled incrementally
   * so overlapping batch payloads stay consistent.
   */
  mergeBulk(serializedEntries) {
    for (const [id, entry] of serializedEntries) {
      const existing = this.entries.get(id);
      if (existing) {
        this._removeFromIndex(existing);
        this.totalChunks -= existing.chunks.length;
      }
      this.entries.set(id, entry);
      this.totalChunks += entry.chunks.length;
      for (const chunk of entry.chunks) {
        for (const keyword of chunk.keywords) {
          if (!this.invertedIndex.has(keyword)) {
            this.invertedIndex.set(keyword, new Set());
          }
          this.invertedIndex.get(keyword).add(chunk.id);
        }
      }
      this._dirtyIds.add(id);
      this._removedIds.delete(id);
    }
    this._hydrated = true;
    this._persist();
    notifyRepoContentChanged();
  }

  _persist() {
    saveContentStore(this);
  }

  search(query, { maxChunks = 10, category = null, entryIds = null } = {}) {
    const queryKeywords = extractKeywords(query, 20);
    const scores = new Map();

    for (const keyword of queryKeywords) {
      const matchingChunkIds = this.invertedIndex.get(keyword);
      if (!matchingChunkIds) continue;
      for (const chunkId of matchingChunkIds) {
        scores.set(chunkId, (scores.get(chunkId) || 0) + 1);
      }
    }

    const results = [];
    for (const [chunkId, score] of scores) {
      for (const [, entry] of this.entries) {
        const chunk = entry.chunks.find(c => c.id === chunkId);
        if (!chunk) continue;
        if (category && entry.category !== category) continue;
        if (entryIds && !entryIds.includes(entry.id)) continue;
        results.push({ chunk, score, entryId: entry.id, sourcePath: entry.sourcePath });
        break;
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, maxChunks);
  }

  getEntry(id) {
    return this.entries.get(id) || null;
  }

  getManifest() {
    const manifest = [];
    for (const [id, entry] of this.entries) {
      manifest.push({
        id,
        category: entry.category,
        sourcePath: entry.sourcePath,
        chunkCount: entry.chunks.length,
        totalChars: entry.totalChars,
        tags: entry.tags,
        lastUpdated: entry.lastUpdated,
      });
    }
    return manifest;
  }

  _removeFromIndex(entry) {
    for (const chunk of entry.chunks) {
      for (const keyword of chunk.keywords) {
        const set = this.invertedIndex.get(keyword);
        if (set) {
          set.delete(chunk.id);
          if (set.size === 0) this.invertedIndex.delete(keyword);
        }
      }
    }
  }
}

let _instance = null;
let _initPromise = null;
export function getContentStore() {
  if (!_instance) {
    _instance = new ContentStore();
    _initPromise = _instance._ensureHydrated();
  }
  return _instance;
}

export function waitForContentStoreHydration() {
  if (!_instance) getContentStore();
  return _initPromise;
}
