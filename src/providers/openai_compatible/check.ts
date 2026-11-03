/**
 * OpenAI Compatible's readiness check (spec: "Readiness is one check"):
 * calls `GET <endpoint>/v1/models` with the user's key in the Authorization
 * header; validates that both `asrModel` and `translateModel` (when non-empty)
 * appear in the returned list. Uses `boundedFetch` with the request's clock.
 * Throws on network/404/5xx — the runner catches and words it. Returns
 * `{ ok: false, code: 'model_not_listed', ... }` when a model is absent.
 * `checkReads: ['endpoint', 'asrModel', 'translateModel']` — a change to
 * any of these re-runs the check.
 */
import { realClock, type Clock } from '../../lib/contract/clock';
import { boundedFetch } from '../../lib/provider/boundedFetch';
import type { CheckContext, CheckResult, ModelOption } from '../../lib/provider/types';
import type { CompatibleCredentials, CompatibleSettings } from './settings';
import { normalizeEndpoint, COMPATIBLE_DEFAULTS } from './settings';

export const CHECK_TIMEOUT_MS = 15_000;

interface ModelsResponse {
  data?: Array<{ id?: unknown }>;
}
interface ErrorBody {
  error?: { message?: unknown; code?: unknown };
}

/** The check function for the provider definition. */
export function checkCompatible(
  k: CompatibleCredentials,
  s: CompatibleSettings,
  ctx: CheckContext
): Promise<CheckResult> {
  const endpoint = normalizeEndpoint(s.endpoint);
  if (endpoint === '') {
    return Promise.resolve({ ok: false, code: 'endpoint_required', reason: 'Enter the endpoint URL.' });
  }

  const asrModel = s.asrModel;
  const translateModel = s.translateModel;

  return boundedFetch(
    { clock: realClock, ms: CHECK_TIMEOUT_MS, signal: ctx.signal, late: `The endpoint did not answer the model list within ${CHECK_TIMEOUT_MS / 1000} s.` },
    async (signal) => {
      const response = await fetch(`${endpoint}/v1/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${k.apiKey}` },
        signal,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ErrorBody;
        const said = typeof body.error?.message === 'string' && body.error.message ? body.error.message : "The endpoint did not accept this key.";
        const reason = `HTTP ${response.status}: ${said}`;
        if (body.error?.code === 'unsupported_country_region_territory') return { ok: false, code: 'region_unsupported', reason };
        if (response.status === 401 || response.status === 403) return { ok: false, code: 'auth', reason };
        if (response.status === 429) return { ok: false, code: 'rate_limit', reason };
        throw new Error(`The endpoint answered the model list with HTTP ${response.status}.`);
      }

      const body = (await response.json()) as ModelsResponse | Array<{ id?: unknown }>;
      const dataArray = Array.isArray(body) ? body : (body.data ?? []);
      const models = dataArray
        .flatMap((m) => (typeof m.id === 'string' ? [{ id: m.id }] : []));
      const ids = [...new Set(models.map((m) => m.id))];

      if (asrModel !== '' && !ids.includes(asrModel)) {
        return { ok: false, code: 'model_not_listed', reason: `The endpoint does not list "${asrModel}".` };
      }
      if (translateModel !== '' && !ids.includes(translateModel)) {
        return { ok: false, code: 'model_not_listed', reason: `The endpoint does not list "${translateModel}".` };
      }
      return { ok: true, models: [] };
    }
  );
}