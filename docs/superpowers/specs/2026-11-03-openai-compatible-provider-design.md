# OpenAI Compatible Provider — Design

A new, independent provider `openai_compatible` that runs ASR, translation, and TTS
against any OpenAI-compatible endpoint the user names. Re-introduction of the retired
`openai_compatible` id (ruling 1 of the OpenAI Realtime port) — this one is ported,
not retired, and the tests that pinned "registered nowhere" now pin its new place.

## Why

Users run OpenAI-compatible realtime and audio endpoints (Ollama, vLLM, LM Studio,
self-hosted gateways) and want to point Sokuji at them: pick endpoint, pick key, pick
model IDs. Nothing in the current registry offers that — the three OpenAI providers
all dial `api.openai.com`.

## Goals

- One provider, `openai_compatible`, in the picker between OpenAI Live and Soniox.
- All three platforms: `electron`, `extension`, `web`. `kind: 'own-key'`, unflagged.
- **Two** model slots, each a free text field the user fills in themselves:
  - `asrModel` — the transcription model, passed to `audio.input.transcription.model`
    in `session.update`.
  - `translateModel` — the session's dialogue/translation model, passed to
    `?model=` in the WebSocket URL.
- **TTS has no model field.** The Realtime protocol has no separate TTS model
  parameter; TTS is produced inline by the session model's `audio.output`. The
  user picks a voice from the endpoint's `GET /v1/audio/voices` (two fields:
  `voice` for the speaker leg, `participantVoice` for the participant leg),
  sent through `audio.output.voice` in `session.update`.
- **Settings parity with OpenAI Realtime.** Besides the endpoint, the two model
  IDs, and the two voice fields, the provider exposes the same knobs as OpenAI
  Realtime: `turnDetectionMode` (Normal / Semantic), `threshold`,
  `prefixPadding`, `silenceDuration`, `semanticEagerness`, `maxTokens`,
  `noiseReduction`, `transcriptKeywords`, and the instructions
  (`useTemplateMode`, `systemInstructions`, `participantSystemInstructions`).
  The `reasoningEffort` knob is dropped — it is specific to
  `gpt-realtime-2*` OpenAI models and has no meaning on a third-party
  endpoint.
- **Readiness (`check`)** validates against the endpoint's `GET /v1/models` with
  the user's key: both `asrModel` and `translateModel` must each appear in the
  list. When either is absent, `check` answers
  `{ ok: false, code: 'model_not_listed', reason: '…' }`.
- **Languages:** the same 55-language list as OpenAI Realtime
  (`REALTIME_LANGUAGES` in `openai/settings.ts`), with `sources: () => [AUTO, ...55]`,
  `targets: () => 55`. `initial: () => ({ source: 'en', target: 'zh-CN' })`.
  No `reverse` of its own (the plain swap).
- **Capabilities** (same as OpenAI Realtime):
  - `speech: 'optional'` — text-only legs are supported.
  - `textInput: () => true` — typed text is accepted.
  - `boundaries: () => 'provider'` — the server's commits end segments.
  - `turns: () => ['auto', 'manual']` — both turn modes.
  - `participantSpeech: true` (default) — the participant may speak.
  - No `faceToFace`.
  - `checkReads: ['endpoint', 'asrModel', 'translateModel']` — the check is
    re-run when any of these settings fields changes or when the key changes.
    The check itself reads no other settings field.

## Non-goals

- No `voicesInEngine` — voices live in the Settings view.
- No `faceToFace`.
- No `checkReadsDirection` — a language pair change does not re-run the check.
- No `reasoningEffort` setting (specific to OpenAI's `gpt-realtime-2*` models).
- No separate REST TTS path (`POST /v1/audio/speech`) — TTS comes inline
  through the Realtime session's `audio.output`.
- No legacy migration of the *other* fields: a stored selection of the retired
  `openai_compatible` (pre-2026-10, the old `LEGACY_REALTIME` protocol)
  **does** carry forward its `endpoint` and `apiKey` through
  `settings.key: 'openaiCompatible'` (Q4, below). The user's old endpoint and
  key load into the new provider's settings. No other field is migrated; the
  new provider's fields (`asrModel`, `translateModel`, `voice`,
  `participantVoice`, turn detection, etc.) start at their defaults when
  nothing is stored.
- No `flagged: true` — ships in every release build, unflagged, on all three
  platforms.

## Constraints

### Extension manifest (MV3 static declarations)

Chrome extension MV3 declares `host_permissions` and CSP `connect-src`
statically. The new provider's endpoint is user-chosen and cannot be
enumerated ahead of time. The manifest needs:

- Add `"http://*/*"` and `"https://*/*"` to `host_permissions` (broad HTTP
  access, needed for `GET /v1/models` and `GET /v1/audio/voices` against any
  user-chosen HTTPS endpoint).
- Add `ws://*/*` and `wss://*/*` to `connect-src` in the extension's CSP so
  the WebSocket to the user's endpoint can open from the extension's pages.

The `extension/manifest.consistency.test.ts` test pins the manifest against
the registry-derived content scripts; adding these two wildcard entries does
not break it, but add a comment in the manifest noting the wildcards exist
for OpenAI Compatible's user-chosen endpoint.

### Endpoint URL normalization

The endpoint field accepts any user input with no scheme validation beyond
non-empty. Before the check's fetch and before the WebSocket URL
construction, the endpoint must be normalized:

1. Trim whitespace.
2. If it does not start with `http://` or `https://`, prepend `https://`.
3. Strip a trailing `/`.
4. Strip a trailing `/v1` (users paste `https://host/v1`; the provider
   always appends `/v1/realtime` itself).

The normalized URL is what `check` fetches and what the adapter's
WebSocket URL is built from. A short helper `normalizeEndpoint(raw: string): string`
in `settings.ts` does steps 1–4; both `check.ts` and `wire.ts` call it.

### Diagnostics / redaction

`src/lib/diagnostics/redact.ts` already redacts
`openai-insecure-api-key.<key>` subprotocol tokens. The new provider's key
rides the same `openai-insecure-api-key.<key>` subprotocol (Q6 below), so
no new redaction rule is needed. The endpoint URL is not a secret; do not
redact it.

### Error words

The OpenAI Realtime adapter's fixed words name "OpenAI" (`NEVER_OPENED`,
"OpenAI did not start the session within …", "The connection to OpenAI
closed (…)"). For this provider, replace "OpenAI" with "the endpoint" in
every start/close/failure word:

- `NEVER_OPENED` → "The endpoint's socket did not open (check the endpoint
  URL, the network, and that the API key is still valid)."
- start timeout → "The endpoint did not start the session within 30 s."
- close → "The connection to the endpoint closed (code reason)."

The `session_expired` 60-minute cap mapping to `segment_ended` is kept as-is:
a third-party endpoint may or may not honor it, but the mapping is harmless.

### i18n — new keys

All 30 locale catalogs need:

- `providers.openai_compatible.name` — "OpenAI Compatible"
- `providers.openai_compatible.description` — "A custom OpenAI-compatible
  endpoint for realtime ASR, translation, and TTS."
- `providers.openai_compatible.endpoint` — "API Endpoint"
- `providers.openai_compatible.endpointPlaceholder` — "https://my-server.example.com"
- `providers.openai_compatible.asrModel` — "ASR Model"
- `providers.openai_compatible.asrModelPlaceholder` — "e.g. qwen3-asr"
- `providers.openai_compatible.translateModel` — "Translation Model"
- `providers.openai_compatible.translateModelPlaceholder` — "e.g. qwen3-translate"
- `providers.openai_compatible.voice` — "My Voice"
- `providers.openai_compatible.participantVoice` — "Other's Voice"
- `notices.model_not_listed` — "The endpoint does not list this model."
- `notices.endpoint_required` — "Enter the endpoint URL."

The `setup.credentials.endpoint` and `setup.credentials.endpointPlaceholder`
keys were deleted with the retired provider; the new keys above replace
them. The other 29 catalogs: copy the English strings (no transliteration
required; English is the fallback and the picker labels show English on
non-English systems until localized).

### settings.key and LEGACY_SLICE_KEYS

`settings.key: 'openaiCompatible'` — the retired provider's old slice key
(Q4). `LEGACY_SLICE_KEYS['openai_compatible']` is already `'openaiCompatible'`
(today the entry exists but is unreachable because the provider was retired);
this reactivates it. The `registry.test.ts` "ported" allowlist
(`PORTED` constant, line 166) must gain `'openai_compatible'`, and the
"every ported id is the old Provider enum's spelling" test (line 169) now
includes it. The "a stored selection falls to the first offered provider"
test in `openai/provider.test.ts` (line 83) is rewritten:
`selectionFromStored('openai_compatible', offered, ...)` now returns
`{ id: 'openai_compatible', fromStorage: true }` on every platform, because
the provider is offered everywhere. The same test in
`loadStores.test.ts` is updated accordingly.

## Parts (file layout)

`src/providers/openai_compatible/`:

| File | Responsibility |
|------|----------------|
| `provider.ts` | The definition: `id: 'openai_compatible'`, `kind: 'own-key'`, `platforms: ['electron','extension','web']`, `icon: OpenAIIcon`, `settings.key: 'openaiCompatible'`, `credentials`, `check`, `languages`, `speech: 'optional'`, `textInput: () => true`, `boundaries: () => 'provider'`, `turns: () => ['auto','manual']`, `checkReads: ['endpoint','asrModel','translateModel']`, `build`, `describe`, `start`. `TurnDetection` section: `Summary` / `Controls` / `Help` re-using `openai/RealtimeTurnDetection.tsx` components (they are generic over the settings shape). |
| `settings.ts` | `CompatibleSettings` type (below), `COMPATIBLE_DEFAULTS`, `COMPATIBLE_LEGACY_KEYS` (reads `endpoint` and the OpenAI Realtime instruction fields from the old slice; the new fields default), `migrateCompatibleSettings`, `compatibleCredentials`, the 55-language lists (import `REALTIME_LANGUAGES` from `openai/settings.ts` — it is exported), `identityWire()`, `normalizeEndpoint(raw)`. |
| `config.ts` | `CompatibleConfig` type, `buildCompatible`, `describeCompatible`. |
| `check.ts` | `checkCompatible(k, s, ctx)` — normalizes `s.endpoint`, calls
  `GET <endpoint>/v1/models` with the key in the `Authorization` header;
  validates `s.asrModel` and `s.translateModel` are both in the returned
  list; on success returns
  `{ ok: true, models: [{id: asrModel}, {id: translateModel}] }`;
  when the endpoint is empty: `{ ok: false, code: 'endpoint_required', … }`;
  when either model ID is absent from the list:
  `{ ok: false, code: 'model_not_listed', reason: 'The endpoint does not list "<id>".' }`. |
| `adapter.ts` | `createCompatibleAdapter()` — returns an
  `Adapter<CompatibleConfig, CompatibleCredentials>`. The speaker leg and
  participant leg each open one Realtime WebSocket to the endpoint with
  `?model=<translateModel>`; the `session.update` payload carries
  `audio.input.transcription.model = <asrModel>` and
  `audio.output.voice = <voice|participantVoice>`. Mirrors
  `openai/adapter.ts` structurally (same `RealtimeLeg` phases, same
  `RealtimeItems`, same `ResponseQueue`, same drift anchor, same
  error-wording rules) with the endpoint URL and model/voice coming from
  `CompatibleConfig` instead of `RealtimeConfig`. |
| `wire.ts` | `compatibleUrl(c: {endpoint, translateModel})` →
  `wss://<normalized>/v1/realtime?model=<translateModel>`;
  `compatibleProtocols(k)` → `['realtime', 'openai-insecure-api-key.<key>']`;
  `compatibleSessionUpdate(c)` — the `session.update` payload reading
  `CompatibleConfig` (same shape as `openai/wire.ts`'s `sessionUpdate` but
  with `audio.input.transcription.model = c.asrModel` and
  `audio.output.voice = c.voice`). |
| `RealtimeSettings.tsx` | The Settings view (described below). |
| `RealtimeSettings.test.tsx` | Tests for the Settings view. |
| `provider.test.ts` | Definition tests: position in registry, `checkReads`,
  capabilities, the rewritten stored-selection test. |
| `check.test.ts` | Tests for `checkCompatible` with a stubbed `fetch`. |
| `adapter.test.ts` | Tests for the adapter's lifecycle. |
| `config.test.ts` | Tests for `buildCompatible` and `describeCompatible`. |
| `testing.ts` | Test fixtures: `KEY`, `AUTO_CTX`, `SHARED`, `configFor`, etc. |

### `CompatibleSettings` type

```ts
interface CompatibleSettings extends InstructionsSettings {
  endpoint: string;        // raw, not normalized
  asrModel: string;        // free text
  translateModel: string;  // free text
  voice: string;           // '' = endpoint default
  participantVoice: string; // '' = endpoint default
  turnDetectionMode: TurnDetectionMode;  // 'Normal' | 'Semantic'
  threshold: number;
  prefixPadding: number;
  silenceDuration: number;
  semanticEagerness: SemanticEagerness;
  maxTokens: number | 'inf';
  transcriptKeywords: string;
  noiseReduction: NoiseReduction;  // 'None' | 'Near field' | 'Far field'
}
```

`COMPATIBLE_DEFAULTS`: same as `REALTIME_DEFAULTS` except `model` is split
into `asrModel: ''` and `translateModel: ''`, `voice: ''`,
`participantVoice: ''`, `endpoint: ''`. The instruction fields
(`useTemplateMode`, `systemInstructions`, `participantSystemInstructions`)
are inherited from `InstructionsSettings` and read from the old slice via
`COMPATIBLE_LEGACY_KEYS` (the `INSTRUCTION_LEGACY_KEYS` plus `endpoint` and
`asrModel`/`translateModel`/`voice`/`participantVoice` — the new fields
default to `''` or the `REALTIME_DEFAULTS` values respectively).

### Settings view (`RealtimeSettings.tsx`)

Sections in order:

1. **Endpoint** — text input for the endpoint URL, labelled
   `providers.openai_compatible.endpoint`, placeholder
   `providers.openai_compatible.endpointPlaceholder`.
2. **API Key** — secret input, labelled `setup.credentials.apiKey`,
   placeholder `simpleSettings.apiKeyPlaceholder`.
3. **ASR Model** — text input, labelled
   `providers.openai_compatible.asrModel`, placeholder
   `providers.openai_compatible.asrModelPlaceholder`.
4. **Translation Model** — text input, labelled
   `providers.openai_compatible.translateModel`, placeholder
   `providers.openai_compatible.translateModelPlaceholder`.
5. **My Voice** — a select, populated lazily: when the Settings view mounts
   and both `endpoint` and `apiKey` are non-empty, `GET <endpoint>/v1/audio/voices`
   (Authorization: Bearer key, bounded by `CHECK_TIMEOUT_MS`); on a 200
   response whose body is a JSON array of voice objects, populate the
   options; on any other outcome, show a single free-text input. The
   selected value persists to `settings.voice` on change (Q8: write back
   to settings). Labelled `providers.openai_compatible.voice`.
6. **Other's Voice** — same mechanism, persists to
   `settings.participantVoice`. Labelled
   `providers.openai_compatible.participantVoice`. Defaults: when the
   voices list has ≥ 2 entries, `voice` = first, `participantVoice` =
   second (via `distinctVoice`); when it has exactly 1, `voice` = that one,
   `participantVoice` = `''`; when it has 0 (or the fetch fails), both
   default to `''` (endpoint decides).
7. The remaining knobs (`turnDetectionMode`, sliders, `maxTokens`,
   `noiseReduction`, `transcriptKeywords`, instructions) mirror
   `openai/RealtimeSettings.tsx` with the same labels and ranges.
   `reasoningEffort` is omitted.

### Changes to existing files

1. **`src/providers/registry.ts`** — add `openaiCompatibleProvider` to
   `RELEASED` between `openaiLiveProvider` and `sonioxProvider`. Update the
   order test in `registry.test.ts` (the released order now has
   `openai_compatible` at index 8, before `soniox` at index 9).

2. **`src/providers/registry.test.ts`** — add `'openai_compatible'` to
   the `PORTED` constant (line 166). The "released order" assertion
   (line 361) gains `'openai_compatible'` between `'openai_live'` and
   `'soniox'`.

3. **`extension/manifest.json`** — add `http://*/*`, `https://*/*` to
   `host_permissions`; add `ws://*/*`, `wss://*/*` to the CSP
   `connect-src` in `extension_pages`. Update
   `extension/manifest.consistency.test.ts` if needed.

4. **`src/locales/*/translation.json`** (all 30) — add the keys listed
   under "i18n — new keys" above.

5. **`src/providers/openai/provider.test.ts`** — update line 76
   ("OpenAI Compatible is registered nowhere") to assert it **is**
   registered at the right position. Update line 83
   ("a stored OpenAI Compatible selection falls to the first provider
   offered") to assert it now **stays on `openai_compatible`** with
   `fromStorage: true` on all three platforms.

6. **`src/lib/session/loadStores.test.ts`** — update the stored-selection
   test for `openai_compatible` similarly (if it exists at line 86).

## Key decisions (final, resolved)

| # | Question | Answer |
|---|----------|--------|
| 1 | `ttsModel` field | Dropped. TTS is inline through `audio.output.voice`. Two model fields: `asrModel`, `translateModel`. |
| 2 | `settings.key` | `'openaiCompatible'` (the old slice key). Old endpoint/key load forward. |
| 3 | `describe` shape | `describeCompatible(c)` returns `{ asrModel: c.asrModel, translationModel: c.translateModel }` — no `ttsModel`. |
| 4 | `checkReads` | `['endpoint', 'asrModel', 'translateModel']`. A change to any of these re-runs the check. No `effectiveCompatibleModel` function is needed — `buildCompatible` trusts the settings verbatim (no model-list filtering at build time; the check already validated). |
| 5 | Voice persistence | The Settings view writes the chosen `voice` / `participantVoice` back to settings on change (persistent, not re-fetched on reload). |
| 6 | Subprotocol | Same as OpenAI Realtime: `['realtime', 'openai-insecure-api-key.<key>']`. No change to `redact.ts` needed. |
| 7 | Endpoint normalization | Trim, default `https://`, strip trailing `/` and `/v1`. Helper in `settings.ts`. |
| 8 | Initial language pair | `{ source: 'en', target: 'zh-CN' }`, same as OpenAI Realtime. No `reverse` (plain swap). |
| 9 | `textInput` / `turns` / `boundaries` | Same as OpenAI Realtime: `textInput: () => true`, `turns: () => ['auto','manual']`, `boundaries: () => 'provider'`. |
| 10 | `reasoningEffort` | Dropped — specific to OpenAI's `gpt-realtime-2*` models. |

## What is left to the builder

- The exact implementation of `checkCompatible`'s fetch: mirror
  `openaiModels.ts`'s `createOpenAIModelCheck` pattern but pointed at the
  user's normalized endpoint, with `keep` matching the two typed model IDs
  (a Set lookup, not a family-prefix filter).
- The lazy fetch of `/v1/audio/voices` in the Settings view: use
  `boundedFetch` with the normalized endpoint's `/v1/audio/voices` URL and
  `Authorization: Bearer <key>` (not `x-goog-api-key`).
- The `RealtimeSettings.tsx` component: mirror `openai/RealtimeSettings.tsx`
  with the endpoint field, two model fields, two voice fields, and no
  `reasoningEffort`. The voice fetch happens in a `useEffect` on mount and
  on `endpoint`/`apiKey` change, writing the chosen value back via
  `update({ voice })` / `update({ participantVoice })`.
- The `session.update` payload: same as `openai/wire.ts`'s `sessionUpdate`
  but reading from `CompatibleConfig` (with `audio.input.transcription.model`
  = `asrModel`, `audio.output.voice` = `voice`).
- The conformance test suite pass (`src/lib/contract/conformance.ts`).
- The `TurnDetection` section: re-use `openai/RealtimeTurnDetection.tsx`
  components directly (they are generic over the settings shape and read
  the same field names). If a type mismatch appears, lift them to
  `src/lib/provider/` — the builder decides.
