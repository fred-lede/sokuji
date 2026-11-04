// The frame sequence under automatic turns, against the reference gateway.
// This is what a server-side voice detector has to produce.
import { WebSocket } from 'ws';

const url = process.argv[2] || 'ws://127.0.0.1:8091/v1/realtime?model=reference-translate';
const key = process.argv[3] || 'test-key';
const ws = new WebSocket(url, ['realtime', `openai-insecure-api-key.${key}`]);
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(2);

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      type: 'realtime', output_modalities: ['audio'], instructions: 'You translate.',
      tool_choice: 'none', tools: [], max_output_tokens: 1024,
      audio: {
        input: {
          transcription: { model: 'whisper-large-v3' },
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 200, create_response: true },
        },
        output: { voice: 'alloy' },
      },
    },
  }));

  setTimeout(() => {
    // A loud burst, then the quiet that ends it.
    const loud = new Int16Array(4800);
    for (let i = 0; i < loud.length; i += 1) loud[i] = Math.round(Math.sin((i / 48) * 2 * Math.PI) * 8000);
    const pcm = Buffer.concat([Buffer.from(loud.buffer), Buffer.alloc(24000 * 2)]);
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }));
    console.log(`[${at()}s] >> one turn of speech`);
  }, 600);
});

ws.on('message', (data) => {
  const raw = data.toString();
  let kind = '?';
  try {
    kind = JSON.parse(raw).type;
  } catch {}
  console.log(`[${at()}s] << ${kind}`);
});

ws.on('close', (code) => {
  console.log(`[${at()}s] closed ${code}`);
  process.exit(0);
});
setTimeout(() => process.exit(0), 12000);
