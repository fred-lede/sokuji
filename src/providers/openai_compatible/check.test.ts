import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVirtualClock } from '../../lib/contract/clock';
import { checkCompatible } from './check';
import { COMPATIBLE_DEFAULTS, type CompatibleCredentials, type CompatibleSettings } from './settings';

const KEY: CompatibleCredentials = { apiKey: 'sk-test' };
const baseSettings = (patch: Partial<CompatibleSettings> = {}): CompatibleSettings => ({
  ...COMPATIBLE_DEFAULTS,
  ...patch,
});

function mockFetch(responseBody: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseBody,
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch({ data: [] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkCompatible', () => {
  it('answers endpoint_required when the endpoint is empty', async () => {
    const result = await checkCompatible(KEY, baseSettings({ endpoint: '' }), { clock: createVirtualClock() } as any);
    expect(result).toEqual({ ok: false, code: 'endpoint_required', reason: 'Enter the endpoint URL.' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('answers endpoint_required for whitespace-only endpoint', async () => {
    const result = await checkCompatible(KEY, baseSettings({ endpoint: '   ' }), { clock: createVirtualClock() } as any);
    expect(result).toEqual({ ok: false, code: 'endpoint_required', reason: 'Enter the endpoint URL.' });
  });

  it('answers invalid_key on HTTP 401', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'unauthorized' }, 401));
    const result = await checkCompatible(KEY, baseSettings({ endpoint: 'https://host' }), { clock: createVirtualClock() } as any);
    expect(result).toEqual({ ok: false, code: 'invalid_key', reason: 'The API key was refused by the endpoint.' });
  });

  it('answers invalid_key on HTTP 403', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'forbidden' }, 403));
    const result = await checkCompatible(KEY, baseSettings({ endpoint: 'https://host' }), { clock: createVirtualClock() } as any);
    expect(result).toEqual({ ok: false, code: 'invalid_key', reason: 'The API key was refused by the endpoint.' });
  });

  it('throws on HTTP 404', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'not found' }, 404));
    await expect(
      checkCompatible(KEY, baseSettings({ endpoint: 'https://host' }), { clock: createVirtualClock() } as any),
    ).rejects.toThrow();
  });

  it('throws on HTTP 500', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'server error' }, 500));
    await expect(
      checkCompatible(KEY, baseSettings({ endpoint: 'https://host' }), { clock: createVirtualClock() } as any),
    ).rejects.toThrow();
  });

  it('throws when the fetch fails (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(
      checkCompatible(KEY, baseSettings({ endpoint: 'https://host' }), { clock: createVirtualClock() } as any),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('answers ok when both model IDs are in the list', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: [{ id: 'qwen3-asr' }, { id: 'qwen3-translate' }] }));
    const result = await checkCompatible(
      KEY,
      baseSettings({ endpoint: 'https://host', asrModel: 'qwen3-asr', translateModel: 'qwen3-translate' }),
      { clock: createVirtualClock() } as any,
    );
    expect(result).toEqual({ ok: true, models: [] });
  });

  it('answers model_not_listed when asrModel is not in the list', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: [{ id: 'other-model' }] }));
    const result = await checkCompatible(
      KEY,
      baseSettings({ endpoint: 'https://host', asrModel: 'qwen3-asr' }),
      { clock: createVirtualClock() } as any,
    );
    expect(result).toEqual({ ok: false, code: 'model_not_listed', reason: 'The endpoint does not list "qwen3-asr".' });
  });

  it('answers model_not_listed when translateModel is not in the list', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: [{ id: 'qwen3-asr' }] }));
    const result = await checkCompatible(
      KEY,
      baseSettings({ endpoint: 'https://host', asrModel: 'qwen3-asr', translateModel: 'qwen3-translate' }),
      { clock: createVirtualClock() } as any,
    );
    expect(result).toEqual({ ok: false, code: 'model_not_listed', reason: 'The endpoint does not list "qwen3-translate".' });
  });

  it('skips model validation when a field is empty', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: [] }));
    const result = await checkCompatible(
      KEY,
      baseSettings({ endpoint: 'https://host', asrModel: '', translateModel: '' }),
      { clock: createVirtualClock() } as any,
    );
    expect(result).toEqual({ ok: true, models: [] });
  });

  it('parses a bare array response (not { data: [] })', async () => {
    vi.stubGlobal('fetch', mockFetch([{ id: 'm1' }, { id: 'm2' }]));
    const result = await checkCompatible(
      KEY,
      baseSettings({ endpoint: 'https://host', asrModel: 'm1', translateModel: 'm2' }),
      { clock: createVirtualClock() } as any,
    );
    expect(result).toEqual({ ok: true, models: [] });
  });

  it('normalizes the endpoint before fetching', async () => {
    const fetchMock = mockFetch({ data: [] });
    vi.stubGlobal('fetch', fetchMock);
    await checkCompatible(
      KEY,
      baseSettings({ endpoint: 'myhost/v1', asrModel: '', translateModel: '' }),
      { clock: createVirtualClock() } as any,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://myhost/v1/models',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }) }),
    );
  });

  it('sends the key in the Authorization header, not the URL', async () => {
    const fetchMock = mockFetch({ data: [] });
    vi.stubGlobal('fetch', fetchMock);
    await checkCompatible(
      KEY,
      baseSettings({ endpoint: 'https://host' }),
      { clock: createVirtualClock() } as any,
    );
    const [url] = fetchMock.mock.calls[0];
    expect(url).not.toContain('sk-test');
  });
});
