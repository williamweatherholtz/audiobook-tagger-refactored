// src/api.claude-cli.test.js
// Tests for Claude CLI as an AI provider.
//
// Verifies:
//   1. validateAIConfig accepts Claude CLI config (no API key needed)
//   2. DNA is always enabled for Claude CLI (never suppressed by local_skip_dna)
//   3. All batch handlers run SEQUENTIALLY (concurrency=1) — spawning 5 concurrent
//      `claude` subprocesses would hit rate limits and thrash the user's machine
//   4. classify_books_batch / generate_book_dna_batch / process_with_pipeline all
//      call the AI for DNA and return dna_tags in their results
//
// The concurrency tests are the critical regression guard: if someone changes the
// isLocal check and forgets Claude CLI, they'll see maxConcurrent > 1 failures.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callBackend, getLocalConfig, saveLocalConfig } from './api';

// ---------------------------------------------------------------------------
// Mock the networking layer — all AI calls are controlled via mockCallAI
// ---------------------------------------------------------------------------

const mockCallAI = vi.fn();
const mockParseAIJson = vi.fn();
const mockAbsApi = vi.fn();

vi.mock('./lib/proxy', () => ({
  callAI: (...args) => mockCallAI(...args),
  parseAIJson: (...args) => mockParseAIJson(...args),
  absApi: (...args) => mockAbsApi(...args),
  proxyFetch: vi.fn(),
  callOllama: vi.fn(),
  callOpenAI: vi.fn(),
  callAnthropic: vi.fn(),
  callClaudeCli: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save a minimal Claude CLI config to localStorage. */
function setClaudeCliConfig(overrides = {}) {
  saveLocalConfig({
    use_claude_cli: true,
    claude_cli_model: 'sonnet',
    use_local_ai: false,
    ollama_model: null,
    ai_model: 'gpt-5-nano',
    openai_api_key: null,
    anthropic_api_key: null,
    cloud_concurrency: 5, // default — should NOT be used for Claude CLI
    ...overrides,
  });
}

/** A minimal classification JSON response. */
const CLASSIFY_RESPONSE = JSON.stringify({
  genres: ['Science Fiction'],
  tags: ['space-opera'],
  age_rating: { intended_for_kids: false, age_category: 'Adult', content_rating: 'PG-13' },
  themes: ['survival'],
  tropes: [],
});

/** A minimal DNA JSON response. */
const DNA_RESPONSE = JSON.stringify({
  length: 'long',
  pacing: 'fast',
  structure: 'linear',
  pov: 'third-person',
  tropes: ['chosen-one'],
  themes: ['redemption'],
  moods: [{ mood: 'tense', intensity: 8 }],
});

/** A minimal metadata JSON response. */
const METADATA_RESPONSE = JSON.stringify({
  title: 'Dune',
  author: 'Frank Herbert',
  subtitle: null,
  series: 'Dune Chronicles',
  sequence: 1,
  confidence: 90,
});

/** A minimal description JSON response. */
const DESCRIPTION_RESPONSE = JSON.stringify({
  action: 'kept',
  description: 'A desert planet, a prophecy.',
});

function makeBook(id = 'b1', title = 'Dune') {
  return { id, title, author: 'Frank Herbert', description: 'A desert planet.' };
}

function makePipelineBook(id = 'b1') {
  return { abs_id: id, title: 'Dune', author: 'Frank Herbert', description: 'A desert planet.' };
}

/** Track max concurrent AI calls by counting in-flight requests. */
function makeConcurrencyTrackingMock(responseJson) {
  let inFlight = 0;
  let maxConcurrent = 0;
  const mock = vi.fn().mockImplementation(async () => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise(r => setTimeout(r, 10)); // yield to let concurrent calls stack up
    inFlight--;
    return responseJson;
  });
  mock.getMaxConcurrent = () => maxConcurrent;
  return mock;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // Default: parseAIJson returns the parsed object for whatever was passed
  mockParseAIJson.mockImplementation((text) => {
    try { return JSON.parse(text); } catch { return {}; }
  });
});

// ===========================================================================
// validateAIConfig
// ===========================================================================

describe('validateAIConfig — Claude CLI', () => {
  it('does not throw when use_claude_cli is true and no API keys are set', async () => {
    setClaudeCliConfig({ openai_api_key: null, anthropic_api_key: null });

    // classify_books_batch calls validateAIConfig internally
    mockCallAI.mockResolvedValue(CLASSIFY_RESPONSE);
    await expect(callBackend('classify_books_batch', { books: [makeBook()], dnaEnabled: false }))
      .resolves.not.toThrow();
  });

  it('does throw when no provider is configured at all', async () => {
    saveLocalConfig({ use_claude_cli: false, use_local_ai: false, ai_model: 'gpt-5-nano', openai_api_key: null });
    await expect(callBackend('classify_books_batch', { books: [makeBook()] }))
      .rejects.toThrow(/api key/i);
  });
});

// ===========================================================================
// classify_books_batch
// ===========================================================================

describe('classify_books_batch — Claude CLI', () => {
  it('processes all books and returns results', async () => {
    setClaudeCliConfig();
    mockCallAI.mockResolvedValue(CLASSIFY_RESPONSE);

    const books = [makeBook('b1', 'Dune'), makeBook('b2', 'Foundation')];
    const result = await callBackend('classify_books_batch', { books, dnaEnabled: false });

    expect(result.results).toHaveLength(2);
    expect(result.total_processed).toBe(2);
    expect(result.total_failed).toBe(0);
  });

  it('includes DNA tags in results when dnaEnabled is true (default)', async () => {
    setClaudeCliConfig();
    // First call = classify, second = DNA
    mockCallAI
      .mockResolvedValueOnce(CLASSIFY_RESPONSE)
      .mockResolvedValueOnce(DNA_RESPONSE);

    const result = await callBackend('classify_books_batch', { books: [makeBook()] });

    const book = result.results[0];
    expect(book.success).toBe(true);
    expect(book.dna_tags.length).toBeGreaterThan(0);
    expect(book.dna_tags.some(t => t.startsWith('dna:'))).toBe(true);
  });

  it('DNA is NOT suppressed by local_skip_dna (that flag is only for Ollama)', async () => {
    // local_skip_dna=true should have no effect when use_claude_cli=true
    setClaudeCliConfig({ local_skip_dna: true });
    mockCallAI
      .mockResolvedValueOnce(CLASSIFY_RESPONSE)
      .mockResolvedValueOnce(DNA_RESPONSE);

    const result = await callBackend('classify_books_batch', { books: [makeBook()] });

    expect(result.results[0].dna_tags.length).toBeGreaterThan(0);
  });

  it('runs sequentially (concurrency = 1) — never spawns multiple claude processes at once', async () => {
    setClaudeCliConfig();
    const trackingMock = makeConcurrencyTrackingMock(CLASSIFY_RESPONSE);
    mockCallAI.mockImplementation(trackingMock);

    const books = [makeBook('b1'), makeBook('b2'), makeBook('b3')];
    await callBackend('classify_books_batch', { books, dnaEnabled: false });

    // With correct concurrency=1, max concurrent AI calls must be 1
    // With broken concurrency=5, all 3 books start simultaneously → maxConcurrent=3
    expect(trackingMock.getMaxConcurrent()).toBe(1);
  });

  it('DNA is included in sequential processing (both classify and DNA calls made)', async () => {
    setClaudeCliConfig();
    mockCallAI
      .mockResolvedValueOnce(CLASSIFY_RESPONSE) // classify
      .mockResolvedValueOnce(DNA_RESPONSE);      // DNA

    await callBackend('classify_books_batch', { books: [makeBook()] });

    // 2 calls: 1 for classification + 1 for DNA
    expect(mockCallAI).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// generate_book_dna_batch
// ===========================================================================

describe('generate_book_dna_batch — Claude CLI', () => {
  it('generates DNA tags for each item', async () => {
    setClaudeCliConfig();
    mockCallAI.mockResolvedValue(DNA_RESPONSE);

    const items = [
      { id: 'b1', title: 'Dune', author: 'Frank Herbert', tags: [] },
      { id: 'b2', title: 'Foundation', author: 'Isaac Asimov', tags: [] },
    ];
    const result = await callBackend('generate_book_dna_batch', { items });

    expect(result.total_processed).toBe(2);
    expect(result.total_failed).toBe(0);
    result.results.forEach(r => {
      expect(r.success).toBe(true);
      expect(r.dna_tags.length).toBeGreaterThan(0);
      expect(r.dna_tags.every(t => t.startsWith('dna:'))).toBe(true);
    });
  });

  it('preserves existing non-DNA tags in merged_tags', async () => {
    setClaudeCliConfig();
    mockCallAI.mockResolvedValue(DNA_RESPONSE);

    const item = { id: 'b1', title: 'Dune', author: 'Frank Herbert', tags: ['for-kids', 'space-opera'] };
    const result = await callBackend('generate_book_dna_batch', { items: [item] });

    const r = result.results[0];
    expect(r.merged_tags).toContain('for-kids');
    expect(r.merged_tags).toContain('space-opera');
    expect(r.merged_tags.some(t => t.startsWith('dna:'))).toBe(true);
  });

  it('replaces stale DNA tags (does not accumulate duplicates)', async () => {
    setClaudeCliConfig();
    mockCallAI.mockResolvedValue(DNA_RESPONSE);

    const item = {
      id: 'b1', title: 'Dune', author: 'Frank Herbert',
      tags: ['dna:pacing:slow', 'dna:length:short', 'for-kids'], // stale DNA
    };
    const result = await callBackend('generate_book_dna_batch', { items: [item] });

    const { merged_tags } = result.results[0];
    // Old DNA tags gone, new ones present
    expect(merged_tags).not.toContain('dna:pacing:slow');
    expect(merged_tags).not.toContain('dna:length:short');
    expect(merged_tags).toContain('for-kids'); // non-DNA preserved
    expect(merged_tags.some(t => t === 'dna:pacing:fast')).toBe(true);
  });

  it('records failure and continues when callAI throws for one item', async () => {
    setClaudeCliConfig();
    mockCallAI
      .mockResolvedValueOnce(DNA_RESPONSE)
      .mockRejectedValueOnce(new Error('CLI not found'));

    const items = [
      { id: 'b1', title: 'Dune', tags: [] },
      { id: 'b2', title: 'Foundation', tags: [] },
    ];
    const result = await callBackend('generate_book_dna_batch', { items });

    expect(result.total_processed).toBe(1);
    expect(result.total_failed).toBe(1);
    expect(result.results[1].error).toMatch(/CLI not found/);
  });
});

// ===========================================================================
// process_with_pipeline
// ===========================================================================

describe('process_with_pipeline — Claude CLI', () => {
  it('always performs the DNA step — never skipped for Claude CLI', async () => {
    setClaudeCliConfig();
    // Pipeline calls: classify → DNA → description
    mockCallAI
      .mockResolvedValueOnce(CLASSIFY_RESPONSE)
      .mockResolvedValueOnce(DNA_RESPONSE)
      .mockResolvedValueOnce(DESCRIPTION_RESPONSE);

    const result = await callBackend('process_with_pipeline', {
      request: { books: [makePipelineBook()] },
    });

    // 3 AI calls: classify + DNA + description
    expect(mockCallAI).toHaveBeenCalledTimes(3);
    expect(result.books[0].success).toBe(true);
    // DNA tags end up merged into metadata.tags
    expect(result.books[0].metadata.tags.some(t => t.startsWith('dna:'))).toBe(true);
  });

  it('includes both classification tags and DNA tags in metadata.tags', async () => {
    setClaudeCliConfig();
    mockCallAI
      .mockResolvedValueOnce(CLASSIFY_RESPONSE)
      .mockResolvedValueOnce(DNA_RESPONSE)
      .mockResolvedValueOnce(DESCRIPTION_RESPONSE);

    const result = await callBackend('process_with_pipeline', {
      request: { books: [makePipelineBook()] },
    });

    const tags = result.books[0].metadata.tags;
    expect(tags).toContain('space-opera');           // from classification
    expect(tags.some(t => t.startsWith('dna:'))).toBe(true); // from DNA
  });

  it('still succeeds even if DNA call fails (DNA is try/catch wrapped)', async () => {
    setClaudeCliConfig();
    mockCallAI
      .mockResolvedValueOnce(CLASSIFY_RESPONSE)
      .mockRejectedValueOnce(new Error('DNA failed'))   // DNA throws
      .mockResolvedValueOnce(DESCRIPTION_RESPONSE);

    const result = await callBackend('process_with_pipeline', {
      request: { books: [makePipelineBook()] },
    });

    expect(result.books[0].success).toBe(true);
    // tags still populated from classification
    expect(result.books[0].metadata.tags).toContain('space-opera');
  });
});

// ===========================================================================
// assign_tags_with_gpt
// ===========================================================================

describe('assign_tags_with_gpt — Claude CLI', () => {
  it('includes DNA tags by default (dnaEnabled defaults to true)', async () => {
    setClaudeCliConfig();
    mockCallAI
      .mockResolvedValueOnce(JSON.stringify({ tags: ['space-opera', 'epic'] })) // tags
      .mockResolvedValueOnce(DNA_RESPONSE);                                      // DNA

    const result = await callBackend('assign_tags_with_gpt', {
      books: [{ id: 'b1', title: 'Dune', author: 'Frank Herbert', genres: ['Science Fiction'] }],
    });

    expect(result.results[0].success).toBe(true);
    expect(result.results[0].dna_tags.length).toBeGreaterThan(0);
    expect(result.results[0].tags).toContain('space-opera');
  });

  it('skips DNA when dnaEnabled is explicitly false', async () => {
    setClaudeCliConfig();
    mockCallAI.mockResolvedValue(JSON.stringify({ tags: ['space-opera'] }));

    const result = await callBackend('assign_tags_with_gpt', {
      books: [{ id: 'b1', title: 'Dune', author: 'Frank Herbert', genres: ['Science Fiction'] }],
      dnaEnabled: false,
    });

    // Only 1 AI call (no DNA)
    expect(mockCallAI).toHaveBeenCalledTimes(1);
    expect(result.results[0].dna_tags).toHaveLength(0);
  });
});

// ===========================================================================
// resolve_metadata_batch
// ===========================================================================

describe('resolve_metadata_batch — Claude CLI', () => {
  it('processes all books', async () => {
    setClaudeCliConfig();
    mockCallAI.mockResolvedValue(METADATA_RESPONSE);

    const books = [
      { id: 'b1', current_title: 'Dune', current_author: 'F. Herbert' },
      { id: 'b2', current_title: 'Foundation', current_author: 'I. Asimov' },
    ];
    const result = await callBackend('resolve_metadata_batch', { books });

    expect(result.total_processed).toBe(2);
    expect(result.total_failed).toBe(0);
  });

  it('runs sequentially (concurrency = 1) — not the cloud concurrency of 5', async () => {
    setClaudeCliConfig({ cloud_concurrency: 5 });
    const trackingMock = makeConcurrencyTrackingMock(METADATA_RESPONSE);
    mockCallAI.mockImplementation(trackingMock);

    const books = [1, 2, 3, 4].map(i => ({
      id: `b${i}`, current_title: `Book ${i}`, current_author: 'Author',
    }));
    await callBackend('resolve_metadata_batch', { books });

    expect(trackingMock.getMaxConcurrent()).toBe(1);
  });
});

// ===========================================================================
// fix_descriptions_with_gpt
// ===========================================================================

describe('fix_descriptions_with_gpt — Claude CLI', () => {
  it('runs sequentially (concurrency = 1)', async () => {
    setClaudeCliConfig({ cloud_concurrency: 5 });
    const trackingMock = makeConcurrencyTrackingMock(DESCRIPTION_RESPONSE);
    mockCallAI.mockImplementation(trackingMock);

    const books = [1, 2, 3].map(i => ({
      id: `b${i}`, title: `Book ${i}`, description: 'A book.',
    }));
    await callBackend('fix_descriptions_with_gpt', { books });

    expect(trackingMock.getMaxConcurrent()).toBe(1);
  });
});
