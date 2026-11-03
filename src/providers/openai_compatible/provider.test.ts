import { afterEach, describe, it, expect, vi } from 'vitest';

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

import { OpenAICompatibleIcon } from '../../components/Icons/ProviderIcons';
import { createVirtualClock } from '../../lib/contract/clock';
import { recordEvents } from '../../lib/contract/events';
import { readCredentials } from '../../lib/provider/credentials';
import { AUTO } from '../../lib/provider/languages';
import { contextsFor, gate } from '../../lib/session/shape';
import { selectionFromStored } from '../../lib/session/storedSettings';
import type { RunShape } from '../../lib/session/types';
import { useProviderStore } from '../../stores/providerStore';
import { presentProviders, PROVIDERS } from '../registry';
import { buildCompatible, describeCompatible, type CompatibleConfig } from './config';
import { openaiCompatibleProvider } from './provider';
import { CompatibleSettingsView } from './RealtimeSettings';
import { CompatibleTurnDetectionControls, CompatibleTurnDetectionHelp, CompatibleTurnDetectionSummary } from './RealtimeTurnDetection';
import { migrateCompatibleSettings, COMPATIBLE_DEFAULTS, COMPATIBLE_LEGACY_KEYS, compatibleCredentials, compatibleLanguages, type CompatibleSettings } from './settings';
import { AUTO_CTX, configFor, KEY, SHARED } from './testing';

afterEach(() => {
  vi.unstubAllGlobals();
  stored.clear();
  getSetting.mockClear();
  setSetting.mockClear();
  useProviderStore.setState({ entries: {}, intent: undefined, readiness: {}, selected: null, selectionLocked: false, legs: ['speaker'], speech: { textOnly: false, participantSpeech: false } });
});

const both = (pair: { source: string; target: string }, patch: Partial<RunShape> = {}) =>
  ({ provider: openaiCompatibleProvider, settings: COMPATIBLE_DEFAULTS, pair, legs: ['speaker', 'participant'], textOnly: false, participantSpeech: false, turnMode: 'auto', ...patch }) as unknown as RunShape;
const noAuth = { signedIn: false, getToken: async () => null };

describe('the OpenAI Compatible definition', () => {
  it('is OpenAI Compatible with your own key, on every platform, under its slice key, linking the setup guide', () => {
    expect(openaiCompatibleProvider).toMatchObject({
      id: 'openai_compatible',
      kind: 'own-key',
      platforms: ['electron', 'extension', 'web'],
      icon: OpenAICompatibleIcon,
      guideUrl: 'https://sokuji.kizuna.ai/docs/tutorials/openai-compatible-setup',
      settings: { key: 'openaiCompatible', defaults: COMPATIBLE_DEFAULTS, legacyKeys: COMPATIBLE_LEGACY_KEYS, migrate: migrateCompatibleSettings },
      Settings: CompatibleSettingsView,
      TurnDetection: { Summary: CompatibleTurnDetectionSummary, Controls: CompatibleTurnDetectionControls, Help: CompatibleTurnDetectionHelp },
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

  it('sits after OpenAI Live and before Soniox, unflagged and registered (rulings 18, 1)', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids.indexOf('openai_compatible')).toBe(ids.indexOf('openai_live') + 1);
    expect(ids.indexOf('openai_compatible')).toBe(ids.indexOf('soniox') - 1);
  });

  it('a stored openai_compatible selection stays on openai_compatible, fromStorage true (ruling 1, re-introduced 2026-11-03)', () => {
    for (const platform of ['electron', 'extension', 'web'] as const) {
      const offered = presentProviders({ platform, dev: false, enabled: new Set(), kizuna: true, switchOn: () => false }).map((p) => p.id);
      expect(selectionFromStored('openai_compatible', offered, 'kizunaai_soniox'), platform).toEqual({ id: 'openai_compatible', fromStorage: true });
    }
  });

  it("lets the participant speak when its switch is on, with Other's prompt and the user's own detection, and refuses Both for Auto-detect", () => {
    const participant = contextsFor(both({ source: 'ja', target: 'en' }, { participantSpeech: true })).participant!;
    expect(participant).toEqual({ direction: { source: 'en', target: 'ja' }, speech: true, turns: 'auto' });
    const s: CompatibleSettings = { ...COMPATIBLE_DEFAULTS, endpoint: 'https://host', asrModel: 'qwen3-asr', translateModel: 'qwen3-translate', useTemplateMode: false, systemInstructions: 'Mine.', participantSystemInstructions: "Other's.", turnDetectionMode: 'Semantic' };
    const shared = { ...SHARED, reversed: (d: { source: string; target: string }) => d.source === 'en' && d.target === 'ja' };
    expect(openaiCompatibleProvider.build(participant, s, shared)).toMatchObject({ instructions: "Other's.", modalities: ['audio'], turnDetection: { type: 'semantic_vad', eagerness: 'auto' } });
    expect(contextsFor(both({ source: 'ja', target: 'en' })).participant!.speech).toBe(false);
    expect(gate(both({ source: AUTO, target: 'en' }), 'electron')).toMatchObject({ code: 'participant_unsupported', leg: 'participant' });
    expect(gate(both({ source: 'ja', target: 'en' }), 'electron')).toBeNull();
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

  it("loads an old profile as it was — the key, the pair, the settings — reading no temperature and no WebRTC choice, which runs over WebSocket, converting nothing, and writes nothing", async () => {
    stored.set('settings.openaiCompatible.apiKey', 'sk-proj-oldProfileKey0123');
    stored.set('settings.common.sourceLanguage', 'ko');
    stored.set('settings.common.targetLanguage', 'ja');
    stored.set('settings.openaiCompatible.endpoint', 'https://my-endpoint.com');
    stored.set('settings.openaiCompatible.asrModel', 'whisper-1');
    stored.set('settings.openaiCompatible.translateModel', 'gpt-4o');
    stored.set('settings.openaiCompatible.voice', 'marin');
    stored.set('settings.openaiCompatible.participantVoice', 'coral');
    stored.set('settings.openaiCompatible.turnDetectionMode', 'Semantic');
    stored.set('settings.openaiCompatible.semanticEagerness', 'High');
    stored.set('settings.openaiCompatible.maxTokens', '2048');
    stored.set('settings.openaiCompatible.noiseReduction', 'Near field');
    stored.set('settings.common.useTemplateMode', false);
    stored.set('settings.common.systemInstructions', 'Translate plainly.');
    await useProviderStore.getState().load(openaiCompatibleProvider);
    const entry = useProviderStore.getState().entries.openai_compatible;
    expect(entry.settings as CompatibleSettings).toMatchObject({
      endpoint: 'https://my-endpoint.com', asrModel: 'whisper-1', translateModel: 'gpt-4o', voice: 'marin', participantVoice: 'coral',
      turnDetectionMode: 'Semantic', semanticEagerness: 'High', maxTokens: 2048, noiseReduction: 'Near field',
      useTemplateMode: false, systemInstructions: 'Translate plainly.',
    });
    expect(readCredentials(openaiCompatibleProvider, entry.settings, entry.credentials, noAuth)).toEqual({ apiKey: 'sk-proj-oldProfileKey0123' });
    expect(entry.pair).toEqual({ source: 'ko', target: 'ja' });
    const config = openaiCompatibleProvider.build({ direction: entry.pair, speech: true, turns: 'auto' }, entry.settings as CompatibleSettings, { ...SHARED, models: [{ id: 'gpt-4o' }] }) as CompatibleConfig;
    expect(config).toMatchObject({ transport: 'websocket', translateModel: 'gpt-4o', voice: 'marin', maxTokens: 2048, instructions: 'Translate plainly.' });
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("keeps its readiness through an edit to a slider or the prompt: Start stays on and nothing is listed again; a new key forgets it", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'qwen3-asr', created: 1 }, { id: 'qwen3-translate', created: 1 }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const store = useProviderStore.getState();
    await store.load(openaiCompatibleProvider);
    store.setCredential(openaiCompatibleProvider, 'apiKey', 'sk-proj-readyKey0123');
    store.updateSettings(openaiCompatibleProvider, { endpoint: 'https://host', asrModel: 'qwen3-asr', translateModel: 'qwen3-translate' });
    await store.refreshReadiness(openaiCompatibleProvider, noAuth);
    expect(useProviderStore.getState().readiness.openai_compatible).toEqual({ state: 'ready', models: [] });
    store.updateSettings(openaiCompatibleProvider, { threshold: 0.7 });
    store.updateSettings(openaiCompatibleProvider, { systemInstructions: 'A new prompt.' });
    expect(useProviderStore.getState().readiness.openai_compatible).toEqual({ state: 'ready', models: [] });
    const entry = useProviderStore.getState().entries.openai_compatible;
    await store.refreshReadiness(openaiCompatibleProvider, noAuth, { settings: entry.settings, credentials: entry.credentials, pair: entry.pair, legs: ['speaker'] });
    expect(fetch).toHaveBeenCalledTimes(1);
    store.setCredential(openaiCompatibleProvider, 'apiKey', 'sk-proj-otherKey0123');
    expect(useProviderStore.getState().readiness.openai_compatible).toEqual({ state: 'unknown' });
  });
});