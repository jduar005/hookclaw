import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractEntities, parseTemporalExpression, enrichQuery } from "../src/query-enricher.js";

describe("extractEntities", () => {
  it("returns empty for null/undefined/empty", () => {
    assert.deepEqual(extractEntities(null), []);
    assert.deepEqual(extractEntities(undefined), []);
    assert.deepEqual(extractEntities(""), []);
  });

  it("extracts file paths", () => {
    const entities = extractEntities("check the file src/hook-handler.js for the bug");
    assert.ok(entities.some((e) => e.includes("hook-handler.js")));
  });

  it("extracts dotted paths", () => {
    const entities = extractEntities("look at ./utils/helper.ts");
    assert.ok(entities.some((e) => e.includes("helper.ts")));
  });

  it("extracts error codes", () => {
    const entities = extractEntities("getting NETSDK1005 when building");
    assert.ok(entities.includes("NETSDK1005"));
  });

  it("extracts multiple error codes", () => {
    const entities = extractEntities("seeing NETSDK1005 and HTTP_500 errors");
    assert.ok(entities.includes("NETSDK1005"));
    assert.ok(entities.includes("HTTP_500"));
  });

  it("extracts CamelCase identifiers", () => {
    const entities = extractEntities("the TelegramBotService is failing");
    assert.ok(entities.includes("TelegramBotService"));
  });

  it("extracts package names", () => {
    const entities = extractEntities("install @xenova/transformers for the model");
    assert.ok(entities.includes("@xenova/transformers"));
  });

  it("extracts quoted strings", () => {
    const entities = extractEntities('search for "connection refused" in the logs');
    assert.ok(entities.includes("connection refused"));
  });

  it("extracts single-quoted strings", () => {
    const entities = extractEntities("look for 'memory search timeout' errors");
    assert.ok(entities.includes("memory search timeout"));
  });

  it("handles prompts with no entities", () => {
    const entities = extractEntities("how do I do this thing");
    assert.equal(entities.length, 0);
  });

  it("extracts multiple entity types from one prompt", () => {
    const entities = extractEntities(
      'fix NETSDK1005 in src/hook-handler.js for TelegramBotService "connection failed"'
    );
    assert.ok(entities.length >= 3);
    assert.ok(entities.includes("NETSDK1005"));
    assert.ok(entities.includes("TelegramBotService"));
    assert.ok(entities.includes("connection failed"));
  });
});

describe("parseTemporalExpression", () => {
  // Fixed "now" for deterministic tests
  const NOW = new Date("2026-02-14T12:00:00Z");

  it("returns null for null/undefined/empty", () => {
    assert.equal(parseTemporalExpression(null), null);
    assert.equal(parseTemporalExpression(""), null);
  });

  it("returns null for prompts without temporal expressions", () => {
    assert.equal(parseTemporalExpression("fix the bug in the login", NOW), null);
    assert.equal(parseTemporalExpression("how does auth work", NOW), null);
  });

  it("parses 'yesterday'", () => {
    const result = parseTemporalExpression("what did we do yesterday", NOW);
    assert.ok(result);
    assert.equal(result.startDate.getUTCDate(), 13);
    assert.equal(result.endDate.getUTCDate(), 13);
  });

  it("parses 'today'", () => {
    const result = parseTemporalExpression("what happened today", NOW);
    assert.ok(result);
    assert.equal(result.startDate.getUTCDate(), 14);
    assert.equal(result.endDate.getUTCDate(), 14);
  });

  it("parses 'last week'", () => {
    const result = parseTemporalExpression("what did we discuss last week", NOW);
    assert.ok(result);
    // Should be 7 days before now
    const expectedStart = new Date("2026-02-07T00:00:00Z");
    assert.equal(result.startDate.getUTCDate(), expectedStart.getUTCDate());
  });

  it("parses 'last 3 days'", () => {
    const result = parseTemporalExpression("show me changes from last 3 days", NOW);
    assert.ok(result);
    assert.equal(result.startDate.getUTCDate(), 11); // 14 - 3
  });

  it("parses 'past 24 hours'", () => {
    const result = parseTemporalExpression("errors in the past 24 hours", NOW);
    assert.ok(result);
    const diffHours = (result.endDate - result.startDate) / (1000 * 60 * 60);
    assert.ok(diffHours >= 23 && diffHours <= 25);
  });

  it("parses '2 days ago'", () => {
    const result = parseTemporalExpression("what happened 2 days ago", NOW);
    assert.ok(result);
    assert.equal(result.startDate.getUTCDate(), 12); // 14 - 2
    assert.equal(result.endDate.getUTCDate(), 12);
  });

  it("parses 'this week'", () => {
    const result = parseTemporalExpression("summarize this week", NOW);
    assert.ok(result);
    assert.ok(result.startDate < NOW);
  });

  it("parses 'past week'", () => {
    const result = parseTemporalExpression("show past week activity", NOW);
    assert.ok(result);
    assert.ok(result.startDate < NOW);
  });
});

describe("enrichQuery", () => {
  const NOW = new Date("2026-02-14T12:00:00Z");

  it("returns combined enrichment", () => {
    const result = enrichQuery("fix NETSDK1005 from yesterday", NOW);
    assert.ok(result.entities.includes("NETSDK1005"));
    assert.ok(result.temporalFilter);
    assert.equal(result.originalPrompt, "fix NETSDK1005 from yesterday");
  });

  it("returns null temporal for non-temporal queries", () => {
    const result = enrichQuery("how does the API work", NOW);
    assert.equal(result.temporalFilter, null);
  });

  it("returns empty entities for plain queries", () => {
    const result = enrichQuery("explain the architecture", NOW);
    assert.equal(result.entities.length, 0);
  });
});
