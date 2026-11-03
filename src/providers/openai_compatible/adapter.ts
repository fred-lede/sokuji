/**
 * OpenAI Compatible on the new contract (spec: "L0 — the client contract"),
 * mirrored from `openai/adapter.ts` with endpoint URL and model/voice from
 * `CompatibleConfig` instead of `RealtimeConfig`, and error words saying
 * "the endpoint" instead of "OpenAI".
 */
import type {
  ConversationItemAdded,
  ConversationItemInputAudioTranscriptionCompletedEvent,
  ConversationItemInputAudioTranscriptionDeltaEvent,
  ConversationItemInputAudioTranscriptionFailedEvent,
  InputAudioBufferCommittedEvent,
  InputAudioBufferSpeechStartedEvent,
  InputAudioBufferSpeechStoppedEvent,
  RateLimitsUpdatedEvent,
  RealtimeError,
  RealtimeErrorEvent,
  ResponseAudioDeltaEvent,
  ResponseAudioDoneEvent,
  ResponseAudioTranscriptDeltaEvent,
  ResponseAudioTranscriptDoneEvent,
  ResponseCreatedEvent,
  ResponseDoneEvent,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
  SessionCreatedEvent,
  SessionUpdatedEvent,
} from 'openai/resources/realtime/realtime';
import {
  AdapterStartError,
  type Adapter,
  type AdapterEvents,
  type AdapterSession,
  type StartRequest,
} from '../../lib/contract/adapter';
import { framePayload } from '../../lib/contract/framePayload';
import { base64ToPcm } from '../../lib/contract/pcm64';
import { describeCause } from '../../lib/diagnostics/describeCause';
import type { CompatibleConfig } from './config';
import { RealtimeItems } from '../openai/items';
import { ACTIVE_RESPONSE, ResponseQueue, type Request } from '../openai/queue';
import type { CompatibleCredentials } from './settings';
import { nativeSocket, WS_OPEN, type OpenSocket } from '../openai/socket';
import {
  anchorResponse,
  appendFrame,
  CLEAR,
  COMMIT,
  compatibleProtocols,
  compatibleUrl,
  decodeServerEvent,
  errorCode,
  errorWords,
  isOutOfBand,
  requestOf,
  responseCreate,
  compatibleSessionUpdate,
  textItem,
  unwrapTranslationText,
  type ServerEvent,
} from './wire';

/** The old client's bound on the start (30 s), now on the request's clock, and closing the socket. */
export const START_TIMEOUT_MS = 30_000;
/** A socket that failed before it opened: a browser cannot read why. */
export const NEVER_OPENED = "The endpoint's socket did not open (check the endpoint URL, the network, and that the API key is still valid).";
/** How long a mid-session `error` words the close that follows it. */
export const ERROR_WORDS_MS = 10_000;
/** The drift anchor's interval: at the start, then after every fifth completed translation. */
export const ANCHOR_EVERY = 5;

/** Known events with nothing to act on: a Logs line under their own name. */
const QUIET = new Set([
  'conversation.item.done', 'conversation.item.deleted', 'conversation.item.truncated', 'conversation.item.input_audio_transcription.segment',
  'input_audio_buffer.timeout_triggered', 'response.content_part.added', 'response.content_part.done',
]);

export interface CompatibleAdapterDeps {
  /** `new WebSocket(url, protocols)` in the app; a `FakeSocket` factory in tests. */
  openSocket: OpenSocket;
}

const closeWords = (e: CloseEvent) => `${e.code}${e.reason ? ` ${e.reason}` : ''}`;

/** A thrown value's name alone (`SyntaxError`, `SecurityError`), never its message. */
function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name !== '' ? name : 'unknown error';
}

/** A conversation item's id and role, whatever kind of item it is. */
function itemOf(item: unknown): { id: string | undefined; role: string | undefined } {
  const i = (item ?? {}) as { id?: unknown; role?: unknown };
  return { id: typeof i.id === 'string' ? i.id : undefined, role: typeof i.role === 'string' ? i.role : undefined };
}

class CompatibleLeg implements AdapterSession {
  readonly info: { transport: string };
  readonly opening: Promise<AdapterSession>;
  private phase: 'opening' | 'configuring' | 'live' | 'ended' = 'opening';
  private opened = false;
  private readonly socket: WebSocket;
  private readonly items: RealtimeItems;
  private readonly queue: ResponseQueue;
  private ids = 0;
  private readonly itemsSent = new Set<string>();
  private producing = false;
  private completed = 0;
  private anchoredAt = -1;
  private readable = true;
  private audioReadable = true;
  private lastError: { code: string; message: string; at: number } | null = null;
  private settle: { resolve(): void; reject(error: unknown): void } | null = null;

  constructor(
    private readonly request: StartRequest<CompatibleConfig, CompatibleCredentials>,
    private readonly events: AdapterEvents,
    openSocket: OpenSocket,
  ) {
    const { config, clock, signal } = request;
    this.info = { transport: config.transport };
    this.items = new RealtimeItems(events);
    this.queue = new ResponseQueue({
      clock,
      eventId: () => `sokuji_${++this.ids}`,
      sink: {
        send: (asked, eventId, waitedMs, merged) => this.ask(asked, eventId, waitedMs, merged),
        queued: (asked, waiting) => this.frame('out', 'response.queued', { for: asked.kind, waiting }),
      },
    });
    const url = compatibleUrl(config);
    const protocols = compatibleProtocols(request.credentials);
    try {
      this.socket = openSocket(url, protocols);
    } catch (error) {
      throw new AdapterStartError(`The browser would not open the socket (${errorName(error)}).`, 'network');
    }
    this.socket.binaryType = 'arraybuffer';
    this.opening = new Promise<AdapterSession>((resolve, reject) => {
      const cancelTimer = clock.setTimeout(() => this.refuse(this.opened
        ? new AdapterStartError(`The endpoint did not start the session within ${START_TIMEOUT_MS / 1000} s.`, 'server')
        : new AdapterStartError(`The endpoint did not open the connection within ${START_TIMEOUT_MS / 1000} s.`, 'network')), START_TIMEOUT_MS);
      const onAbort = () => this.refuse(signal.reason ?? new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      const done = () => { cancelTimer(); signal.removeEventListener('abort', onAbort); };
      this.settle = {
        resolve: () => { done(); resolve(this); },
        reject: (error) => { done(); reject(error); },
      };
    });
    this.socket.onopen = () => this.onOpen();
    this.socket.onmessage = (e: MessageEvent) => this.onMessage(e.data);
    this.socket.onerror = () => this.frame('in', 'session.socket_error');
    this.socket.onclose = (e: CloseEvent) => this.onClose(e);
  }

  appendAudio(pcm: Int16Array): void {
    if (this.phase !== 'live') return;
    this.send(appendFrame(pcm));
  }

  appendText(text: string): void {
    const trimmed = text.trim();
    if (this.phase !== 'live' || !trimmed) return;
    const itemId = `sokuji_text_${++this.ids}`;
    this.items.typed(itemId, trimmed);
    this.queue.push({ kind: 'text', itemId, text: trimmed });
  }

  beginTurn(): void {}

  endTurn(): void {
    if (this.phase !== 'live' || this.request.context.turns !== 'manual') return;
    if (!this.send(JSON.stringify(COMMIT))) return;
    this.frame('out', 'input_audio_buffer.commit');
    this.queue.push({ kind: 'turn' });
  }

  cancelTurn(): void {
    if (this.phase !== 'live' || this.request.context.turns !== 'manual') return;
    if (this.send(JSON.stringify(CLEAR))) this.frame('out', 'input_audio_buffer.clear');
  }

  stop(): Promise<void> {
    this.shutDown();
    return Promise.resolve();
  }

  private onOpen(): void {
    if (this.phase !== 'opening') return;
    this.opened = true;
    const { config, context } = this.request;
    this.frame('out', 'session.opened', {
      model: config.translateModel, modalities: config.modalities, voice: config.voice ?? null, turnDetection: config.turnDetection?.type ?? null, manual: context.turns === 'manual',
    });
  }

  private onMessage(data: unknown): void {
    if (this.phase === 'ended') return;
    let e: ServerEvent;
    try {
      e = decodeServerEvent(data);
    } catch (error) {
      this.unreadable('frame', error);
      return;
    }
    this.readable = true;
    switch (e.type) {
      case 'session.created': return this.created(e as unknown as SessionCreatedEvent);
      case 'session.updated': return this.updated(e as unknown as SessionUpdatedEvent);
      case 'error': return this.serverError((e as unknown as Partial<RealtimeErrorEvent>).error ?? {});
      case 'input_audio_buffer.committed': return this.committed(e as unknown as InputAudioBufferCommittedEvent);
      case 'input_audio_buffer.speech_started': {
        const s = e as unknown as InputAudioBufferSpeechStartedEvent;
        return this.frame('in', e.type, { itemId: s.item_id ?? null, audioStartMs: s.audio_start_ms ?? null });
      }
      case 'input_audio_buffer.speech_stopped': {
        const s = e as unknown as InputAudioBufferSpeechStoppedEvent;
        return this.frame('in', e.type, { itemId: s.item_id ?? null, audioEndMs: s.audio_end_ms ?? null });
      }
      case 'input_audio_buffer.cleared': return this.frame('in', e.type);
      case 'conversation.item.added': return this.itemAdded(e as unknown as ConversationItemAdded);
      case 'conversation.item.input_audio_transcription.delta': return this.inputDelta(e as unknown as ConversationItemInputAudioTranscriptionDeltaEvent);
      case 'conversation.item.input_audio_transcription.completed': return this.inputDone(e as unknown as ConversationItemInputAudioTranscriptionCompletedEvent);
      case 'conversation.item.input_audio_transcription.failed': return this.inputFailed(e as unknown as ConversationItemInputAudioTranscriptionFailedEvent);
      case 'response.created': return this.responseCreated(e as unknown as ResponseCreatedEvent);
      case 'response.output_item.added': return this.outputAdded(e as unknown as ResponseOutputItemAddedEvent);
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta': return this.outputDelta(e as unknown as ResponseAudioTranscriptDeltaEvent | ResponseTextDeltaEvent);
      case 'response.output_audio_transcript.done': {
        const d = e as unknown as ResponseAudioTranscriptDoneEvent;
        return this.outputDone(d, d.transcript);
      }
      case 'response.output_text.done': {
        const d = e as unknown as ResponseTextDoneEvent;
        return this.outputDone(d, d.text);
      }
      case 'response.output_audio.delta': return this.audioDelta(e as unknown as ResponseAudioDeltaEvent);
      case 'response.output_audio.done': {
        const d = e as unknown as ResponseAudioDoneEvent;
        return this.frame('in', e.type, { responseId: d.response_id ?? null, itemId: d.item_id ?? null });
      }
      case 'response.output_item.done': return this.outputItemDone(e as unknown as ResponseOutputItemDoneEvent);
      case 'response.done': return this.responseDone(e as unknown as ResponseDoneEvent);
      case 'rate_limits.updated': return this.frame('in', e.type, { rateLimits: (e as unknown as RateLimitsUpdatedEvent).rate_limits ?? null });
      default:
        if (QUIET.has(e.type)) this.frame('in', e.type);
        else this.frame('in', 'session.unknown', { type: e.type });
    }
  }

  private created(e: SessionCreatedEvent): void {
    const s = (e.session ?? {}) as { id?: unknown; model?: unknown; expires_at?: unknown };
    this.frame('in', 'session.created', { id: s.id ?? null, model: s.model ?? null, expiresAt: s.expires_at ?? null });
    if (this.phase !== 'opening') return;
    const update = compatibleSessionUpdate(this.request.config);
    if (this.send(JSON.stringify(update))) this.frame('out', 'session.update', update.session);
    this.phase = 'configuring';
  }

  private updated(e: SessionUpdatedEvent): void {
    const s = (e.session ?? {}) as { output_modalities?: unknown; audio?: unknown; reasoning?: unknown; max_output_tokens?: unknown };
    this.frame('in', 'session.updated', { outputModalities: s.output_modalities ?? null, audio: s.audio ?? null, reasoning: s.reasoning ?? null, maxOutputTokens: s.max_output_tokens ?? null });
    if (this.phase !== 'configuring') return;
    this.phase = 'live';
    const settle = this.settle;
    this.settle = null;
    settle?.resolve();
    this.anchor();
  }

  private serverError(error: Partial<RealtimeError>): void {
    this.frame('in', 'session.error', { type: error.type ?? null, code: error.code ?? null, message: error.message ?? null, param: error.param ?? null, eventId: error.event_id ?? null });
    const refusal = { code: errorCode(error), message: errorWords(error) };
    if (this.phase !== 'live') {
      this.refuse(new AdapterStartError(refusal.message, refusal.code));
      return;
    }
    if (refusal.code === 'segment_ended') {
      this.end({ failed: refusal });
      return;
    }
    if (error.code !== ACTIVE_RESPONSE) this.lastError = { ...refusal, at: this.request.clock.now() };
    this.queue.refused(error.event_id, error.code);
  }

  private committed(e: InputAudioBufferCommittedEvent): void {
    this.frame('in', e.type, { itemId: e.item_id ?? null, previousItemId: e.previous_item_id ?? null });
    if (this.phase === 'live' && typeof e.item_id === 'string') this.items.committed(e.item_id);
  }

  private itemAdded(e: ConversationItemAdded): void {
    const { id, role } = itemOf(e.item);
    this.frame('in', e.type, { itemId: id ?? null, role: role ?? null, previousItemId: e.previous_item_id ?? null });
    if (this.phase !== 'live' || id === undefined) return;
    if (role === 'user') this.items.inputAdded(id);
    else if (role === 'assistant') this.items.assistantAdded(id, e.previous_item_id);
  }

  private inputDelta(e: ConversationItemInputAudioTranscriptionDeltaEvent): void {
    this.frame('in', e.type, { itemId: e.item_id ?? null, delta: e.delta ?? null });
    if (this.phase === 'live' && typeof e.item_id === 'string' && typeof e.delta === 'string') this.items.inputDelta(e.item_id, e.delta);
  }

  private inputDone(e: ConversationItemInputAudioTranscriptionCompletedEvent): void {
    this.frame('in', e.type, { itemId: e.item_id ?? null, transcript: e.transcript ?? null });
    if (this.phase === 'live' && typeof e.item_id === 'string') this.items.inputDone(e.item_id, typeof e.transcript === 'string' ? e.transcript : '');
  }

  private inputFailed(e: ConversationItemInputAudioTranscriptionFailedEvent): void {
    const error = e.error ?? {};
    this.frame('in', e.type, { itemId: e.item_id ?? null, error: { type: error.type ?? null, code: error.code ?? null, message: error.message ?? null } });
    if (this.phase === 'live' && typeof e.item_id === 'string') this.items.inputFailed(e.item_id);
  }

  private responseCreated(e: ResponseCreatedEvent): void {
    const id = e.response?.id;
    const outOfBand = isOutOfBand(e.response);
    this.frame('in', e.type, { responseId: id ?? null, outOfBand });
    if (this.phase !== 'live' || typeof id !== 'string') return;
    this.items.responseCreated(id, outOfBand);
    if (outOfBand) return;
    this.queue.created(id, requestOf(e.response));
    if (!this.producing) {
      this.producing = true;
      this.events.busy(true);
    }
  }

  private outputAdded(e: ResponseOutputItemAddedEvent): void {
    const { id, role } = itemOf(e.item);
    this.frame('in', e.type, { responseId: e.response_id ?? null, itemId: id ?? null, role: role ?? null });
    if (this.phase === 'live' && id !== undefined && typeof e.response_id === 'string') this.items.outputAdded(id, e.response_id);
  }

  private outputDelta(e: ResponseAudioTranscriptDeltaEvent | ResponseTextDeltaEvent): void {
    this.frame('in', e.type, { responseId: e.response_id ?? null, itemId: e.item_id ?? null, delta: e.delta ?? null });
    if (this.phase === 'live' && typeof e.item_id === 'string' && typeof e.response_id === 'string' && typeof e.delta === 'string') {
      this.items.outputDelta(e.item_id, e.response_id, e.delta);
    }
  }

  private outputDone(e: ResponseAudioTranscriptDoneEvent | ResponseTextDoneEvent, text: unknown): void {
    this.frame('in', e.type, { responseId: e.response_id ?? null, itemId: e.item_id ?? null, text: text ?? null });
    if (this.phase === 'live' && typeof e.item_id === 'string' && typeof e.response_id === 'string' && typeof text === 'string') {
      this.items.outputDone(e.item_id, e.response_id, unwrapTranslationText(text));
    }
  }

  private audioDelta(e: ResponseAudioDeltaEvent): void {
    if (this.phase !== 'live') return;
    if (typeof e.delta !== 'string') {
      this.unreadable('audio', new Error('an audio delta with no base64 string'));
      return;
    }
    let pcm: Int16Array;
    try {
      pcm = base64ToPcm(e.delta);
    } catch (error) {
      this.unreadable('audio', error);
      return;
    }
    this.audioReadable = true;
    this.frame('in', e.type, { responseId: e.response_id ?? null, itemId: e.item_id ?? null, samples: pcm.length });
    if (this.request.context.speech && typeof e.item_id === 'string' && typeof e.response_id === 'string') this.items.audio(e.item_id, e.response_id, pcm);
  }

  private outputItemDone(e: ResponseOutputItemDoneEvent): void {
    const { id } = itemOf(e.item);
    this.frame('in', e.type, { responseId: e.response_id ?? null, itemId: id ?? null });
    if (this.phase === 'live' && id !== undefined) this.items.itemDone(id);
  }

  private responseDone(e: ResponseDoneEvent): void {
    const r = e.response;
    const id = r?.id;
    const outOfBand = isOutOfBand(r);
    this.frame('in', e.type, { responseId: id ?? null, status: r?.status ?? null, statusDetails: r?.status_details ?? null, outOfBand, usage: r?.usage ?? null });
    if (this.phase !== 'live' || typeof id !== 'string') return;
    this.items.responseDone(id);
    if (outOfBand) return;
    if (this.producing) {
      this.producing = false;
      this.events.busy(false);
    }
    if (r?.status === 'completed') this.completed += 1;
    this.queue.done(id);
    if (this.completed > 0 && this.completed % ANCHOR_EVERY === 0) this.anchor();
  }

  private anchor(): void {
    if (this.phase !== 'live' || this.anchoredAt === this.completed) return;
    this.anchoredAt = this.completed;
    const eventId = `sokuji_${++this.ids}`;
    if (!this.send(JSON.stringify(anchorResponse(eventId, this.request.config.instructions)))) return;
    this.frame('out', 'response.anchor', { eventId, translations: this.completed });
  }

  private ask(asked: Request, eventId: string, waitedMs: number, merged: number): void {
    if (asked.kind === 'text' && !this.itemsSent.has(asked.itemId)) {
      if (!this.send(JSON.stringify(textItem(asked.itemId, asked.text)))) return;
      this.itemsSent.add(asked.itemId);
      this.frame('out', 'conversation.item.create', { itemId: asked.itemId, length: asked.text.length });
    }
    if (this.send(JSON.stringify(responseCreate(eventId)))) {
      this.frame('out', 'response.create', { eventId, for: asked.kind, waitedMs, ...(merged > 0 ? { merged } : {}) });
    }
  }

  private unreadable(latch: 'frame' | 'audio', error: unknown): void {
    if (latch === 'frame' ? !this.readable : !this.audioReadable) return;
    if (latch === 'frame') this.readable = false;
    else this.audioReadable = false;
    this.frame('in', 'session.unreadable', { message: describeCause(error) });
    if (this.phase === 'live') this.events.degraded({ code: 'parse_error', message: `A message from the endpoint could not be read: ${describeCause(error)}`, cause: error });
  }

  private recentError(): { code: string; message: string } | null {
    const last = this.lastError;
    if (!last) return null;
    const age = this.request.clock.now() - last.at;
    if (age < 0 || age > ERROR_WORDS_MS) return null;
    return { code: last.code, message: last.message };
  }

  private send(data: string): boolean {
    if (this.socket.readyState !== WS_OPEN) return false;
    this.socket.send(data);
    return true;
  }

  private onClose(e: CloseEvent): void {
    if (this.phase === 'ended') return;
    this.frame('in', 'session.connection_lost', { code: e.code, reason: e.reason });
    if (this.phase !== 'live') {
      this.refuse(this.opened
        ? new AdapterStartError(`The endpoint closed the connection before the session started (${closeWords(e)}).`, 'server')
        : new AdapterStartError(NEVER_OPENED, 'network'));
      return;
    }
    this.end({ failed: this.recentError() ?? { code: 'connection_lost', message: `The connection to the endpoint closed (${closeWords(e)}).` } });
  }

  private refuse(error: unknown): void {
    if (this.phase === 'live' || this.phase === 'ended') return;
    this.shutDown();
    const settle = this.settle;
    this.settle = null;
    settle?.reject(error);
  }

  private end(how: { failed: { code: string; message: string } }): void {
    if (this.phase !== 'live') return;
    this.shutDown();
    this.events.failed(how.failed);
  }

  private shutDown(): void {
    this.phase = 'ended';
    this.queue.stop();
    this.items.stop();
    const socket = this.socket;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState <= WS_OPEN) socket.close(1000);
  }

  private frame(direction: 'in' | 'out', type: string, payload?: unknown): void {
    if (this.phase === 'ended') return;
    this.events.frame(payload === undefined ? { direction, type } : { direction, type, payload: framePayload(payload) });
  }
}

export function createCompatibleAdapter(deps: Partial<CompatibleAdapterDeps> = {}): Adapter<CompatibleConfig, CompatibleCredentials> {
  const openSocket = deps.openSocket ?? nativeSocket;
  return {
    start(request, events) {
      if (request.signal.aborted) return Promise.reject(request.signal.reason ?? new Error('aborted'));
      try {
        return new CompatibleLeg(request, events, openSocket).opening;
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}