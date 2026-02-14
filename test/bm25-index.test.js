import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Bm25Index, addChunk, buildIndex, search, resetIndex, getIndex } from "../src/bm25-index.js";

describe("Bm25Index", () => {
  it("creates empty index", () => {
    const idx = new Bm25Index();
    assert.equal(idx.size, 0);
  });

  it("adds documents and tracks size", () => {
    const idx = new Bm25Index();
    idx.addDocument({ text: "hello world", path: "a.md" });
    idx.addDocument({ text: "goodbye world", path: "b.md" });
    assert.equal(idx.size, 2);
  });

  it("returns empty for no matches", () => {
    const idx = new Bm25Index();
    idx.addDocument({ text: "the cat sat on the mat", path: "a.md" });
    idx.build();
    const results = idx.search("banana");
    assert.equal(results.length, 0);
  });

  it("returns empty for empty query", () => {
    const idx = new Bm25Index();
    idx.addDocument({ text: "hello world", path: "a.md" });
    idx.build();
    assert.equal(idx.search("").length, 0);
  });

  it("returns empty for empty index", () => {
    const idx = new Bm25Index();
    idx.build();
    assert.equal(idx.search("hello").length, 0);
  });

  it("finds exact keyword matches", () => {
    const idx = new Bm25Index();
    idx.addDocument({ text: "NETSDK1005 error when building the project", path: "a.md" });
    idx.addDocument({ text: "The weather today is sunny and warm", path: "b.md" });
    idx.build();

    const results = idx.search("NETSDK1005");
    assert.equal(results.length, 1);
    assert.ok(results[0].text.includes("NETSDK1005"));
  });

  it("ranks documents by relevance", () => {
    const idx = new Bm25Index();
    idx.addDocument({ text: "logging configuration with serilog structured logging", path: "a.md" });
    idx.addDocument({ text: "the deployment pipeline runs on Azure", path: "b.md" });
    idx.addDocument({ text: "logging is important for debugging issues in production logging", path: "c.md" });
    idx.build();

    const results = idx.search("logging");
    assert.ok(results.length >= 2);
    // Documents with "logging" should rank higher
    assert.ok(results[0].path === "a.md" || results[0].path === "c.md");
  });

  it("respects maxResults", () => {
    const idx = new Bm25Index();
    for (let i = 0; i < 20; i++) {
      idx.addDocument({ text: `document number ${i} about testing`, path: `${i}.md` });
    }
    idx.build();

    const results = idx.search("testing", { maxResults: 3 });
    assert.equal(results.length, 3);
  });

  it("boosts specified terms", () => {
    const idx = new Bm25Index();
    idx.addDocument({ text: "general text about TelegramBotService configuration", path: "a.md" });
    idx.addDocument({ text: "general text about configuration settings", path: "b.md" });
    idx.build();

    const normal = idx.search("configuration");
    const boosted = idx.search("configuration", { boostTerms: ["telegrambotservice"] });

    // With boost, the doc containing "TelegramBotService" should score higher
    assert.equal(boosted[0].path, "a.md");
  });

  it("handles multi-word queries", () => {
    const idx = new Bm25Index();
    idx.addDocument({ text: "MongoDB connection pooling and TLS configuration", path: "a.md" });
    idx.addDocument({ text: "Redis cache configuration for sessions", path: "b.md" });
    idx.addDocument({ text: "MongoDB atlas cluster management guide", path: "c.md" });
    idx.build();

    const results = idx.search("MongoDB connection configuration");
    assert.ok(results.length >= 1);
    // Document a.md matches most query terms
    assert.equal(results[0].path, "a.md");
  });

  it("clears the index", () => {
    const idx = new Bm25Index();
    idx.addDocument({ text: "hello", path: "a.md" });
    idx.build();
    assert.equal(idx.size, 1);

    idx.clear();
    assert.equal(idx.size, 0);
    assert.equal(idx.search("hello").length, 0);
  });

  it("preserves source metadata in results", () => {
    const idx = new Bm25Index();
    idx.addDocument({
      text: "found the error here",
      source: "memory",
      path: "memory/2026-02-14.md",
      lines: "10-15",
    });
    idx.build();

    const results = idx.search("error");
    assert.equal(results.length, 1);
    assert.equal(results[0].source, "memory");
    assert.equal(results[0].path, "memory/2026-02-14.md");
    assert.equal(results[0].lines, "10-15");
    assert.ok(typeof results[0].score === "number");
    assert.ok(results[0].score > 0);
  });

  it("auto-builds if search called before build", () => {
    const idx = new Bm25Index();
    idx.addDocument({ text: "hello world", path: "a.md" });
    // No explicit build()
    const results = idx.search("hello");
    assert.equal(results.length, 1);
  });
});

describe("singleton index functions", () => {
  beforeEach(() => {
    resetIndex();
  });

  it("adds chunks and searches", () => {
    addChunk({ text: "Serilog structured logging patterns", path: "a.md" });
    addChunk({ text: "Deployment to Azure App Service", path: "b.md" });
    buildIndex();

    const results = search("Serilog logging");
    assert.ok(results.length >= 1);
    assert.ok(results[0].text.includes("Serilog"));
  });

  it("resets the index", () => {
    addChunk({ text: "test content", path: "a.md" });
    buildIndex();
    assert.ok(getIndex().size > 0);

    resetIndex();
    assert.equal(getIndex().size, 0);
  });
});
