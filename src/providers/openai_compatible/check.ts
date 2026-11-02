/**
 * OpenAI Compatible's readiness (spec: "Readiness is one check"): the user's
 * endpoint's model list, `GET <endpoint>/v1/models`, with the key in the
 * `Authorization` header. Two changes over the OpenAI Realtime check:
 * the URL is the user's endpoint (normalized), not `api.openai.com`, and
 * the `keep` filter is a Set of the user's two typed model IDs, not a
 * family prefix. A refused key (401/403) answers `invalid_key`; a status
 * the key does not explain (404, 5xx) or a failed fetch throws — the
 * runner words it. The settings side: not reached by the adapter, so it
 * may use the real clock by default.
 */
import { realClock, type Clock } from '../../lib/contract/clock';
import { boundedFetch } from '../../lib/provider/boundedFetch';
import type { CheckContext, CheckResult } from '../../lib/provider/types';
import { normalizeEndpoint, type CompatibleCredentials, type CompatibleSettings } from './settings';

/** As long as the other checks wait. */
export const CHECK_TIMEOUT_MS = 15_000;

export function checkCompatible(
  k: CompatibleCredentials,
  s: CompatibleSettings,
  ctx: Pick<CheckContext, 'clock' | 'signal'> & { clock?: Clock },
): Promise<CheckResult> {
  const clock = ctx.clock ?? realClock;
  const endpoint = normalizeEndpoint(s.endpoint);
  if (endpoint === '') {
    return Promise.resolve({ ok: false, code: 'endpoint_required', reason: 'Enter the endpoint URL.' });
  }

  const url = `${endpoint}/v1/models`;
  return boundedFetch(
    { clock, ms: CHECK_TIMEOUT_MS, signal: ctx.signal, late: 'The endpoint did not answer the model check within 15 s.' },
    async (signal) => {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${k.apiKey}` },
          signal,
        });
      } catch (err) {
        // A failed fetch (DNS, refused connection) throws; the runner words it.
        throw err;
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, code: 'invalid_key', reason: 'The API key was refused by the endpoint.' } as CheckResult;
      }
      if (!res.ok) {
        // A status the key does not explain (404, 5xx) throws.
        throw new Error(`The endpoint answered the model check with HTTP ${res.status}.`);
      }
      const body: unknown = await res.json();
      // The OpenAI models-list shape: `{ data: [{ id, ... }] }`, but some
      // endpoints return a bare array.
      const models = Array.isArray(body)
        ? body
        : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
          ? (body as { data: unknown[] }).data
          : [];
      const ids = new Set(
        models
          .filter((m): m is { id: string } => m !== null && typeof m === 'object' && 'id' in m)
          .map((m) => m.id),
      );
      if (s.asrModel !== '' && !ids.has(s.asrModel)) {
        return { ok: false, code: 'model_not_listed', reason: `The endpoint does not list "${s.asrModel}".` } as CheckResult;
      }
      if (s.translateModel !== '' && !ids.has(s.translateModel)) {
        return { ok: false, code: 'model_not_listed', reason: `The endpoint does not list "${s.translateModel}".` } as CheckResult;
      }
      // Both model IDs validated (or empty): the readiness answer is binary.
      return { ok: true, models: [] } as CheckResult;
    },
  );
}
