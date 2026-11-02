/**
 * OpenAI Compatible: a user-named endpoint speaking the OpenAI Realtime
 * WebSocket protocol. One leg per direction, two free-text model fields
 * (asrModel, translateModel), and voices fetched lazily from the endpoint
 * when both endpoint and key are set. Runs on electron, extension and web:
 * the extension's manifest carries the wildcard host_permissions and CSP
 * connect-src entries for the user-chosen endpoint. Settings are stored
 * under the old slice `openaiCompatible` so a stored endpoint and key from
 * the retired provider carry forward without a migration.
 */
import { OpenAIIcon } from '../../components/Icons/ProviderIcons';
import type { Provider } from '../../lib/provider/types';
import { createCompatibleAdapter } from './adapter';
import { checkCompatible } from './check';
import { buildCompatible, describeCompatible, type CompatibleConfig } from './config';
import { CompatibleSettingsView, CompatibleVoiceSummary } from './RealtimeSettings';
import {
  RealtimeTurnDetectionControls,
  RealtimeTurnDetectionHelp,
  RealtimeTurnDetectionSummary,
} from '../openai/RealtimeTurnDetection';
import {
  compatibleCredentials,
  compatibleLanguages,
  COMPATIBLE_DEFAULTS,
  migrateCompatibleSettings,
  type CompatibleCredentials,
  type CompatibleSettings,
} from './settings';

const adapter = createCompatibleAdapter();

export const openaiCompatibleProvider: Provider<CompatibleSettings, CompatibleCredentials, CompatibleConfig> & { id: 'openai_compatible' } = {
  id: 'openai_compatible',
  kind: 'own-key',
  platforms: ['electron', 'extension', 'web'],
  icon: OpenAIIcon,

  settings: {
    key: 'openaiCompatible',
    defaults: COMPATIBLE_DEFAULTS,
    migrate: migrateCompatibleSettings,
  },
  Settings: CompatibleSettingsView,
  VoiceSummary: CompatibleVoiceSummary,
  TurnDetection: {
    Summary: RealtimeTurnDetectionSummary,
    Controls: RealtimeTurnDetectionControls,
    Help: RealtimeTurnDetectionHelp,
  },

  credentials: compatibleCredentials,
  check: (k, s, ctx) => checkCompatible(k, s, ctx),
  checkReads: ['endpoint', 'asrModel', 'translateModel'],

  languages: compatibleLanguages,

  // Text only is supported: a leg that does not speak asks for text alone.
  speech: 'optional',
  textInput: () => true,
  // The server's commits and responses end segments.
  boundaries: () => 'provider',
  // WebSocket only: both turn modes on every leg.
  turns: () => ['auto', 'manual'],

  build: buildCompatible,
  describe: describeCompatible,
  start: adapter.start,
};
