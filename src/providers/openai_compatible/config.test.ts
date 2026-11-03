import { describe, it, expect } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import type { SharedSettings } from '../../lib/provider/types';
import { buildCompatible, describeCompatible, type CompatibleConfig } from './config';
import { COMPATIBLE_DEFAULTS, type CompatibleSettings } from './settings';

const SHARED: SharedSettings = {
  pauses: { sourceSeconds: 1.5, translationSeconds: 1.5 },
  reversed: (d) => d.source === 'en' && d.target === 'ja',
  segmentation: { mode: 'pause', sentencesPerRow: 0 },
  models: [{ id: 'test-model' }],
};

const AUTO_CTX: SessionContext = { direction: { source: 'en', target: 'zh-CN' }, speech: true, turns: 'auto' };
const MANUAL_CTX: SessionContext = { ...AUTO_CTX, turns: 'manual' };

function configFor(context: SessionContext = AUTO_CTX, patch: Partial<CompatibleSettings> = {}): CompatibleConfig {
  const s: CompatibleSettings = { ...COMPATIBLE_DEFAULTS, ...patch };
  const c = buildCompatible(context, s, SHARED);
  if ('refused' in c) throw new Error(c.refused);
  return c;
}

describe('buildCompatible', () => {
  it('empty endpoint and both models empty → refused with endpoint_required', () => {
    const c = buildCompatible(AUTO_CTX, { ...COMPATIBLE_DEFAULTS, endpoint: '', asrModel: '', translateModel: '' }, SHARED);
    expect(c).toEqual({ refused: 'Enter the endpoint, and a model to run.', code: 'endpoint_required' });
  });

  it('with asrModel, translateModel, endpoint → config has them', () => {
    const c = configFor(AUTO_CTX, {
      endpoint: 'https://host',
      asrModel: 'qwen3-asr',
      translateModel: 'qwen3-translate',
    });
    expect(c.endpoint).toBe('https://host');
    expect(c.asrModel).toBe('qwen3-asr');
    expect(c.translateModel).toBe('qwen3-translate');
  });

  it('manual turns → turnDetection: null', () => {
    const c = configFor(MANUAL_CTX, { endpoint: 'https://host' });
    expect(c.turnDetection).toBeNull();
  });

  it('auto turns, turnDetectionMode: Semantic → semantic_vad', () => {
    const c = configFor(AUTO_CTX, { endpoint: 'https://host', turnDetectionMode: 'Semantic', semanticEagerness: 'High' });
    expect(c.turnDetection).toEqual({ type: 'semantic_vad', eagerness: 'high' });
  });

  it('auto turns, turnDetectionMode: Normal → server_vad with clamped values', () => {
    const c = configFor(AUTO_CTX, { endpoint: 'https://host', turnDetectionMode: 'Normal', threshold: 0.8, prefixPadding: 1.2, silenceDuration: 1.5 });
    expect(c.turnDetection).toEqual({
      type: 'server_vad',
      threshold: 0.8,
      prefixPaddingMs: 1200,
      silenceDurationMs: 1500,
    });
  });

  it('speech: false → modalities: ["text"], no voice field', () => {
    const c = configFor({ ...AUTO_CTX, speech: false }, { endpoint: 'https://host', voice: 'v1' });
    expect(c.modalities).toEqual(['text']);
    expect(c).not.toHaveProperty('voice');
  });

  it('speech: true, voice: "" → no voice field', () => {
    const c = configFor(AUTO_CTX, { endpoint: 'https://host', voice: '', participantVoice: 'v2' });
    expect(c).not.toHaveProperty('voice');
  });

  it('speech: true, voice: "custom-voice-1" → voice: "custom-voice-1"', () => {
    const c = configFor(AUTO_CTX, { endpoint: 'https://host', voice: 'custom-voice-1', participantVoice: '' });
    expect(c.voice).toBe('custom-voice-1');
  });

  it('participant leg uses participantVoice', () => {
    // shared.reversed returns true when source === 'en' && target === 'ja'
    const ctx: SessionContext = { ...AUTO_CTX, direction: { source: 'en', target: 'ja' } }; // reversed
    const c = configFor(ctx, { endpoint: 'https://host', voice: 'v1', participantVoice: 'v2' });
    expect(c.voice).toBe('v2');
  });

  it('maxTokens: "inf" → "inf"', () => {
    const c = configFor(AUTO_CTX, { endpoint: 'https://host', maxTokens: 'inf' });
    expect(c.maxTokens).toBe('inf');
  });

  it('maxTokens: 2048 → clamped to 2048', () => {
    const c = configFor(AUTO_CTX, { endpoint: 'https://host', maxTokens: 2048 });
    expect(c.maxTokens).toBe(2048);
  });

  it('maxTokens: 99999 → clamped to 4096', () => {
    const c = configFor(AUTO_CTX, { endpoint: 'https://host', maxTokens: 99999 });
    expect(c.maxTokens).toBe(4096);
  });

  it('noiseReduction: None → null', () => {
    const c = configFor(AUTO_CTX, { endpoint: 'https://host', noiseReduction: 'None' });
    expect(c.noiseReduction).toBeNull();
  });

  it('noiseReduction: Near field → near_field', () => {
    const c = configFor(AUTO_CTX, { endpoint: 'https://host', noiseReduction: 'Near field' });
    expect(c.noiseReduction).toBe('near_field');
  });

  it('noiseReduction: Far field → far_field', () => {
    const c = configFor(AUTO_CTX, { endpoint: 'https://host', noiseReduction: 'Far field' });
    expect(c.noiseReduction).toBe('far_field');
  });

  it('transport is always websocket', () => {
    const c = configFor(AUTO_CTX, { endpoint: 'https://host' });
    expect(c.transport).toBe('websocket');
  });
});

describe('describeCompatible', () => {
  it('returns { asrModel, translationModel } with no ttsModel key', () => {
    const c: CompatibleConfig = {
      endpoint: 'https://host',
      asrModel: 'qwen3-asr',
      translateModel: 'qwen3-translate',
      instructions: '',
      modalities: ['audio'],
      maxTokens: 'inf',
      turnDetection: null,
      noiseReduction: null,
      transport: 'websocket',
    };
    expect(describeCompatible(c)).toEqual({ asrModel: 'qwen3-asr', translationModel: 'qwen3-translate' });
  });
});