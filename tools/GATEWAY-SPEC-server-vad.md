# Spec: server-side voice detection for sokuji's OpenAI Compatible provider

> **摘要（給人看的）**：sokuji 的 OpenAI Compatible provider 在預設的 auto 模式下，
> client 只送音訊、**不送** `response.create`，完全依賴 server 自己偵測語音結束並
> 發起 response。目前 gateway 缺這個能力，所以整個 leg 靜默無輸出。
> 本 spec 描述要補的行為、幀序列、偵測參數與驗收方式。附一份可跑的參考實作。

**Audience:** an agent (or engineer) implementing this on the gateway host.
This document is self-contained: it assumes no knowledge of sokuji's source.

**Status of the gateway today:** the protocol handshake, the session frames,
the manual-turn path and the anchor all work. What is missing is the voice
detection. Do not rewrite what already works — see "Do not change" below.

**Severity:** with this missing, the app shows no translation, no error and
no busy state. The leg simply stays silent after the first sentence.

---

## 1. What the client does

The client is sokuji's OpenAI Compatible provider. It speaks the OpenAI
Realtime protocol over one WebSocket for the whole session.

Under the default turn mode (`auto`) the client:

- sends `input_audio_buffer.append` with every chunk of audio, as it comes
- **never** sends `input_audio_buffer.commit`
- **never** sends `response.create` for a spoken turn
- waits for the endpoint to detect the end of the turn and to begin the
  response itself

Under `push-to-talk` and `push-to-translate` the client instead sends
`input_audio_buffer.commit` and then `response.create`, and the endpoint
only has to answer. That path already works today.

So the endpoint has to serve both: answer a `response.create` when one
arrives, and — the work in this spec — detect the end of a spoken turn and
answer it without being asked.

This is the same contract OpenAI Realtime, Gemini Live and Qwen Live all
follow. Their servers run the detector and open the response.

## 2. The handshake

- **URL**: `ws://HOST:PORT/v1/realtime?model=MODEL` (`wss://` for TLS).
  `MODEL` is URL-encoded by the client. The path is exactly `/v1/realtime`.
- **Authentication**: the API key arrives in the WebSocket subprotocol, not
  in the query and not in a header:

  ```
  Sec-WebSocket-Protocol: realtime, openai-insecure-api-key.<KEY>
  ```

  The server must echo back one of the offered subprotocols — `realtime` is
  the right one to pick. Read the key from the `openai-insecure-api-key.`
  subprotocol.

  **Note:** an earlier build of the client also put `api_key` in the URL
  query. The current build does not. Read the key from the subprotocol,
  and accept `api_key` from the query as a fallback if it is there, so
  the endpoint works with both client builds. The query key is not
  required and should not be.

## 3. The audio

`input_audio_buffer.append` carries:

```json
{"type": "input_audio_buffer.append", "audio": "<base64>"}
```

The bytes are **PCM16, 24 000 Hz, mono, little-endian**. Each buffer holds
whatever the client had at that moment — anywhere from 20 ms to a second of
audio. Do not assume a fixed frame size.

## 4. The frames to send

### 4.1 On connect

```json
{"type": "session.created",
 "session": {"id": "realtime_...", "object": "realtime.session",
             "model": "MODEL", "output_modalities": ["audio"]}}
```

### 4.2 On `session.update`

Echo the session back. The client's payload carries `output_modalities`,
`instructions`, `max_output_tokens`, `tool_choice`, `tools` and
`audio.input.turn_detection`:

```json
{"type": "session.updated", "session": { ...the session the client sent... }}
```

Read `output_modalities` from it: when it contains `"audio"` the
translation is reported as an audio transcript, otherwise as plain text
(section 5.4).

### 4.3 When the detector finds the end of a turn

In this order:

```
input_audio_buffer.speech_started
input_audio_buffer.speech_stopped
input_audio_buffer.committed
conversation.item.added          (role user)
response.created
response.output_item.added
conversation.item.added          (role assistant)
response.output_audio_transcript.delta     (or response.output_text.delta)
response.output_audio_transcript.done     (or response.output_text.done)
response.output_item.done
response.done
```

`input_audio_buffer.speech_started` and `input_audio_buffer.speech_stopped`
carry the item id of the input, so they can be sent the moment the
detector knows it:

```json
{"type": "input_audio_buffer.speech_started", "item_id": "item_in_1", "audio_start_ms": 0}
{"type": "input_audio_buffer.speech_stopped",  "item_id": "item_in_1", "audio_end_ms": 0}
{"type": "input_audio_buffer.committed", "item_id": "item_in_1", "previous_item_id": null}
```

### 4.4 The response

```json
{"type": "conversation.item.added", "previous_item_id": null,
 "item": {"id": "item_in_1", "object": "realtime.item", "type": "message",
          "role": "user", "status": "completed", "content": []}}

{"type": "response.created",
 "response": {"id": "resp_...", "object": "realtime.response", "status": "in_progress",
              "status_details": null, "output": [], "conversation_id": "conv_...",
              "metadata": null}}

{"type": "response.output_item.added", "response_id": "resp_...", "output_index": 0,
 "item": {"id": "item_out_1", "object": "realtime.item", "type": "message",
          "role": "assistant", "status": "in_progress", "content": []}}

{"type": "conversation.item.added", "previous_item_id": "item_in_1",
 "item": {"id": "item_out_1", "object": "realtime.item", "type": "message",
          "role": "assistant", "status": "in_progress", "content": []}}
```

Then the translation itself. When `output_modalities` contains `"audio"`:

```json
{"type": "response.output_audio_transcript.delta",
 "response_id": "resp_...", "item_id": "item_out_1",
 "output_index": 0, "content_index": 0, "delta": "the translation"}
{"type": "response.output_audio_transcript.done",
 "response_id": "resp_...", "item_id": "item_out_1",
 "output_index": 0, "content_index": 0, "transcript": "the translation"}
```

When it does not, use `response.output_text.delta` (field `delta`) and
`response.output_text.done` (field `text`) instead.

**Send exactly one of the two forms.** The client appends both to the same
buffer, so sending text and audio transcript frames together duplicates the
translation.

**`metadata` is `null` for a response the server opened by itself.** The
client reads a response with no `metadata.request` as the server's own
answer to the turn it just heard. When the client asked for the response
(section 5.3), `metadata` is `{"request": "<the event id it sent>"}`.

And the ends:

```json
{"type": "response.output_item.done", "response_id": "resp_...", "output_index": 0,
 "item": {"id": "item_out_1", "object": "realtime.item", "type": "message",
          "role": "assistant", "status": "completed", "content": []}}

{"type": "response.done",
 "response": {"id": "resp_...", "object": "realtime.response", "status": "completed",
              "status_details": null, "output": [], "conversation_id": "conv_...",
              "metadata": null,
              "usage": {"total_tokens": 1200, "input_tokens": 1000, "output_tokens": 200}}}
```

The `response.done` frame is what ends the turn on the client. Without it
the client waits for the next turn forever.

## 5. The rules that are easy to get wrong

### 5.1 The request id

A `response.create` from the client looks like:

```json
{"type": "response.create", "event_id": "sokuji_3",
 "response": {"metadata": {"request": "sokuji_3"}}}
```

The event id is in **two** places: `event_id` at the top level, and
`response.metadata.request`. The client matches on
`response.metadata.request`. **Echo that value back in the `metadata` of
`response.created` and `response.done`.**

If the client never sees its own request id come back, its request queue
never clears and the next turn is never asked for. This is the single most
important detail in the manual-turn path.

### 5.2 The anchor

Every so often the client sends an anchor: a `response.create` that asks for
nothing, to keep the conversation from drifting.

```json
{"type": "response.create", "event_id": "sokuji_anchor_1",
 "response": {"conversation": "none", "output_modalities": ["text"],
              "metadata": {"purpose": "anchor"}}}
```

Answer it out of band — with no text at all:

```json
{"type": "response.created",
 "response": {"id": "resp_...", "object": "realtime.response", "status": "in_progress",
              "status_details": null, "output": [], "conversation_id": null,
              "metadata": {"purpose": "anchor"}}}
{"type": "response.done",
 "response": {"id": "resp_...", "object": "realtime.response", "status": "completed",
              "status_details": null, "output": [], "conversation_id": null,
              "metadata": {"purpose": "anchor"}}}
```

`conversation_id: null` and `metadata.purpose: "anchor"` are what mark it
out of band. A response that is not marked out of band is counted as a
translation turn and will show up as an empty segment in the app.

**This already works on the gateway today.** Keep it exactly as it is.

### 5.3 The refusal

While a response is running, another turn may arrive. Turn it away with:

```json
{"type": "error",
 "error": {"type": "invalid_request_error",
           "code": "conversation_already_has_active_response",
           "message": "a response is already in progress"}}
```

**The `code` field is what makes the client try again.** The client
re-queues a turn refused with that code and drops one refused without it,
so a refusal with no `code` loses the sentence.

The gateway currently sends the message with no `code`. Adding the code is
part of this work.

Note the consequence for the voice path: a turn the detector found while
another response was running is refused with this frame, and the client
re-asks for it when the running response finishes. That is the correct
behaviour — do not silently drop it, and do not queue it on the server if
the client can re-ask.

### 5.4 One response at a time

The gateway's model call is slow (about 17 seconds for one response). A
second turn that arrives during it is refused as above. The client waits
for the running response, then asks again. The client queues one turn at a
time and sends it again on its own; the server does not have to hold a
queue of its own.

## 6. The voice detector

This is the part to write.

### 6.1 What it has to decide

- **Speech has started** — the client may be told, but it is optional
  (section 7). Send it anyway: it is what a client shows as "hearing you".
- **The turn has ended** — after this the server opens the response.

### 6.2 How to decide

A plain loudness detector is enough to start. Read the incoming audio in
**20 ms windows** (480 samples at 24 kHz) and take the RMS of each:

- a window whose loudness is above the threshold is speech
- a run of quiet windows that adds up to `silence_ms` ends the turn
- a turn shorter than `min_speech_ms` is a cough, not a sentence: drop it

**Count the quiet in samples, not in wall-clock time.** The length of the
silence is the audio's, not the network's, and it does not depend on how
the client cuts its buffers.

**A whole turn can arrive in one buffer.** Process the whole buffer and
report every event it caused, in order — do not stop at the first one.

For a better detector, run Silero VAD or a Whisper turn model over the
same stream. The frames above stay exactly the same; only the decision
changes.

### 6.3 Parameters to start with

These are the values the sokuji app itself uses for its own local voice
detection, so the two feel the same to a user:

| Parameter | Start with | Meaning |
|---|---|---|
| `threshold` | 0.30 | loudness above which a window counts as speech |
| `negative_threshold` | auto | quiet threshold, below `threshold`; hysteresis keeps it from chattering |
| `min_silence_duration` | 1.40 s | quiet that ends a turn |
| `min_speech_duration` | 0.40 s | speech shorter than this is dropped |
| `pre_speech_pad` | 0.80 s | audio kept before the speech was noticed |
| `max_speech_duration` | 30 s | a turn longer than this is cut |
| `check_after` | 0.30 s | how long to wait before a smarter decision |
| `smart_turn_threshold` | 0.50 | confidence the smarter detector needs |

The absolute loudness threshold depends on the loudness of the audio the
user speaks into their microphone and on the gain the client applies. If
the detector never fires, lower `threshold`; if it fires on every breath,
raise it. The reference implementation in section 10 uses 0.02 on
normalised samples, which is roughly the same rule at a different scale.

### 6.4 The transcript

The client needs the text of what was said to show the original beside the
translation. Two ways to give it:

- **Ask your model to transcribe as well as translate**, and send that as
  the transcript (section 7, `conversation.item.input_audio_transcription.completed`).
- **Run a separate ASR** over the same audio.

The gateway currently sends neither, so the original column stays empty.
This is worth fixing, but it is not what makes the app go quiet — do it
after the detector works.

## 7. Optional frames

The client works without these. Send them if you can; they improve the
app.

| Frame | What it buys |
|---|---|
| `input_audio_buffer.speech_started` | the app can show "hearing you" |
| `input_audio_buffer.committed` | the client marks the input item as done |
| `conversation.item.added` (role `user`) | the client pairs the input with the output |
| `conversation.item.input_audio_transcription.completed` | the original text beside the translation |
| `input_audio_buffer.clear` | clears the input buffer; the client sends this before a manual turn |

Note that `input_audio_buffer.committed` is **not** what makes the client
ask for a response. The client asks when the turn ends, not when the
server acknowledges the commit. The acknowledgement only tells the client
the input item is finished.

## 8. What not to change

These already work on the gateway. They were checked against the live
endpoint and against the client, and breaking them costs more than it
gains.

| Keep | Why |
|---|---|
| The `openai-insecure-api-key.<key>` subprotocol | the key is **not** in the URL query any more; the client was changed to keep it out of proxy and access logs. Read the key from the subprotocol, and take a query `api_key` as a fallback for older client builds. |
| The URL path `/v1/realtime` and the `model` query parameter | that is the path the client dials |
| `conversation_id: null` + `metadata.purpose: "anchor"` on the anchor | marks it out of band; without it the anchor is counted as an empty translation turn |
| Echoing `response.metadata.request` in `response.created` and `response.done` | the client's request queue only clears when it sees its own id back |
| The `response.done` frame | it is what ends the turn on the client |
| The endpoint not closing the connection | the client has no reconnect logic; a closed socket ends the run |
| `session.created` and `session.updated` | the client waits for them before it considers the session open |

The gateway also sends `response.text.delta` and `response.text.done`,
which are not part of the protocol, and a `conversation.item.created` the
client does not use. They are harmless. Leave them alone unless there is
a reason to remove them.

## 9. How to know it works

### 9.1 The client's own test

The sokuji repository has a live contract test. From the repository root:

```sh
SOKUJI_ENDPOINT=http://YOUR_HOST:YOUR_PORT \
SOKUJI_KEY=YOUR_KEY \
SOKUJI_MODEL=YOUR_MODEL \
npx vitest run src/providers/openai_compatible/gatewayContract.test.ts --maxWorkers=1
```

Two tests:

- `answers every turn over one socket` — the manual path. **This passes
  today.**
- `ends the turn by itself under automatic turns` — the automatic path.
  **This fails today and must pass after this work.**

The second test sends a loud burst followed by a second of quiet, then
waits for the endpoint to end the turn and answer on its own. It prints
the frames it saw when it fails:

```
timed out waiting for the endpoint to answer: answered=0
frames=["out session.opened","in session.created","out session.update",
"in session.updated","out response.anchor","in response.created","in response.done"]
```

A passing run has no `out response.create` in it — under automatic turns
the client never asks for a response. The endpoint has to.

### 9.2 Watching the frames

To see the exchange directly, run the reference gateway and the probe
beside it:

```sh
python3 tools/reference_gateway/vad_gateway.py --port 8091
node tools/probe_reference_vad.mjs
```

A working automatic turn looks like this, in this order:

```
out session.opened
in  session.created
out session.update
in  session.updated
out response.anchor
in  response.created
in  response.done
in  input_audio_buffer.speech_started
in  input_audio_buffer.speech_stopped
in  input_audio_buffer.committed
in  conversation.item.added
in  response.created
in  response.output_item.added
in  conversation.item.added
in  response.output_audio_transcript.delta
in  response.output_audio_transcript.done
in  response.output_item.done
in  response.done
```

### 9.3 The symptoms, before and after

Before, with the client in automatic mode:

- the app shows no translation, no error, and no failure — the turn is
  simply silent
- the endpoint receives `input_audio_buffer.append` and then nothing
- the endpoint sees no `response.create` from the client, because the
  client never sends one in automatic mode

After:

- the endpoint detects the end of the turn and starts the response itself
- the translation appears in the app

## 10. Reference implementation

A working implementation is in the sokuji repository, in Python:

- `tools/reference_gateway/vad_gateway.py` — the endpoint, with the voice
  detector, the frames, the anchor and the refusal
- `tools/SERVER-SIDE-VAD.md` — the same ground in prose
- `tools/probe_reference_vad.mjs` — prints the frame exchange

It is a reference, not a drop-in: it answers with a fixed string instead
of calling a model. Port the detector and the frame handling into the
real gateway and keep the real translation call.

The detector in it is about 60 lines. It reads the audio in 20 ms
windows, counts the loud ones as speech and the quiet ones as silence,
and reports a turn that starts and a turn that ends.

## 11. Work list

1. Read the key from the `openai-insecure-api-key` subprotocol (and from a
   query `api_key` if an older client sends one).
2. Add the voice detector over the incoming audio (section 6).
3. On a detected turn end: send `input_audio_buffer.speech_stopped`, then
   `input_audio_buffer.committed`, then run the response yourself.
4. Echo `response.metadata.request` when the client asked (section 5.1).
5. Add `code: "conversation_already_has_active_response"` to the refusal
   (section 5.3).
6. Keep the anchor out of band (section 5.2).
7. Send the user's transcript if the model gives one (section 6.4).
8. Run the live contract test (section 9.1) until both tests pass.

Steps 1, 2, 3 and 8 are the ones that make the app work. Steps 4, 5 and
6 make it work under load and in the long run. Step 7 is polish.

## 12. Summary for the reader

The client keeps one socket open for the whole run and, in its automatic
mode, does nothing but send the microphone's audio. It never asks for a
translation. The endpoint has to hear where the turn ends and start the
response itself — that is what the OpenAI Realtime server does, and what
this endpoint must do too.
