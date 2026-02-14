/**
 * Query enrichment — extracts entities and temporal expressions
 * from user prompts to improve search quality.
 *
 * Uses lightweight regex patterns (no NLP library needed for v1).
 * Temporal parsing uses chrono-node if available, falls back to
 * simple regex patterns.
 */

// ---------------------------------------------------------------------------
// Entity extraction patterns
// ---------------------------------------------------------------------------

/** File paths: src/index.js, ./utils/helper.ts, etc. */
const FILE_PATH_RE = /(?:^|[\s(])([.\/]?[\w\-./]+\.\w{1,6})\b/g;

/** Error codes: NETSDK1005, ERR_MODULE_NOT_FOUND, HTTP_500, etc. */
const ERROR_CODE_RE = /\b([A-Z][A-Z_]*\d+[A-Z0-9]*)\b/g;

/** CamelCase identifiers: TelegramBotService, createHandler, etc. */
const CAMEL_CASE_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+){1,})\b/g;

/** Package names: @xenova/transformers, wink-bm25, etc. */
const PACKAGE_RE = /@[\w\-]+\/[\w\-]+/g;

/** Quoted strings: "like this" or 'like this' */
const QUOTED_RE = /["']([^"']{2,50})["']/g;

/**
 * Extract structured entities from a prompt.
 *
 * @param {string} prompt
 * @returns {string[]} Extracted entities
 */
export function extractEntities(prompt) {
  if (!prompt) return [];

  const entities = new Set();

  // File paths
  for (const match of prompt.matchAll(FILE_PATH_RE)) {
    const path = match[1];
    // Filter out common false positives
    if (!path.match(/^\d/) && path.length > 3) {
      entities.add(path);
    }
  }

  // Error codes
  for (const match of prompt.matchAll(ERROR_CODE_RE)) {
    entities.add(match[1]);
  }

  // CamelCase identifiers
  for (const match of prompt.matchAll(CAMEL_CASE_RE)) {
    entities.add(match[1]);
  }

  // Package names
  for (const match of prompt.matchAll(PACKAGE_RE)) {
    entities.add(match[0]);
  }

  // Quoted strings
  for (const match of prompt.matchAll(QUOTED_RE)) {
    entities.add(match[1]);
  }

  return Array.from(entities);
}

// ---------------------------------------------------------------------------
// Temporal parsing — lightweight regex fallback
// ---------------------------------------------------------------------------

/**
 * Simple temporal expression parser.
 * Returns a time window { startDate, endDate } for filtering results.
 *
 * Supports:
 * - "yesterday" -> previous day
 * - "today" -> current day
 * - "(last|this|past) week" -> past 7 days
 * - "last N days/hours" -> past N days/hours
 * - "N days ago" -> specific day
 *
 * @param {string} prompt
 * @param {Date} [now] - Current date (for testing)
 * @returns {{ startDate: Date, endDate: Date } | null}
 */
export function parseTemporalExpression(prompt, now = new Date()) {
  if (!prompt) return null;

  const lower = prompt.toLowerCase();

  // "yesterday"
  if (/\byesterday\b/.test(lower)) {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 1);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCHours(23, 59, 59, 999);
    return { startDate: start, endDate: end };
  }

  // "today"
  if (/\btoday\b/.test(lower)) {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCHours(23, 59, 59, 999);
    return { startDate: start, endDate: end };
  }

  // "last week" or "this week" or "past week"
  if (/\b(last|this|past)\s+week\b/.test(lower)) {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 7);
    start.setUTCHours(0, 0, 0, 0);
    return { startDate: start, endDate: now };
  }

  // "last N days" or "past N days"
  const lastNDays = lower.match(/\b(?:last|past)\s+(\d+)\s+days?\b/);
  if (lastNDays) {
    const n = parseInt(lastNDays[1], 10);
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - n);
    start.setUTCHours(0, 0, 0, 0);
    return { startDate: start, endDate: now };
  }

  // "last N hours"
  const lastNHours = lower.match(/\b(?:last|past)\s+(\d+)\s+hours?\b/);
  if (lastNHours) {
    const n = parseInt(lastNHours[1], 10);
    const start = new Date(now.getTime() - n * 60 * 60 * 1000);
    return { startDate: start, endDate: now };
  }

  // "N days ago"
  const nDaysAgo = lower.match(/\b(\d+)\s+days?\s+ago\b/);
  if (nDaysAgo) {
    const n = parseInt(nDaysAgo[1], 10);
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - n);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCHours(23, 59, 59, 999);
    return { startDate: start, endDate: end };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Combined query enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich a query with extracted entities and temporal context.
 *
 * @param {string} prompt
 * @param {Date} [now] - Current date (for testing)
 * @returns {{ entities: string[], temporalFilter: { startDate: Date, endDate: Date } | null, originalPrompt: string }}
 */
export function enrichQuery(prompt, now = new Date()) {
  return {
    entities: extractEntities(prompt),
    temporalFilter: parseTemporalExpression(prompt, now),
    originalPrompt: prompt,
  };
}
