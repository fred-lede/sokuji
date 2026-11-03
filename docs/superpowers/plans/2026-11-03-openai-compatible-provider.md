# OpenAI Compatible Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new, unflagged own-key provider, `openai_compatible`, that runs ASR, translation, and TTS against any user-named OpenAI-compatible endpoint via the OpenAI Realtime WebSocket protocol. Re-introduction of the retired id — the tests that pinned "registered nowhere" now pin its new place.

**Architecture:** One folder, `src/providers/openai_compatible/`, shaped like `openai/`: a settings module, a key check pointed at the user's endpoint (not `api.openai.com`), a builder, a pure wire module, a settings view with lazy voice fetch, and an adapter that mirrors `openai/adapter.ts` structurally. The registry gains one line between OpenAI Live and Soniox; the extension manifest gains two wildcard entries; 30 locale catalogs gain the new provider's block.

**Tech Stack:** TypeScript (strict), React 18, Vitest + Testing Library, the client contract kit (`src/lib/contract/`), `boundedFetch` (`src/lib/provider/boundedFetch.ts`), the existing `REALTIME_LANGUAGES` export from `openai/settings.ts`.

**Design spec:** `docs/superpowers/specs/2026-11-03-openai-compatible-provider-design.md`

---

## Global constraints

- **No `console.*` or `report()` inside any adapter session** (CLAUDE.md, F17; `consoleLedger.consistency.test.ts` enforces).
- **Every timer reads the request's clock** (F9 convention); no wall clock, no global timer inside an adapter.
- **The `openai` SDK types are type-only imports** — no runtime SDK dependency in `wire.ts`.
- **`settings.key` is `'openaiCompatible'`** (the old slice key). `LEGACY_SLICE_KEYS['openai_compatible']` already equals `'openaiCompatible'` in `src/lib/session/storedSettings.ts` line 57 — no change to that file.
- **Error words** in the adapter replace "OpenAI" with "the endpoint": `NEVER_OPENED` → "The endpoint's socket did not open (check the endpoint URL, the network, and that the API key is still valid)."; start timeout → "The endpoint did not start the session within 30 s."; close → "The connection to the endpoint closed (code reason)."
- **`checkReads: ['endpoint', 'asrModel', 'translateModel']`** — a change to any of these settings fields re-runs the check. No other field is in the list.
- **i18n:** all 30 locale catalogs get the new keys; non-en catalogs copy the English strings verbatim (no transliteration).

---

## File map

```
src/providers/openai_compatible/
├── provider.ts              ← Task 7
├── provider.test.ts         ← Task 7
├── settings.ts              ← Task 1
├── settings.test.ts         ← Task 1
├── config.ts                ← Task 3
├── config.test.ts           ← Task 3
├── check.ts                 ← Task 2
├── check.test.ts            ← Task 2
├── wire.ts                  ← Task 4
├── wire.test.ts             ← Task 4
├── adapter.ts               ← Task 5
├── adapter.test.ts          ← Task 5
├── testing.ts               ← Task 5
├── RealtimeSettings.tsx     ← Task 6
└── RealtimeSettings.test.tsx← Task 6

src/providers/registry.ts           ← Task 8
src/providers/registry.test.ts      ← Task 8
src/providers/openai/provider.ts    ← Task 9 (update comment)
src/providers/openai/provider.test.ts ← Task 9 (update two tests)
extension/manifest.json             ← Task 11
extension/manifest.consistency.test.ts ← Task 11
src/locales/*/translation.json      ← Task 10 (30 catalogs)
```

---

## Task 1: Settings module

**Files:**
- Create: `src/providers/openai_compatible/settings.ts`
- Test: `src/providers/openai_compatible/settings.test.ts`

**Consumes:** `REALTIME_LANGUAGES` from `openai/settings.ts` (exported at line 176), `InstructionsSettings` + `INSTRUCTIONS_DEFAULTS` + `INSTRUCTION_LEGACY_KEYS` + `migrateInstructions` from `src/lib/provider/instructions`, `identityWire` from `src/lib/language/wire`, `NOISE_REDUCTIONS` + `TurnDetectionMode` + `SemanticEagerness` + range constants from `openai/settings.ts` (re-export or import — import, not re-export), `distinctVoice` from `src/lib/provider/voices`, `AUTO` from `src/lib/provider/languages`.

**Produces:** `CompatibleSettings` type, `COMPATIBLE_DEFAULTS`, `COMPATIBLE_LEGACY_KEYS`, `migrateCompatibleSettings`, `compatibleCredentials`, `compatibleLanguages`, `normalizeEndpoint(raw: string): string`, `identityWire()` re-export.

### `CompatibleSettings` shape

```ts
interface CompatibleSettings extends InstructionsSettings {
  endpoint: string;              // raw, not normalized — normalize at use
  asrModel: string;             // free text; '' = default
  translateModel: string;       // free text; '' = default
  voice: string;                // '' = endpoint default
  participantVoice: string;     // '' = endpoint default
  turnDetectionMode: TurnDetectionMode;
  threshold: number;
  prefixPadding: number;
  silenceDuration: number;
  semanticEagerness: SemanticEagerness;
  maxTokens: number | 'inf';
  transcriptKeywords: string;
  noiseReduction: NoiseReduction;
}
```

No `transcriptModel`, no `reasoningEffort`, no `model` — those three fields are OpenAI-specific.

### `COMPATIBLE_DEFAULTS`

```ts
export const COMPATIBLE_DEFAULTS: CompatibleSettings = {
  ...INSTRUCTIONS_DEFAULTS,
  endpoint: '',
  asrModel: '',
  translateModel: '',
  voice: '',
  participantVoice: '',
  turnDetectionMode: 'Normal',
  threshold: 0.49,
  prefixPadding: 0.5,
  silenceDuration: 0.5,
  semanticEagerness: 'Auto',
  maxTokens: 'inf',
  transcriptKeywords: '',
  noiseReduction: 'None',
};
```

### `COMPATIBLE_LEGACY_KEYS`

Reads `endpoint` and the instruction fields from the old slice. `asrModel`, `translateModel`, `voice`, `participantVoice` have no old-slice counterpart (the old provider used a single `model` field) — they default to `''`.

```ts
export const COMPATIBLE_LEGACY_KEYS: readonly string[] = INSTRUCTION_LEGACY_KEYS;
```

### `migrateCompatibleSettings`

Same shape as `migrateRealtimeSettings` but for `CompatibleSettings` fields. `endpoint`, `asrModel`, `translateModel`, `transcriptKeywords` are free-text: read as string or fall to `''`. `voice` / `participantVoice`: read as string, fall to `''` (no voice list validation — the list is endpoint-specific). The turn-detection / noise / maxTokens fields mirror `migrateRealtimeSettings`.

### `normalizeEndpoint(raw: string): string`

```ts
export function normalizeEndpoint(raw: string): string {
  let s = raw.trim();
  if (s === '') return '';
  if (!s.startsWith('http://') && !s.startsWith('https://')) s = 'https://' + s;
  s = s.replace(/\/$/, '');
  s = s.replace(/\/v1$/, '');
  return s;
}
```

### `compatibleCredentials`

Same shape as `realtimeCredentials` but the `missing` message is "Enter the endpoint's API key." (not "Enter your OpenAI API key."):

```ts
export const compatibleCredentials: Provider<CompatibleSettings, CompatibleCredentials, never>['credentials'] = {
  keys: ['apiKey'],
  fields: () => [{ key: 'apiKey', labelKey: 'setup.credentials.apiKey', secret: true, placeholderKey: 'simpleSettings.apiKeyPlaceholder' }],
  read: (values): CompatibleCredentials | CredentialsMissing => {
    const apiKey = (values.apiKey ?? '').trim();
    return apiKey ? { apiKey } : { missing: "Enter the endpoint's API key." };
  },
};
```

### `compatibleLanguages`

```ts
import { REALTIME_LANGUAGES } from '../openai/settings';
const AUTO_SOURCE: LanguageOption = { value: AUTO };
export const compatibleLanguages: Provider<CompatibleSettings, never, never>['languages'] = {
  sources: () => [AUTO_SOURCE, ...REALTIME_LANGUAGES],
  targets: () => REALTIME_LANGUAGES,
  initial: () => ({ source: 'en', target: 'zh-CN' }),
  wire: identityWire(),
};
```

### Tests (`settings.test.ts`)

- `normalizeEndpoint`: `''` → `''`; `'myhost'` → `'https://myhost'`; `'https://host/'` → `'https://host'`; `'https://host/v1'` → `'https://host'`; `'  https://host/v1/  '` → `'https://host'`.
- `migrateCompatibleSettings`: defaults when nothing stored; a stored `endpoint` string is read; a stored `asrModel` non-string falls to `''`; `turnDetectionMode` outside `TURN_DETECTION_MODES` falls to `'Normal'`; `noiseReduction` outside list falls to `'None'`; `maxTokens: 'inf'` is preserved; `maxTokens: 4096` is preserved; `maxTokens: 99999` is clamped to `4096` by the builder (not the migrator).
- `COMPATIBLE_DEFAULTS`: `endpoint: ''`, `asrModel: ''`, `translateModel: ''`, `voice: ''`, `participantVoice: ''`.

---

## Task 2: Check module

**Files:**
- Create: `src/providers/openai_compatible/check.ts`
- Test: `src/providers/openai_compatible/check.test.ts`

**Consumes:** `boundedFetch` from `src/lib/provider/boundedFetch.ts`, `realClock` + `Clock` type from `src/lib/contract/clock`, `CheckContext` + `CheckResult` from `src/lib/provider/types`, `CompatibleSettings` + `normalizeEndpoint` from `./settings`, `COMPATIBLE_DEFAULTS` from `./settings`.

**Produces:** `checkCompatible(k, s, ctx): Promise<CheckResult>` where `k: { apiKey: string }`.

### Behavior

1. If `normalizeEndpoint(s.endpoint) === ''`, return `{ ok: false, code: 'endpoint_required', reason: "Enter the endpoint URL." }`.
2. Fetch `GET ${normalizeEndpoint(s.endpoint)}/v1/models` with `Authorization: Bearer <apiKey>`, bounded by `CHECK_TIMEOUT_MS` (reuse `15_000` — define locally, same value as `openaiModels.ts`).
3. On HTTP 401/403: return `{ ok: false, code: 'invalid_key', reason: 'The API key was refused by the endpoint.' }`.
4. On HTTP 404 or 5xx or fetch failure: **throw** (as `openaiModels.ts` does) — the runner catches it and words it.
5. Parse the JSON body: extract the `data` array (OpenAI models-list shape) or the top-level array (some endpoints return a bare array). Build a `Set<string>` of model `id` fields.
6. If `s.asrModel !== ''` and not in the set, return `{ ok: false, code: 'model_not_listed', reason: `The endpoint does not list "${s.asrModel}".` }`.
7. If `s.translateModel !== ''` and not in the set, return `{ ok: false, code: 'model_not_listed', reason: `The endpoint does not list "${s.translateModel}".` }`.
8. Success: return `{ ok: true, models: [] }` — the model list is not surfaced to a picker (both model fields are free text, not a select). The `models` array is empty; the readiness answer is binary.

### Tests (`check.test.ts`)

Stub `globalThis.fetch` with `vi.stubGlobal`. Test cases:

- endpoint empty → `{ ok: false, code: 'endpoint_required' }`.
- fetch returns 401 → `{ ok: false, code: 'invalid_key' }`.
- fetch returns 200, `asrModel` in list, `translateModel` in list → `{ ok: true }`.
- fetch returns 200, `asrModel` not in list → `{ ok: false, code: 'model_not_listed', reason: 'The endpoint does not list "<id>".' }`.
- fetch returns 200, `translateModel` not in list → `{ ok: false, code: 'model_not_listed' }`.
- fetch throws (network failure) → the check throws.
- fetch returns 200, body is a bare array (not `{ data: [] }`) → parsed correctly, check passes when model IDs are in the array.

---

## Task 3: Config module

**Files:**
- Create: `src/providers/openai_compatible/config.ts`
- Test: `src/providers/openai_compatible/config.test.ts`

**Consumes:** `SessionContext` from `src/lib/contract/adapter`, `resolveInstructions` from `src/lib/provider/instructions`, `ProviderRefusal` + `SharedSettings` from `src/lib/provider/types`, `CompatibleSettings` + `COMPATIBLE_DEFAULTS` + range constants + `TurnDetectionMode` + `NoiseReduction` + `SemanticEagerness` + `normalizeEndpoint` from `./settings`.

**Produces:** `CompatibleConfig` type, `buildCompatible(context, s, shared): CompatibleConfig | ProviderRefusal`, `describeCompatible(c: CompatibleConfig): { asrModel: string; translationModel: string }`.

### `CompatibleConfig` shape

```ts
interface CompatibleConfig {
  /** The normalized endpoint URL, without trailing /v1. */
  endpoint: string;
  /** The user's translateModel, as typed. '' means the endpoint's default. */
  translateModel: string;
  /** The user's asrModel, as typed. '' means the endpoint's default. */
  asrModel: string;
  /** This leg's voice: '' = endpoint default. */
  voice?: string;
  /** This direction's prompt. */
  instructions: string;
  modalities: ['audio'] | ['text'];
  maxTokens: number | 'inf';
  turnDetection: TurnDetection | null;
  noiseReduction: 'near_field' | 'far_field' | null;
  transport: 'websocket';
}
```

Import `TurnDetection` from `openai/config.ts` (re-export from there — do not redefine).

### `buildCompatible`

- If `translateModel === ''` and `asrModel === ''` and `endpoint === ''` after normalization: return `{ refused: "Enter the endpoint, and a model to run.", code: 'endpoint_required' }`.
- Otherwise: build the config. `turnDetection` follows the same logic as `buildRealtime` (clamped, semantic eagerness lowercased). `noiseReduction` follows the `NOISE` map. No `reasoningEffort`. No `transcription` hint (the old `TranscriptionHint` is OpenAI-specific; a custom endpoint has no such hint — omit it entirely).
- `voice`: `shared.reversed(context.direction) ? (s.participantVoice || undefined) : (s.voice || undefined)` — empty string becomes `undefined` so the wire omits the field.

### `describeCompatible`

```ts
export function describeCompatible(c: CompatibleConfig): { asrModel: string; translationModel: string } {
  return { asrModel: c.asrModel, translationModel: c.translateModel };
}
```

### Tests (`config.test.ts`)

Mirror `openai/config.test.ts` structure:
- `buildCompatible` with empty endpoint → refused with `endpoint_required`.
- `buildCompatible` with `asrModel: 'qwen3-asr'`, `translateModel: 'qwen3-translate'`, `endpoint: 'https://host'` → config has `endpoint: 'https://host'`, `translateModel: 'qwen3-translate'`, `asrModel: 'qwen3-asr'`.
- `buildCompatible` with `turns: 'manual'` → `turnDetection: null`.
- `buildCompatible` with `turns: 'auto'`, `turnDetectionMode: 'Semantic'` → `turnDetection.type === 'semantic_vad'`.
- `buildCompatible` with `speech: false` → `modalities: ['text']`, no `voice` field.
- `buildCompatible` with `speech: true`, `voice: ''` → no `voice` field in config.
- `buildCompatible` with `speech: true`, `voice: 'custom-voice-1'` → `voice: 'custom-voice-1'`.
- `describeCompatible` returns `{ asrModel, translationModel }` with no `ttsModel` key.

---

## Task 4: Wire module

**Files:**
- Create: `src/providers/openai_compatible/wire.ts`
- Test: `src/providers/openai_compatible/wire.test.ts`

**Consumes:** `CompatibleConfig` from `./config`, `CompatibleCredentials` from `./settings`, `pcmToBase64` from `src/lib/contract/pcm64`, the OpenAI SDK realtime types (type-only import, same as `openai/wire.ts`).

**Produces:** `compatibleUrl(c: CompatibleConfig, key: string): string`, `compatibleProtocols(key: string): string[]`, `compatibleSessionUpdate(c: CompatibleConfig): object` (the `session.update` payload), re-exports of `base64ToPcm`, `decodeServerEvent`, `errorCode`, `errorWords` from `src/lib/provider/openaiWire`.

### `compatibleUrl`

```ts
export function compatibleUrl(c: CompatibleConfig, key: string): string {
  // The model is ?model=<translateModel>; '' (no model) omits the parameter.
  const model = c.translateModel ? `?model=${encodeURIComponent(c.translateModel)}` : '';
  return `wss://${c.endpoint.replace(/^https?:\/\//, '')}/v1/realtime${model}`;
}
```

Wait — the endpoint is already normalized to `https://host` (no scheme-stripped). The WebSocket URL must be `wss://host/v1/realtime`:

```ts
export function compatibleUrl(c: CompatibleConfig, key: string): string {
  const host = c.endpoint.replace(/^https?:\/\//, '');
  const model = c.translateModel ? `?model=${encodeURIComponent(c.translateModel)}` : '';
  return `wss://${host}/v1/realtime${model}`;
}
```

### `compatibleProtocols`

Same as `realtimeProtocols` in `openai/wire.ts`:

```ts
export function compatibleProtocols(key: string): string[] {
  return ['realtime', `openai-insecure-api-key.${key}`];
}
```

### `compatibleSessionUpdate`

Same shape as `openai/wire.ts`'s `sessionUpdate` but:
- `audio.input.transcription.model` = `c.asrModel` (omit the field when `''`)
- `audio.output.voice` = `c.voice` (omit when `undefined`)
- No `transcription.languages`, no `transcription.prompt` (the `TranscriptionHint` is OpenAI-specific)
- No `reasoning_effort`
- `instructions` = `c.instructions`
- `modalities` = `c.modalities`
- `turn_detection` = `c.turnDetection` (null → omit the field)
- `max_output_tokens` = `c.maxTokens` ('inf' → omit)
- `input_audio_transcription.noise_suppression` = `c.noiseReduction` (null → omit)

### Tests (`wire.test.ts`)

- `compatibleUrl({ endpoint: 'https://host', translateModel: '' })` → `'wss://host/v1/realtime'`.
- `compatibleUrl({ endpoint: 'https://host', translateModel: 'qwen3-translate' })` → `'wss://host/v1/realtime?model=qwen3-translate'`.
- `compatibleProtocols('sk-abc')` → `['realtime', 'openai-insecure-api-key.sk-abc']`.
- `compatibleSessionUpdate` with `asrModel: 'qwen3-asr'` → payload has `audio.input.transcription.model === 'qwen3-asr'`.
- `compatibleSessionUpdate` with `asrModel: ''` → payload has no `audio.input.transcription` object.
- `compatibleSessionUpdate` with `voice: 'custom-voice'` → payload has `audio.output.voice === 'custom-voice'`.
- `compatibleSessionUpdate` with `turnDetection: null` → no `turn_detection` field in payload.

---

## Task 5: Adapter + testing module

**Files:**
- Create: `src/providers/openai_compatible/adapter.ts`
- Create: `src/providers/openai_compatible/testing.ts`
- Test: `src/providers/openai_compatible/adapter.test.ts`

**Consumes:** Mirror `openai/adapter.ts` structurally. The adapter is a copy of `openai/adapter.ts` with these substitutions:
- `RealtimeConfig` → `CompatibleConfig`
- `RealtimeCredentials` → `CompatibleCredentials`
- `realtimeUrl` → `compatibleUrl`
- `realtimeProtocols` → `compatibleProtocols`
- `sessionUpdate` → `compatibleSessionUpdate`
- Error words: "OpenAI" → "the endpoint" (per the global constraints above)
- Everything else (the `RealtimeLeg` phases, `RealtimeItems`, `ResponseQueue`, drift anchor, in-band response queue, timer discipline) is the same.

**Testing module (`testing.ts`)**

Mirror `openai/testing.ts` with:
- `KEY = 'sk-test-compat'`
- `COMPATIBLE_CTX`: a `SessionContext` with `direction: { source: 'en', target: 'zh-CN' }`, `speech: true`, `turns: 'auto'`
- `COMPAT_DEFAULTS`: `COMPATIBLE_DEFAULTS` spread with `endpoint: 'https://example.com'`, `asrModel: 'test-asr'`, `translateModel: 'test-translate'`, `voice: 'v1'`, `participantVoice: 'v2'`
- `COMPAT_CONFIG`: `buildCompatible(COMPATIBLE_CTX, COMPAT_DEFAULTS, SHARED)` cast to `CompatibleConfig`
- `startCompatible`: a harness that opens a `FakeSocket` leg over `compatibleUrl` + `compatibleProtocols` and drives it with `SERVER` events (same as `openai/testing.ts`'s `startRealtime`)
- `SERVER` events: the same JSON text frames as `openai/testing.ts`

**Tests (`adapter.test.ts`)**

Mirror `openai/adapter.test.ts` with the new config/credentials types. Test cases:
- Start resolves on `session.updated`.
- A start timeout (30 s) rejects with "The endpoint did not start the session within 30 s."
- A never-opened socket rejects with "The endpoint's socket did not open (check the endpoint URL, the network, and that the API key is still valid)."
- A `response.done` event closes the in-band response; the next `response.create` is out-of-band.
- The drift anchor re-sends the instructions on a `session.truncated` event.
- `closed` event with code 1000 → "The connection to the endpoint closed (normal close)."

---

## Task 6: Settings view

**Files:**
- Create: `src/providers/openai_compatible/RealtimeSettings.tsx`
- Test: `src/providers/openai_compatible/RealtimeSettings.test.tsx`

**Consumes:** `SettingsProps` from `src/lib/provider/types`, `useTranslation` from `react-i18next`, `boundedFetch` from `src/lib/provider/boundedFetch.ts`, `InstructionsField` from `src/components/providers/fields/InstructionsField`, `NoiseReductionField` from `src/components/providers/fields/NoiseReductionField`, `RealtimeTurnDetectionControls` + `RealtimeTurnDetectionHelp` + `RealtimeTurnDetectionSummary` from `openai/RealtimeTurnDetection.tsx` (they read the same field names — `turnDetectionMode`, `threshold`, `prefixPadding`, `silenceDuration`, `semanticEagerness` — so they work for `CompatibleSettings` without changes), `COMPATIBLE_DEFAULTS` + `CompatibleSettings` + `normalizeEndpoint` from `./settings`.

**Produces:** `CompatibleSettingsView({ settings, update, disabled }: SettingsProps<CompatibleSettings>)`.

### Voice fetch

On mount, and when `settings.endpoint` or the API key change:
1. If `normalizeEndpoint(settings.endpoint)` is empty or key is empty, skip (no fetch).
2. `GET ${normalizeEndpoint(settings.endpoint)}/v1/audio/voices` with `Authorization: Bearer <key>`, bounded.
3. On a 200 with a JSON array of `{ id, name }` objects: populate a `<select>` with those options; default `voice` to first, `participantVoice` to second (via `distinctVoice`).
4. On any other outcome (404, non-JSON, network error): show a free-text input for each voice field instead.
5. On user change, call `update({ voice })` / `update({ participantVoice })` — the value persists to settings.

The fetch runs in a `useEffect` with a `useRef` guard to avoid duplicate fetches while a fetch is in flight.

### View structure (in order)

1. **Endpoint** — text input, label key `providers.openai_compatible.endpoint`, placeholder key `providers.openai_compatible.endpointPlaceholder`.
2. **API Key** — secret input, label `setup.credentials.apiKey`, placeholder `simpleSettings.apiKeyPlaceholder`.
3. **ASR Model** — text input, label `providers.openai_compatible.asrModel`, placeholder `providers.openai_compatible.asrModelPlaceholder`.
4. **Translation Model** — text input, label `providers.openai_compatible.translateModel`, placeholder `providers.openai_compatible.translateModelPlaceholder`.
5. **My Voice** — select or free-text (per the fetch result above), label `providers.openai_compatible.voice`.
6. **Other's Voice** — same, label `providers.openai_compatible.participantVoice`.
7. `RealtimeTurnDetectionSummary` + `RealtimeTurnDetectionControls` + `RealtimeTurnDetectionHelp` (imported from `openai/RealtimeTurnDetection.tsx`).
8. `NoiseReductionField` (same as OpenAI Realtime).
9. `InstructionsField` (same as OpenAI Realtime).

No `reasoningEffort`, no `transcriptModel` select, no `maxTokens` slider (the same slider as OpenAI Realtime — actually include it: `ModelConfigurationField` or a plain range input, label `settings.maxTokens`).

### Tests (`RealtimeSettings.test.tsx`)

- Renders the endpoint field; typing in it calls `update` with the new value.
- Renders the two model fields.
- When `endpoint` and key are both set and `fetch` (mocked) returns a 200 voices list, the voice fields render as `<select>` with the fetched options.
- When `fetch` returns 404, the voice fields render as free-text inputs.
- Changing a voice select calls `update({ voice })`.

---

## Task 7: Provider definition

**Files:**
- Create: `src/providers/openai_compatible/provider.ts`
- Test: `src/providers/openai_compatible/provider.test.ts`

### `provider.ts`

```ts
import { OpenAIIcon } from '../../components/Icons/ProviderIcons';
import type { Provider } from '../../lib/provider/types';
import { createCompatibleAdapter } from './adapter';
import { checkCompatible } from './check';
import { buildCompatible, describeCompatible, type CompatibleConfig } from './config';
import { CompatibleSettingsView, CompatibleVoiceSummary } from './RealtimeSettings';
import { RealtimeTurnDetectionControls, RealtimeTurnDetectionHelp, RealtimeTurnDetectionSummary } from '../openai/RealtimeTurnDetection';
import {
  compatibleCredentials, compatibleLanguages,
  COMPATIBLE_DEFAULTS, migrateCompatibleSettings,
  type CompatibleCredentials, type CompatibleSettings,
} from './settings';

const adapter = createCompatibleAdapter();

export const openaiCompatibleProvider: Provider<CompatibleSettings, CompatibleCredentials, never> = {
  id: 'openai_compatible',
  kind: 'own-key',
  platforms: ['electron', 'extension', 'web'],
  icon: OpenAIIcon,
  settings: {
    key: 'openaiCompatible',
    defaults: COMPATIBLE_DEFAULTS,
    view: CompatibleSettingsView,
    migrate: migrateCompatibleSettings,
  },
  credentials: compatibleCredentials,
  languages: compatibleLanguages,
  speech: 'optional',
  textInput: () => true,
  boundaries: () => 'provider',
  turns: () => ['auto', 'manual'],
  check: { read: checkCompatible, reads: ['endpoint', 'asrModel', 'translateModel'] },
  build: buildCompatible,
  describe: describeCompatible,
  turnDetection: { Summary: RealtimeTurnDetectionSummary, Controls: RealtimeTurnDetectionControls, Help: RealtimeTurnDetectionHelp },
  start: adapter.start,
};
```

### `provider.test.ts`

Mirror `openai/provider.test.ts` structure:
- Position in registry: `openai_compatible` is in `PROVIDERS`, between `openai_live` and `soniox`.
- `checkReads` equals `['endpoint', 'asrModel', 'translateModel']`.
- `speech: 'optional'`, `textInput() === true`, `boundaries() === 'provider'`, `turns() === ['auto', 'manual']`.
- A stored `openai_compatible` selection now stays on `openai_compatible` with `fromStorage: true` on all three platforms (the rewritten version of the "falls to first provider" test that lives in `openai/provider.test.ts`).

---

## Task 8: Registry

**Files:**
- Modify: `src/providers/registry.ts`
- Modify: `src/providers/registry.test.ts`

### `registry.ts`

- Add import: `import { openaiCompatibleProvider } from './openai_compatible/provider';`
- In the `RELEASED` array, insert `openaiCompatibleProvider` between `openaiLiveProvider` and `sonioxProvider`:

```ts
const RELEASED = [
  kizunaSonioxProvider, kizunaQwenProvider, localInferenceProvider, geminiProvider,
  volcengineAst2Provider, openaiProvider, openaiTranslateProvider, openaiLiveProvider,
  openaiCompatibleProvider,   // ← new
  sonioxProvider, qwenLiveTranslateProvider, palabraProvider
] as const;
```

Update the comment on line 23 to include `openai_compatible` in the order description.

### `registry.test.ts`

- Line 152: add `openai_compatible: ['endpoint', 'asrModel', 'translateModel']` to the `checkReads` object.
- Line 166 (`PORTED` constant): add `'openai_compatible'` to the array.
- Line 361 (release order assertion): change the expected array to include `'openai_compatible'` between `'openai_live'` and `'soniox'`:

```ts
expect(releaseBuild.PROVIDERS.map((p) => p.id)).toEqual([
  'kizunaai_soniox', 'kizunaai_qwen', 'local_inference', 'gemini',
  'volcengine_ast2', 'openai', 'openai_translate', 'openai_live',
  'openai_compatible',  // ← new
  'soniox', 'qwen_livetranslate', 'palabraai'
]);
```

---

## Task 9: Update OpenAI provider tests

**Files:**
- Modify: `src/providers/openai/provider.ts` (update the comment at lines 30–32)
- Modify: `src/providers/openai/provider.test.ts` (lines 76 and 83)

### `provider.ts` comment update

The current comment says "OpenAI Compatible is retired, not ported (ruling 1)". Replace with:

```
OpenAI Compatible was retired with this port (ruling 1) and is now
re-introduced as its own provider (`src/providers/openai_compatible/`),
between OpenAI Live and Soniox. A stored openai_compatible selection
stays on the new provider; the old slice's endpoint and key carry forward
via settings.key 'openaiCompatible'.
```

### `provider.test.ts` updates

**Line 76** — the test currently asserts `expect(ids).not.toContain('openai_compatible')`. Rewrite:

```ts
it('sits after OpenAI Live and before Soniox, and OpenAI Compatible is registered at its place (rulings 18, 1)', () => {
  const ids = PROVIDERS.map((p) => p.id);
  const i = ids.indexOf('openai');
  const j = ids.indexOf('openai_live');
  const k = ids.indexOf('openai_compatible');
  const m = ids.indexOf('soniox');
  expect(i).toBeLessThan(j);
  expect(j).toBeLessThan(k);
  expect(k).toBeLessThan(m);
});
```

**Line 83** — the test currently asserts `expect(selectionFromStored('openai_compatible', offered, 'kizunaai_soniox', platform)).toEqual({ id: offered[0], fromStorage: false })`. Rewrite:

```ts
it('a stored OpenAI Compatible selection stays on openai_compatible, fromStorage true (ruling 1, re-introduced 2026-11-03)', () => {
  const offered = presentProviders({ platform, dev: false, enabled: new Set(['openai_compatible']), kizuna: true, switchOn: () => false });
  expect(selectionFromStored('openai_compatible', offered, 'kizunaai_soniox', platform)).toEqual({ id: 'openai_compatible', fromStorage: true });
});
```

Check whether `loadStores.test.ts` has a similar assertion; update it the same way.

---

## Task 10: Locale catalogs

**Files:** All 30 files in `src/locales/*/translation.json`

### Keys to add

In each catalog's `providers` block, add:

```json
"openai_compatible": {
  "name": "OpenAI Compatible",
  "description": "A custom OpenAI-compatible endpoint for realtime ASR, translation, and TTS.",
  "endpoint": "API Endpoint",
  "endpointPlaceholder": "https://my-server.example.com",
  "asrModel": "ASR Model",
  "asrModelPlaceholder": "e.g. qwen3-asr",
  "translateModel": "Translation Model",
  "translateModelPlaceholder": "e.g. qwen3-translate",
  "voice": "My Voice",
  "participantVoice": "Other's Voice"
}
```

In each catalog's `notices` block, add:

```json
"model_not_listed": "The endpoint does not list this model.",
"endpoint_required": "Enter the endpoint URL."
```

**Strategy:** add to `en/translation.json` first, verify the new keys appear. Then for the other 29 catalogs: copy the English strings verbatim (no transliteration — English is the fallback and the non-en catalogs get identical values until localized).

The `manifest.consistency.test.ts` and `registry.test.ts` both pin `providers.<id>.name` and `providers.<id>.description` for every released provider — these two keys must exist in `en` at minimum.

---

## Task 11: Extension manifest

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/manifest.consistency.test.ts` (if it needs updating)

### `manifest.json`

In the `host_permissions` array (currently lines 35–44), add:

```json
"http://*/*",
"https://*/*"
```

In the CSP `connect-src` value (line 120), append:

```
ws://*/* wss://*/*
```

Add a JSON comment note (if the file supports it, otherwise a separate code comment in the test) explaining: "The broad wildcard host_permissions and CSP connect-src entries are for OpenAI Compatible's user-chosen endpoint (`src/providers/openai_compatible/`). The user specifies any HTTPS endpoint; the extension must reach it for `GET /v1/models`, `GET /v1/audio/voices`, and the Realtime WebSocket."

### `manifest.consistency.test.ts`

Run the test. If it passes without changes (the consistency test walks content scripts derived from the registry, not host_permissions), no edit is needed. If it asserts on the `connect-src` string content, update the expected string to include the new wildcards.

---

## Task 12: Full verification

Run the complete test suite and type check:

```bash
npx vitest run
npx tsc --noEmit
```

Expected: all tests pass, no type errors.

Specifically confirm:
- `sessionSide.consistency.test.ts` walks the new provider's folder and passes (the adapter does not import a store or call `report()`).
- `registry.test.ts` passes with the new `PORTED` entry and the updated release order.
- `openai/provider.test.ts` passes with the rewritten tests.
- `manifest.consistency.test.ts` passes.
- The `checkReads` object in `registry.test.ts` includes `openai_compatible: ['endpoint', 'asrModel', 'translateModel']`.

---

## Execution order

Run tasks in this order (dependencies):

1. **Task 1** (settings) — no dependencies
2. **Task 2** (check) — depends on Task 1 (`normalizeEndpoint`, `CompatibleSettings`)
3. **Task 3** (config) — depends on Task 1
4. **Task 4** (wire) — depends on Task 3
5. **Task 5** (adapter + testing) — depends on Tasks 1, 3, 4
6. **Task 6** (settings view) — depends on Tasks 1, 3
7. **Task 7** (provider definition) — depends on Tasks 1–6
8. **Task 8** (registry) — depends on Task 7
9. **Task 9** (update OpenAI provider tests) — depends on Task 8
10. **Task 10** (locales) — depends on Task 8 (registry invariant checks)
11. **Task 11** (manifest) — independent, but run after Task 8
12. **Task 12** (verification) — after all of the above
