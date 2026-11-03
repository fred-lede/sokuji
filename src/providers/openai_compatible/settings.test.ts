import { describe, it, expect } from 'vitest';
import { INSTRUCTION_LEGACY_KEYS, INSTRUCTIONS_DEFAULTS } from '../../lib/provider/instructions';
import { AUTO, reverseSupported } from '../../lib/provider/languages';
import type { AuthContext } from '../../lib/provider/types';
import { parseCode } from '../../lib/language/code';
import { englishLanguageName } from '../../lib/language/label';
import {
  compatibleCredentials,
  compatibleLanguages,
  COMPATIBLE_DEFAULTS,
  COMPATIBLE_LEGACY_KEYS,
  migrateCompatibleSettings,
  normalizeEndpoint,
  type CompatibleSettings,
} from './settings';
import { REALTIME_LANGUAGES } from '../openai/settings';

const signedOut: AuthContext = { signedIn: false, getToken: async () => null };
const migrate = (stored: Record<string, unknown>, legacy: Record<string, unknown> = {}) =>
  migrateCompatibleSettings(stored, { legacy, credentials: { apiKey: '' } });

describe("OpenAI Compatible's settings", () => {
  it('starts from INSTRUCTIONS_DEFAULTS plus endpoint and the new model/voice fields', () => {
    expect(COMPATIBLE_DEFAULTS).toEqual({
      ...INSTRUCTIONS_DEFAULTS,
      endpoint: '',
      asrModel: '',
      translateModel: '',
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
    });
    expect(COMPATIBLE_DEFAULTS).not.toHaveProperty('transcriptModel');
    expect(COMPATIBLE_DEFAULTS).not.toHaveProperty('reasoningEffort');
    expect(COMPATIBLE_DEFAULTS).not.toHaveProperty('model');
  });

  it('legacy keys are INSTRUCTION_LEGACY_KEYS plus endpoint', () => {
    expect(COMPATIBLE_LEGACY_KEYS).toEqual([...INSTRUCTION_LEGACY_KEYS, 'endpoint']);
  });

  it('loads an old profile field by field: endpoint from old slice, new fields default to empty', () => {
    const s = migrate({
      endpoint: 'https://my-server.example.com',
      turnDetectionMode: 'Semantic',
      threshold: 0.7,
      prefixPadding: 0.3,
      silenceDuration: 1.2,
      semanticEagerness: 'High',
      maxTokens: 2048,
      transcriptKeywords: 'Sokuji',
      noiseReduction: 'Far field',
    });
    expect(s).toMatchObject({
      endpoint: 'https://my-server.example.com',
      turnDetectionMode: 'Semantic',
      threshold: 0.7,
      prefixPadding: 0.3,
      silenceDuration: 1.2,
      semanticEagerness: 'High',
      maxTokens: 2048,
      transcriptKeywords: 'Sokuji',
      noiseReduction: 'Far field',
      asrModel: '',
      translateModel: '',
      voice: '',
      participantVoice: '',
    });
  });

  it("reads a stored push mode as no mechanism: 'Disabled' and 'Push-to-Translate' fall to 'Normal'", () => {
    expect(migrate({ turnDetectionMode: 'Disabled' }).turnDetectionMode).toBe('Normal');
    expect(migrate({ turnDetectionMode: 'Push-to-Translate' }).turnDetectionMode).toBe('Normal');
    expect(migrate({ turnDetectionMode: 'Normal' }).turnDetectionMode).toBe('Normal');
  });

  it('falls each malformed field to its default, and reads an Electron max-tokens string as its number', () => {
    const s = migrate({
      endpoint: 5,
      asrModel: null,
      translateModel: undefined,
      voice: 123,
      participantVoice: true,
      turnDetectionMode: 'Loud',
      threshold: 'high',
      prefixPadding: Number.NaN,
      silenceDuration: undefined,
      semanticEagerness: 'Eager',
      maxTokens: '2048',
      transcriptKeywords: ['a'],
      noiseReduction: 'Loud',
    });
    expect(s).toEqual({ ...COMPATIBLE_DEFAULTS, maxTokens: 2048 });
    expect(migrate({ maxTokens: 'lots' }).maxTokens).toBe('inf');
    expect(migrate({ maxTokens: 'inf' }).maxTokens).toBe('inf');
  });

  it('reads the instructions from the old global copy until its own is written', () => {
    const s = migrate({}, { 'settings.common.useTemplateMode': false, 'settings.common.systemInstructions': 'Translate plainly.' });
    expect(s).toMatchObject({ useTemplateMode: false, systemInstructions: 'Translate plainly.' });
  });

  it('offers Auto-detect and the 55 languages as sources, the 55 as every source targets, en → zh-CN first', () => {
    const sources = compatibleLanguages.sources(COMPATIBLE_DEFAULTS);
    expect(sources).toHaveLength(56);
    expect(sources[0].value).toBe(AUTO);
    expect(sources.slice(1)).toEqual(REALTIME_LANGUAGES);
    expect(compatibleLanguages.targets(AUTO, COMPATIBLE_DEFAULTS)).toEqual(REALTIME_LANGUAGES);
    expect(compatibleLanguages.targets('en', COMPATIBLE_DEFAULTS).map((o) => o.value)).toContain('en');
    expect(compatibleLanguages.initial?.(COMPATIBLE_DEFAULTS)).toEqual({ source: 'en', target: 'zh-CN' });
    expect(reverseSupported({ languages: compatibleLanguages }, COMPATIBLE_DEFAULTS, { source: AUTO, target: 'en' })).toBe(false);
    expect(reverseSupported({ languages: compatibleLanguages }, COMPATIBLE_DEFAULTS, { source: 'ja', target: 'en' })).toBe(true);
  });

  it('names a language in English for the template, Auto-detect as "the spoken language"', () => {
    expect(compatibleLanguages.wire?.toWire('zh-CN')).toBe('zh-CN');
    expect(compatibleLanguages.wire?.fromWire('zh-CN')).toBe('zh-CN');
  });

  it('reads one key, trimmed, and an empty one as missing with endpoint-specific message', () => {
    expect(compatibleCredentials.fields(COMPATIBLE_DEFAULTS)).toEqual([{ key: 'apiKey', labelKey: 'setup.credentials.apiKey', secret: true, placeholderKey: 'simpleSettings.apiKeyPlaceholder' }]);
    expect(compatibleCredentials.read({ apiKey: ' sk-proj-abc\n' }, signedOut)).toEqual({ apiKey: 'sk-proj-abc' });
    expect(compatibleCredentials.read({ apiKey: '  ' }, signedOut)).toEqual({ missing: "Enter the endpoint's API key." });
  });

  describe('normalizeEndpoint', () => {
    it('empty string stays empty', () => {
      expect(normalizeEndpoint('')).toBe('');
      expect(normalizeEndpoint('   ')).toBe('');
    });

    it('adds https:// when no scheme', () => {
      expect(normalizeEndpoint('myhost')).toBe('https://myhost');
      expect(normalizeEndpoint('myhost/')).toBe('https://myhost');
      expect(normalizeEndpoint('myhost/v1')).toBe('https://myhost');
      expect(normalizeEndpoint('myhost/v1/')).toBe('https://myhost');
    });

    it('keeps https:// and strips trailing / and /v1', () => {
      expect(normalizeEndpoint('https://host')).toBe('https://host');
      expect(normalizeEndpoint('https://host/')).toBe('https://host');
      expect(normalizeEndpoint('https://host/v1')).toBe('https://host');
      expect(normalizeEndpoint('https://host/v1/')).toBe('https://host');
    });

    it('keeps http:// and strips trailing / and /v1', () => {
      expect(normalizeEndpoint('http://host')).toBe('http://host');
      expect(normalizeEndpoint('http://host/')).toBe('http://host');
      expect(normalizeEndpoint('http://host/v1')).toBe('http://host');
      expect(normalizeEndpoint('http://host/v1/')).toBe('http://host');
    });

    it('trims whitespace', () => {
      expect(normalizeEndpoint('  https://host/v1/  ')).toBe('https://host');
    });
  });
});