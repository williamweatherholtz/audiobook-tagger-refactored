// src/lib/proxy.test.js
// Tests for absApi — the core ABS networking layer.
// These tests define the contract: any change to proxy.js that breaks them
// is a regression in ABS connectivity.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { absApi } from './proxy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object that fetch would return. */
function mockResponse(status, body) {
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(bodyText),
    json: () => Promise.resolve(typeof body === 'object' ? body : JSON.parse(bodyText)),
  };
}

/** Extract the URL and headers from the first fetch call. */
function firstCallArgs() {
  const [url, options] = global.fetch.mock.calls[0];
  return { url, options };
}

// ---------------------------------------------------------------------------
// Setup: mock global fetch so proxyFetch uses our stub (browser path).
// isTauri() returns false in jsdom so no Tauri HTTP plugin is involved.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// URL construction
// ===========================================================================

describe('absApi — URL construction', () => {
  it('concatenates base URL and path', async () => {
    global.fetch.mockResolvedValue(mockResponse(200, { libraries: [] }));

    await absApi('http://192.168.1.100:13378', 'tok', '/api/libraries');

    expect(firstCallArgs().url).toBe('http://192.168.1.100:13378/api/libraries');
  });

  it('removes a trailing slash from the base URL before concatenating', async () => {
    global.fetch.mockResolvedValue(mockResponse(200, { libraries: [] }));

    await absApi('http://192.168.1.100:13378/', 'tok', '/api/libraries');

    expect(firstCallArgs().url).toBe('http://192.168.1.100:13378/api/libraries');
  });

  it('preserves a sub-path install (e.g. /audiobookshelf)', async () => {
    global.fetch.mockResolvedValue(mockResponse(200, { libraries: [] }));

    await absApi('http://192.168.1.100:13378/audiobookshelf', 'tok', '/api/libraries');

    expect(firstCallArgs().url).toBe('http://192.168.1.100:13378/audiobookshelf/api/libraries');
  });

  it('trims leading/trailing whitespace from base URL', async () => {
    // Copy-pasting from a browser URL bar often adds spaces.
    // Without trimming, " http://..." is an invalid URL and the request silently fails.
    global.fetch.mockResolvedValue(mockResponse(200, { libraries: [] }));

    await absApi('  http://192.168.1.100:13378  ', 'tok', '/api/libraries');

    expect(firstCallArgs().url).toBe('http://192.168.1.100:13378/api/libraries');
  });

  it('trims trailing slash AND leading whitespace together', async () => {
    global.fetch.mockResolvedValue(mockResponse(200, { libraries: [] }));

    await absApi('  http://192.168.1.100:13378/  ', 'tok', '/api/libraries');

    expect(firstCallArgs().url).toBe('http://192.168.1.100:13378/api/libraries');
  });
});

// ===========================================================================
// Authorization header
// ===========================================================================

describe('absApi — Authorization header', () => {
  it('sends Authorization: Bearer <token>', async () => {
    global.fetch.mockResolvedValue(mockResponse(200, { libraries: [] }));

    await absApi('http://server', 'my-api-token', '/api/libraries');

    const { options } = firstCallArgs();
    expect(options.headers['Authorization']).toBe('Bearer my-api-token');
  });

  it('trims whitespace from token — spaces must not appear inside Bearer value', async () => {
    // ABS tokens pasted from the UI often carry trailing newlines or spaces.
    // "Bearer  my-token " (with extra spaces) will be rejected by ABS with 401.
    global.fetch.mockResolvedValue(mockResponse(200, { libraries: [] }));

    await absApi('http://server', '  my-api-token  ', '/api/libraries');

    const { options } = firstCallArgs();
    expect(options.headers['Authorization']).toBe('Bearer my-api-token');
  });

  it('includes Content-Type: application/json', async () => {
    global.fetch.mockResolvedValue(mockResponse(200, {}));

    await absApi('http://server', 'tok', '/api/libraries');

    const { options } = firstCallArgs();
    expect(options.headers['Content-Type']).toBe('application/json');
  });
});

// ===========================================================================
// HTTP method
// ===========================================================================

describe('absApi — HTTP method', () => {
  it('defaults to GET', async () => {
    global.fetch.mockResolvedValue(mockResponse(200, {}));
    await absApi('http://server', 'tok', '/api/libraries');
    expect(firstCallArgs().options.method).toBe('GET');
  });

  it('passes through PATCH for metadata updates', async () => {
    global.fetch.mockResolvedValue(mockResponse(200, {}));
    await absApi('http://server', 'tok', '/api/items/abc/media', {
      method: 'PATCH',
      body: { metadata: { title: 'Test' } },
    });
    expect(firstCallArgs().options.method).toBe('PATCH');
  });
});

// ===========================================================================
// Response handling
// ===========================================================================

describe('absApi — response handling', () => {
  it('returns parsed JSON on 200', async () => {
    const data = { libraries: [{ id: 'lib1', name: 'Audiobooks' }] };
    global.fetch.mockResolvedValue(mockResponse(200, data));

    const result = await absApi('http://server', 'tok', '/api/libraries');

    expect(result).toEqual(data);
  });

  it('throws on 401 Unauthorized — wrong or expired token', async () => {
    global.fetch.mockResolvedValue(mockResponse(401, 'Unauthorized'));

    await expect(absApi('http://server', 'bad-token', '/api/libraries'))
      .rejects.toThrow('ABS API error 401');
  });

  it('throws on 403 Forbidden', async () => {
    global.fetch.mockResolvedValue(mockResponse(403, 'Forbidden'));

    await expect(absApi('http://server', 'tok', '/api/libraries'))
      .rejects.toThrow('ABS API error 403');
  });

  it('throws on 404 Not Found — wrong URL path', async () => {
    global.fetch.mockResolvedValue(mockResponse(404, 'Not Found'));

    await expect(absApi('http://server', 'tok', '/api/WRONG'))
      .rejects.toThrow('ABS API error 404');
  });

  it('throws on 500 and includes response body in message', async () => {
    global.fetch.mockResolvedValue(mockResponse(500, 'Internal Server Error'));

    await expect(absApi('http://server', 'tok', '/api/libraries'))
      .rejects.toThrow('ABS API error 500: Internal Server Error');
  });

  it('includes ABS error body in thrown message so callers can show it to users', async () => {
    global.fetch.mockResolvedValue(mockResponse(401, 'Invalid token: malformed UUID'));

    await expect(absApi('http://server', 'tok', '/api/libraries'))
      .rejects.toThrow('Invalid token: malformed UUID');
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe('absApi — edge cases', () => {
  it('works with http:// (plain HTTP, not HTTPS)', async () => {
    global.fetch.mockResolvedValue(mockResponse(200, { libraries: [] }));

    await expect(absApi('http://192.168.1.100:13378', 'tok', '/api/libraries'))
      .resolves.not.toThrow();
  });

  it('works with https:// (secure)', async () => {
    global.fetch.mockResolvedValue(mockResponse(200, { libraries: [] }));

    await expect(absApi('https://abs.example.com', 'tok', '/api/libraries'))
      .resolves.not.toThrow();
  });

  it('handles empty response body on 401', async () => {
    global.fetch.mockResolvedValue(mockResponse(401, ''));

    await expect(absApi('http://server', 'tok', '/api/libraries'))
      .rejects.toThrow('ABS API error 401');
  });
});
