/**
 * Automatic turns: the mode the app runs in by default.
 *
 * Under `turns: 'auto'` the client does not commit and does not ask for a
 * response. It streams `input_audio_buffer.append` and waits for the
 * endpoint to detect the end of the turn — server-side voice detection — and
 * to start the response itself. The client's `endTurn` is a no-op outside
 * manual turns (`adapter.ts`), so a gateway that never begins a response
 * leaves the leg silent: no translation, no failure, nothing at all.
 *
 * That is the failure this locks down (2026-11-03). Against the live
 * gateway, the frame sequence of a whole automatic turn was:
 *
 *   out session.opened → in session.created → out session.update
 *   → in session.updated → out response.anchor → in response.created
 *   → in response.done
 *
 * No `out response.create` anywhere: the client never asked. The gateway
 * answered `speech_started` and `speech_stopped` with "unsupported event
 * type", and stayed silent for thirty seconds over speech-like audio. The
 * endpoint has to run its own voice detection, or the turn mode has to be
 * manual — this suite says which half is missing.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { createCompatibleAdapter } from './adapter';
import { AUTO_CTX, KEY, SERVER, configFor, exchange } from './testing';
import type { Clock } from '../../lib/contract/clock';

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
 * A gateway under automatic turns.
 *
 * `detectVoice` false is the gateway without voice detection: it takes the
 * audio and says nothing back, ever. True is the gateway that ends the turn
 * itself — it reports the speech, commits the buffer, and starts a response
 * — which is the whole of what the client waits for.
 */
function gateway(o: { detectVoice?: boolean } = {}) {
  const detectVoice = o.detectVoice ?? false;
  const servers: WebSocketServer[] = [];
  const asked: string[] = [];
  const appended: number[] = [];

  const start = async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    let turn = 0;

    server.on('connection', (socket: WebSocket) => {
      socket.send(SERVER.created());
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; event_id?: string };
        if (frame.type === 'session.update') {
          socket.send(SERVER.updated());
          return;
        }
        if (frame.type === 'input_audio_buffer.append') {
          appended.push(1);
          // The endpoint sees speech, ends the turn on its own, and starts
          // the response: the speech frames, the commit, the input item, and
          // the response with its transcript.
          if (!detectVoice) return;
          turn += 1;
          for (const out of exchange(turn, { source: 'こんにちは。', translation: `Translation ${turn}` })) socket.send(out);
          return;
        }
        if (frame.type === 'response.create') {
          // The anchor is a response.create of its own: it is out of band
          // and asks for no translation, so it does not count as a request.
          const purpose = (frame as { response?: { metadata?: { purpose?: string } } }).response?.metadata?.purpose;
          if (purpose !== 'anchor') asked.push(frame.event_id ?? 'no-event-id');
        }
      });
    });
    return { url: `http://127.0.0.1:${port}`, asked, appended };
  };

  const stop = async () => {
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { start, stop, asked, appended };
}

/**
 * The events a leg reports, and the frames it sent.
 *
 * A leg reports both sides on one channel: the source it heard and the
 * translation it made, told apart by the `side` of the segment each belongs
 * to. Only the translation side is what a caller wants here.
 */
function collector() {
  const sides = new Map<number, 'source' | 'translation'>();
  const translations: string[] = [];
  const sources: string[] = [];
  const failures: string[] = [];
  const frames: string[] = [];
  return {
    translations,
    sources,
    failures,
    frames,
    events: {
      segmentOpened: (e: { ref: number; side: 'source' | 'translation' }) => sides.set(e.ref, e.side),
      segmentText: (e: { ref: number; text: string }) => (sides.get(e.ref) === 'source' ? sources : translations).push(e.text),
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
      frame: (e: { direction: string; type: string }) => frames.push(`${e.direction} ${e.type}`),
    },
  };
}

/** The leg, over a real socket to the gateway under test. */
async function leg(url: string, events: ReturnType<typeof collector>['events']) {
  const config = configFor(AUTO_CTX, { endpoint: url });
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
  const session = await adapter.start({ context: AUTO_CTX, config, credentials: KEY, clock, signal: controller.signal }, events);
  return { session, controller };
}

/** Waits for a condition, or gives up with the state that was seen. */
async function waitFor(ok: () => boolean, what: string, state: () => unknown = () => ''): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}${state() ? `: ${state()}` : ''}`);
}

describe('the OpenAI Compatible endpoint under automatic turns', () => {
  it('never asks for a response: the endpoint has to end the turn itself', async () => {
    const server = gateway({ detectVoice: false });
    const { url } = await server.start();
    const seen = collector();
    const { session } = await leg(url, seen.events);
    try {
      session.beginTurn();
      session.appendAudio(new Int16Array(2_400));
      session.endTurn();
      // The audio goes out, and nothing else: the client waits for the
      // endpoint to begin a response and, with no voice detection, no
      // response is ever begun.
      await waitFor(() => server.appended.length > 0, 'the audio', () => `appended=${server.appended.length}`);
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(server.asked).toEqual([]);
      expect(seen.frames).not.toContain('out response.create');
      expect(seen.translations).toEqual([]);
      expect(seen.failures).toEqual([]);
    } finally {
      await session.stop();
      await server.stop();
    }
  }, 20000);

  it('a gateway that detects the voice itself gets its turn translated', async () => {
    const server = gateway({ detectVoice: true });
    const { url } = await server.start();
    const seen = collector();
    const { session } = await leg(url, seen.events);
    try {
      session.beginTurn();
      session.appendAudio(new Int16Array(2_400));
      session.endTurn();
      await waitFor(
        () => seen.translations.length >= 1,
        'the translation',
        () => `translations=${JSON.stringify(seen.translations)} frames=${JSON.stringify(seen.frames)}`,
      );
      expect(seen.translations).toEqual(['Translation 1']);
      expect(seen.failures).toEqual([]);
    } finally {
      await session.stop();
      await server.stop();
    }
  }, 20000);

  it('keeps translating turn after turn when the endpoint detects the voice', async () => {
    const server = gateway({ detectVoice: true });
    const { url } = await server.start();
    const seen = collector();
    const { session } = await leg(url, seen.events);
    try {
      for (let turn = 1; turn <= 3; turn += 1) {
        session.beginTurn();
        session.appendAudio(new Int16Array(2_400));
        session.endTurn();
        await waitFor(
          () => seen.translations.length >= turn,
          `translation ${turn}`,
          () => `translations=${JSON.stringify(seen.translations)} failures=${JSON.stringify(seen.failures)}`,
        );
      }
      expect(seen.translations).toEqual(['Translation 1', 'Translation 2', 'Translation 3']);
      expect(seen.failures).toEqual([]);
    } finally {
      await session.stop();
      await server.stop();
    }
  }, 20000);
});
