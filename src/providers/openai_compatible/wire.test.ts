import { describe, it, expect } from 'vitest';
import {
  compatibleProtocols,
  compatibleSessionUpdate,
  compatibleUrl,
} from './wire';
import type { CompatibleConfig, TurnDetection } from './config';
import type { CompatibleCredentials } from './settings';

const key: CompatibleCredentials = { apiKey: 'sk-test' };

function config(patch: Partial<CompatibleConfig> = {}): CompatibleConfig {
  return {
    endpoint: 'https://host.example.com',
    translateModel: 'qwen3-translate',
    asrModel: 'qwen3-asr',
    instructions: 'Translate en → zh.',
    modalities: ['audio'],
    voice: undefined,
    maxTokens: 'inf',
    turnDetection: null,
    noiseReduction: null,
    transport: 'websocket',
    ...patch,
  };
}

describe('compatibleUrl', () => {
  it('builds wss:// URL with no model when translateModel is empty', () => {
    expect(compatibleUrl(config({ translateModel: '' }))).toBe('wss://host.example.com/v1/realtime');
  });
  it('includes ?model= when translateModel is set', () => {
    expect(compatibleUrl(config())).toBe('wss://host.example.com/v1/realtime?model=qwen3-translate');
  });
  it('strips https:// from the endpoint', () => {
    expect(compatibleUrl(config())).not.toContain('https://');
    expect(compatibleUrl(config())).toMatch(/^wss:\/\//);
  });
});

describe('compatibleProtocols', () => {
  it('returns realtime and the key subprotocol', () => {
    expect(compatibleProtocols(key)).toEqual(['realtime', 'openai-insecure-api-key.sk-test']);
  });
});

describe('compatibleSessionUpdate', () => {
  it('includes audio.input.transcription.model when asrModel is set', () => {
    const { session } = compatibleSessionUpdate(config());
    expect((session as any).audio.input.transcription).toEqual({ model: 'qwen3-asr' });
  });
  it('omits transcription when asrModel is empty', () => {
    const { session } = compatibleSessionUpdate(config({ asrModel: '' }));
    expect((session as any).audio.input.transcription).toBeUndefined();
  });
  it('includes audio.output.voice when voice is set', () => {
    const { session } = compatibleSessionUpdate(config({ voice: 'custom-voice-1' }));
    expect((session as any).audio.output).toEqual({ voice: 'custom-voice-1' });
  });
  it('omits audio.output when voice is undefined', () => {
    const { session } = compatibleSessionUpdate(config({ voice: undefined }));
    expect((session as any).audio.output).toBeUndefined();
  });
  it('omits turn_detection when turnDetection is null', () => {
    const { session } = compatibleSessionUpdate(config({ turnDetection: null }));
    expect((session as any).audio.input.turn_detection).toBeUndefined();
  });
  it('includes turn_detection for semantic_vad', () => {
    const td: TurnDetection = { type: 'semantic_vad', eagerness: 'low' };
    const { session } = compatibleSessionUpdate(config({ turnDetection: td }));
    expect((session as any).audio.input.turn_detection).toEqual({
      type: 'semantic_vad',
      create_response: true,
      interrupt_response: false,
      eagerness: 'low',
    });
  });
  it('includes turn_detection for server_vad with correct ms units', () => {
    const td: TurnDetection = { type: 'server_vad', threshold: 0.5, prefixPaddingMs: 500, silenceDurationMs: 500 };
    const { session } = compatibleSessionUpdate(config({ turnDetection: td }));
    expect((session as any).audio.input.turn_detection).toEqual({
      type: 'server_vad',
      create_response: true,
      interrupt_response: false,
      threshold: 0.5,
      prefix_padding_ms: 500,
      silence_duration_ms: 500,
    });
  });
  it('includes max_output_tokens when maxTokens is a finite number', () => {
    const { session } = compatibleSessionUpdate(config({ maxTokens: 2048 }));
    expect((session as any).max_output_tokens).toBe(2048);
  });
  it('omits max_output_tokens when maxTokens is inf', () => {
    const { session } = compatibleSessionUpdate(config({ maxTokens: 'inf' }));
    expect((session as any).max_output_tokens).toBeUndefined();
  });
  it('includes noise_reduction when not null', () => {
    const { session } = compatibleSessionUpdate(config({ noiseReduction: 'near_field' }));
    expect((session as any).audio.input.noise_reduction).toEqual({ type: 'near_field' });
  });
  it('omits noise_reduction when null', () => {
    const { session } = compatibleSessionUpdate(config({ noiseReduction: null }));
    expect((session as any).audio.input.noise_reduction).toBeUndefined();
  });
  it('never includes a reasoning field', () => {
    const { session } = compatibleSessionUpdate(config());
    expect((session as any).reasoning).toBeUndefined();
  });
});
