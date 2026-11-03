import { OpenAICompatibleIcon } from '../../components/Icons/ProviderIcons';
import type { Provider } from '../../lib/provider/types';
import { createCompatibleAdapter } from './adapter';
import { checkCompatible } from './check';
import { buildCompatible, describeCompatible, type CompatibleConfig } from './config';
import { CompatibleSettingsView, CompatibleVoiceSummary } from './RealtimeSettings';
import { CompatibleTurnDetectionControls, CompatibleTurnDetectionHelp, CompatibleTurnDetectionSummary } from './RealtimeTurnDetection';
import {
  migrateCompatibleSettings,
  COMPATIBLE_DEFAULTS,
  COMPATIBLE_LEGACY_KEYS,
  compatibleCredentials,
  compatibleLanguages,
  type CompatibleCredentials,
  type CompatibleSettings,
} from './settings';

const adapter = createCompatibleAdapter();

/**
 * OpenAI Compatible with the user's own key: a GPT Realtime-compatible endpoint
 * made a translator by its instructions, one WebSocket per leg, the only transport.
 * The old enum's id (`openai_compatible`) and slice (`openaiCompatible`), so a
 * stored selection, the key, the pair and every setting carry over. The key
 * rides in a subprotocol a browser sets itself, so it runs on every platform.
 * Unflagged (ruling 18).
 */
export const openaiCompatibleProvider: Provider<CompatibleSettings, CompatibleCredentials, CompatibleConfig> & { id: 'openai_compatible' } = {
  id: 'openai_compatible',
  kind: 'own-key',
  platforms: ['electron', 'extension', 'web'],
  icon: OpenAICompatibleIcon,
  guideUrl: 'https://sokuji.kizuna.ai/docs/tutorials/openai-compatible-setup',

  settings: { key: 'openaiCompatible', defaults: COMPATIBLE_DEFAULTS, legacyKeys: COMPATIBLE_LEGACY_KEYS, migrate: migrateCompatibleSettings },
  Settings: CompatibleSettingsView,
  VoiceSummary: CompatibleVoiceSummary,
  TurnDetection: { Summary: CompatibleTurnDetectionSummary, Controls: CompatibleTurnDetectionControls, Help: CompatibleTurnDetectionHelp },

  credentials: compatibleCredentials,
  check: (k, s, ctx) => checkCompatible(k, s, ctx),
  checkReads: ['endpoint', 'asrModel', 'translateModel'],

  languages: compatibleLanguages,

  speech: 'optional',
  textInput: () => true,
  boundaries: () => 'provider',
  turns: () => ['auto', 'manual'],

  build: buildCompatible,
  describe: describeCompatible,
  start: adapter.start,
};