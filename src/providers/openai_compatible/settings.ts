/**
 * OpenAI Compatible's settings, credentials and languages (survey §2.3–2.8):
 * the old slice (`openaiCompatible`) with the endpoint, two free-text model
 * fields, two voice fields, and the same turn detection / noise reduction /
 * instructions knobs as OpenAI Realtime. No `transcriptModel`, no
 * `reasoningEffort`, no single `model` — those three are OpenAI-specific.
 * Stored under `settings.openaiCompatible.*`. The language list is the same
 * 55 as OpenAI Realtime (`REALTIME_LANGUAGES` from `openai/settings.ts`).
 */
import { AUTO } from '../../lib/provider/languages';
import { identityWire } from '../../lib/language/wire';
import { INSTRUCTION_LEGACY_KEYS, INSTRUCTIONS_DEFAULTS, migrateInstructions, type InstructionsSettings } from '../../lib/provider/instructions';
import type { CredentialsMissing, LanguageOption, MigrationInputs, ModelOption, Provider } from '../../lib/provider/types';
import { distinctVoice } from '../../lib/provider/voices';
import { REALTIME_LANGUAGES, REALTIME_THRESHOLD_RANGE, REALTIME_PREFIX_RANGE, REALTIME_SILENCE_RANGE, REALTIME_MAX_TOKENS_RANGE, TURN_DETECTION_MODES, SEMANTIC_EAGERNESSES, NOISE_REDUCTIONS, type TurnDetectionMode, type NoiseReduction, type SemanticEagerness } from '../openai/settings';

/** The two model slots and the knobs shared with OpenAI Realtime, plus instructions. */
export interface CompatibleSettings extends InstructionsSettings {
  endpoint: string;
  asrModel: string;
  translateModel: string;
  voice: string;
  participantVoice: string;
  turnDetectionMode: TurnDetectionMode;
  threshold: number;
  prefixPadding: number;
  silenceDuration: number;
  semanticEagerness: SemanticEagerness;
  maxTokens: number | 'inf';
  transcriptKeywords: string;
  noiseReduction: NoiseReduction;
}

export const COMPATIBLE_DEFAULTS: CompatibleSettings = {
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
};

/** Reads `endpoint` and the instruction fields from the old slice. The new fields (`asrModel`, `translateModel`, `voice`, `participantVoice`) have no old-slice counterpart — they default to `''`. */
export const COMPATIBLE_LEGACY_KEYS: readonly string[] = [...INSTRUCTION_LEGACY_KEYS, 'endpoint'];

/** What was stored, made valid field by field. Free-text fields fall to `''`. Enum fields fall to their defaults. `maxTokens: 'inf'` is preserved. */
export function migrateCompatibleSettings(stored: Readonly<Record<string, unknown>>, inputs: MigrationInputs): CompatibleSettings {
  const text = (k: string, fallback: string) => (typeof stored[k] === 'string' ? (stored[k] as string) : fallback);
  const oneOf = <T extends string>(values: readonly T[], v: unknown, fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);
  const numberOf = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const maxTokensOf = (v: unknown): number | 'inf' => {
    if (v === 'inf') return 'inf';
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
    return Number.isFinite(n) ? n : COMPATIBLE_DEFAULTS.maxTokens;
  };

  const migratedInstructions = migrateInstructions(stored, inputs.legacy);

  return {
    ...migratedInstructions,
    endpoint: text('endpoint', COMPATIBLE_DEFAULTS.endpoint),
    asrModel: text('asrModel', COMPATIBLE_DEFAULTS.asrModel),
    translateModel: text('translateModel', COMPATIBLE_DEFAULTS.translateModel),
    voice: text('voice', COMPATIBLE_DEFAULTS.voice),
    participantVoice: text('participantVoice', COMPATIBLE_DEFAULTS.participantVoice),
    turnDetectionMode: oneOf(TURN_DETECTION_MODES, stored.turnDetectionMode, COMPATIBLE_DEFAULTS.turnDetectionMode),
    threshold: numberOf(stored.threshold, COMPATIBLE_DEFAULTS.threshold),
    prefixPadding: numberOf(stored.prefixPadding, COMPATIBLE_DEFAULTS.prefixPadding),
    silenceDuration: numberOf(stored.silenceDuration, COMPATIBLE_DEFAULTS.silenceDuration),
    semanticEagerness: oneOf(SEMANTIC_EAGERNESSES, stored.semanticEagerness, COMPATIBLE_DEFAULTS.semanticEagerness),
    maxTokens: maxTokensOf(stored.maxTokens),
    transcriptKeywords: text('transcriptKeywords', COMPATIBLE_DEFAULTS.transcriptKeywords),
    noiseReduction: oneOf(NOISE_REDUCTIONS, stored.noiseReduction, COMPATIBLE_DEFAULTS.noiseReduction),
  };
}

/** Normalize the raw endpoint: trim, default to https://, strip trailing / and /v1. */
export function normalizeEndpoint(raw: string): string {
  let s = raw.trim();
  if (s === '') return '';
  if (!s.startsWith('http://') && !s.startsWith('https://')) s = 'https://' + s;
  s = s.replace(/\/$/, '');
  s = s.replace(/\/v1$/, '');
  return s;
}

export interface CompatibleCredentials {
  apiKey: string;
}

export const compatibleCredentials: Provider<CompatibleSettings, CompatibleCredentials, never>['credentials'] = {
  keys: ['apiKey'],
  fields: () => [{ key: 'apiKey', labelKey: 'setup.credentials.apiKey', secret: true, placeholderKey: 'simpleSettings.apiKeyPlaceholder' }],
  read: (values): CompatibleCredentials | CredentialsMissing => {
    const apiKey = (values.apiKey ?? '').trim();
    return apiKey ? { apiKey } : { missing: "Enter the endpoint's API key." };
  },
};

const AUTO_SOURCE: LanguageOption = { value: AUTO };
export const compatibleLanguages: Provider<CompatibleSettings, never, never>['languages'] = {
  sources: () => [AUTO_SOURCE, ...REALTIME_LANGUAGES],
  targets: () => REALTIME_LANGUAGES,
  initial: () => ({ source: 'en', target: 'zh-CN' }),
  wire: identityWire(),
};