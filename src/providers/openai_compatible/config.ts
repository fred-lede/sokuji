/**
 * OpenAI Compatible's `C`, `build` and `describe` (survey §2.10).
 * One builder for both legs, as OpenAI Realtime's: the participant is the
 * same call on the reversed direction, so its prompt and its voice follow
 * from `context`. The endpoint and the two model IDs come from the
 * settings, not from a model picker. No `TranscriptionHint` — a
 * third-party endpoint does not accept OpenAI's transcription context.
 */
import type { SessionContext } from '../../lib/contract/adapter';
import { resolveInstructions } from '../../lib/provider/instructions';
import type { ProviderRefusal, SharedSettings } from '../../lib/provider/types';
import {
  compatibleLanguageName,
  COMPATIBLE_DEFAULTS,
  normalizeEndpoint,
  type CompatibleSettings,
} from './settings';
import {
  REALTIME_MAX_TOKENS_RANGE,
  REALTIME_PREFIX_RANGE,
  REALTIME_SILENCE_RANGE,
  REALTIME_THRESHOLD_RANGE,
} from '../openai/settings';

/**
 * Automatic detection as the wire takes it — the same type OpenAI
 * Realtime's `config.ts` exports, re-used here.
 */
export type TurnDetection =
  | { type: 'server_vad'; threshold: number; prefixPaddingMs: number; silenceDurationMs: number }
  | { type: 'semantic_vad'; eagerness: 'auto' | 'low' | 'medium' | 'high' };

export interface CompatibleConfig {
  /** The normalized endpoint URL, no trailing /v1. */
  endpoint: string;
  /** The user's translateModel, as typed. '' means the endpoint's default. */
  translateModel: string;
  /** The user's asrModel, as typed. '' means the endpoint's default. */
  asrModel: string;
  /** This leg's voice; undefined when the endpoint's default should apply. */
  voice?: string;
  /** This direction's prompt. */
  instructions: string;
  /** Audio out, or text only: `context.speech`. */
  modalities: ['audio'] | ['text'];
  maxTokens: number | 'inf';
  /** Manual turns: `null`, the client commits. Auto: the user's mechanism. */
  turnDetection: TurnDetection | null;
  /** `null` turns it off. */
  noiseReduction: 'near_field' | 'far_field' | null;
  /** WebSocket only: the owner abandoned WebRTC for this provider family. */
  transport: 'websocket';
}

const NOISE: Readonly<Record<CompatibleSettings['noiseReduction'], CompatibleConfig['noiseReduction']>> = {
  None: null,
  'Near field': 'near_field',
  'Far field': 'far_field',
};

const clamp = (v: number, range: { min: number; max: number }, fallback: number): number =>
  Number.isFinite(v) ? Math.min(range.max, Math.max(range.min, v)) : fallback;

export function buildCompatible(
  context: SessionContext,
  s: CompatibleSettings,
  shared: SharedSettings,
): CompatibleConfig | ProviderRefusal {
  const endpoint = normalizeEndpoint(s.endpoint);
  if (endpoint === '') {
    return { refused: 'Enter the endpoint URL.', code: 'endpoint_required' };
  }
  const { source, target } = context.direction;
  const instructions = resolveInstructions(s, {
    participant: shared.reversed(context.direction),
    source: compatibleLanguageName(source),
    target: compatibleLanguageName(target),
  });
  const turnDetection: TurnDetection | null =
    context.turns === 'manual'
      ? null
      : s.turnDetectionMode === 'Semantic'
        ? { type: 'semantic_vad', eagerness: s.semanticEagerness.toLowerCase() as 'auto' | 'low' | 'medium' | 'high' }
        : {
            type: 'server_vad',
            threshold: clamp(s.threshold, REALTIME_THRESHOLD_RANGE, COMPATIBLE_DEFAULTS.threshold),
            prefixPaddingMs: Math.round(clamp(s.prefixPadding, REALTIME_PREFIX_RANGE, COMPATIBLE_DEFAULTS.prefixPadding) * 1000),
            silenceDurationMs: Math.round(clamp(s.silenceDuration, REALTIME_SILENCE_RANGE, COMPATIBLE_DEFAULTS.silenceDuration) * 1000),
          };

  // Each leg its own voice: the participant's never mine.
  const rawVoice = shared.reversed(context.direction) ? s.participantVoice : s.voice;
  const voice = rawVoice !== '' ? rawVoice : undefined;

  return {
    endpoint,
    translateModel: s.translateModel,
    asrModel: s.asrModel,
    instructions,
    modalities: context.speech ? ['audio'] : ['text'],
    ...(context.speech && voice !== undefined ? { voice } : {}),
    maxTokens:
      s.maxTokens === 'inf' || !Number.isFinite(s.maxTokens)
        ? 'inf'
        : Math.round(clamp(s.maxTokens, REALTIME_MAX_TOKENS_RANGE, REALTIME_MAX_TOKENS_RANGE.max)),
    turnDetection,
    noiseReduction: NOISE[s.noiseReduction],
    transport: 'websocket',
  };
}

/**
 * Two models: the translation's and the source transcript's. The settings
 * view and the runner call this same function; nothing writes it back.
 */
export function describeCompatible(c: CompatibleConfig): { asrModel: string; translationModel: string } {
  return { asrModel: c.asrModel, translationModel: c.translateModel };
}
