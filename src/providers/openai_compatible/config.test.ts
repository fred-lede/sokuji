import { describe, it, expect } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import type { SharedSettings } from '../../lib/provider/types';
import { buildCompatible, describeCompatible, type CompatibleConfig } from './config';
import { COMPATIBLE_DEFAULTS, type CompatibleSettings } from './settings';

const PAIR = { source: 'en', target: 'zh-CN' };
const shared = (patch: Partial<SharedSettings> = {}): SharedSettings => ({
  pauses: { sourceSeconds: 1.5, translationSeconds: 1.5 },
  reversed: (d) => d.source === PAIR.target && d.target === PAIR.source,
  segmentation: { mode: 'pause', sentencesPerRow: 0 },
  models: [{ id: 'test-model' }],
  ...patch,
});

const SPEAKER: SessionContext = { direction: PAIR, speech: true, turns: 'auto' };
const PARTICIPANT: SessionContext = { direction: { source: 'zh-CN', target: 'en' }, speech: true, turns: 'auto' };
const MANUAL: SessionContext = { direction: PAIR, speech: true, turns: 'manual' };
const TEXT_ONLY: SessionContext = { direction: PAIR, speech: false, turns: 'auto' };

const settings = (patch: Partial<CompatibleSettings> = {}): CompatibleSettings => ({
  ...COMPATIBLE_DEFAULTS,
  endpoint: 'https://host.example.com',
  ...patch,
});

describe('buildCompatible', () => {
  it('refuses when the endpoint is empty', () => {
    const result = buildCompatible(SPEAKER, settings({ endpoint: '' }), shared());
    expect(result).toEqual({ refused: 'Enter the endpoint URL.', code: 'endpoint_required' });
  });

  it('refuses for a whitespace-only endpoint', () => {
    const result = buildCompatible(SPEAKER, settings({ endpoint: '   ' }), shared());
    expect(result).toMatchObject({ code: 'endpoint_required' });
  });

  it('normalizes the endpoint in the config', () => {
    const result = buildCompatible(SPEAKER, settings({ endpoint: 'myhost/v1' }), shared()) as CompatibleConfig;
    expect(result.endpoint).toBe('https://myhost');
  });

  it('sets translateModel and asrModel verbatim', () => {
    const result = buildCompatible(
      SPEAKER,
      settings({ translateModel: 'qwen3-translate', asrModel: 'qwen3-asr' }),
      shared(),
    ) as CompatibleConfig;
    expect(result.translateModel).toBe('qwen3-translate');
    expect(result.asrModel).toBe('qwen3-asr');
  });

  it('sets modalities to [audio] when speech is true', () => {
    const result = buildCompatible(SPEAKER, settings(), shared()) as CompatibleConfig;
    expect(result.modalities).toEqual(['audio']);
  });

  it('sets modalities to [text] when speech is false', () => {
    const result = buildCompatible(TEXT_ONLY, settings(), shared()) as CompatibleConfig;
    expect(result.modalities).toEqual(['text']);
  });

  it('sets voice from the speaker field when not reversed', () => {
    const result = buildCompatible(SPEAKER, settings({ voice: 'my-voice' }), shared()) as CompatibleConfig;
    expect(result.voice).toBe('my-voice');
  });

  it('sets voice from the participant field when reversed', () => {
    const result = buildCompatible(
      PARTICIPANT,
      settings({ voice: 'my-voice', participantVoice: 'their-voice' }),
      shared(),
    ) as CompatibleConfig;
    expect(result.voice).toBe('their-voice');
  });

  it('omits voice when the field is empty', () => {
    const result = buildCompatible(SPEAKER, settings({ voice: '' }), shared()) as CompatibleConfig;
    expect(result.voice).toBeUndefined();
  });

  it('omits voice when speech is false, even if set', () => {
    const result = buildCompatible(TEXT_ONLY, settings({ voice: 'my-voice' }), shared()) as CompatibleConfig;
    expect(result.voice).toBeUndefined();
  });

  it('turnDetection is null for manual turns', () => {
    const result = buildCompatible(MANUAL, settings(), shared()) as CompatibleConfig;
    expect(result.turnDetection).toBeNull();
  });

  it('turnDetection is server_vad for Normal mode', () => {
    const result = buildCompatible(SPEAKER, settings({ turnDetectionMode: 'Normal' }), shared()) as CompatibleConfig;
    expect(result.turnDetection).toMatchObject({ type: 'server_vad' });
  });

  it('turnDetection is semantic_vad for Semantic mode', () => {
    const result = buildCompatible(
      SPEAKER,
      settings({ turnDetectionMode: 'Semantic', semanticEagerness: 'High' }),
      shared(),
    ) as CompatibleConfig;
    expect(result.turnDetection).toEqual({ type: 'semantic_vad', eagerness: 'high' });
  });

  it('noiseReduction is null for None', () => {
    const result = buildCompatible(SPEAKER, settings({ noiseReduction: 'None' }), shared()) as CompatibleConfig;
    expect(result.noiseReduction).toBeNull();
  });

  it('noiseReduction is near_field for Near field', () => {
    const result = buildCompatible(SPEAKER, settings({ noiseReduction: 'Near field' }), shared()) as CompatibleConfig;
    expect(result.noiseReduction).toBe('near_field');
  });

  it('maxTokens is inf by default', () => {
    const result = buildCompatible(SPEAKER, settings(), shared()) as CompatibleConfig;
    expect(result.maxTokens).toBe('inf');
  });

  it('maxTokens is clamped to 4096 when stored above the range', () => {
    const result = buildCompatible(SPEAKER, settings({ maxTokens: 99999 } as any), shared()) as CompatibleConfig;
    expect(result.maxTokens).toBe(4096);
  });

  it('transport is always websocket', () => {
    const result = buildCompatible(SPEAKER, settings(), shared()) as CompatibleConfig;
    expect(result.transport).toBe('websocket');
  });

  it('instructions use participantSystemInstructions when reversed and non-blank', () => {
    const result = buildCompatible(
      PARTICIPANT,
      settings({
        participantSystemInstructions: 'Custom participant',
        systemInstructions: 'My default instructions',
        useTemplateMode: false,
      }),
      shared(),
    ) as CompatibleConfig;
    expect(result.instructions).toBe('Custom participant');
  });

  it('instructions fall back to systemInstructions when participantSystemInstructions is blank', () => {
    const result = buildCompatible(
      PARTICIPANT,
      settings({
        participantSystemInstructions: '',
        systemInstructions: 'My default instructions',
        useTemplateMode: false,
      }),
      shared(),
    ) as CompatibleConfig;
    expect(result.instructions).toBe('My default instructions');
  });
});

describe('describeCompatible', () => {
  it('returns asrModel and translationModel, no ttsModel key', () => {
    const c: CompatibleConfig = {
      endpoint: 'https://host',
      translateModel: 'qwen3-translate',
      asrModel: 'qwen3-asr',
      instructions: '',
      modalities: ['audio'],
      maxTokens: 'inf',
      turnDetection: null,
      noiseReduction: null,
      transport: 'websocket',
    };
    const desc = describeCompatible(c);
    expect(desc).toEqual({ asrModel: 'qwen3-asr', translationModel: 'qwen3-translate' });
    expect(desc).not.toHaveProperty('ttsModel');
  });
});
