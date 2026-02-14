/**
 * Reciprocal Rank Fusion (RRF) — merges multiple ranked result lists
 * into a unified ranking.
 *
 * RRF is rank-based (not score-based), which means it doesn't need
 * score normalization across different retrieval signals.
 *
 * Formula: RRF(doc) = sum_i( weight_i / (k + rank_i) )
 */

/**
 * Default fusion weights for each signal.
 */
const DEFAULT_WEIGHTS = {
  vector: 0.4,
  bm25: 0.3,
  recency: 0.2,
  entity: 0.1,
};

const DEFAULT_K = 60;

/**
 * Build a rank map from a scored results array.
 * Results should already be sorted by score descending.
 *
 * @param {Array<{path?: string, text?: string}>} results
 * @returns {Map<string, number>} doc key -> rank (1-based)
 */
function buildRankMap(results) {
  const map = new Map();
  for (let i = 0; i < results.length; i++) {
    const key = docKey(results[i]);
    if (!map.has(key)) {
      map.set(key, i + 1); // 1-based rank
    }
  }
  return map;
}

/**
 * Generate a unique key for a document.
 * Uses path if available, falls back to first 100 chars of text.
 *
 * @param {object} doc
 * @returns {string}
 */
function docKey(doc) {
  if (doc.path) return doc.path;
  return (doc.text || "").slice(0, 100);
}

/**
 * Compute recency rank from results based on path dates.
 * Newer documents get lower ranks (better).
 *
 * @param {Array<object>} allDocs - All unique documents
 * @returns {Map<string, number>} doc key -> recency rank (1-based)
 */
function buildRecencyRankMap(allDocs) {
  const dateRegex = /(\d{4}-\d{2}-\d{2})/;
  const withDates = allDocs.map((doc) => {
    const match = (doc.path || "").match(dateRegex);
    const date = match ? new Date(match[1] + "T00:00:00Z") : new Date(0);
    return { key: docKey(doc), date };
  });

  // Sort by date descending (newest first)
  withDates.sort((a, b) => b.date.getTime() - a.date.getTime());

  const map = new Map();
  for (let i = 0; i < withDates.length; i++) {
    map.set(withDates[i].key, i + 1);
  }
  return map;
}

/**
 * Compute entity match rank based on extracted entities.
 * Documents containing more entity matches rank higher.
 *
 * @param {Array<object>} allDocs
 * @param {string[]} entities - Extracted entities from query
 * @returns {Map<string, number>} doc key -> entity rank (1-based)
 */
function buildEntityRankMap(allDocs, entities) {
  if (!entities || entities.length === 0) {
    return new Map();
  }

  const lowerEntities = entities.map((e) => e.toLowerCase());
  const scored = allDocs.map((doc) => {
    const text = (doc.text || "").toLowerCase();
    let matches = 0;
    for (const entity of lowerEntities) {
      if (text.includes(entity)) matches++;
    }
    return { key: docKey(doc), matches };
  });

  // Sort by matches descending
  scored.sort((a, b) => b.matches - a.matches);

  const map = new Map();
  for (let i = 0; i < scored.length; i++) {
    map.set(scored[i].key, i + 1);
  }
  return map;
}

/**
 * Fuse multiple ranked result lists using Reciprocal Rank Fusion.
 *
 * @param {object} params
 * @param {Array} params.vectorResults - Vector search results (scored, sorted)
 * @param {Array} params.bm25Results - BM25 search results (scored, sorted)
 * @param {object} [params.weights] - Signal weights
 * @param {number} [params.k=60] - RRF constant
 * @param {number} [params.maxResults=5] - Max results to return
 * @param {object} [params.temporalFilter] - Time window filter from query parsing
 * @param {string[]} [params.entities] - Extracted entities for entity rank signal
 * @returns {Array<{text: string, source: string, path: string, lines: string, score: number}>}
 */
export function fuseResults({
  vectorResults = [],
  bm25Results = [],
  weights = DEFAULT_WEIGHTS,
  k = DEFAULT_K,
  maxResults = 5,
  temporalFilter = null,
  entities = [],
} = {}) {
  // Collect all unique documents
  const docMap = new Map(); // key -> doc object
  for (const doc of [...vectorResults, ...bm25Results]) {
    const key = docKey(doc);
    if (!docMap.has(key)) {
      docMap.set(key, { ...doc });
    }
  }

  if (docMap.size === 0) return [];

  const allDocs = Array.from(docMap.values());

  // Build rank maps for each signal
  const vectorRanks = buildRankMap(vectorResults);
  const bm25Ranks = buildRankMap(bm25Results);
  const recencyRanks = buildRecencyRankMap(allDocs);
  const entityRanks = buildEntityRankMap(allDocs, entities);

  const totalDocs = docMap.size;
  const defaultRank = totalDocs + 1; // Rank for missing signals

  // Compute RRF score for each document
  const scored = [];
  for (const [key, doc] of docMap) {
    const vectorRank = vectorRanks.get(key) || defaultRank;
    const bm25Rank = bm25Ranks.get(key) || defaultRank;
    const recencyRank = recencyRanks.get(key) || defaultRank;
    const entityRank = entityRanks.get(key) || defaultRank;

    const rrfScore =
      (weights.vector || 0) / (k + vectorRank) +
      (weights.bm25 || 0) / (k + bm25Rank) +
      (weights.recency || 0) / (k + recencyRank) +
      (weights.entity || 0) / (k + entityRank);

    scored.push({ ...doc, score: rrfScore, _rrfDetails: { vectorRank, bm25Rank, recencyRank, entityRank } });
  }

  // Sort by RRF score descending
  scored.sort((a, b) => b.score - a.score);

  // Apply temporal filter if present
  let filtered = scored;
  if (temporalFilter?.startDate || temporalFilter?.endDate) {
    const dateRegex = /(\d{4}-\d{2}-\d{2})/;
    filtered = scored.filter((doc) => {
      const match = (doc.path || "").match(dateRegex);
      if (!match) return true; // Keep docs without dates

      const docDate = new Date(match[1] + "T00:00:00Z");
      if (temporalFilter.startDate && docDate < temporalFilter.startDate) return false;
      if (temporalFilter.endDate && docDate > temporalFilter.endDate) return false;
      return true;
    });
  }

  return filtered.slice(0, maxResults);
}
