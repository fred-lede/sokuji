# sokuji OpenAI Compatible gateway — what your server MUST do

Derived from `src/providers/openai_compatible/{wire,adapter,config,settings}.ts` and
`src/providers/openai/{queue,items}.ts`, and **verified against a live gateway** on
2026-11-04. Verify your own with: `node tools/probe_sokuji.mjs <endpoint> <key>`.

## 1. Handshake

- URL: `ws://<endpoint>/v1/realtime?model=<translateModel>` (endpoint is normalised: trailing `/` and `/v1` stripped)
- Subprotocols offered by the client: `realtime`, `openai-insecure-api-key.<key>`
  → echo one back (or none). If the upgrade is refused the leg dies before any translation.
- Keep the socket open for the whole session. **The client has NO reconnect**: any close ends the run.
  The live gateway was measured holding the socket open for 75 s of silence, so a gateway
  that drops the socket is the gateway's own doing, not a client timeout.

## 2. Immediately after the upgrade the server must send

```json
{"type":"session.created","session":{}}
```
Without it the leg times out: "The endpoint did not start the session within Ns".

## 3. The client then sends `session.update` shaped like this

```json
{"type":"session.update","session":{
  "type":"realtime",
  "output_modalities":["audio"],
  "instructions":"<translation instructions>",
  "tool_choice":"none",
  "tools":[],
  "max_output_tokens":1024,
  "audio":{"input":{
     "transcription":{"model":"whisper-large-v3"},
     "turn_detection":{
        "type":"server_vad","create_response":true,"interrupt_response":false,
        "threshold":0.49,"prefix_padding_ms":500,"silence_duration_ms":500}}}}
}}
```

Gotchas:
- `turn_detection` is nested under `audio.input`, NOT the legacy top-level `session.turn_detection`.
- There is **no** `input_audio_format` field — audio is always PCM16 mono @ 24 kHz.
- `max_output_tokens` only appears when Max tokens != 'inf'.
- `audio.input.transcription` appears only when ASR is on.

The server must reply `{"type":"session.updated"}`; otherwise the leg never reaches `live` and **no audio is sent at all**.

## 4. Audio frames the client sends

```json
{"type":"input_audio_buffer.append","audio":"<base64 PCM16 mono 24 kHz>"}
```
One frame every 200 ms (24000 samples/s). **The client sends these in every mode.**

## 5. Turn detection — the server drives it (the live gateway fails here)

`sokuji`'s turn mode is one global setting (`settings.common.turnMode`):
`'auto'` (default), `'push-to-talk'`, `'push-to-translate'`. The last two are
**manual** turns to the adapter; `'auto'` is server VAD.

| mode | the client sends | the endpoint must do |
|---|---|---|
| `auto` (default) | `input_audio_buffer.append` **only** | detect the end of the turn, and **open a response itself** |
| `push-to-talk` / `push-to-translate` | `input_audio_buffer.commit` + `response.create` | answer the request |

Under `auto` the client's `endTurn` is a no-op (`adapter.ts`), so **nothing asks the
endpoint for a response**. The whole frame sequence of one automatic turn is:

```
out session.opened → in session.created → out session.update → in session.updated
→ out response.anchor → in response.created → in response.done
```

— no `out response.create` anywhere, and the leg reports no translation, no failure,
and no end: it simply sits there.

**Verified gap (2026-11-04, live gateway):** `speech_started` and `speech_stopped` were
answered with `unsupported event type`, and a server_vad session fed 4 s of speech-like
audio (2 s loud + 2 s quiet) produced **no event at all for 30 s**. The endpoint runs no
voice detection, so under the default turn mode it never translates anything.

**Either** implement VAD in the gateway — emit `speech_started`, `speech_stopped`,
`input_audio_buffer.committed`, `conversation.item.added` (role `user`), then open the
response yourself — **or** set the app's turn mode to push-to-talk.

## 6. A translation must be a full response lifecycle

```
response.created            { response: { id, metadata: { request: "<event_id of the create>" } } }
response.output_item.added  { response_id, output_index, item: { type: "message" } }
response.output_text.delta  { response_id, item_id, delta: "chunk" }   (one or more)
response.output_text.done   { response_id, item_id, text: "full text" }
response.output_item.done   { response_id, output_index, item }
response.done               { response: { id, status: "completed" } }
```

- `metadata.request` **must echo the `event_id` of the `response.create` that asked.**
  The client's queue clears its request only when the response names it back; without
  the echo the next request waits forever.
- Under `output_modalities: ["audio"]` the spoken text arrives as
  `response.output_audio_transcript.delta` / `.done` instead, with
  `response.output_audio.delta` / `.done` beside it. Send the transcript **or** the text,
  never both: the client appends each to the same segment, so both at once double the
  translation.
- `response.done` with `status:"completed"` is what increments the drift anchor counter.
  A `response.done` whose id never had deltas closes that leg (`segment_ended`).
- `response.done` needs no `output` array — the client reads the deltas.

## 7. The drift anchor (watch this one)

Right after `session.updated`, and then every 5 completed responses, the client sends:

```json
{"type":"response.create","event_id":"sokuji_N",
 "response":{"conversation":"none","output_modalities":["text"],
             "instructions":"<the leg's instructions>","metadata":{"purpose":"anchor"}}}
```

It is out of band: it must make no translation segment, and it must not take the slot
that holds one response at a time. The client recognises it by
`response.conversation_id === null` **or** `response.metadata.purpose === "anchor"` —
so echo **both** on the response, or at least one of them:

```json
{"type":"response.created","response":{"id":"resp_…","conversation_id":null,
                                       "metadata":{"purpose":"anchor"},"status":"in_progress"}}
```

Without that the client treats the anchor as a real turn: it counts it as a completed
translation with no text, and the leg fails. (The live gateway already does this right.)

## 8. Errors

- `session_expired` → treated as a clean end, **not** an error.
- any other `error` event → the matching queued request is refused; too many kills the leg.
- close code 1006 with no close frame → "connection closed: connection_lost".

**The refusal code matters.** A `response.create` refused because a response is still
active must carry the OpenAI code:

```json
{"type":"error","event_id":"<the create's event_id>",
 "error":{"type":"invalid_request_error","code":"conversation_already_has_active_response",
          "message":"a response is already in progress"}}
```

The client's queue re-queues **only** that code; any other code (including **no code
at all**, which is what the live gateway sent) drops the request on the floor, and that
turn is never translated. If the endpoint refuses without the code, put it in.

## 9. What the client does not need

- `input_audio_buffer.committed` is **not** what makes the client ask for a response —
  the commit itself is. The acknowledgement only tells the client the input item is
  done, so without it the source side of the turn stays empty.
- `conversation.item.added` (role `user`) and
  `conversation.item.input_audio_transcription.completed` are how the client learns
  **what was said**. Without them the translation arrives but the original never does.
- `conversation.item.added` (role `assistant`) is how the client pairs a translation
  with the turn it belongs to.
- The events `response.text.delta`, `response.text.done` and `conversation.item.created`
  are **not** OpenAI's names. The live gateway sends them beside the standard ones; the
  client logs them as `session.unknown` and ignores them — harmless, but half the
  bandwidth.

## Reference

- `tools/mock-realtime-gateway.mjs` is a ~120-line conforming implementation. Run it and
  point sokuji at `http://localhost:8090` to see the event stream a correct gateway produces.
- `src/providers/openai_compatible/multiturn.test.ts` — the mock gateway's contract, in
  tests: every turn answered, over one socket, under both content modalities.
- `src/providers/openai_compatible/autoTurn.test.ts` — the automatic-turn contract: the
  client asks for nothing, so the endpoint must end the turn itself.
- `src/providers/openai_compatible/gatewayContract.test.ts` — the same two contracts,
  run against a live endpoint (set `SOKUJI_ENDPOINT`, `SOKUJI_KEY`, `SOKUJI_MODEL`).
