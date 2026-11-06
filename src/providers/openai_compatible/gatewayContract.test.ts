/**
 * The contract a real OpenAI Compatible gateway has to meet for sokuji to
 * keep translating: one socket, many turns.
 *
 * Run against a live endpoint with:
 *   SOKUJI_ENDPOINT=http://host:port SOKUJI_KEY=… SOKUJI_MODEL=… \
 *     npx vitest run src/providers/openai_compatible/gatewayContract.test.ts
 *
 * Without those the suite is skipped — it must never reach the network from
 * the ordinary test run.
 *
 * Two modes are checked, because they ask the endpoint for different things.
 * Under manual turns the client commits the buffer and asks for a response
 * itself; under automatic turns — the app's default — it only streams audio
 * and waits for the endpoint to detect the end of the turn and begin the
 * response. An endpoint that runs no voice detection passes the first and
 * fails the second, which is how the live gateway behaved.
 *
 * What is asserted is that every request is answered, not that the answer
 * carries text: the text depends on the model having something to translate,
 * and a leg fed silence is answered with nothing.
 */
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import { createCompatibleAdapter } from './adapter';
import { AUTO_CTX, KEY, MANUAL_CTX, configFor } from './testing';
import type { Clock } from '../../lib/contract/clock';
import type { SessionContext } from '../../lib/contract/adapter';

const ENDPOINT = process.env.SOKUJI_ENDPOINT;
const LIVE_KEY = process.env.SOKUJI_KEY;
const MODEL = process.env.SOKUJI_MODEL;
const live = Boolean(ENDPOINT && LIVE_KEY && MODEL);

/**
 * The events a leg reports. A leg reports both sides on one channel, so the
 * segments are told apart by the `side` they opened with: only the
 * translation side is what this contract is about.
 */
function collector() {
  const sides = new Map<number, 'source' | 'translation'>();
  const translations: string[] = [];
  const failures: string[] = [];
  const frames: string[] = [];
  /** The endpoint's answers, one per in-band response it finished. */
  let answered = 0;
  return {
    translations,
    failures,
    frames,
    answered: () => answered,
    events: {
      segmentOpened: (e: { ref: number; side: 'source' | 'translation' }) => sides.set(e.ref, e.side),
      segmentText: (e: { ref: number; text: string }) => {
        if (sides.get(e.ref) !== 'source') translations.push(e.text);
      },
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
      frame: (e: { direction: string; type: string; payload?: { outOfBand?: boolean } }) => {
        frames.push(`${e.direction} ${e.type}`);
        // The anchor is out of band: it answers nobody's turn.
        if (e.direction === 'in' && e.type === 'response.done' && e.payload?.outOfBand !== true) answered += 1;
      },
    },
  };
}

/** Waits for a condition, or gives up with the state that was seen. */
async function waitFor(ok: () => boolean, what: string, state: () => unknown = () => ''): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}${state() ? `: ${state()}` : ''}`);
}

/** One manual turn: begin, speak, end. The endpoint answers it. */
function speakTurn(session: { beginTurn(): void; appendAudio(pcm: Int16Array): void; endTurn(): void }) {
  session.beginTurn();
  session.appendAudio(new Int16Array(2_400));
  session.endTurn();
}

/**
 * One spoken turn under automatic turns: a loud burst and then the quiet
 * that ends it.
 *
 * A voice detector answers to sound, not to silence: it has to hear
 * something before the quiet after it means anything. So the turn carries
 * a tone — loud enough to be speech, quiet enough to end it.
 */
function speakLoudTurn(session: { appendAudio(pcm: Int16Array): void }) {
  const loud = new Int16Array(4_800);
  for (let i = 0; i < loud.length; i += 1) {
    loud[i] = Math.round(Math.sin((i / 48) * 2 * Math.PI) * 8_000);
  }
  session.appendAudio(loud);
  // A second of quiet, so a detector that waits for it has it.
  session.appendAudio(new Int16Array(24_000));
}

/**
 * The gateway under test: sokuji's own socket, the live endpoint. The
 * adapter is the real one — no mock stands between them.
 */
async function liveLeg(context: SessionContext, events: ReturnType<typeof collector>['events']) {
  const config = configFor(context, { endpoint: ENDPOINT as string, translateModel: MODEL });
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
  const session = await adapter.start(
    { context, config, credentials: { apiKey: LIVE_KEY as string }, clock, signal: controller.signal },
    events,
  );
  return { session, controller };
}

describe.skipIf(!live)('a live OpenAI Compatible gateway', () => {
  it('answers every turn over one socket', async () => {
    const seen = collector();
    const { session } = await liveLeg(MANUAL_CTX, seen.events);
    try {
      for (let turn = 1; turn <= 3; turn += 1) {
        speakTurn(session);
        await waitFor(
          () => seen.answered() >= turn,
          `the answer to turn ${turn}`,
          () => `answered=${seen.answered()} translations=${JSON.stringify(seen.translations)} failures=${JSON.stringify(seen.failures)} frames=${JSON.stringify(seen.frames)}`,
        );
      }
      expect(seen.answered()).toBeGreaterThanOrEqual(3);
      expect(seen.failures).toEqual([]);
    } finally {
      await session.stop();
    }
  }, 180000);

  it('ends the turn by itself under automatic turns', async () => {
    const seen = collector();
    const { session } = await liveLeg(AUTO_CTX, seen.events);
    try {
      speakLoudTurn(session);
      // Under automatic turns the client asks for nothing: the endpoint has
      // to detect the end of the turn and begin the response itself.
      await waitFor(
        () => seen.answered() >= 1,
        'the endpoint to answer',
        () => `answered=${seen.answered()} frames=${JSON.stringify(seen.frames)}`,
      );
      expect(seen.failures).toEqual([]);
    } finally {
      await session.stop();
    }
  }, 120000);
});
