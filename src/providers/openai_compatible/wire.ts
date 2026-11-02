/**
 * OpenAI Compatible's wire: the URL to the user's endpoint, its
 * subprotocols (the key in the same subprotocol as OpenAI Realtime),
 * and the `session.update` payload — the same shape as
 * `openai/wire.ts`'s `sessionUpdate`, but reading from `CompatibleConfig`
 * instead of `RealtimeConfig`: the ASR model replaces OpenAI's
 * `TranscriptionHint`, the voice field is free text, and there is no
 * `reasoningEffort`. Pure: no socket, no timer.
 */
import type {
  ConversationItemCreateEvent,
  InputAudioBufferAppendEvent,
  InputAudioBufferClearEvent,
  InputAudioBufferCommitEvent,
  ResponseCreateEvent,
} from 'openai/resources/realtime/realtime';
import { pcmToBase64 } from '../../lib/contract/pcm64';
import type { CompatibleConfig, TurnDetection } from './config';
import type { CompatibleCredentials } from './settings';

export { base64ToPcm } from '../../lib/contract/pcm64';
export { decodeServerEvent, errorCode, errorWords, type ServerEvent } from '../../lib/provider/openaiWire';

/**
 * The WebSocket URL to the user's endpoint's Realtime socket.
 * The endpoint is already normalized (no trailing /, /v1 stripped);
 * `https://host` becomes `wss://host/v1/realtime`.
 * An empty `translateModel` omits the `?model=` parameter entirely.
 */
export function compatibleUrl(c: Pick<CompatibleConfig, 'endpoint' | 'translateModel'>): string {
  const host = c.endpoint.replace(/^https?:\/\//, '');
  const model = c.translateModel ? `?model=${encodeURIComponent(c.translateModel)}` : '';
  return `wss://${host}/v1/realtime${model}`;
}

/**
 * The subprotocols a socket authenticates with: `realtime`, and the key as
 * `openai-insecure-api-key.<key>` — the same subprotocol OpenAI Realtime
 * uses, so the redaction net in `redact.ts` already covers it.
 */
export function compatibleProtocols(k: CompatibleCredentials): string[] {
  return ['realtime', `openai-insecure-api-key.${k.apiKey}`];
}

/**
 * The `session.update` payload for a Compatible session.
 * Mirrors `openai/wire.ts`'s `sessionUpdate`, with:
 * - `audio.input.transcription.model` set to `asrModel` when non-empty
 *   (no `languages` / `keywords` / `prompt` — the OpenAI-specific
 *   `TranscriptionHint` is not sent to a third-party endpoint)
 * - `audio.output.voice` set to `voice` when present (free text, not a
 *   preset enum)
 * - no `reasoning` field
 */
export function compatibleSessionUpdate(c: CompatibleConfig): {
  type: 'session.update';
  session: Record<string, unknown>;
} {
  const session: Record<string, unknown> = {
    type: 'realtime',
    output_modalities: c.modalities,
    instructions: c.instructions,
    tool_choice: 'none',
    tools: [],
    audio: {
      input: {
        ...(c.turnDetection === null ? {} : { turn_detection: turnDetectionWire(c.turnDetection) }),
        ...(c.asrModel !== '' ? { transcription: { model: c.asrModel } } : {}),
        ...(c.noiseReduction === null ? {} : { noise_reduction: { type: c.noiseReduction } }),
      },
      ...(c.voice ? { output: { voice: c.voice } } : {}),
    },
  };
  if (c.maxTokens !== 'inf') session.max_output_tokens = c.maxTokens;
  return { type: 'session.update', session };
}

function turnDetectionWire(d: TurnDetection): Record<string, unknown> {
  if (d.type === 'semantic_vad') {
    return { type: 'semantic_vad', create_response: true, interrupt_response: false, eagerness: d.eagerness };
  }
  return {
    type: 'server_vad',
    create_response: true,
    interrupt_response: false,
    threshold: d.threshold,
    prefix_padding_ms: d.prefixPaddingMs,
    silence_duration_ms: d.silenceDurationMs,
  };
}

/** One chunk as it goes up: 24 kHz PCM16 mono. */
export function appendFrame(pcm: Int16Array): string {
  const frame: InputAudioBufferAppendEvent = { type: 'input_audio_buffer.append', audio: pcmToBase64(pcm) };
  return JSON.stringify(frame);
}

export const COMMIT: InputAudioBufferCommitEvent = { type: 'input_audio_buffer.commit' };
export const CLEAR: InputAudioBufferClearEvent = { type: 'input_audio_buffer.clear' };

export function textItem(itemId: string, text: string): ConversationItemCreateEvent {
  return {
    type: 'conversation.item.create',
    item: { id: itemId, type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
}

export function responseCreate(eventId: string): ResponseCreateEvent {
  return { type: 'response.create', event_id: eventId, response: { metadata: { request: eventId } } };
}

export function requestOf(response: { metadata?: unknown } | undefined): string | undefined {
  const request = (response?.metadata as { request?: unknown } | null | undefined)?.request;
  return typeof request === 'string' ? request : undefined;
}

export const ANCHOR_METADATA = { purpose: 'anchor' } as const;

export function anchorResponse(eventId: string, instructions: string): ResponseCreateEvent {
  return {
    type: 'response.create',
    event_id: eventId,
    response: {
      conversation: 'none',
      output_modalities: ['text'],
      ...(instructions ? { instructions } : {}),
      metadata: { ...ANCHOR_METADATA },
    },
  };
}

export function isOutOfBand(response: { conversation_id?: unknown; metadata?: unknown } | undefined): boolean {
  if (!response) return false;
  const metadata = response.metadata as { purpose?: unknown } | null | undefined;
  return response.conversation_id === null || metadata?.purpose === ANCHOR_METADATA.purpose;
}

export function unwrapTranslationText(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      for (const key of ['final_text', 'final', 'text', 'translation', 'result', 'query']) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === 'string') return value.trim();
      }
    }
  } catch {
    // Not JSON: the text as it stands.
  }
  return trimmed;
}

export type ErrorCode = 'auth' | 'rate_limit' | 'client' | 'server' | 'segment_ended';
