// src/api.abs.test.js
// Tests for the ABS command handlers in api.js:
//   test_abs_connection, import_from_abs, push_abs_updates, push_abs_imports
//
// These tests define the contract for all ABS server interactions.
// They mock absApi so networking is not involved — only the handler logic is tested.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callBackend, getLocalConfig, saveLocalConfig } from './api';

// ---------------------------------------------------------------------------
// Mock the networking layer so no real HTTP calls are made.
// All absApi behaviour is controlled per-test via mockAbsApi.
// ---------------------------------------------------------------------------

const mockAbsApi = vi.fn();

vi.mock('./lib/proxy', () => ({
  absApi: (...args) => mockAbsApi(...args),
  proxyFetch: vi.fn(),
  callAI: vi.fn(),
  parseAIJson: vi.fn(),
  callOllama: vi.fn(),
  callOpenAI: vi.fn(),
  callAnthropic: vi.fn(),
}));

// ---------------------------------------------------------------------------
// localStorage mock (jsdom provides one, but we reset it between tests)
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

// ===========================================================================
// getLocalConfig / saveLocalConfig
// ===========================================================================

describe('getLocalConfig', () => {
  it('returns default config when nothing is stored', () => {
    const config = getLocalConfig();
    expect(config.abs_base_url).toBe('');
    expect(config.abs_api_token).toBe('');
    expect(config.abs_library_id).toBe('');
  });

  it('merges stored values over defaults', () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      abs_base_url: 'http://myserver:13378',
      abs_api_token: 'abc123',
    }));
    const config = getLocalConfig();
    expect(config.abs_base_url).toBe('http://myserver:13378');
    expect(config.abs_api_token).toBe('abc123');
  });

  it('returns defaults when localStorage contains malformed JSON', () => {
    localStorage.setItem('audiobook_tagger_config', 'not-json{{{');
    const config = getLocalConfig();
    expect(config.abs_base_url).toBe('');
  });

  it('preserves default values for keys not in stored config', () => {
    localStorage.setItem('audiobook_tagger_config', JSON.stringify({
      abs_base_url: 'http://server',
    }));
    const config = getLocalConfig();
    expect(config.backup_tags).toBe(true); // default
    expect(config.genre_enforcement).toBe(true); // default
  });
});

describe('saveLocalConfig', () => {
  it('persists config to localStorage', () => {
    saveLocalConfig({ abs_base_url: 'http://saved', abs_api_token: 'tok' });
    const stored = JSON.parse(localStorage.getItem('audiobook_tagger_config'));
    expect(stored.abs_base_url).toBe('http://saved');
    expect(stored.abs_api_token).toBe('tok');
  });

  it('round-trips through getLocalConfig', () => {
    saveLocalConfig({ abs_base_url: 'http://roundtrip', abs_api_token: 'rt-tok' });
    const config = getLocalConfig();
    expect(config.abs_base_url).toBe('http://roundtrip');
    expect(config.abs_api_token).toBe('rt-tok');
  });
});

// ===========================================================================
// test_abs_connection
// ===========================================================================

describe('test_abs_connection', () => {
  it('returns success when absApi resolves', async () => {
    mockAbsApi.mockResolvedValue({ libraries: [] });

    const result = await callBackend('test_abs_connection', {
      config: { abs_base_url: 'http://server', abs_api_token: 'tok' },
    });

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Connected/i);
  });

  it('returns failure when absApi throws', async () => {
    mockAbsApi.mockRejectedValue(new Error('ABS API error 401: Unauthorized'));

    const result = await callBackend('test_abs_connection', {
      config: { abs_base_url: 'http://server', abs_api_token: 'bad-token' },
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/401/);
  });

  it('returns failure immediately when URL is empty — no network call', async () => {
    const result = await callBackend('test_abs_connection', {
      config: { abs_base_url: '', abs_api_token: 'tok' },
    });

    expect(result.success).toBe(false);
    expect(mockAbsApi).not.toHaveBeenCalled();
  });

  it('calls absApi with /api/libraries path', async () => {
    mockAbsApi.mockResolvedValue({ libraries: [] });

    await callBackend('test_abs_connection', {
      config: { abs_base_url: 'http://server:13378', abs_api_token: 'tok' },
    });

    expect(mockAbsApi).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      '/api/libraries'
    );
  });

  it('passes the configured URL and token to absApi', async () => {
    mockAbsApi.mockResolvedValue({ libraries: [] });

    await callBackend('test_abs_connection', {
      config: { abs_base_url: 'http://192.168.1.50:13378', abs_api_token: 'secret-token' },
    });

    expect(mockAbsApi).toHaveBeenCalledWith(
      'http://192.168.1.50:13378',
      'secret-token',
      '/api/libraries'
    );
  });

  it('falls back to localStorage config when no config arg provided', async () => {
    saveLocalConfig({ abs_base_url: 'http://from-storage', abs_api_token: 'stored-tok' });
    mockAbsApi.mockResolvedValue({ libraries: [] });

    const result = await callBackend('test_abs_connection', {});

    expect(result.success).toBe(true);
    expect(mockAbsApi).toHaveBeenCalledWith('http://from-storage', 'stored-tok', '/api/libraries');
  });
});

// ===========================================================================
// import_from_abs
// ===========================================================================

describe('import_from_abs', () => {
  function setAbsConfig(overrides = {}) {
    saveLocalConfig({
      abs_base_url: 'http://server',
      abs_api_token: 'tok',
      abs_library_id: 'lib1',
      ...overrides,
    });
  }

  it('throws when URL is not configured', async () => {
    saveLocalConfig({ abs_base_url: '', abs_api_token: 'tok', abs_library_id: 'lib1' });
    await expect(callBackend('import_from_abs', {})).rejects.toThrow(/Configure ABS/i);
  });

  it('throws when token is not configured', async () => {
    saveLocalConfig({ abs_base_url: 'http://server', abs_api_token: '', abs_library_id: 'lib1' });
    await expect(callBackend('import_from_abs', {})).rejects.toThrow(/Configure ABS/i);
  });

  it('throws when library ID is not configured', async () => {
    saveLocalConfig({ abs_base_url: 'http://server', abs_api_token: 'tok', abs_library_id: '' });
    await expect(callBackend('import_from_abs', {})).rejects.toThrow(/Configure ABS/i);
  });

  it('fetches library items using the correct API path', async () => {
    setAbsConfig();
    mockAbsApi.mockResolvedValue({ results: [], total: 0 });

    await callBackend('import_from_abs', {});

    expect(mockAbsApi).toHaveBeenCalledWith(
      'http://server',
      'tok',
      expect.stringContaining('/api/libraries/lib1/items')
    );
  });

  it('returns groups array and total count', async () => {
    setAbsConfig();
    mockAbsApi.mockResolvedValue({
      results: [
        {
          id: 'item1',
          media: { metadata: { title: 'Dune', authorName: 'Frank Herbert', genres: [] } },
          libraryFiles: [],
        },
      ],
      total: 1,
    });

    const result = await callBackend('import_from_abs', {});

    expect(result.groups).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('paginates until all items are fetched', async () => {
    setAbsConfig();
    // Page 0: 100 items, total 150
    mockAbsApi.mockResolvedValueOnce({
      results: Array.from({ length: 100 }, (_, i) => ({
        id: `item${i}`,
        media: { metadata: { title: `Book ${i}`, authorName: 'Author', genres: [] } },
        libraryFiles: [],
      })),
      total: 150,
    });
    // Page 1: 50 items, total 150
    mockAbsApi.mockResolvedValueOnce({
      results: Array.from({ length: 50 }, (_, i) => ({
        id: `item${100 + i}`,
        media: { metadata: { title: `Book ${100 + i}`, authorName: 'Author', genres: [] } },
        libraryFiles: [],
      })),
      total: 150,
    });

    const result = await callBackend('import_from_abs', {});

    expect(mockAbsApi).toHaveBeenCalledTimes(2);
    expect(result.groups).toHaveLength(150);
    expect(result.total).toBe(150);
  });

  it('returns an empty library without error when ABS has no items', async () => {
    setAbsConfig();
    mockAbsApi.mockResolvedValue({ results: [], total: 0 });

    const result = await callBackend('import_from_abs', {});

    expect(result.groups).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

// ===========================================================================
// push_abs_updates
// ===========================================================================

describe('push_abs_updates', () => {
  beforeEach(() => {
    saveLocalConfig({ abs_base_url: 'http://server', abs_api_token: 'tok' });
  });

  it('calls PATCH on /api/items/<id>/media for each item', async () => {
    mockAbsApi.mockResolvedValue({});

    await callBackend('push_abs_updates', {
      items: [
        { abs_id: 'abc123', metadata: { title: 'Dune', genres: ['Science Fiction'] } },
        { abs_id: 'def456', metadata: { title: 'Foundation', genres: ['Science Fiction'] } },
      ],
    });

    expect(mockAbsApi).toHaveBeenCalledTimes(2);
    expect(mockAbsApi).toHaveBeenCalledWith(
      'http://server', 'tok', '/api/items/abc123/media',
      expect.objectContaining({ method: 'PATCH' })
    );
    expect(mockAbsApi).toHaveBeenCalledWith(
      'http://server', 'tok', '/api/items/def456/media',
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  it('returns correct success count when all items succeed', async () => {
    mockAbsApi.mockResolvedValue({});

    const result = await callBackend('push_abs_updates', {
      items: [
        { abs_id: 'id1', metadata: {} },
        { abs_id: 'id2', metadata: {} },
        { abs_id: 'id3', metadata: {} },
      ],
    });

    expect(result.success).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('counts failures and continues with remaining items on partial failure', async () => {
    mockAbsApi
      .mockResolvedValueOnce({})                               // id1 succeeds
      .mockRejectedValueOnce(new Error('ABS API error 404'))   // id2 fails
      .mockResolvedValueOnce({});                              // id3 succeeds

    const result = await callBackend('push_abs_updates', {
      items: [
        { abs_id: 'id1', metadata: {} },
        { abs_id: 'id2', metadata: {} },
        { abs_id: 'id3', metadata: {} },
      ],
    });

    expect(result.success).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].id).toBe('id2');
  });

  it('records failure with item id and error message in errors array', async () => {
    mockAbsApi.mockRejectedValue(new Error('ABS API error 403: Forbidden'));

    const result = await callBackend('push_abs_updates', {
      items: [{ abs_id: 'bad-id', metadata: {} }],
    });

    expect(result.errors[0]).toMatchObject({
      id: 'bad-id',
      error: expect.stringContaining('403'),
    });
  });

  it('skips items with missing abs_id and counts them as failed', async () => {
    const result = await callBackend('push_abs_updates', {
      items: [
        { metadata: { title: 'No ID Book' } }, // missing abs_id
      ],
    });

    expect(result.failed).toBe(1);
    expect(mockAbsApi).not.toHaveBeenCalled();
  });

  it('handles empty items array without error', async () => {
    const result = await callBackend('push_abs_updates', { items: [] });
    expect(result.success).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('accepts items array nested under request key', async () => {
    mockAbsApi.mockResolvedValue({});

    const result = await callBackend('push_abs_updates', {
      request: { items: [{ abs_id: 'id1', metadata: {} }] },
    });

    expect(result.success).toBe(1);
  });
});

// ===========================================================================
// push_abs_imports
// ===========================================================================

describe('push_abs_imports', () => {
  beforeEach(() => {
    saveLocalConfig({ abs_base_url: 'http://server', abs_api_token: 'tok' });
  });

  it('returns updated count on success', async () => {
    mockAbsApi.mockResolvedValue({});

    const result = await callBackend('push_abs_imports', {
      items: [
        { id: 'id1', metadata: { title: 'Book 1' } },
        { id: 'id2', metadata: { title: 'Book 2' } },
      ],
    });

    expect(result.updated).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('continues after individual item failure', async () => {
    mockAbsApi
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Network error'));

    const result = await callBackend('push_abs_imports', {
      items: [
        { id: 'id1', metadata: {} },
        { id: 'id2', metadata: {} },
      ],
    });

    expect(result.updated).toBe(1);
    expect(result.failed).toBe(1);
  });
});
