/*
  Reference mock of the OpenAI Realtime protocol that sokuji's
  openai_compatible provider expects. Run it, then point sokuji at
  http://localhost:8090  (endpoint WITHOUT /v1) to compare event
  sequences with your own gateway.

  node tools/mock-realtime-gateway.mjs
*/
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8090);
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'sokuji-asr' }, { id: 'sokuji-translate' }] }));
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.on('upgrade', (req, socket, body) => {
  const key = (req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
  const accept = key[0];
  const acceptHeader = crypto.createHash('sha1').update((req.headers['sec-websocket-key'] || '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: ' + accept + '\r\nSec-WebSocket-Accept: ' + acceptHeader + '\r\n\r\n');
  if (body && body.length) socket.write(body); // ignore stray post-upgrade bytes

  let buf = Buffer.alloc(0);
  let sessionId = 'mock_' + Math.random().toString(36).slice(2, 10);
  let frames = 0;

  const send = obj => {
    const p = Buffer.from(JSON.stringify(obj));
    const len = p.length;
    let head;
    if (len < 126) head = Buffer.from([0x81, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0]=0x81; head[1]=126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0]=0x81; head[1]=127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    socket.write(Buffer.concat([head, p]));
  };

  const emitResponse = (requestId, text) => {
    const respId = 'resp_' + Math.random().toString(36).slice(2, 8);
    send({ type: 'response.created', response: { id: respId, metadata: { request: requestId } } });
    send({ type: 'response.output_item.added', response_id: respId, output_index: 0, item: { type: 'message', role: 'assistant' } });
    send({ type: 'response.output_text.delta', response_id: respId, item_id: 'item_0', index: 0, delta: text });
    send({ type: 'response.output_text.done', response_id: respId, item_id: 'item_0', index: 0, text });
    send({ type: 'response.output_item.done', response_id: respId, output_index: 0, item: { type: 'message', role: 'assistant', content: [{ type: 'text', text }] } });
    send({ type: 'response.done', response: { id: respId, status: 'completed', metadata: { request: requestId } } });
  };

  send({ type: 'session.created', session: { id: sessionId, object: 'realtime.session' } });

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      let masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { len = buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { len = Number(buf.readUInt32BE(off + 4)); off += 8; }
      let mask = null;
      if (masked) { mask = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) break;
      let payload = buf.slice(off, off + len);
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.slice(off + len);
      if (op === 8) { socket.end(); return; }
      if (op !== 1) continue;
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch (e) { continue; }

      if (msg.type === 'session.update') {
        send({ type: 'session.updated', session: msg.session });
      } else if (msg.type === 'input_audio_buffer.append') {
        frames++;
        if (frames === 1) send({ type: 'input_audio_buffer.speech_started', audio_start: frames * 100 });
        if (frames === 5) {
          send({ type: 'input_audio_buffer.speech_stopped', audio_end: frames * 100 });
          send({ type: 'input_audio_buffer.committed', item_id: 'item_in_1' });
          emitResponse(null, 'hello from mock (server VAD auto response)');
        }
      } else if (msg.type === 'input_audio_buffer.commit') {
        emitResponse(null, 'hello from mock (manual commit)');
      } else if (msg.type === 'response.create') {
        const request = msg.response && msg.response.metadata ? msg.response.metadata.request : null;
        emitResponse(request, 'hello from mock (response.create)');
      }
    }
  });

  socket.on('close', () => console.log('[mock] socket closed'));
  console.log('[mock] client connected, subprotocol:', accept);
});

server.listen(PORT, () => console.log('mock realtime gateway on ws://localhost:' + PORT + '/v1/realtime'));
