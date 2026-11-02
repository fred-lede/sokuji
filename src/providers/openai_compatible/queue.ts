/**
 * The in-band responses one leg asks for — copied from `openai/queue.ts`
 * without its OpenAI-specific comment context. The queue's rules are
 * protocol-generic: a released press's `response.create` and each typed
 * text wait, first in first out, while a response is in progress, and
 * go up one at a time. Pure; the clock serves the frames' `waitedMs` alone.
 */
import type { Clock } from '../../lib/contract/clock';

/** The refusal of a `response.create` sent while a response is still active. */
export const ACTIVE_RESPONSE = 'conversation_already_has_active_response';

export type Request = { kind: 'turn' } | { kind: 'text'; itemId: string; text: string };

export interface QueueSink {
  send(request: Request, eventId: string, waitedMs: number, merged: number): void;
  queued(request: Request, waiting: number): void;
}

export interface QueueOptions {
  clock: Pick<Clock, 'now'>;
  sink: QueueSink;
  eventId(): string;
}

interface Waiting {
  request: Request;
  at: number;
  merged: ReadonlyArray<{ request: Request; at: number }>;
}

export class ResponseQueue {
  private readonly waiting: Waiting[] = [];
  private active: string | null = null;
  private asked: (Waiting & { eventId: string }) | null = null;
  private stopped = false;

  constructor(private readonly o: QueueOptions) {}

  get busy(): boolean {
    return this.active !== null || this.asked !== null;
  }

  push(request: Request): void {
    if (this.stopped) return;
    this.waiting.push({ request, at: this.o.clock.now(), merged: [] });
    if (this.busy) this.o.sink.queued(request, this.waiting.length);
    this.flush();
  }

  created(responseId: string, request: string | undefined): void {
    this.active = responseId;
    if (request !== undefined && request === this.asked?.eventId) this.asked = null;
  }

  done(responseId: string): void {
    if (this.active === responseId) this.active = null;
    this.asked = null;
    this.flush();
  }

  refused(eventId: string | null | undefined, code: string | null | undefined): void {
    const asked = this.asked;
    if (!asked || (eventId && eventId !== asked.eventId)) return;
    this.asked = null;
    if (eventId === asked.eventId && code === ACTIVE_RESPONSE) {
      this.waiting.unshift({ request: asked.request, at: asked.at, merged: asked.merged });
    } else if (eventId === asked.eventId && asked.merged.length > 0) {
      const [first, ...rest] = asked.merged;
      this.waiting.unshift({ request: first.request, at: first.at, merged: rest });
    }
    this.flush();
  }

  stop(): void {
    this.stopped = true;
    this.waiting.length = 0;
  }

  private flush(): void {
    if (this.stopped || this.busy) return;
    const next = this.waiting.shift();
    if (!next) return;
    const merged = [...next.merged];
    for (let i = 0; i < this.waiting.length; ) {
      const w = this.waiting[i];
      if (w.request.kind !== 'turn') {
        i += 1;
        continue;
      }
      this.waiting.splice(i, 1);
      merged.push({ request: w.request, at: w.at }, ...w.merged);
    }
    const eventId = this.o.eventId();
    this.asked = { eventId, request: next.request, at: next.at, merged };
    this.o.sink.send(next.request, eventId, this.o.clock.now() - next.at, merged.length);
  }
}
