/**
 * The one seam OpenAI Compatible's session side opens sockets through:
 * `new WebSocket(url, protocols)` in the app, a `FakeSocket` factory in
 * tests. The key rides in a subprotocol, which a browser sets itself, so
 * no upgrade header is needed and F14 is not this provider's.
 */
export type OpenSocket = (url: string, protocols: string[]) => WebSocket;

export { nativeSocket, WS_OPEN } from '../../lib/contract/socket';
