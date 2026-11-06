import { describe, it, expect } from 'vitest';
import { compatibleUrl, compatibleProtocols, compatibleSessionUpdate, type CompatibleConfig } from './wire';
import { TurnDetection } from '../openai/config';

const baseConfig: CompatibleConfig = {
  endpoint: 'https://host',
  translateModel: '',
  asrModel: '',
  instructions: '',
  modalities: ['audio'],
  maxTokens: 'inf',
  turnDetection: null,
  noiseReduction: null,
  transport: 'websocket',
};

describe('wire', () => {
  describe('compatibleUrl', () => {
    it('no model, no apiKey → wss://host/v1/realtime', () => {
      expect(compatibleUrl({ ...baseConfig, endpoint: 'https://host', translateModel: '' })).toBe('wss://host/v1/realtime');
    });

    it('with model, no apiKey → wss://host/v1/realtime?model=...', () => {
      expect(compatibleUrl({ ...baseConfig, endpoint: 'https://host', translateModel: 'qwen3-translate' })).toBe('wss://host/v1/realtime?model=qwen3-translate');
    });

    it('with model and apiKey → wss://host/v1/realtime?model=...&api_key=...', () => {
      expect(compatibleUrl({ ...baseConfig, endpoint: 'https://host', translateModel: 'qwen3-translate' }, 'sk-abc')).toBe('wss://host/v1/realtime?model=qwen3-translate&api_key=sk-abc');
    });

    it('endpoint already normalized (no scheme stripping needed)', () => {
      expect(compatibleUrl({ ...baseConfig, endpoint: 'https://host', translateModel: 'm' })).toBe('wss://host/v1/realtime?model=m');
    });

    it('http endpoint → ws:// (plain-HTTP server)', () => {
      expect(compatibleUrl({ ...baseConfig, endpoint: 'http://122.116.209.1:8001', translateModel: 'm' })).toBe('ws://122.116.209.1:8001/v1/realtime?model=m');
    });

    it('http endpoint with apiKey → ws://...?model=...&api_key=...', () => {
      expect(compatibleUrl({ ...baseConfig, endpoint: 'http://122.116.209.1:8001', translateModel: 'm' }, 'sk-xyz')).toBe('ws://122.116.209.1:8001/v1/realtime?model=m&api_key=sk-xyz');
    });

    it('bare host → wss://', () => {
      expect(compatibleUrl({ ...baseConfig, endpoint: 'host', translateModel: '' })).toBe('wss://host/v1/realtime');
    });

    it('keeps a path prefix', () => {
      expect(compatibleUrl({ ...baseConfig, endpoint: 'http://gw.example.com/openai', translateModel: 'm' })).toBe('ws://gw.example.com/openai/v1/realtime?model=m');
    });
  });

  describe('compatibleProtocols', () => {
    it('returns realtime and openai-insecure-api-key.<key>', () => {
      expect(compatibleProtocols({ apiKey: 'sk-abc' })).toEqual(['realtime', 'openai-insecure-api-key.sk-abc']);
    });
  });

  describe('compatibleSessionUpdate', () => {
    it('with asrModel → payload has audio.input.transcription.model', () => {
      const c: CompatibleConfig = { ...baseConfig, asrModel: 'qwen3-asr', modalities: ['audio'] };
      const update = compatibleSessionUpdate(c) as { session: { audio: { input: { transcription?: { model: string } } } } };
      expect(update.session.audio.input.transcription).toEqual({ model: 'qwen3-asr' });
    });

    it('without asrModel → no audio.input.transcription object', () => {
      const c: CompatibleConfig = { ...baseConfig, asrModel: '', modalities: ['audio'] };
      const update = compatibleSessionUpdate(c) as { session: { audio: { input: { transcription?: { model: string } } } } };
      expect(update.session.audio.input.transcription).toBeUndefined();
    });

    it('with voice → payload has audio.output.voice', () => {
      const c: CompatibleConfig = { ...baseConfig, voice: 'custom-voice', modalities: ['audio'] };
      const update = compatibleSessionUpdate(c) as { session: { audio: { output: { voice: string } } } };
      expect(update.session.audio.output).toEqual({ voice: 'custom-voice' });
    });

    it('without voice → no audio.output', () => {
      const c: CompatibleConfig = { ...baseConfig, modalities: ['audio'] };
      const update = compatibleSessionUpdate(c) as { session: { audio: { output?: { voice: string } } } };
      expect(update.session.audio.output).toBeUndefined();
    });

    it('turnDetection: null → turn_detection: null', () => {
      const c: CompatibleConfig = { ...baseConfig, turnDetection: null, modalities: ['audio'] };
      const update = compatibleSessionUpdate(c) as { session: { audio: { input: { turn_detection: unknown } } } };
      expect(update.session.audio.input.turn_detection).toBeNull();
    });

    it('turnDetection: server_vad → includes threshold, prefix_padding_ms, silence_duration_ms', () => {
      const c: CompatibleConfig = {
        ...baseConfig,
        turnDetection: { type: 'server_vad', threshold: 0.5, prefixPaddingMs: 300, silenceDurationMs: 500 },
        modalities: ['audio'],
      };
      const update = compatibleSessionUpdate(c) as { session: { audio: { input: { turn_detection: unknown } } } };
      expect(update.session.audio.input.turn_detection).toEqual({
        type: 'server_vad', create_response: true, interrupt_response: false, threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500,
      });
    });

    it('turnDetection: semantic_vad → includes eagerness', () => {
      const c: CompatibleConfig = {
        ...baseConfig,
        turnDetection: { type: 'semantic_vad', eagerness: 'high' },
        modalities: ['audio'],
      };
      const update = compatibleSessionUpdate(c) as { session: { audio: { input: { turn_detection: unknown } } } };
      expect(update.session.audio.input.turn_detection).toEqual({
        type: 'semantic_vad', create_response: true, interrupt_response: false, eagerness: 'high',
      });
    });

    it('noiseReduction: null → noise_reduction: null', () => {
      const c: CompatibleConfig = { ...baseConfig, noiseReduction: null, modalities: ['audio'] };
      const update = compatibleSessionUpdate(c) as { session: { audio: { input: { noise_reduction: unknown } } } };
      expect(update.session.audio.input.noise_reduction).toBeNull();
    });

    it('noiseReduction: near_field → { type: "near_field" }', () => {
      const c: CompatibleConfig = { ...baseConfig, noiseReduction: 'near_field', modalities: ['audio'] };
      const update = compatibleSessionUpdate(c) as { session: { audio: { input: { noise_reduction: unknown } } } };
      expect(update.session.audio.input.noise_reduction).toEqual({ type: 'near_field' });
    });

    it('maxTokens: "inf" → no max_output_tokens', () => {
      const c: CompatibleConfig = { ...baseConfig, maxTokens: 'inf', modalities: ['audio'] };
      const update = compatibleSessionUpdate(c) as { session: { max_output_tokens?: number | 'inf' } };
      expect(update.session.max_output_tokens).toBeUndefined();
    });

    it('maxTokens: 2048 → max_output_tokens: 2048', () => {
      const c: CompatibleConfig = { ...baseConfig, maxTokens: 2048, modalities: ['audio'] };
      const update = compatibleSessionUpdate(c) as { session: { max_output_tokens: number } };
      expect(update.session.max_output_tokens).toBe(2048);
    });

    it('modalities: ["text"] → output_modalities: ["text"], no audio.output', () => {
      const c: CompatibleConfig = { ...baseConfig, modalities: ['text'] };
      const update = compatibleSessionUpdate(c) as { session: { output_modalities: string[]; audio: { output?: unknown } } };
      expect(update.session.output_modalities).toEqual(['text']);
      expect(update.session.audio.output).toBeUndefined();
    });
  });
});