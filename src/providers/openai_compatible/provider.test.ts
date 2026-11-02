import { describe, it, expect, vi, afterEach } from 'vitest';

const { stored, getSetting, setSetting } = vi.hoisted(() => {
  const stored = new Map<string, unknown>();
  return {
    stored,
    getSetting: vi.fn(async (key: string, def: unknown) => (stored.has(key) ? stored.get(key) : def)),
    setSetting: vi.fn(async (key: string, value: unknown) => {
      stored.set(key, value);
      return { success: true };
    }),
  };
});
vi.mock('../../services/ServiceFactory', () => ({
  ServiceFactory: { getSettingsService: () => ({ getSetting, setSetting }) },
}));

import { OpenAIIcon } from '../../components/Icons/ProviderIcons';
import { presentProviders, PROVIDERS } from '../registry';
import { selectionFromStored } from '../../lib/session/storedSettings';
import { useProviderStore } from '../../stores/providerStore';
import { createVirtualClock } from '../../lib/contract/clock';
import { recordEvents } from '../../lib/contract/events';
import { AUTO_CTX, KEY, configFor } from './testing';
import { COMPATIBLE_DEFAULTS, compatibleCredentials, compatibleLanguages } from './settings';
import { buildCompatible, describeCompatible } from './config';
import { checkCompatible } from './check';
import { CompatibleSettingsView, CompatibleVoiceSummary } from './RealtimeSettings';
import { openaiCompatibleProvider } from './provider';

afterEach(() => {
  vi.unstubAllGlobals();
  stored.clear();
  getSetting.mockClear();
  setSetting.mockClear();
  useProviderStore.setState({ entries: {}, intent: undefined, readiness: {}, selected: null, selectionLocked: false, legs: ['speaker'], speech: { textOnly: false, participantSpeech: false } });
});

describe('the OpenAI Compatible definition', () => {
  it('is OpenAI Compatible on all three platforms, under the old slice key', () => {
    expect(openaiCompatibleProvider).toMatchObject({
      id: 'openai_compatible',
      kind: 'own-key',
      platforms: ['electron', 'extension', 'web'],
      icon: OpenAIIcon,
      settings: { key: 'openaiCompatible', defaults: COMPATIBLE_DEFAULTS, migrate: expect.any(Function) },
      Settings: CompatibleSettingsView,
      VoiceSummary: CompatibleVoiceSummary,
      credentials: compatibleCredentials,
      checkReads: ['endpoint', 'asrModel', 'translateModel'],
      languages: compatibleLanguages,
      build: buildCompatible,
      describe: describeCompatible,
    });
    for (const absent of ['flagged', 'session', 'participantSpeech'] as const) {
      expect(openaiCompatibleProvider, absent).not.toHaveProperty(absent);
    }
  });

  it('offers Text only and typed text, keeps the server\'s boundaries, and offers both turn modes', () => {
    expect(openaiCompatibleProvider.speech).toBe('optional');
    expect(openaiCompatibleProvider.textInput(COMPATIBLE_DEFAULTS)).toBe(true);
    expect(openaiCompatibleProvider.boundaries(COMPATIBLE_DEFAULTS)).toBe('provider');
    expect(openaiCompatibleProvider.turns(COMPATIBLE_DEFAULTS)).toEqual(['auto', 'manual']);
  });

  it('sits between OpenAI Live and Soniox in the registry', () => {
    const ids = PROVIDERS.map((p) => p.id);
    const i = ids.indexOf('openai_live');
    const j = ids.indexOf('openai_compatible');
    const k = ids.indexOf('soniox');
    expect(i).toBeLessThan(j);
    expect(j).toBeLessThan(k);
  });

  it('a stored openai_compatible selection stays on openai_compatible, fromStorage true', () => {
    for (const platform of ['electron', 'extension', 'web'] as const) {
      const offered = presentProviders({ platform, dev: false, enabled: new Set(['openai_compatible']), kizuna: true, switchOn: () => false }).map((p) => p.id);
      expect(selectionFromStored('openai_compatible', offered, 'kizunaai_soniox'), platform).toEqual({ id: 'openai_compatible', fromStorage: true });
    }
  });

  it('a start whose signal already aborted opens no socket', async () => {
    const opened = vi.fn();
    vi.stubGlobal('WebSocket', opened);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    await expect(openaiCompatibleProvider.start(
      { context: AUTO_CTX, config: configFor(), credentials: KEY, clock: createVirtualClock(0), signal: controller.signal },
      recordEvents().events,
    )).rejects.toBe(reason);
    expect(opened).not.toHaveBeenCalled();
  });

  it('refuses to build when the endpoint is empty (endpoint_required)', () => {
    const result = openaiCompatibleProvider.build(
      { direction: { source: 'en', target: 'zh-CN' }, speech: true, turns: 'auto' },
      COMPATIBLE_DEFAULTS,
      { pauses: { sourceSeconds: 1.5, translationSeconds: 1.5 }, reversed: () => false, segmentation: { mode: 'pause', sentencesPerRow: 0 }, models: [] },
    );
    expect(result).toMatchObject({ code: 'endpoint_required' });
  });
});
