# Server-side voice detection for sokuji's OpenAI Compatible provider

sokuji's OpenAI Compatible provider speaks the Realtime protocol. Under the
default turn mode (`auto`) the client sends the audio and nothing else: it
does not ask for a response and it does not decide where a turn ends. The
endpoint has to hear the turn end and start the response itself.

This is what OpenAI, Gemini Live and Qwen Live all do. Their servers run a
voice detector, report where the speech was, and open the response. sokuji's
client is written against that contract and works with every one of them.

An endpoint that answers the audio with silence produces silence in return:
the leg stays open, reports no text, no failure and no busy, and the app
looks frozen after the first sentence.

## The frames a detector has to produce

In order, for one turn:

```
input_audio_buffer.speech_started
input_audio_buffer.speech_stopped
input_audio_buffer.committed
conversation.item.added            (role user)
response.created
response.output_item.added
conversation.item.added            (role assistant)
response.output_audio_transcript.delta   (or response.output_text.delta)
response.output_audio_transcript.done   (or response.output_text.done)
response.output_item.done
response.done
```

`speech_started` and `speech_stopped` carry the item id of the input. The
response that follows the detection names no request, because the client
never asked for one: a response with no `metadata.request` is the server's
own answer, and sokuji takes it as such.

Run the sequence to see it:

```
node tools/probe_reference_vad.mjs
```

## The reference implementation

`tools/reference_gateway/vad_gateway.py` is a working gateway that does
exactly this. It is small on purpose — the voice detection is the point,
not the model.

```
python3 tools/reference_gateway/vad_gateway.py --port 8091
SOKUJI_ENDPOINT=http://127.0.0.1:8091 SOKUJI_KEY=any SOKUJI_MODEL=reference-translate \
  npx vitest run src/providers/openai_compatible/gatewayContract.test.ts --maxWorkers=1
```

Both tests pass against it, the automatic one included.

### How it decides

The detector reads the audio in 20 ms windows and takes the loudness of
each. A window above `threshold` is speech; a run of quiet windows that
adds up to `silence_ms` ends the turn. A turn shorter than
`min_speech_ms` is a cough, not a sentence, and is dropped.

The quiet is counted in samples rather than in wall-clock time, so how the
client cuts its audio into buffers does not change what the detector hears.
A whole turn can arrive in one buffer, so the detector reports every event
it caused, in order.

```
--threshold 0.02      loudness above which audio counts as speech
--silence-ms 700      the quiet that ends a turn
--min-speech-ms 100   speech shorter than this is not a turn
```

For a better detector, run Silero VAD or Whisper's turn model over the same
stream; the frames stay the same. The values in sokuji's own VAD settings
(local inference) are a good starting point for the thresholds.

### Where the translation comes from

`Session.translate()` is where the model is called. Everything else in the
file is the protocol around it.

## The other half: the refusal

When a response is already running and another turn arrives, the endpoint
turns the turn away:

```json
{"type": "error",
 "error": {"type": "invalid_request_error",
           "code": "conversation_already_has_active_response",
           "message": "a response is already in progress"}}
```

The `code` is what makes the client try again. sokuji re-queues a turn
refused with that code and drops one refused without it, so a refusal
without a code loses the sentence.

## The frames an endpoint may leave out

| Frame | What happens without it |
| --- | --- |
| `input_audio_buffer.committed` | The translation still arrives; the source side (what was said) stays empty. |
| `conversation.item.added` (user) | The same: the source side stays empty. |
| `conversation.item.input_audio_transcription.completed` | The source side stays empty. |

They cost nothing to send and the app shows both sides of the exchange with
them.

## Manual turns

Under `push-to-talk` and `push-to-translate` the client commits the buffer
and asks for the response itself, and none of this is needed. The endpoint
only has to answer a `response.create`.

## Checking an endpoint

`tools/GATEWAY-CONTRACT.md` lists the whole contract. The live test in
`src/providers/openai_compatible/gatewayContract.test.ts` checks it against
a running endpoint:

```
SOKUJI_ENDPOINT=http://host:port SOKUJI_KEY=... SOKUJI_MODEL=... \
  npx vitest run src/providers/openai_compatible/gatewayContract.test.ts --maxWorkers=1
```

The automatic test sends a loud burst and then the quiet after it, and
waits for the endpoint to answer on its own. It says exactly which frames
arrived when it fails.
