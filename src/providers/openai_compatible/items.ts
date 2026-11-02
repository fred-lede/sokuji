/**
 * OpenAI Compatible's conversation items → segments: the same pairing rules
 * as OpenAI Realtime's `items.ts` — an input's transcript opens and closes
 * a source segment, a response's assistant item opens a translation
 * segment paired by the input its `previous_item_id` names, karaoke by
 * arrival. Copied without OpenAI-specific comment context. No timer:
 * the server's own events open and close every segment.
 */
import type { AdapterEvents, Ref, TextRange } from '../../lib/contract/adapter';

export type ItemSink = Pick<AdapterEvents, 'segmentOpened' | 'segmentText' | 'segmentClosed' | 'audio' | 'speechRanges'>;

interface Input {
  ref: Ref;
  text: string;
  closed: boolean;
  known: boolean;
  knownAt: number;
  answered: boolean;
}

interface Output {
  ref: Ref;
  text: string;
  spoken: number;
  ranges: TextRange[];
  closed: boolean;
}

interface ResponseState {
  outOfBand: boolean;
  fallback?: string;
}

export class RealtimeItems {
  private refs = 0;
  private knownSeq = 0;
  private readonly inputs = new Map<string, Input>();
  private readonly outputs = new Map<string, Output>();
  private readonly responses = new Map<string, ResponseState>();
  private readonly owners = new Map<string, string>();
  private stopped = false;

  constructor(private readonly sink: ItemSink) {}

  committed(itemId: string): void {
    if (this.stopped || this.inputs.has(itemId)) return;
    this.openInput(itemId, true);
  }

  typed(itemId: string, text: string): void {
    if (this.stopped || this.inputs.has(itemId)) return;
    const input = this.openInput(itemId, false);
    input.text = text;
    this.sink.segmentText({ ref: input.ref, text });
    this.closeInput(input);
  }

  inputAdded(itemId: string): void {
    const input = this.inputs.get(itemId);
    if (!input || input.known) return;
    input.known = true;
    input.knownAt = ++this.knownSeq;
  }

  inputDelta(itemId: string, delta: string): void {
    const input = this.input(itemId);
    if (!input || !delta) return;
    input.text += delta;
    this.sink.segmentText({ ref: input.ref, text: input.text });
  }

  inputDone(itemId: string, transcript: string): void {
    const input = this.input(itemId);
    if (!input) return;
    if (transcript && transcript !== input.text) {
      input.text = transcript;
      this.sink.segmentText({ ref: input.ref, text: transcript });
    }
    this.closeInput(input);
  }

  inputFailed(itemId: string): void {
    const input = this.inputs.get(itemId);
    if (input && !input.closed && !this.stopped) this.closeInput(input);
  }

  responseCreated(responseId: string, outOfBand: boolean): void {
    if (this.stopped) return;
    this.responses.set(responseId, outOfBand ? { outOfBand } : { outOfBand, fallback: this.newestUnanswered() });
  }

  outputAdded(itemId: string, responseId: string): void {
    this.owners.set(itemId, responseId);
  }

  assistantAdded(itemId: string, previousItemId: string | null | undefined): void {
    if (this.stopped) return;
    if (!this.owners.has(itemId)) {
      const running = [...this.responses].filter(([, r]) => !r.outOfBand).map(([responseId]) => responseId);
      if (running.length === 1) this.owners.set(itemId, running[0]);
    }
    if (this.outOfBand(this.owners.get(itemId))) return;
    this.output(itemId, previousItemId);
  }

  outputDelta(itemId: string, responseId: string, delta: string): void {
    if (this.stopped || !delta || this.outOfBand(responseId)) return;
    this.owners.set(itemId, responseId);
    const out = this.output(itemId);
    if (!out) return;
    out.text += delta;
    this.sink.segmentText({ ref: out.ref, text: out.text });
  }

  outputDone(itemId: string, responseId: string, text: string): void {
    if (this.stopped || this.outOfBand(responseId)) return;
    this.owners.set(itemId, responseId);
    const out = this.output(itemId);
    if (!out || !text || text === out.text) return;
    out.text = text;
    this.sink.segmentText({ ref: out.ref, text });
    const len = text.length;
    const restated = out.ranges.flatMap((range, index) => {
      if (range[1] <= len) return [];
      const inside: TextRange = [Math.min(range[0], len), len];
      out.ranges[index] = inside;
      return [{ index, range: inside }];
    });
    out.spoken = Math.min(out.spoken, len);
    if (restated.length > 0) this.sink.speechRanges({ ref: out.ref, ranges: restated });
  }

  audio(itemId: string, responseId: string, pcm: Int16Array): void {
    if (this.stopped || pcm.length === 0 || this.outOfBand(responseId)) return;
    this.owners.set(itemId, responseId);
    const out = this.output(itemId);
    if (!out) {
      this.sink.audio({ pcm });
      return;
    }
    const range: TextRange = [out.spoken, out.text.length];
    out.ranges.push(range);
    out.spoken = range[1];
    this.sink.audio({ pcm, ref: out.ref, range });
  }

  itemDone(itemId: string): void {
    const out = this.outputs.get(itemId);
    if (out && !out.closed && !this.stopped) this.closeOutput(out);
  }

  responseDone(responseId: string): void {
    if (this.stopped) return;
    for (const [itemId, owner] of this.owners) {
      if (owner !== responseId) continue;
      const out = this.outputs.get(itemId);
      if (out && !out.closed) this.closeOutput(out);
      this.owners.delete(itemId);
    }
    this.responses.delete(responseId);
  }

  stop(): void {
    this.stopped = true;
  }

  private outOfBand(responseId: string | undefined): boolean {
    return responseId !== undefined && this.responses.get(responseId)?.outOfBand === true;
  }

  private openInput(itemId: string, known: boolean): Input {
    const ref = ++this.refs;
    this.sink.segmentOpened({ ref, side: 'source', origin: itemId });
    const input: Input = { ref, text: '', closed: false, known, knownAt: known ? ++this.knownSeq : 0, answered: false };
    this.inputs.set(itemId, input);
    return input;
  }

  private closeInput(input: Input): void {
    input.closed = true;
    this.sink.segmentClosed({ ref: input.ref });
  }

  private input(itemId: string): Input | null {
    if (this.stopped) return null;
    const input = this.inputs.get(itemId) ?? this.openInput(itemId, true);
    return input.closed ? null : input;
  }

  private output(itemId: string, previousItemId?: string | null): Output | null {
    const known = this.outputs.get(itemId);
    if (known) return known.closed ? null : known;
    const origin = this.originFor(itemId, previousItemId);
    const ref = ++this.refs;
    this.sink.segmentOpened({ ref, side: 'translation', ...(origin ? { origin } : {}) });
    const out: Output = { ref, text: '', spoken: 0, ranges: [], closed: false };
    this.outputs.set(itemId, out);
    return out;
  }

  private closeOutput(out: Output): void {
    out.closed = true;
    this.sink.segmentClosed({ ref: out.ref });
  }

  private originFor(itemId: string, previousItemId: string | null | undefined): string | undefined {
    const origin = previousItemId && this.inputs.has(previousItemId)
      ? previousItemId
      : this.responses.get(this.owners.get(itemId) ?? '')?.fallback;
    const input = origin === undefined ? undefined : this.inputs.get(origin);
    if (input) input.answered = true;
    return origin;
  }

  private newestUnanswered(): string | undefined {
    let newest: Input | undefined;
    let newestId: string | undefined;
    for (const [itemId, input] of this.inputs) {
      if (input.known && (newest === undefined || input.knownAt > newest.knownAt)) {
        newest = input;
        newestId = itemId;
      }
    }
    return newest !== undefined && !newest.answered ? newestId : undefined;
  }
}
