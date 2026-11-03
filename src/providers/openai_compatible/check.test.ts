import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CheckContext } from '../../lib/provider/types';
import { checkCompatible } from './check';
import type { CompatibleSettings } from './settings';

const CHECK_TIMEOUT_MS = 15_000;

const defaultSettings: CompatibleSettings = {
  endpoint: 'https://example.com',
  asrModel: 'qwen3-asr',
  translateModel: 'qwen3-translate',
  voice: '',
  participantVoice: '',
  turnDetectionMode: 'Normal',
  threshold: 0.49,
  prefixPadding: 0.5,
  silenceDuration: 0.5,
  semanticEagerness: 'Auto',
  maxTokens: 'inf',
  transcriptKeywords: '',
  noiseReduction: 'None',
  useTemplateMode: true,
  systemInstructions: '',
  participantSystemInstructions: '',
};

const defaultCredentials = { apiKey: 'sk-test-key' };

const defaultContext: CheckContext = {
  pair: { source: 'en', target: 'zh-CN' },
  legs: ['speaker', 'participant'],
};

describe('checkCompatible', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it('endpoint empty → endpoint_required', async () => {
    const s = { ...defaultSettings, endpoint: '' };
    const result = await checkCompatible(defaultCredentials, s, defaultContext);
    expect(result).toEqual({ ok: false, code: 'endpoint_required', reason: 'Enter the endpoint URL.' });
  });

  it('401/403 → invalid_key', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }),
    } as Response);

    const result = await checkCompatible(defaultCredentials, defaultSettings, defaultContext);
    expect(result).toEqual({ ok: false, code: 'auth', reason: expect.stringContaining('HTTP 401') });
  });

  it('200 with both models in list → ok', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'qwen3-asr' }, { id: 'qwen3-translate' }, { id: 'other-model' }] }),
    } as Response);

    const result = await checkCompatible(defaultCredentials, defaultSettings, defaultContext);
    expect(result).toEqual({ ok: true, models: [] });
  });

  it('200 with asrModel not in list → model_not_listed', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'qwen3-translate' }] }),
    } as Response);

    const result = await checkCompatible(defaultCredentials, defaultSettings, defaultContext);
    expect(result).toEqual({ ok: false, code: 'model_not_listed', reason: 'The endpoint does not list "qwen3-asr".' });
  });

  it('200 with translateModel not in list → model_not_listed', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'qwen3-asr' }] }),
    } as Response);

    const result = await checkCompatible(defaultCredentials, defaultSettings, defaultContext);
    expect(result).toEqual({ ok: false, code: 'model_not_listed', reason: 'The endpoint does not list "qwen3-translate".' });
  });

  it('fetch throws (network failure) → throws', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockRejectedValueOnce(new Error('network error'));

    await expect(checkCompatible(defaultCredentials, defaultSettings, defaultContext)).rejects.toThrow('network error');
  });

  it('200 with bare array body (not { data: [] }) → parsed correctly', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 'qwen3-asr' }, { id: 'qwen3-translate' }],
    } as Response);

    const result = await checkCompatible(defaultCredentials, defaultSettings, defaultContext);
    expect(result).toEqual({ ok: true, models: [] });
  });

  it('empty model fields are not validated against the list', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    const s = { ...defaultSettings, asrModel: '', translateModel: '' };
    const result = await checkCompatible(defaultCredentials, s, defaultContext);
    expect(result).toEqual({ ok: true, models: [] });
  });

  it('429 → rate_limit', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Rate limited', code: 'rate_limit_exceeded' } }),
    } as Response);

    const result = await checkCompatible(defaultCredentials, defaultSettings, defaultContext);
    expect(result).toEqual({ ok: false, code: 'rate_limit', reason: expect.stringContaining('HTTP 429') });
  });

  it('5xx → throws', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'Internal server error', code: 'internal_error' } }),
    } as Response);

    await expect(checkCompatible(defaultCredentials, defaultSettings, defaultContext)).rejects.toThrow('The endpoint answered the model list with HTTP 500.');
  });

  it('404 → throws', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: 'Not found', code: 'not_found' } }),
    } as Response);

    await expect(checkCompatible(defaultCredentials, defaultSettings, defaultContext)).rejects.toThrow('The endpoint answered the model list with HTTP 404.');
  });
});