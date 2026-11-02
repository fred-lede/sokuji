/**
 * OpenAI Compatible's adapter: the opening and its refusals in words, the
 * audio, the turns and typed text going up through the queue, items to
 * segments paired exactly, the drift anchor, failures and stop.
 * On `FakeSocket` and a virtual clock — no network, no fake timers.
 */
import { describe, it, expect, vi } from 'vitest';
import { AdapterStartError } from '../../lib/contract/adapter';
import { createVirtualClock } from '../../lib/contract/clock';
import { recordEvents } from '../../lib/contract/events';
import { flush } from '../../lib/contract/testing/drive';
import { fakeSockets } from '../../lib/contract/testing/fakeSocket';
import { ANCHOR_EVERY, createCompatibleAdapter, ERROR_WORDS_MS, NEVER_OPENED, START_TIMEOUT_MS } from './adapter';


import { AUTO_CTX, configFor, exchange, KEY, liveCompatible, MANUAL_CTX, RefusingWebSocket, SERVER, startCompatible } from './testing';
import { compatibleSessionUpdate, compatibleProtocols, compatibleUrl } from './wire';

/** A capture chunk: 2 048 samples of 24 kHz voice, 85.3 ms. */
const chunk = () => new Int16Array(2_048).fill(1_000);
/** What no frame, failure or refusal may carry: the key, and the subprotocol that holds it. */
const SECRETS = [KEY.apiKey, 'openai-insecure-api-key', 'compatibleKey'];

describe('the OpenAI Compatible adapter: opening', () => {
  it('dials the user endpoint with the model in its query and the key in a subprotocol, reads binary frames as ArrayBuffers, and sends nothing until the session exists', () => {
    const h = startCompatible();
    expect(h.socket().url).toBe(compatibleUrl(h.config));
    expect(h.socket().protocols).toEqual(compatibleProtocols(KEY));
    expect(h.socket().binaryType).toBe('arraybuffer');
    h.socket().open('realtime');
    expect(h.sent()).toEqual([]);
    expect(h.frames('session.opened')).toEqual([{
      model: h.config.translateModel, modalities: h.config.modalities, voice: h.config.voice ?? null,
      turnDetection: h.config.turnDetection?.type ?? null, manual: false,
    }]);
  });

  it('configures the session once the server created it, framing what the server started with and what it was sent', () => {
    const h = startCompatible({ patch: { noiseReduction: 'Far field' } });
    h.socket().open('realtime');
    h.receive(SERVER.created());
    expect(h.sent()).toEqual([compatibleSessionUpdate(h.config)]);
    expect(h.frames('session.created')).toEqual([{ id: 'sess_1', model: 'qwen3-translate', expiresAt: 1_790_000_000 }]);
  });

  it('resolves only once the server confirms the configuration, over a websocket, emitting nothing but frames, with no timer left — and sends the first anchor', async () => {
    const h = startCompatible();
    let resolved = false;
    void h.starting.then(() => { resolved = true; });
    h.socket().open('realtime');
    h.receive(SERVER.created());
    await flush();
    expect(resolved).toBe(false);
    h.receive(SERVER.updated());
    const session = await h.starting;
    expect(session.info).toEqual({ transport: 'websocket' });
    expect(h.frames('session.updated')).toHaveLength(1);
    // The first anchor is sent.
    expect(h.sent()[1].type).toBe('response.create');
    expect(h.frames('response.anchor')).toEqual([{ eventId: 'sokuji_1', translations: 0 }]);
    expect(h.content()).toEqual([]);
    expect(h.timers()).toBe(0);
  });

  it.each([
    ['invalid_api_key', 'invalid_request_error', 'auth'],
    ['rate_limit_exceeded', 'invalid_request_error', 'rate_limit'],
    ['invalid_value', 'invalid_request_error', 'client'],
    [null, 'server_error', 'server'],
  ] as const)('an error (%s) before the configuration is confirmed rejects the start in the endpoint\'s words, as %s', async (code, type, expected) => {
    const h = startCompatible();
    h.socket().open('realtime');
    h.receive(SERVER.created(), SERVER.error({ type, code, message: 'The request was refused.' }));
    const error = await h.starting.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterStartError);
    expect(error).toMatchObject({ code: expected, message: `[the endpoint ${code ?? type}] The request was refused.` });
    expect(h.content()).toEqual([]);
    expect(h.timers()).toBe(0);
  });

  it('a socket that fails before it opens rejects as the network, in the endpoint\'s words', async () => {
    const h = startCompatible();
    h.socket().drop();
    await expect(h.starting).rejects.toMatchObject({ code: 'network', message: NEVER_OPENED });
    expect(h.content()).toEqual([]);
    expect(h.timers()).toBe(0);
  });

  it('a close after the socket opened, before the start, rejects as the service\'s at once', async () => {
    const h = startCompatible();
    h.socket().open('realtime');
    h.socket().serverClose(1008, 'policy');
    await expect(h.starting).rejects.toMatchObject({ code: 'server', message: 'The endpoint closed the connection before the session started (1008 policy).' });
    expect(h.frames('session.connection_lost')).toEqual([{ code: 1008, reason: 'policy' }]);
  });

  it('bounds the start: no confirmation within 30 s rejects — network when the socket never opened, server when it did — and closes the socket', async () => {
    const never = startCompatible();
    never.clock.advance(START_TIMEOUT_MS);
    await expect(never.starting).rejects.toMatchObject({ code: 'network', message: 'The endpoint did not open the connection within 30 s.' });
    expect(never.socket().closedByClient).not.toBeNull();
    expect(never.timers()).toBe(0);

    const silent = startCompatible();
    let settled = false;
    void silent.starting.catch(() => { settled = true; });
    silent.socket().open('realtime');
    silent.receive(SERVER.created());
    silent.clock.advance(START_TIMEOUT_MS - 1);
    await flush();
    expect(settled).toBe(false);
    silent.clock.advance(1);
    await expect(silent.starting).rejects.toMatchObject({ code: 'server', message: 'The endpoint did not start the session within 30 s.' });
    expect(silent.socket().closedByClient).not.toBeNull();
    expect(silent.timers()).toBe(0);
  });

  it('an abort while opening rejects with its reason, closes the socket and emits nothing; a start already aborted opens no socket', async () => {
    const h = startCompatible();
    h.socket().open('realtime');
    const reason = new Error('cancelled');
    h.controller.abort(reason);
    await expect(h.starting).rejects.toBe(reason);
    expect(h.socket().closedByClient).not.toBeNull();
    expect(h.content()).toEqual([]);
    expect(h.timers()).toBe(0);

    const sockets = fakeSockets();
    const controller = new AbortController();
    controller.abort(reason);
    const starting = createCompatibleAdapter({ openSocket: sockets.create }).start(
      { context: AUTO_CTX, config: configFor(), credentials: KEY, clock: createVirtualClock(0), signal: controller.signal },
      recordEvents().events,
    );
    await expect(starting).rejects.toBe(reason);
    expect(sockets.all).toEqual([]);
  });

  it('a browser that will not open the socket rejects the start in fixed words, never its own, which quote the key', async () => {
    const openSocket = (_url: string, protocols: string[]): WebSocket => {
      throw new DOMException(`Failed to construct 'WebSocket': The subprotocol '${protocols[1]}' is invalid.`, 'SyntaxError');
    };
    const run = async (adapter: ReturnType<typeof createCompatibleAdapter>) => {
      const { events, log } = recordEvents();
      const error = await adapter.start(
        { context: AUTO_CTX, config: configFor(), credentials: KEY, clock: createVirtualClock(0), signal: new AbortController().signal },
        events,
      ).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(AdapterStartError);
      expect(error).toMatchObject({ code: 'network', message: 'The browser would not open the socket (SyntaxError).' });
      for (const secret of SECRETS) expect((error as Error).message).not.toContain(secret);
      expect(log).toEqual([]);
    };
    await run(createCompatibleAdapter({ openSocket }));
    vi.stubGlobal('WebSocket', RefusingWebSocket);
    try {
      await run(createCompatibleAdapter());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the OpenAI Compatible adapter: audio, turns and typed text going up', () => {
  it('sends each chunk as it came, one append each, and frames none of them (the hot-path rule)', async () => {
    const h = await liveCompatible();
    for (let i = 0; i < 3; i++) h.session.appendAudio(chunk());
    expect(h.appended().map((p) => [p.length, p[0]])).toEqual([[2_048, 1_000], [2_048, 1_000], [2_048, 1_000]]);
    expect(h.of('frame').filter((f) => f.payload.direction === 'out').map((f) => f.payload.type)).toEqual(['session.opened', 'session.update', 'response.anchor']);
  });

  it('under manual turns a release with speech commits the press and asks its response at once', async () => {
    const h = await liveCompatible({ context: MANUAL_CTX });
    // turn_detection is omitted entirely when null (manual mode).
    const sessionUpdate = h.sent()[0] as { session: { audio: { input: Record<string, unknown> } } };
    expect(sessionUpdate.session.audio.input.turn_detection).toBeUndefined();
    h.session.beginTurn();
    h.session.appendAudio(chunk());
    h.session.endTurn();
    expect(h.said().slice(2)).toEqual([{ type: 'input_audio_buffer.commit' }, { type: 'response.create', event_id: 'sokuji_2', response: { metadata: { request: 'sokuji_2' } } }]);
    expect(h.frames('response.create')).toEqual([{ eventId: 'sokuji_2', for: 'turn', waitedMs: 0 }]);
  });

  it('under automatic turns the turn keys send nothing', async () => {
    const h = await liveCompatible();
    h.session.beginTurn();
    h.session.endTurn();
    h.session.cancelTurn();
    expect(h.said().map((m) => m.type)).toEqual(['session.update', 'response.create']);
  });

  it('a typed text shows at once as its own source, sends its item and asks its response', async () => {
    const h = await liveCompatible();
    h.session.appendText('  Hello there  ');
    expect(h.of('segmentOpened').map((e) => e.payload)).toEqual([{ ref: 1, side: 'source', origin: 'sokuji_text_2' }]);
    expect(h.of('segmentText').map((e) => e.payload)).toEqual([{ ref: 1, text: 'Hello there' }]);
    expect(h.of('segmentClosed').map((e) => e.payload)).toEqual([{ ref: 1 }]);
    expect(h.said().slice(2)).toEqual([
      { type: 'conversation.item.create', item: { id: 'sokuji_text_2', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello there' }] } },
      { type: 'response.create', event_id: 'sokuji_3', response: { metadata: { request: 'sokuji_3' } } },
    ]);
  });

  it('a release while a translation streams commits at once, and its response waits for that one\'s end: no request into an active response', async () => {
    const h = await liveCompatible({ context: MANUAL_CTX });
    h.receive(SERVER.responseCreated('resp_1'));
    h.session.beginTurn();
    h.session.appendAudio(chunk());
    h.session.endTurn();
    expect(h.said().slice(2).map((m) => m.type)).toEqual(['input_audio_buffer.commit']);
    expect(h.frames('response.queued')).toEqual([{ for: 'turn', waiting: 1 }]);
    h.clock.advance(1_200);
    h.receive(SERVER.responseDone('resp_1'));
    expect(h.said().slice(3)).toEqual([{ type: 'response.create', event_id: 'sokuji_2', response: { metadata: { request: 'sokuji_2' } } }]);
    expect(h.frames('response.create')).toEqual([{ eventId: 'sokuji_2', for: 'turn', waitedMs: 1_200 }]);
  });
});

describe('the OpenAI Compatible adapter: what comes down', () => {
  it('makes each input a source under its item id, streaming its transcript, and each translation a segment paired with the input it follows', async () => {
    const h = await liveCompatible();
    h.receive(SERVER.committed('item_in_1'), SERVER.itemAdded('item_in_1', 'user'), SERVER.inputDelta('item_in_1', '你好'), SERVER.inputDelta('item_in_1', '世界'));
    h.receive(SERVER.responseCreated('resp_1'), SERVER.outputItemAdded('resp_1', 'item_out_1'), SERVER.itemAdded('item_out_1', 'assistant', 'item_in_1'));
    h.receive(SERVER.transcriptDelta('resp_1', 'item_out_1', 'Hello'), SERVER.transcriptDelta('resp_1', 'item_out_1', ' world.'));
    h.receive(SERVER.inputDone('item_in_1', '你好世界'), SERVER.transcriptDone('resp_1', 'item_out_1', 'Hello world.'), SERVER.outputItemDone('resp_1', 'item_out_1'), SERVER.responseDone('resp_1'));
    expect(h.of('segmentOpened').map((e) => e.payload)).toEqual([{ ref: 1, side: 'source', origin: 'item_in_1' }, { ref: 2, side: 'translation', origin: 'item_in_1' }]);
    expect(h.of('segmentText').map((e) => e.payload)).toEqual([
      { ref: 1, text: '你好' }, { ref: 1, text: '你好世界' }, { ref: 2, text: 'Hello' }, { ref: 2, text: 'Hello world.' },
    ]);
    expect(h.of('segmentClosed').map((e) => e.payload)).toEqual([{ ref: 1 }, { ref: 2 }]);
  });

  it('re-sends the instructions out of band after every fifth completed translation, once per count', async () => {
    const h = await liveCompatible();
    expect(ANCHOR_EVERY).toBe(5);
    for (let n = 1; n <= 4; n++) h.receive(...exchange(n));
    h.receive(SERVER.responseCreated('resp_x'), SERVER.responseDone('resp_x', { status: 'cancelled' }));
    expect(h.frames('response.anchor')).toHaveLength(1);
    h.receive(...exchange(5));
    expect(h.frames('response.anchor')).toEqual([{ eventId: 'sokuji_1', translations: 0 }, { eventId: 'sokuji_2', translations: 5 }]);
  });

  it('is busy while an in-band response is in progress, and not for the anchor\'s', async () => {
    const h = await liveCompatible();
    h.receive(SERVER.responseCreated('resp_anchor', { outOfBand: true }), SERVER.responseDone('resp_anchor', { outOfBand: true }));
    expect(h.of('busy')).toEqual([]);
    h.receive(...exchange(1));
    expect(h.of('busy').map((e) => e.payload)).toEqual([true, false]);
  });
});

describe('the OpenAI Compatible adapter: failures and stop', () => {
  it('frames a mid-session error and runs on; a close within 10 s of it is worded as that error, a later one as the lost connection', async () => {
    expect(ERROR_WORDS_MS).toBe(10_000);
    const keyed = await liveCompatible();
    keyed.receive(SERVER.error({ code: 'invalid_api_key', message: 'Incorrect API key provided.' }));
    expect(keyed.frames('session.error')).toEqual([{ type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key provided.', param: null, eventId: null }]);
    expect(keyed.of('failed')).toEqual([]);
    keyed.receive(SERVER.committed('item_in_1'));
    expect(keyed.of('segmentOpened')).toHaveLength(1);
    keyed.clock.advance(ERROR_WORDS_MS);
    keyed.socket().serverClose(1008, '');
    await flush();
    expect(keyed.of('failed').map((e) => e.payload)).toEqual([{ code: 'auth', message: '[the endpoint invalid_api_key] Incorrect API key provided.' }]);
    expect(keyed.of('degraded')).toEqual([]);

    const stale = await liveCompatible();
    stale.receive(SERVER.error({ code: 'rate_limit_exceeded', message: 'Rate limit reached.' }));
    stale.clock.advance(ERROR_WORDS_MS + 1);
    stale.socket().serverClose(1006, '');
    await flush();
    expect(stale.of('failed').map((e) => e.payload)).toEqual([{ code: 'connection_lost', message: 'The connection to the endpoint closed (1006).' }]);
  });

  it('an unexpected close fails with connection_lost, once, and nothing reconnects', async () => {
    const h = await liveCompatible();
    h.socket().onerror?.call(h.socket(), new Event('error'));
    expect(h.frames('session.socket_error')).toHaveLength(1);
    expect(h.of('failed')).toEqual([]);
    h.socket().serverClose(1011, 'Internal error');
    await flush();
    expect(h.frames('session.connection_lost')).toEqual([{ code: 1011, reason: 'Internal error' }]);
    expect(h.of('failed').map((e) => e.payload)).toEqual([{ code: 'connection_lost', message: 'The connection to the endpoint closed (1011 Internal error).' }]);
    expect(h.sockets.all).toHaveLength(1);
    expect(h.timers()).toBe(0);
  });

  it('never frames, fails or degrades with the key or the subprotocol that carries it', async () => {
    const h = await liveCompatible({ context: MANUAL_CTX });
    h.receive(...exchange(1));
    h.session.beginTurn();
    h.session.appendAudio(chunk());
    h.session.endTurn();
    h.session.appendText('typed');
    h.receive('not a frame', SERVER.error({ code: 'invalid_api_key', message: 'Incorrect API key provided.' }));
    h.socket().onerror?.call(h.socket(), new Event('error'));
    h.socket().serverClose(1008, '');
    await flush();
    expect(h.of('failed')).toHaveLength(1);
    const everything = JSON.stringify(h.log.filter((e) => e.kind !== 'audio'));
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
  });

  it('stop closes the socket before it returns; nothing waits, goes up or follows, and no timer or listener is left', async () => {
    const h = startCompatible({ context: MANUAL_CTX });
    const removed = vi.spyOn(h.controller.signal, 'removeEventListener');
    h.socket().open('realtime');
    h.receive(SERVER.created(), SERVER.updated());
    const session = await h.starting;
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    h.receive(SERVER.responseCreated('resp_1'));
    session.appendText('waiting');
    const n = h.log.length;
    const sentBefore = h.sent().length;
    const socket = h.socket();
    const stopping = session.stop();
    expect(socket.closedByClient).toEqual({ code: 1000, reason: undefined });
    await stopping;
    expect([socket.onopen, socket.onmessage, socket.onerror, socket.onclose]).toEqual([null, null, null, null]);
    h.clock.advance(10_000);
    await flush();
    session.appendAudio(chunk());
    session.appendText('late');
    session.endTurn();
    expect(h.log.length).toBe(n);
    expect(h.sent()).toHaveLength(sentBefore);
    expect(h.timers()).toBe(0);
  });
});
