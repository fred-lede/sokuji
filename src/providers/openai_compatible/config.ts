/**
 * OpenAI Compatible's `C`, `build` and `describe` (survey §2.10).
 * One builder for both legs: the participant is the same call on the
 * reversed direction, so its prompt and transcription hint follow from
 * `context`. No `transcription` hint (OpenAI-specific), no `reasoningEffort`.
 */
import type { SessionContext } from '../../lib/contract/adapter';
import { resolveInstructions } from '../../lib/provider/instructions';
import type { ProviderRefusal, SharedSettings } from '../../lib/provider/types';
import {
  normalizeEndpoint,
  COMPATIBLE_DEFAULTS,
  type CompatibleSettings,
  type TurnDetectionMode,
  type NoiseReduction,
  type SemanticEagerness,
} from './settings';
import { TurnDetection } from '../openai/config';

export interface CompatibleConfig {
  /** The normalized endpoint URL, without trailing /v1. */
  endpoint: string;
  /** The user's translateModel, as typed. '' means the endpoint's default. */
  translateModel: string;
  /** The user's asrModel, as typed. '' means the endpoint's default. */
  asrModel: string;
  /** This leg's voice: '' = endpoint default. */
  voice?: string;
  /** This direction's target language, for endpoints that read the session's output language. */
  targetLanguage?: string;
  /** This direction's prompt. */
  instructions: string;
  modalities: ['audio'] | ['text'];
  maxTokens: number | 'inf';
  /** Manual turns: `null`, the client commits. Auto: the user's mechanism and knobs. */
  turnDetection: TurnDetection | null;
  /** `null` turns it off. */
  noiseReduction: 'near_field' | 'far_field' | null;
  /** WebSocket only. */
  transport: 'websocket';
}

const NOISE: Readonly<Record<NoiseReduction, CompatibleConfig['noiseReduction']>> = {
  None: null,
  'Near field': 'near_field',
  'Far field': 'far_field',
};

const clamp = (v: number, range: { min: number; max: number }, fallback: number) =>
  Number.isFinite(v) ? Math.min(range.max, Math.max(range.min, v)) : fallback;

const TURN_DETECTION_MODES = ['Normal', 'Semantic'] as const;
const SEMANTIC_EAGERNESSES = ['Auto', 'Low', 'Medium', 'High'] as const;
const REALTIME_THRESHOLD_RANGE = { min: 0, max: 1, step: 0.01 } as const;
const REALTIME_PREFIX_RANGE = { min: 0, max: 2, step: 0.01 } as const;
const REALTIME_SILENCE_RANGE = { min: 0, max: 2, step: 0.01 } as const;
const REALTIME_MAX_TOKENS_RANGE = { min: 1, max: 4096, step: 1 } as const;

export function buildCompatible(
  context: SessionContext,
  s: CompatibleSettings,
  shared: SharedSettings
): CompatibleConfig | ProviderRefusal {
  const endpoint = normalizeEndpoint(s.endpoint);
  if (s.translateModel === '' && s.asrModel === '' && endpoint === '') {
    return { refused: 'Enter the endpoint, and a model to run.', code: 'endpoint_required' };
  }

  const { source, target } = context.direction;
  const instructions = resolveInstructions(s, {
    participant: shared.reversed(context.direction),
    source: source,
    target: target,
  });

  const turnDetection: TurnDetection | null = context.turns === 'manual'
    ? null
    : s.turnDetectionMode === 'Semantic'
      ? { type: 'semantic_vad', eagerness: s.semanticEagerness.toLowerCase() as 'auto' | 'low' | 'medium' | 'high' }
      : {
          type: 'server_vad',
          threshold: clamp(s.threshold, REALTIME_THRESHOLD_RANGE, COMPATIBLE_DEFAULTS.threshold),
          prefixPaddingMs: Math.round(clamp(s.prefixPadding, REALTIME_PREFIX_RANGE, COMPATIBLE_DEFAULTS.prefixPadding) * 1000),
          silenceDurationMs: Math.round(clamp(s.silenceDuration, REALTIME_SILENCE_RANGE, COMPATIBLE_DEFAULTS.silenceDuration) * 1000),
        };

  const voice = context.speech
    ? (shared.reversed(context.direction) ? (s.participantVoice || undefined) : (s.voice || undefined))
    : undefined;

  const config: CompatibleConfig = {
    endpoint,
    translateModel: s.translateModel,
    asrModel: s.asrModel,
    instructions,
    modalities: context.speech ? ['audio'] : ['text'],
    maxTokens: s.maxTokens === 'inf' || !Number.isFinite(s.maxTokens) ? 'inf' : Math.round(clamp(s.maxTokens, REALTIME_MAX_TOKENS_RANGE, REALTIME_MAX_TOKENS_RANGE.max)),
    turnDetection,
    noiseReduction: NOISE[s.noiseReduction],
    transport: 'websocket',
  };
  if (voice) config.voice = voice;
  if (target) config.targetLanguage = target;

  return config;
}

export function describeCompatible(c: CompatibleConfig): { asrModel: string; translationModel: string } {
  return { asrModel: c.asrModel, translationModel: c.translateModel };
}