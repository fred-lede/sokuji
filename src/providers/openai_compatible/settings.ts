/**
 * OpenAI Compatible's `S`, languages and credentials. `S` carries the
 * endpoint, two free-text model fields, two voice fields, and the same
 * turn-detection, noise-reduction and instructions knobs as OpenAI Realtime
 * (minus `model`, `transcriptModel`, `reasoningEffort`). The language list
 * is the same 55 as OpenAI Realtime's `REALTIME_LANGUAGES` — imported, not
 * copied. Stored under `settings.openaiCompatible.*` (the old slice key, so
 * a stored endpoint and key from the retired provider carry forward).
 */
import { AUTO } from '../../lib/provider/languages';
import { identityWire } from '../../lib/language/wire';
import { englishLanguageName } from '../../lib/language/label';
import { INSTRUCTION_LEGACY_KEYS, INSTRUCTIONS_DEFAULTS, migrateInstructions, type InstructionsSettings } from '../../lib/provider/instructions';
import type { CredentialsMissing, LanguageOption, MigrationInputs, Provider } from '../../lib/provider/types';
import {
  NOISE_REDUCTIONS,
  SEMANTIC_EAGERNESSES,
  REALTIME_LANGUAGES,
  REALTIME_MAX_TOKENS_RANGE,
  REALTIME_PREFIX_RANGE,
  REALTIME_SILENCE_RANGE,
  REALTIME_THRESHOLD_RANGE,
  TURN_DETECTION_MODES,
  type NoiseReduction,
  type SemanticEagerness,
  type TurnDetectionMode,
} from '../openai/settings';

/**
 * The endpoint base URL as the user typed it, not yet normalized.
 * The check and the adapter call `normalizeEndpoint` on it before use.
 */
export interface CompatibleSettings extends InstructionsSettings {
  endpoint: string;
  /** The ASR model, free text. '' means the endpoint's default. */
  asrModel: string;
  /** The translation/dialogue model, free text. '' means the endpoint's default. */
  translateModel: string;
  /** The speaker leg's voice. '' means the endpoint's default. */
  voice: string;
  /** The participant leg's voice. '' means the endpoint's default. */
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

/**
 * The instructions' legacy keys (Stage 2 Gemini, choice 1). The old slice
 * also had a single `model` field, not `asrModel` / `translateModel`, so
 * those two have no legacy key and default to ''.
 */
export const COMPATIBLE_LEGACY_KEYS: readonly string[] = INSTRUCTION_LEGACY_KEYS;

/**
 * Normalizes a user-typed endpoint before use:
 * 1. trim whitespace
 * 2. prepend `https://` when no scheme is present
 * 3. strip a trailing `/`
 * 4. strip a trailing `/v1` (the provider always appends `/v1/realtime` itself)
 */
export function normalizeEndpoint(raw: string): string {
  let s = raw.trim();
  if (s === '') return '';
  if (!s.startsWith('http://') && !s.startsWith('https://')) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/v1$/, '');
  return s;
}

const oneOf = <T extends string>(values: readonly T[], v: unknown, fallback: T): T =>
  (values.includes(v as T) ? (v as T) : fallback);

function numberOf(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function maxTokensOf(v: unknown): number | 'inf' {
  if (v === 'inf') return 'inf';
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : COMPATIBLE_DEFAULTS.maxTokens;
}

/**
 * What was stored, made valid field by field: a field of the wrong type or
 * outside its values falls to its default. Voice fields are free text with
 * no list validation (the voice list is endpoint-specific, fetched lazily
 * by the Settings view). The instructions come from `migrateInstructions`.
 */
export function migrateCompatibleSettings(stored: Readonly<Record<string, unknown>>, inputs: MigrationInputs): CompatibleSettings {
  const text = (k: string): string => (typeof stored[k] === 'string' ? (stored[k] as string) : '');
  return {
    ...migrateInstructions(stored, inputs.legacy),
    endpoint: text('endpoint'),
    asrModel: text('asrModel'),
    translateModel: text('translateModel'),
    voice: text('voice'),
    participantVoice: text('participantVoice'),
    turnDetectionMode: oneOf(TURN_DETECTION_MODES, stored.turnDetectionMode, COMPATIBLE_DEFAULTS.turnDetectionMode),
    threshold: numberOf(stored.threshold, COMPATIBLE_DEFAULTS.threshold),
    prefixPadding: numberOf(stored.prefixPadding, COMPATIBLE_DEFAULTS.prefixPadding),
    silenceDuration: numberOf(stored.silenceDuration, COMPATIBLE_DEFAULTS.silenceDuration),
    semanticEagerness: oneOf(SEMANTIC_EAGERNESSES, stored.semanticEagerness, COMPATIBLE_DEFAULTS.semanticEagerness),
    maxTokens: maxTokensOf(stored.maxTokens),
    transcriptKeywords: text('transcriptKeywords'),
    noiseReduction: oneOf(NOISE_REDUCTIONS, stored.noiseReduction, COMPATIBLE_DEFAULTS.noiseReduction),
  };
}

/** The 55 languages, same as OpenAI Realtime: every one a source and a target. */
const AUTO_SOURCE: LanguageOption = { value: AUTO };

export const compatibleLanguages: Provider<CompatibleSettings, never, never>['languages'] = {
  sources: () => [AUTO_SOURCE, ...REALTIME_LANGUAGES],
  targets: () => REALTIME_LANGUAGES,
  initial: () => ({ source: 'en', target: 'zh-CN' }),
  // The pair never reaches the wire: the instructions name it.
  wire: identityWire(),
};

/**
 * A code's English name, for the instructions' template. Same rule as
 * OpenAI Realtime's `realtimeLanguageName`.
 */
export function compatibleLanguageName(code: string): string {
  if (code === AUTO) return 'the spoken language';
  return englishLanguageName(code);
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
