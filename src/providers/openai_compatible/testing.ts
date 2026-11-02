/**
 * The OpenAI Compatible suites' fixtures: a key, the settings the suites
 * build from, the server's events as the JSON text frames a Realtime
 * endpoint sends, and the harness that starts a leg over `FakeSocket`s.
 * Test-only: nothing but a test imports it (the session-side guard's kit
 * rule counts every provider's `testing.ts` as kit and holds it to that),
 * and the adapter's session walk never reaches it.
 */
import type { SessionContext } from '../../lib/contract/adapter';
import { recordEvents, type AdapterEvent } from '../../lib/contract/events';
import { base64ToPcm } from '../../lib/contract/pcm64';
import { fakeSockets } from '../../lib/contract/testing/fakeSocket';
import { trackedClock } from '../../lib/contract/testing/trackedClock';
import type { SharedSettings } from '../../lib/provider/types';
import { createCompatibleAdapter } from './adapter';
import { buildCompatible, type CompatibleConfig } from './config';
import { COMPATIBLE_DEFAULTS, type CompatibleCredentials, type CompatibleSettings } from './settings';

/** Shaped as a real key (`sk-…`), which `redact()` masks. */
export const KEY: CompatibleCredentials = { apiKey: 'sk-proj-compatibleKey0123456789' };

/** A browser that will not open the socket: a DOMException whose message quotes the subprotocols. */
export class RefusingWebSocket {
  constructor(_url: string, protocols?: string | string[]) {
    const list = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
    throw new DOMException(`Failed to construct 'WebSocket': The subprotocol '${list.join(', ')}' is invalid.`, 'SyntaxError');
  }
}

export const SHARED: SharedSettings = {
  pauses: { sourceSeconds: 1.5, translationSeconds: 1.5 },
  reversed: (d) => d.source === 'en' && d.target === 'zh-CN',
  segmentation: { mode: 'pause', sentencesPerRow: 0 },
  models: [{ id: 'qwen3-translate' }, { id: 'qwen3-asr' }],
};

export const AUTO_CTX: SessionContext = { direction: { source: 'en', target: 'zh-CN' }, speech: true, turns: 'auto' };
export const MANUAL_CTX: SessionContext = { ...AUTO_CTX, turns: 'manual' };

/** A leg's config: the defaults, patched. A refusal is a fixture bug — it throws loudly rather than hiding behind a cast. */
export function configFor(context: SessionContext = AUTO_CTX, patch: Partial<CompatibleSettings> = {}): CompatibleConfig {
  const c = buildCompatible(context, { ...COMPATIBLE_DEFAULTS, endpoint: 'https://host.example.com', ...patch }, SHARED);
  if ('refused' in c) throw new Error(c.refused);
  return c;
}

/** `samples` of 24 kHz pcm16 as an audio delta carries it: base64 of little-endian Int16. */
export function b64(samples: number, fill = 900): string {
  let binary = '';
  for (const byte of new Uint8Array(new Int16Array(samples).fill(fill).buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const event = (e: Record<string, unknown>) => JSON.stringify({ event_id: 'event_1', ...e });

/** The session as `session.created` reports it: the server's defaults. */
const SESSION = {
  type: 'realtime', object: 'realtime.session', id: 'sess_1', model: 'qwen3-translate', expires_at: 1_790_000_000, output_modalities: ['audio'],
  audio: { input: { noise_reduction: null, transcription: null, turn_detection: { type: 'server_vad', threshold: 0.5 } }, output: { voice: 'alloy' } },
};

const item = (id: string, role: 'user' | 'assistant', status = 'in_progress') => ({ id, object: 'realtime.item', type: 'message', role, status, content: [] });

/** A response as the server reports it: out of band with the anchor's metadata; in band naming the request that asked for it. */
const response = (id: string, o: { outOfBand?: boolean; request?: string; status?: string; statusDetails?: unknown; usage?: unknown }) => ({
  id, object: 'realtime.response', status: o.status ?? 'in_progress', status_details: o.statusDetails ?? null, output: [],
  conversation_id: o.outOfBand ? null : 'conv_1', metadata: o.outOfBand ? { purpose: 'anchor' } : o.request ? { request: o.request } : null,
  ...(o.usage ? { usage: o.usage } : {}),
});

/** The server's events, by name, as a Realtime endpoint sends them: JSON text frames. */
export const SERVER = {
  created: () => event({ type: 'session.created', session: SESSION }),
  updated: () => event({ type: 'session.updated', session: SESSION }),
  speechStarted: (itemId: string, ms = 0) => event({ type: 'input_audio_buffer.speech_started', item_id: itemId, audio_start_ms: ms }),
  speechStopped: (itemId: string, ms = 0) => event({ type: 'input_audio_buffer.speech_stopped', item_id: itemId, audio_end_ms: ms }),
  committed: (itemId: string, previous: string | null = null) => event({ type: 'input_audio_buffer.committed', item_id: itemId, previous_item_id: previous }),
  cleared: () => event({ type: 'input_audio_buffer.cleared' }),
  itemAdded: (itemId: string, role: 'user' | 'assistant', previous: string | null = null) =>
    event({ type: 'conversation.item.added', previous_item_id: previous, item: item(itemId, role) }),
  inputDelta: (itemId: string, delta: string) =>
    event({ type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, content_index: 0, delta }),
  inputDone: (itemId: string, transcript: string) =>
    event({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, content_index: 0, transcript, usage: { type: 'duration', seconds: 2 } }),
  inputFailed: (itemId: string) =>
    event({ type: 'conversation.item.input_audio_transcription.failed', item_id: itemId, content_index: 0, error: { type: 'transcription_error', code: 'audio_unintelligible', message: 'Audio was unintelligible.' } }),
  responseCreated: (responseId: string, o: { outOfBand?: boolean; request?: string } = {}) =>
    event({ type: 'response.created', response: response(responseId, o) }),
  outputItemAdded: (responseId: string, itemId: string) =>
    event({ type: 'response.output_item.added', response_id: responseId, output_index: 0, item: item(itemId, 'assistant') }),
  transcriptDelta: (responseId: string, itemId: string, delta: string) =>
    event({ type: 'response.output_audio_transcript.delta', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta }),
  transcriptDone: (responseId: string, itemId: string, transcript: string) =>
    event({ type: 'response.output_audio_transcript.done', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, transcript }),
  textDelta: (responseId: string, itemId: string, delta: string) =>
    event({ type: 'response.output_text.delta', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta }),
  textDone: (responseId: string, itemId: string, text: string) =>
    event({ type: 'response.output_text.done', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, text }),
  audio: (responseId: string, itemId: string, o: { samples?: number; fill?: number } = {}) =>
    event({ type: 'response.output_audio.delta', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta: b64(o.samples ?? 2_400, o.fill ?? 900) }),
  audioDone: (responseId: string, itemId: string) =>
    event({ type: 'response.output_audio.done', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0 }),
  outputItemDone: (responseId: string, itemId: string) =>
    event({ type: 'response.output_item.done', response_id: responseId, output_index: 0, item: item(itemId, 'assistant', 'completed') }),
  responseDone: (responseId: string, o: { outOfBand?: boolean; request?: string; status?: string; statusDetails?: unknown } = {}) =>
    event({ type: 'response.done', response: response(responseId, { ...o, status: o.status ?? 'completed' }) }),
  error: (e: { type?: string; code?: string | null; message?: string; event_id?: string | null } = {}) =>
    event({ type: 'error', error: { type: 'invalid_request_error', code: null, message: 'Something was wrong.', param: null, event_id: null, ...e } }),
  rateLimits: () => event({ type: 'rate_limits.updated', rate_limits: [{ name: 'tokens', limit: 40_000, remaining: 39_000, reset_seconds: 1.5 }] }),
  bare: (type: string) => event({ type }),
};

/**
 * One whole spoken exchange as the server sends it under automatic turns
 * (`n` numbers its ids): the commit and its input item, the response and
 * its assistant item, the source and translation transcripts, 100 ms of audio, and the ends.
 */
export function exchange(n: number, o: { source?: string; translation?: string; previous?: string | null } = {}): string[] {
  const input = `item_in_${n}`;
  const out = `item_out_${n}`;
  const resp = `resp_${n}`;
  return [
    SERVER.speechStarted(input),
    SERVER.speechStopped(input),
    SERVER.committed(input, o.previous ?? null),
    SERVER.itemAdded(input, 'user', o.previous ?? null),
    SERVER.responseCreated(resp),
    SERVER.outputItemAdded(resp, out),
    SERVER.itemAdded(out, 'assistant', input),
    SERVER.transcriptDelta(resp, out, o.translation ?? 'Hello.'),
    SERVER.audio(resp, out),
    SERVER.inputDone(input, o.source ?? '你好。'),
    SERVER.transcriptDone(resp, out, o.translation ?? 'Hello.'),
    SERVER.audioDone(resp, out),
    SERVER.outputItemDone(resp, out),
    SERVER.responseDone(resp),
  ];
}

/** A OpenAI Compatible leg started over `FakeSocket`s on a tracked virtual clock; its socket not yet opened. */
export function startCompatible(
  o: { context?: SessionContext; patch?: Partial<CompatibleSettings>; credentials?: CompatibleCredentials } = {},
) {
  const sockets = fakeSockets();
  const { clock, timers } = trackedClock();
  const { events, log } = recordEvents();
  const controller = new AbortController();
  const context = o.context ?? AUTO_CTX;
  const config = configFor(context, o.patch);
  const starting = createCompatibleAdapter({ openSocket: sockets.create }).start(
    { context, config, credentials: o.credentials ?? KEY, clock, signal: controller.signal },
    events,
  );
  const socket = () => sockets.last();
  const of = <K extends AdapterEvent['kind']>(kind: K) => log.filter((e): e is Extract<AdapterEvent, { kind: K }> => e.kind === kind);
  const frames = (type: string) => of('frame').filter((e) => e.payload.type === type).map((e) => e.payload.payload);
  const sent = () => socket().sentJson<Record<string, unknown>>();
  const said = () => sent().filter((m) => m.type !== 'input_audio_buffer.append');
  const appended = () => sent().filter((m) => m.type === 'input_audio_buffer.append').map((m) => base64ToPcm(m.audio as string));
  const content = () => log.filter((e) => e.kind !== 'frame');
  const receive = (...messages: string[]) => { for (const m of messages) socket().receive(m); };
  return { sockets, clock, timers, log, controller, config, starting, socket, of, frames, sent, said, appended, content, receive };
}

/** Started, opened, created and configured: the start resolved, the first anchor sent. */
export async function liveCompatible(o?: Parameters<typeof startCompatible>[0]) {
  const h = startCompatible(o);
  h.socket().open('realtime');
  h.receive(SERVER.created(), SERVER.updated());
  const session = await h.starting;
  return { ...h, session };
}
