import { describe, it, expect } from 'vitest';
import { AUTO } from '../../lib/provider/languages';
import {
  COMPATIBLE_DEFAULTS,
  compatibleLanguages,
  compatibleCredentials,
  migrateCompatibleSettings,
  normalizeEndpoint,
} from './settings';

import type { MigrationInputs } from '../../lib/provider/types';

const inputs = (legacy: Readonly<Record<string, unknown>> = {}): MigrationInputs => ({ legacy, credentials: {} });

describe('normalizeEndpoint', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeEndpoint('')).toBe('');
    expect(normalizeEndpoint('   ')).toBe('');
  });
  it('prepends https:// when no scheme', () => {
    expect(normalizeEndpoint('myhost')).toBe('https://myhost');
  });
  it('keeps http:// and https:// schemes', () => {
    expect(normalizeEndpoint('http://myhost')).toBe('http://myhost');
    expect(normalizeEndpoint('https://myhost')).toBe('https://myhost');
  });
  it('strips a trailing /', () => {
    expect(normalizeEndpoint('https://myhost/')).toBe('https://myhost');
    expect(normalizeEndpoint('https://myhost///')).toBe('https://myhost');
  });
  it('strips a trailing /v1', () => {
    expect(normalizeEndpoint('https://myhost/v1')).toBe('https://myhost');
    expect(normalizeEndpoint('https://myhost/v1/')).toBe('https://myhost');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeEndpoint('  https://myhost  ')).toBe('https://myhost');
  });
});

describe('COMPATIBLE_DEFAULTS', () => {
  it('has empty endpoint and model fields', () => {
    expect(COMPATIBLE_DEFAULTS.endpoint).toBe('');
    expect(COMPATIBLE_DEFAULTS.asrModel).toBe('');
    expect(COMPATIBLE_DEFAULTS.translateModel).toBe('');
    expect(COMPATIBLE_DEFAULTS.voice).toBe('');
    expect(COMPATIBLE_DEFAULTS.participantVoice).toBe('');
  });
  it('uses the same turn-detection defaults as OpenAI Realtime', () => {
    expect(COMPATIBLE_DEFAULTS.turnDetectionMode).toBe('Normal');
    expect(COMPATIBLE_DEFAULTS.threshold).toBe(0.49);
    expect(COMPATIBLE_DEFAULTS.maxTokens).toBe('inf');
  });
});

describe('migrateCompatibleSettings', () => {
  it('fills in defaults when nothing is stored', () => {
    const s = migrateCompatibleSettings({}, inputs());
    expect(s.endpoint).toBe('');
    expect(s.asrModel).toBe('');
    expect(s.translateModel).toBe('');
    expect(s.voice).toBe('');
    expect(s.participantVoice).toBe('');
  });
  it('reads a stored endpoint string', () => {
    const s = migrateCompatibleSettings({ endpoint: 'https://myhost.com' }, inputs());
    expect(s.endpoint).toBe('https://myhost.com');
  });
  it('falls back to "" for a non-string asrModel', () => {
    const s = migrateCompatibleSettings({ asrModel: 42 }, inputs());
    expect(s.asrModel).toBe('');
  });
  it('falls back to "" for a non-string voice', () => {
    const s = migrateCompatibleSettings({ voice: 42 }, inputs());
    expect(s.voice).toBe('');
  });
  it('turnDetectionMode outside the known modes falls to Normal', () => {
    const s = migrateCompatibleSettings({ turnDetectionMode: 'Disabled' }, inputs());
    expect(s.turnDetectionMode).toBe('Normal');
  });
  it('noiseReduction outside the list falls to None', () => {
    const s = migrateCompatibleSettings({ noiseReduction: 'Weird' }, inputs());
    expect(s.noiseReduction).toBe('None');
  });
  it('preserves a stored maxTokens: "inf"', () => {
    const s = migrateCompatibleSettings({ maxTokens: 'inf' }, inputs());
    expect(s.maxTokens).toBe('inf');
  });
  it('preserves a stored finite maxTokens', () => {
    const s = migrateCompatibleSettings({ maxTokens: 4096 }, inputs());
    expect(s.maxTokens).toBe(4096);
  });
  it('preserves a stored endpoint and model fields', () => {
    const s = migrateCompatibleSettings(
      { endpoint: 'https://host', asrModel: 'qwen3-asr', translateModel: 'qwen3-translate', voice: 'v1', participantVoice: 'v2' },
      inputs(),
    );
    expect(s.endpoint).toBe('https://host');
    expect(s.asrModel).toBe('qwen3-asr');
    expect(s.translateModel).toBe('qwen3-translate');
    expect(s.voice).toBe('v1');
    expect(s.participantVoice).toBe('v2');
  });
});

describe('compatibleLanguages', () => {
  it('offers AUTO as a source', () => {
    const sources = compatibleLanguages.sources(COMPATIBLE_DEFAULTS);
    expect(sources[0].value).toBe(AUTO);
  });
  it('offers 55 languages as targets (not including AUTO)', () => {
    const targets = compatibleLanguages.targets(AUTO, COMPATIBLE_DEFAULTS);
    expect(targets.length).toBe(55);
    expect(targets.map((t) => t.value)).not.toContain(AUTO);
  });
  it('initial pair is en → zh-CN', () => {
    expect(compatibleLanguages.initial!(COMPATIBLE_DEFAULTS)).toEqual({ source: 'en', target: 'zh-CN' });
  });
});

describe('compatibleCredentials', () => {
  const noAuth = { signedIn: false, getToken: async () => null };
  it('returns missing when key is empty', () => {
    const result = compatibleCredentials.read({ apiKey: '' }, noAuth);
    expect('missing' in result).toBe(true);
  });
  it('returns the key when present', () => {
    const result = compatibleCredentials.read({ apiKey: 'sk-abc' }, noAuth);
    expect(result).toEqual({ apiKey: 'sk-abc' });
  });
});
