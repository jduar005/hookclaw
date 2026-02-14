/**
 * BM25 full-text search index for memory chunks.
 *
 * Provides keyword-based search as a complement to vector (embedding) search.
 * BM25 excels at exact matches (error codes, file paths, identifiers) that
 * embeddings often miss.
 *
 * Uses an in-memory inverted index rebuilt from memory files on demand.
 */

// ---------------------------------------------------------------------------
// BM25 parameters (Okapi BM25 defaults)
// ---------------------------------------------------------------------------
const K1 = 1.2; // term frequency saturation
const B = 0.75; // document length normalization

/**
 * Tokenize text into lowercase terms, stripping punctuation.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return (text || "").toLowerCase().match(/\b[\w.@/\-]+\b/g) || [];
}

/**
 * In-memory BM25 index.
 */
class Bm25Index {
  constructor() {
    /** @type {Array<{id: string, text: string, source: string, path: string, lines: string, termFreqs: Map<string, number>, length: number}>} */
    this._docs = [];
    /** @type {Map<string, Set<number>>} term -> doc indices */
    this._invertedIndex = new Map();
    this._avgDocLength = 0;
    this._built = false;
  }

  /**
   * Add a document to the index.
   * @param {object} doc - { text, source, path, lines }
   */
  addDocument(doc) {
    const tokens = tokenize(doc.text);
    const termFreqs = new Map();
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
    }

    const idx = this._docs.length;
    this._docs.push({
      id: doc.path || `doc-${idx}`,
      text: doc.text || "",
      source: doc.source || "memory",
      path: doc.path || "",
      lines: doc.lines || "",
      termFreqs,
      length: tokens.length,
    });

    for (const term of termFreqs.keys()) {
      if (!this._invertedIndex.has(term)) {
        this._invertedIndex.set(term, new Set());
      }
      this._invertedIndex.get(term).add(idx);
    }

    this._built = false;
  }

  /**
   * Build/rebuild the index (compute avg doc length).
   */
  build() {
    if (this._docs.length === 0) {
      this._avgDocLength = 0;
    } else {
      const totalLength = this._docs.reduce((sum, d) => sum + d.length, 0);
      this._avgDocLength = totalLength / this._docs.length;
    }
    this._built = true;
  }

  /**
   * Search the index with a query string.
   *
   * @param {string} query - Search query
   * @param {object} [options]
   * @param {number} [options.maxResults=10] - Max results
   * @param {string[]} [options.boostTerms=[]] - Terms to boost (2x weight)
   * @returns {Array<{text: string, source: string, path: string, lines: string, score: number}>}
   */
  search(query, { maxResults = 10, boostTerms = [] } = {}) {
    if (!this._built) this.build();
    if (this._docs.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const boostSet = new Set(boostTerms.map((t) => t.toLowerCase()));
    const N = this._docs.length;

    // Collect candidate doc indices
    const candidateIndices = new Set();
    for (const token of queryTokens) {
      const docSet = this._invertedIndex.get(token);
      if (docSet) {
        for (const idx of docSet) candidateIndices.add(idx);
      }
    }

    if (candidateIndices.size === 0) return [];

    // Score each candidate
    const scores = [];
    for (const idx of candidateIndices) {
      const doc = this._docs[idx];
      let score = 0;

      for (const term of queryTokens) {
        const tf = doc.termFreqs.get(term) || 0;
        if (tf === 0) continue;

        // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
        const df = this._invertedIndex.get(term)?.size || 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

        // BM25 TF component
        const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.length / this._avgDocLength)));

        let termScore = idf * tfNorm;

        // Boost exact-match terms (entities extracted from prompt)
        if (boostSet.has(term)) {
          termScore *= 2;
        }

        score += termScore;
      }

      if (score > 0) {
        scores.push({ idx, score });
      }
    }

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, maxResults).map(({ idx, score }) => ({
      text: this._docs[idx].text,
      source: this._docs[idx].source,
      path: this._docs[idx].path,
      lines: this._docs[idx].lines,
      score,
    }));
  }

  /**
   * Clear all documents from the index.
   */
  clear() {
    this._docs = [];
    this._invertedIndex.clear();
    this._avgDocLength = 0;
    this._built = false;
  }

  get size() {
    return this._docs.length;
  }
}

// ---------------------------------------------------------------------------
// Singleton index instance
// ---------------------------------------------------------------------------
let _index = new Bm25Index();
let _lastBuildTime = 0;

/**
 * Get the singleton BM25 index.
 * @returns {Bm25Index}
 */
export function getIndex() {
  return _index;
}

/**
 * Add a chunk to the BM25 index.
 * @param {object} chunk - { text, source, path, lines }
 */
export function addChunk(chunk) {
  _index.addDocument(chunk);
}

/**
 * Build or rebuild the index after adding chunks.
 */
export function buildIndex() {
  _index.build();
  _lastBuildTime = Date.now();
}

/**
 * Search the BM25 index.
 * @param {string} query
 * @param {object} [options]
 * @returns {Array}
 */
export function search(query, options = {}) {
  return _index.search(query, options);
}

/**
 * Clear and reset the singleton index.
 */
export function resetIndex() {
  _index = new Bm25Index();
  _lastBuildTime = 0;
}

/**
 * Get the last build timestamp.
 * @returns {number}
 */
export function getLastBuildTime() {
  return _lastBuildTime;
}

// Export class for testing
export { Bm25Index };
