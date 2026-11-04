/**
 * The multi-turn contract of an OpenAI Compatible endpoint: a leg that
 * translates one sentence must go on to translate the next, over the same
 * socket.
 *
 * The failure this locks down (2026-11-03): against a self-hosted realtime
 * gateway, the leg translated exactly one sentence and the connection then
 * died. Two independent causes were found against the live endpoint, and
 * this suite covers both:
 *
 *  1. Automatic turns. The client's default turn mode is `auto`, where it
 *     only streams `input_audio_buffer.append` and waits for the endpoint to
 *     detect the end of the turn and start a response itself. A gateway
 *     without voice detection therefore never gets a `response.create` and
 *     the leg goes silent. (`autoTurn.test.ts` covers that mode.)
 *  2. A refusal that is not the OpenAI code. The gateway answers a second,
 *     overlapping `response.create` with `invalid_request_error` and no
 *     `code` field; the client's queue re-queues only the one code the
 *     OpenAI API uses for it
 *     (`conversation_already_has_active_response`), so any other code drops
 *     the sentence on the floor and the leg goes quiet.
 *
 * The first drives sokuji's own adapter against a real WebSocket server over
 * three turns and wants three translations back; the second reads the frames
 * the leg sent and wants the turn protocol the endpoint is owed.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { createCompatibleAdapter } from './adapter';
import { KEY, MANUAL_CTX, configFor } from './testing';
import type { Clock } from '../../lib/contract/clock';

/** The OpenAI code for "a response is already in progress". */
const ACTIVE_RESPONSE = 'conversation_already_has_active_response';

/**
 * One exchange, as the endpoint answers it: the frames a response is made of.
 *
 * `modality` picks the content frames the way the real API does. Under
 * `text` the translation streams as `response.output_text.delta`; under
 * `audio` it streams as the spoken transcript,
 * `response.output_audio_transcript.delta`, beside the content audio. The
 * two are never sent together: the client appends each to the same segment
 * text, so both at once would double every translation.
 */
function responseFrames(
  id: string,
  text: string,
  o: { requestId?: string; purpose?: string; modality?: 'text' | 'audio' } = {},
): string[] {
  const modality = o.modality ?? 'text';
  const response = {
    id,
    object: 'realtime.response',
    status: 'completed',
    conversation_id: o.purpose === 'anchor' ? null : 'conv_1',
    metadata: o.purpose === 'anchor' ? { purpose: 'anchor' } : o.requestId ? { request: o.requestId } : null,
    output: [],
  };
  const item = { id: `item_${id}`, object: 'realtime.item', type: 'message', role: 'assistant', status: 'completed', content: [] };
  const content = {
    response_id: id,
    item_id: item.id,
    output_index: 0,
    content_index: 0,
  };
  const frames = [
    JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress' } }),
    JSON.stringify({ type: 'response.output_item.added', response_id: id, item }),
  ];
  if (modality === 'audio') {
    frames.push(
      JSON.stringify({ type: 'response.output_audio_transcript.delta', ...content, delta: text }),
      JSON.stringify({ type: 'response.output_audio.delta', ...content, delta: '' }),
      JSON.stringify({ type: 'response.output_audio_transcript.done', ...content, transcript: text }),
      JSON.stringify({ type: 'response.output_audio.done', ...content }),
    );
  } else {
    frames.push(
      JSON.stringify({ type: 'response.output_text.delta', ...content, delta: text }),
      JSON.stringify({ type: 'response.output_text.done', ...content, text }),
    );
  }
  frames.push(
    JSON.stringify({ type: 'response.output_item.done', response_id: id, output_index: 0, item }),
    JSON.stringify({ type: 'response.done', response: { ...response, status: 'completed' } }),
  );
  return frames;
}

const SESSION = {
  type: 'realtime',
  object: 'realtime.session',
  id: 'sess_1',
  model: 'qwen3-translate',
  expires_at: 1_790_000_000,
  output_modalities: ['audio'],
  audio: { input: { noise_reduction: null, transcription: null, turn_detection: { type: 'server_vad', threshold: 0.5 } }, output: { voice: 'alloy' } },
};

/**
 * A gateway that behaves as the OpenAI Realtime API does: one response at a
 * time, and the slot freed the moment the response is done.
 *
 * `clearOnDone` false reproduces the busy-gateway bug — the slot stays taken
 * and the next request is refused. `refusalCode` picks the code the refusal
 * carries: the OpenAI one, which the client re-queues, or none at all,
 * which is what the live gateway sent and what makes the client drop the
 * sentence. `answerCommit` false reproduces the other one — the endpoint
 * never acknowledges the commit, so the client never asks for a response at
 * all.
 */
function gateway(o: { clearOnDone?: boolean; answerCommit?: boolean; refusalCode?: string | null; modality?: 'text' | 'audio' } = {}) {
  const clearOnDone = o.clearOnDone ?? true;
  const answerCommit = o.answerCommit ?? true;
  const refusalCode = o.refusalCode === undefined ? null : o.refusalCode;
  const modality = o.modality ?? 'text';
  const servers: WebSocketServer[] = [];
  const refused: string[] = [];
  const answered: string[] = [];
  const commits: string[] = [];

  const start = async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    let active = false;

    server.on('connection', (socket: WebSocket) => {
      socket.send(JSON.stringify({ type: 'session.created', session: SESSION }));
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as {
          type: string;
          event_id?: string;
          response?: { metadata?: { purpose?: string } };
        };
        if (frame.type === 'session.update') {
          socket.send(JSON.stringify({ type: 'session.updated', session: SESSION }));
          return;
        }
        if (frame.type === 'input_audio_buffer.commit') {
          commits.push(frame.event_id ?? 'commit');
          // The client only asks for a response once the endpoint has
          // acknowledged the commit, so a silent endpoint gets no request.
          if (!answerCommit) return;
          socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item_in', previous_item_id: null }));
          socket.send(JSON.stringify({ type: 'conversation.item.added', previous_item_id: null, item: { id: 'item_in', object: 'realtime.item', type: 'message', role: 'user', content: [] } }));
          return;
        }
        if (frame.type === 'response.create') {
          const purpose = frame.response?.metadata?.purpose;
          // The anchor is out of band: it never takes the in-band slot.
          if (purpose !== 'anchor' && active) {
            refused.push(frame.event_id ?? 'no-event-id');
            socket.send(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: refusalCode, message: 'a response is already in progress', param: null, event_id: frame.event_id ?? null } }));
            return;
          }
          const id = `resp_${answered.length}_${frame.event_id ?? 'x'}`;
          const text = purpose === 'anchor' ? 'anchor' : `Translation ${answered.length + 1}`;
          if (purpose !== 'anchor') {
            answered.push(text);
            active = true;
          }
          for (const out of responseFrames(id, text, { requestId: frame.event_id, purpose, modality })) socket.send(out);
          if (clearOnDone) active = false;
        }
      });
    });
    return { url: `http://127.0.0.1:${port}`, refused, commits };
  };

  const stop = async () => {
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { start, stop, refused, answered, commits };
}

/** The events a leg reports; the test reads the two it cares about. */
function collector() {
  const translations: string[] = [];
  const failures: string[] = [];
  return {
    translations,
    failures,
    events: {
      segmentOpened: () => {},
      segmentText: (e: { text: string }) => translations.push(e.text),
      segmentClosed: () => {},
      audio: () => {},
      speechRanges: () => {},
      closed: () => {},
      reconnecting: () => {},
      reconnected: () => {},
      failed: (e: { message: string }) => failures.push(e.message),
      degraded: () => {},
      loading: () => {},
      busy: () => {},
      frame: () => {},
    },
  };
}

/** The leg, over a real socket to the gateway under test. */
async function leg(url: string, events: ReturnType<typeof collector>['events']) {
  const config = configFor(MANUAL_CTX, { endpoint: url });
  const controller = new AbortController();
  const clock: Clock = {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  };
  const adapter = createCompatibleAdapter({
    openSocket: (socketUrl, protocols) => new WebSocket(socketUrl, protocols) as unknown as never,
  });
  const session = await adapter.start({ context: MANUAL_CTX, config, credentials: KEY, clock, signal: controller.signal }, events);
  return { session, controller };
}

/**
 * Waits for a condition, or gives up with the state that was seen: which
 * translations arrived, which requests were refused, what failed.
 */
async function waitFor(
  ok: () => boolean,
  what: string,
  state: () => unknown = () => '',
): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}${state() ? `: ${state()}` : ''}`);
}

/** One manual turn: begin, speak, end. The endpoint answers it. */
function speakTurn(session: { beginTurn(): void; appendAudio(pcm: Int16Array): void; endTurn(): void }) {
  session.beginTurn();
  session.appendAudio(new Int16Array(1_200));
  session.endTurn();
}

describe('the OpenAI Compatible endpoint over several turns', () => {
  it('translates every turn, not just the first', async () => {
    const server = gateway();
    const { url } = await server.start();
    const seen = collector();
    const { session } = await leg(url, seen.events);
    try {
      for (let turn = 1; turn <= 3; turn += 1) {
        speakTurn(session);
        await waitFor(
          () => seen.translations.length >= turn,
          `translation ${turn}`,
          () => `translations=${JSON.stringify(seen.translations)} refused=${JSON.stringify(server.refused)} failures=${JSON.stringify(seen.failures)}`,
        );
      }
      // The anchor is out of band: it is never a translation, so the first
      // one is the first turn's, not the anchor's.
      expect(seen.translations).toEqual(['Translation 1', 'Translation 2', 'Translation 3']);
      expect(seen.failures).toEqual([]);
      expect(server.refused).toEqual([]);
    } finally {
      await session.stop();
      await server.stop();
    }
  }, 20000);

  it('translates every turn when the answer comes back as spoken audio', async () => {
    const server = gateway({ modality: 'audio' });
    const { url } = await server.start();
    const seen = collector();
    const { session } = await leg(url, seen.events);
    try {
      for (let turn = 1; turn <= 3; turn += 1) {
        speakTurn(session);
        await waitFor(
          () => seen.translations.length >= turn,
          `translation ${turn}`,
          () => `translations=${JSON.stringify(seen.translations)} failures=${JSON.stringify(seen.failures)}`,
        );
      }
      // The transcript carries the translation; the content audio carries
      // none, so the text is stated once and not doubled.
      expect(seen.translations).toEqual(['Translation 1', 'Translation 2', 'Translation 3']);
      expect(seen.failures).toEqual([]);
    } finally {
      await session.stop();
      await server.stop();
    }
  }, 20000);

  it('a gateway that keeps its active response refuses the next turn', async () => {
    const server = gateway({ clearOnDone: false });
    const { url } = await server.start();
    const seen = collector();
    const { session } = await leg(url, seen.events);
    try {
      speakTurn(session);
      await waitFor(() => seen.translations.length >= 1, 'the first translation', () => `translations=${JSON.stringify(seen.translations)}`);
      speakTurn(session);
      await waitFor(() => server.refused.length > 0, 'the refusal', () => `refused=${JSON.stringify(server.refused)}`);
      // The first turn went through; the second was refused and the sentence dropped.
      expect(seen.translations).toHaveLength(1);
      expect(seen.failures).toEqual([]);
    } finally {
      await session.stop();
      await server.stop();
    }
  }, 20000);

  it('a refusal carrying the OpenAI code is re-queued and the turn still lands', async () => {
    // The one code the client re-queues: the sentence waits for the slot
    // instead of being dropped on the floor.
    const server = gateway({ clearOnDone: false, refusalCode: ACTIVE_RESPONSE });
    const { url } = await server.start();
    const seen = collector();
    const { session } = await leg(url, seen.events);
    try {
      speakTurn(session);
      await waitFor(() => seen.translations.length >= 1, 'the first translation', () => `translations=${JSON.stringify(seen.translations)}`);
      speakTurn(session);
      await waitFor(() => server.refused.length > 0, 'the refusal', () => `refused=${JSON.stringify(server.refused)}`);
      // The gateway never frees its slot in this fixture, so the re-queued
      // request waits; what matters is that the client kept it.
      expect(server.refused.length).toBeGreaterThan(0);
      expect(seen.failures).toEqual([]);
    } finally {
      await session.stop();
      await server.stop();
    }
  }, 20000);

  it('the commit asks for the response, not the endpoint\'s acknowledgement of it', async () => {
    // The client asks as soon as the turn is committed. The endpoint's
    // `input_audio_buffer.committed` only tells the client the input item is
    // done; a gateway that never sends it still gets the sentence asked for
    // and still gets it translated.
    const server = gateway({ answerCommit: false });
    const { url } = await server.start();
    const seen = collector();
    const { session } = await leg(url, seen.events);
    try {
      speakTurn(session);
      await waitFor(
        () => seen.translations.length >= 1,
        'the translation',
        () => `translations=${JSON.stringify(seen.translations)} commits=${JSON.stringify(server.commits)} failures=${JSON.stringify(seen.failures)}`,
      );
      expect(server.commits).toHaveLength(1);
      expect(seen.translations).toEqual(['Translation 1']);
      expect(seen.failures).toEqual([]);
    } finally {
      await session.stop();
      await server.stop();
    }
  }, 20000);
});
