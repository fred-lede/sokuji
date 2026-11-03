/**
 * OpenAI Compatible's wire: URL, subprotocols, session.update payload.
 * Pure: no socket, no timer. Type-only imports from openai SDK.
 */
import type { CompatibleConfig } from './config';
import type { CompatibleCredentials } from './settings';
import { pcmToBase64 } from '../../lib/contract/pcm64';
import type {
  ConversationItemCreateEvent,
  InputAudioBufferAppendEvent,
  InputAudioBufferClearEvent,
  InputAudioBufferCommitEvent,
  RealtimeAudioConfigInput,
  RealtimeAudioConfigOutput,
  RealtimeAudioInputTurnDetection,
  RealtimeError,
  RealtimeSessionCreateRequest,
  ResponseCreateEvent,
} from 'openai/resources/realtime/realtime';
import { base64ToPcm, decodeServerEvent, errorCode, errorWords } from '../../lib/provider/openaiWire';

/** Build the WebSocket URL: wss://<normalized-host>/v1/realtime?model=<translateModel>. */
export function compatibleUrl(c: CompatibleConfig): string {
  const host = c.endpoint.replace(/^https?:\/\//, '');
  const model = c.translateModel ? `?model=${encodeURIComponent(c.translateModel)}` : '';
  return `wss://${host}/v1/realtime${model}`;
}

/** Subprotocols: same as OpenAI Realtime. */
export function compatibleProtocols(k: CompatibleCredentials): string[] {
  return ['realtime', `openai-insecure-api-key.${k.apiKey}`];
}

/** Turn detection as the wire takes it. */
function turnDetectionOf(d: TurnDetection | null): RealtimeAudioInputTurnDetection | null {
  if (d === null) return null;
  if (d.type === 'semantic_vad') return { type: 'semantic_vad', create_response: true, interrupt_response: false, eagerness: d.eagerness };
  return {
    type: 'server_vad', create_response: true, interrupt_response: false,
    threshold: d.threshold, prefix_padding_ms: d.prefixPaddingMs, silence_duration_ms: d.silenceDurationMs,
  };
}

/** The session.update payload, same shape as OpenAI Realtime but with asrModel and voice from CompatibleConfig. */
export function compatibleSessionUpdate(c: CompatibleConfig): object {
  const session: Record<string, unknown> = {
    type: 'realtime',
    output_modalities: c.modalities,
    instructions: c.instructions,
    tool_choice: 'none',
    tools: [],
  };
  if (c.maxTokens !== 'inf') session.max_output_tokens = c.maxTokens;
  if (c.voice) session.audio = { output: { voice: c.voice } };
  if (c.turnDetection || c.asrModel || c.noiseReduction !== undefined) {
    const audioInput: Record<string, unknown> = {};
    if (c.turnDetection) audioInput.turn_detection = turnDetectionOf(c.turnDetection);
    if (c.asrModel) audioInput.transcription = { model: c.asrModel };
    if (c.noiseReduction !== null && c.noiseReduction !== undefined) audioInput.noise_reduction = { type: c.noiseReduction };
    else if (c.noiseReduction === null) audioInput.noise_reduction = null;
    session.audio = { input: audioInput, ...(session.audio as Record<string, unknown> | undefined) };
  }
  return { type: 'session.update', session };
}

/** One chunk as it goes up: 24 kHz PCM16 mono. */
export function appendFrame(pcm: Int16Array): string {
  const frame: InputAudioBufferAppendEvent = { type: 'input_audio_buffer.append', audio: pcmToBase64(pcm) };
  return JSON.stringify(frame);
}

/** A release with speech, under manual turns. */
export const COMMIT: InputAudioBufferCommitEvent = { type: 'input_audio_buffer.commit' };
/** A release without speech. */
export const CLEAR: InputAudioBufferClearEvent = { type: 'input_audio_buffer.clear' };

/** Typed text as an input item. */
export function textItem(itemId: string, text: string): ConversationItemCreateEvent {
  return { type: 'conversation.item.create', item: { id: itemId, type: 'message', role: 'user', content: [{ type: 'input_text', text }] } };
}

/** An in-band response for the input the conversation ends with. */
export function responseCreate(eventId: string): ResponseCreateEvent {
  return { type: 'response.create', event_id: eventId, response: { metadata: { request: eventId } } };
}

/** The request an in-band response names back. */
export function requestOf(response: { metadata?: unknown } | undefined): string | undefined {
  const request = (response?.metadata as { request?: unknown } | null | undefined)?.request;
  return typeof request === 'string' ? request : undefined;
}

/** The drift anchor's metadata. */
export const ANCHOR_METADATA = { purpose: 'anchor' } as const;

/** The drift anchor: an out-of-band, text-only response carrying this leg's instructions. */
export function anchorResponse(eventId: string, instructions: string): ResponseCreateEvent {
  return {
    type: 'response.create',
    event_id: eventId,
    response: { conversation: 'none', output_modalities: ['text'], ...(instructions ? { instructions } : {}), metadata: { ...ANCHOR_METADATA } },
  };
}

/** A response out of band: kept out of the conversation or the anchor's own. */
export function isOutOfBand(response: { conversation_id?: unknown; metadata?: unknown } | undefined): boolean {
  if (!response) return false;
  const metadata = response.metadata as { purpose?: unknown } | null | undefined;
  return response.conversation_id === null || metadata?.purpose === ANCHOR_METADATA.purpose;
}

/** A translation's final text: trimmed and unwrapped when JSON. */
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

/** Re-exports from openaiWire for convenience. */
export { base64ToPcm, decodeServerEvent, errorCode, errorWords, type ServerEvent } from '../../lib/provider/openaiWire';