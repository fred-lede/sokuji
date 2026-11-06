#!/usr/bin/env python3
"""Reference server-side voice detection for sokuji's OpenAI Compatible provider.

sokuji's client, in automatic turns, sends the audio and then waits: it
never asks for a response itself. The endpoint has to hear where the
speaker stops and start the response. This file is that endpoint, in
about two hundred lines, so it can be read next to the real one.

    python3 tools/reference_gateway/vad_gateway.py --port 8090

Then point sokuji at http://localhost:8090 (without /v1).
"""
import argparse
import asyncio
import base64
import functools
import json
import math
import time
import uuid

import numpy as np
from websockets.asyncio.server import serve

SAMPLE_RATE = 24000


def rid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class EnergyVad:
    """Decides where a turn ends, from the loudness of the samples.

    A turn starts when the loudness crosses `threshold` and ends after
    `silence_ms` of quiet. `min_speech_ms` keeps a cough from becoming a
    turn, and `preroll_ms` of audio is kept before the turn so the first
    syllable is not cut off.
    """

    def __init__(self, threshold=0.02, silence_ms=700, min_speech_ms=100, preroll_ms=300):
        self.threshold = threshold
        self.silence_ms = silence_ms
        self.min_speech_ms = min_speech_ms
        self.preroll_ms = preroll_ms
        self.speaking = False
        self.speech_samples = 0
        self.silence_samples = 0
        self.preroll = []
        self.samples = 0

    def feed(self, pcm: bytes) -> list[str]:
        """Take one buffer of PCM16 samples. Returns the events it caused.

        The buffer is read in 20 ms windows, so how the client cuts its
        audio does not change what the detector hears. The quiet that ends
        a turn is counted in samples, not in wall-clock time: the length of
        the silence is the audio's, not the network's.

        A whole turn can arrive in one buffer, so this returns every event
        it caused, in order.
        """
        if not pcm:
            return []
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        window = int(SAMPLE_RATE * 0.02)
        events = []
        for start in range(0, samples.size, window):
            piece = samples[start:start + window]
            if piece.size == 0:
                break
            loud = float(np.sqrt(np.mean(np.square(piece))))
            event = self.step(piece.size, loud)
            if event:
                events.append(event)
        return events

    def step(self, count: int, loud: float) -> str | None:
        if not self.speaking:
            if loud >= self.threshold:
                self.speaking = True
                self.speech_samples = count
                self.silence_samples = 0
                return "start"
            keep = int(self.preroll_ms * SAMPLE_RATE / 1000)
            self.preroll.append(count)
            if sum(self.preroll) > keep:
                self.preroll.pop(0)
            return None

        if loud >= self.threshold:
            self.speech_samples += count
            self.silence_samples = 0
            return None

        self.silence_samples += count
        if self.silence_samples * 1000 / SAMPLE_RATE < self.silence_ms:
            return None
        spoken_ms = self.speech_samples * 1000 / SAMPLE_RATE
        self.speaking = False
        self.silence_samples = 0
        self.speech_samples = 0
        if spoken_ms < self.min_speech_ms:
            return None
        return "stop"


class Session:
    """One realtime session: the client's audio in, its translation out."""

    def __init__(self, ws, opts):
        self.ws = ws
        self.opts = opts
        self.vad = EnergyVad(
            threshold=opts.threshold,
            silence_ms=opts.silence_ms,
            min_speech_ms=opts.min_speech_ms,
        )
        self.session_id = rid("realtime")
        self.conversation_id = rid("conv")
        self.output_modalities = ["audio"]
        self.busy = False
        self.turn = 0
        self.text = ""

    async def send(self, obj):
        await self.ws.send(json.dumps(obj))

    async def session_created(self):
        await self.send({
            "type": "session.created",
            "session": {
                "id": self.session_id,
                "object": "realtime.session",
                "model": self.opts.model,
                "output_modalities": self.output_modalities,
            },
        })

    async def refuse(self, message, code="conversation_already_has_active_response"):
        """Turn the client away without dropping the turn.

        The code is what tells the client to try again: sokuji re-queues a
        turn refused with this code and drops one refused without it.
        """
        await self.send({
            "type": "error",
            "error": {"type": "invalid_request_error", "code": code, "message": message},
        })

    async def anchor(self, request_id):
        """A drift anchor asks the model for nothing. Answer out of band."""
        response_id = rid("resp")
        await self.send({
            "type": "response.created",
            "response": {
                "id": response_id,
                "conversation_id": None,
                "metadata": {"purpose": "anchor", "request": request_id},
                "status": "in_progress",
            },
        })
        await self.send({
            "type": "response.done",
            "response": {
                "id": response_id,
                "conversation_id": None,
                "metadata": {"purpose": "anchor", "request": request_id},
                "status": "completed",
            },
        })

    async def respond(self, request_id, source_text=None):
        """Answer one turn: the input item, the response, the translation."""
        if self.busy:
            await self.refuse("a response is already in progress")
            return
        self.busy = True
        try:
            self.turn += 1
            input_id = f"item_in_{self.turn}"
            output_id = f"item_out_{self.turn}"
            response_id = rid("resp")
            translation = self.translate(source_text or f"turn {self.turn}")

            await self.send({
                "type": "conversation.item.added",
                "previous_item_id": None,
                "item": {"id": input_id, "object": "realtime.item", "type": "message",
                         "role": "user", "status": "completed", "content": []},
            })
            await self.send({
                "type": "response.created",
                "response": {"id": response_id, "object": "realtime.response", "status": "in_progress",
                             "status_details": None, "output": [], "conversation_id": self.conversation_id,
                             "metadata": {"request": request_id} if request_id else None},
            })
            await self.send({
                "type": "response.output_item.added",
                "response_id": response_id, "output_index": 0,
                "item": {"id": output_id, "object": "realtime.item", "type": "message",
                         "role": "assistant", "status": "in_progress", "content": []},
            })
            await self.send({
                "type": "conversation.item.added",
                "previous_item_id": input_id,
                "item": {"id": output_id, "object": "realtime.item", "type": "message",
                         "role": "assistant", "status": "in_progress", "content": []},
            })

            # The translation itself. One kind of text, so the client can
            # read it; a real gateway calls the model here.
            if "audio" in self.output_modalities:
                await self.send({"type": "response.output_audio_transcript.delta",
                                 "response_id": response_id, "item_id": output_id,
                                 "output_index": 0, "content_index": 0, "delta": translation})
                await self.send({"type": "response.output_audio_transcript.done",
                                 "response_id": response_id, "item_id": output_id,
                                 "output_index": 0, "content_index": 0, "transcript": translation})
            else:
                await self.send({"type": "response.output_text.delta",
                                 "response_id": response_id, "item_id": output_id,
                                 "output_index": 0, "content_index": 0, "delta": translation})
                await self.send({"type": "response.output_text.done",
                                 "response_id": response_id, "item_id": output_id,
                                 "output_index": 0, "content_index": 0, "text": translation})
            await self.send({"type": "response.output_item.done", "response_id": response_id,
                             "output_index": 0,
                             "item": {"id": output_id, "object": "realtime.item", "type": "message",
                                      "role": "assistant", "status": "completed", "content": []}})
            await self.send({
                "type": "response.done",
                "response": {"id": response_id, "object": "realtime.response", "status": "completed",
                             "status_details": None, "output": [], "conversation_id": self.conversation_id,
                             "metadata": {"request": request_id} if request_id else None,
                             "usage": {"total_tokens": 1200, "input_tokens": 1000, "output_tokens": 200}},
            })
        finally:
            self.busy = False

    def translate(self, source_text: str) -> str:
        """What the model says. A real gateway calls it here."""
        self.text = source_text
        return f"[translated] {source_text}"

    async def handle(self, msg):
        kind = msg.get("type")
        if kind == "session.update":
            session = msg.get("session") or {}
            modalities = session.get("output_modalities")
            if isinstance(modalities, list) and modalities:
                self.output_modalities = modalities
            await self.send({"type": "session.updated", "session": {
                "id": self.session_id, "object": "realtime.session", "model": self.opts.model,
                "output_modalities": self.output_modalities, "instructions": session.get("instructions", ""),
            }})
        elif kind == "input_audio_buffer.append":
            await self.on_audio(msg.get("audio", ""))
        elif kind == "input_audio_buffer.commit":
            await self.on_commit()
        elif kind == "response.create":
            await self.on_response_create(msg.get("response") or {})
        elif kind == "input_audio_buffer.clear":
            self.vad = EnergyVad(threshold=self.opts.threshold, silence_ms=self.opts.silence_ms,
                                  min_speech_ms=self.opts.min_speech_ms)

    async def on_audio(self, audio_b64: str):
        """The client's voice. The VAD here is the whole point of this file."""
        try:
            pcm = base64.b64decode(audio_b64)
        except Exception:
            return
        for event in self.vad.feed(pcm):
            if event == "start":
                item_id = f"item_in_{self.turn + 1}"
                self.item_id = item_id
                await self.send({"type": "input_audio_buffer.speech_started",
                                 "item_id": item_id, "audio_start_ms": 0})
            elif event == "stop":
                item_id = getattr(self, "item_id", f"item_in_{self.turn + 1}")
                await self.send({"type": "input_audio_buffer.speech_stopped",
                                 "item_id": item_id, "audio_end_ms": 0})
                await self.send({"type": "input_audio_buffer.committed",
                                 "item_id": item_id, "previous_item_id": None})
                # The server's own detection ends the turn, so the server also
                # starts the response. The client never asked for one.
                await self.respond(None)

    async def on_commit(self):
        item_id = getattr(self, "item_id", f"item_in_{self.turn + 1}")
        await self.send({"type": "input_audio_buffer.committed",
                         "item_id": item_id, "previous_item_id": None})
        self.committed_item = item_id

    async def on_response_create(self, response: dict):
        metadata = response.get("metadata") or {}
        request_id = metadata.get("request")
        purpose = metadata.get("purpose")
        if purpose == "anchor" or response.get("conversation") == "none":
            await self.anchor(request_id)
            return
        await self.respond(request_id)


async def handler(ws, opts):
    session = Session(ws, opts)
    await session.session_created()
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if not isinstance(msg, dict):
            continue
        try:
            await session.handle(msg)
        except Exception as exc:  # never take the session down for one frame
            print(f"[gateway] {msg.get('type')}: {exc}")


def select_subprotocol(connection, subprotocols):
    for wanted in subprotocols:
        if wanted == "realtime" or wanted.startswith("openai-insecure-api-key."):
            return wanted
    return None


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--model", default="reference-translate")
    parser.add_argument("--threshold", type=float, default=0.02,
                        help="RMS above which the audio counts as speech")
    parser.add_argument("--silence-ms", type=int, default=700,
                        help="quiet that ends a turn")
    parser.add_argument("--min-speech-ms", type=int, default=200,
                        help="speech shorter than this is not a turn")
    opts = parser.parse_args()
    async with serve(functools.partial(handler, opts=opts), opts.host, opts.port,
                     select_subprotocol=select_subprotocol,
                     subprotocols=["realtime"]):
        print(f"[gateway] ws://{opts.host}:{opts.port}/v1/realtime", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
