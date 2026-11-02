/**
 * OpenAI Compatible's own settings view: the endpoint, the key (handled
 * by the provider's credential fields, not here), the two free-text model
 * fields, the two voice fields (populated lazily from `GET /v1/audio/voices`
 * when both endpoint and key are set, falling back to free text on failure),
 * the turn-detection controls (the same ones as OpenAI Realtime, which read
 * the same field names), the noise reduction, and the instructions.
 * No reasoning effort, no model picker (both model fields are free text).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InstructionsField } from '../../components/providers/fields/InstructionsField';
import { ModelConfigurationField } from '../../components/providers/fields/ModelConfigurationField';
import { NoiseReductionField } from '../../components/providers/fields/NoiseReductionField';
import { resolveInstructions } from '../../lib/provider/instructions';
import { boundedFetch } from '../../lib/provider/boundedFetch';
import { realClock } from '../../lib/contract/clock';
import type { SettingsProps, VoiceSummaryProps } from '../../lib/provider/types';
import {
  RealtimeTurnDetectionControls, RealtimeTurnDetectionHelp, RealtimeTurnDetectionSummary,
} from '../openai/RealtimeTurnDetection';
import { REALTIME_MAX_TOKENS_RANGE, NOISE_REDUCTIONS } from '../openai/settings';
import {
  compatibleLanguageName, compatibleLanguages,
  normalizeEndpoint,
  type CompatibleSettings,
} from './settings';

/** One entry in the endpoint's voice list. */
interface VoiceEntry { value: string; name: string }

/**
 * Fetches the endpoint's voice list on mount and when endpoint/key change.
 * Returns the voices (null when the fetch failed or was skipped).
 */
function useEndpointVoices(endpoint: string, apiKey: string): VoiceEntry[] | null {
  const [voices, setVoices] = useState<VoiceEntry[] | null>(null);
  const inFlight = useRef(false);

  const fetchVoices = useCallback(async () => {
    const normalized = normalizeEndpoint(endpoint);
    if (!normalized || !apiKey.trim()) { setVoices(null); return; }
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await boundedFetch(
        { clock: realClock, ms: 10_000, late: '' },
        async (signal) => {
          const res = await fetch(`${normalized}/v1/audio/voices`, {
            headers: { Authorization: `Bearer ${apiKey.trim()}` },
            signal,
          });
          if (!res.ok) { setVoices(null); return; }
          const body: unknown = await res.json();
          const list = Array.isArray(body)
            ? body
            : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
              ? (body as { data: unknown[] }).data
              : null;
          if (!list) { setVoices(null); return; }
          const entries: VoiceEntry[] = list
            .filter((v): v is { id?: unknown; name?: unknown } => v !== null && typeof v === 'object')
            .map((v) => ({ value: String((v as { id?: unknown }).id ?? ''), name: String((v as { name?: unknown }).name ?? '') }))
            .filter((v) => v.value !== '');
          setVoices(entries.length > 0 ? entries : null);
        },
      );
    } catch {
      setVoices(null);
    } finally {
      inFlight.current = false;
    }
  }, [endpoint, apiKey]);

  useEffect(() => { void fetchVoices(); }, [fetchVoices]);

  return voices;
}

/**
 * A voice field: a `<select>` when the endpoint's voice list is available,
 * a free-text input when it is not (no list, no endpoint, no key, or fetch
 * failed).
 */
function VoiceInput({
  labelKey, value, voices, onChange, disabled = false,
}: {
  labelKey: string;
  value: string;
  voices: VoiceEntry[] | null;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (voices && voices.length > 0) {
    return (
      <div className="setting-item">
        <div className="setting-label"><span>{t(labelKey)}</span></div>
        <select
          className="select-dropdown"
          aria-label={t(labelKey)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        >
          <option value="">{t('settings.useDefault', 'Use default')}</option>
          {voices.map((v) => (
            <option key={v.value} value={v.value}>{v.name || v.value}</option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <div className="setting-item">
      <div className="setting-label"><span>{t(labelKey)}</span></div>
      <input
        type="text"
        className="text-input"
        aria-label={t(labelKey)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t(`${labelKey}Placeholder`, '')}
        disabled={disabled}
      />
    </div>
  );
}

/** The voice summary shown in the provider card. */
export function CompatibleVoiceSummary({ settings, leg }: VoiceSummaryProps<CompatibleSettings>) {
  const { t } = useTranslation();
  const voice = leg === 'participant' ? settings.participantVoice : settings.voice;
  return <>{t('settings.voice', 'Voice')} {voice ? `· ${voice}` : '· ' + t('settings.useDefault', 'default')}</>;
}

/** OpenAI Compatible's own settings (the plan's Task 6 view). */
export function CompatibleSettingsView({
  settings, update, disabled = false, pair, account,
}: SettingsProps<CompatibleSettings>) {
  const { t } = useTranslation();
  const apiKey = ((account?.credentials.apiKey ?? '') as string).trim();
  const voices = useEndpointVoices(settings.endpoint, apiKey);

  const initial = compatibleLanguages.initial?.(settings);
  const source = pair?.source ?? initial?.source ?? '';
  const target = pair?.target ?? initial?.target ?? '';
  const preview = resolveInstructions(settings, { participant: false, source: compatibleLanguageName(source), target: compatibleLanguageName(target) });

  const textInput = (labelKey: string, value: string, placeholder: string, write: (v: string) => void) => (
    <div className="setting-item">
      <div className="setting-label"><span>{t(labelKey)}</span></div>
      <input
        type="text"
        className="text-input"
        aria-label={t(labelKey)}
        value={value}
        placeholder={t(placeholder, '')}
        onChange={(e) => write(e.target.value)}
        disabled={disabled}
      />
    </div>
  );

  return (
    <>
      {/* 1. Endpoint */}
      {textInput(
        'providers.openai_compatible.endpoint',
        settings.endpoint,
        'providers.openai_compatible.endpointPlaceholder',
        (endpoint) => update({ endpoint }),
      )}

      {/* 2. ASR Model */}
      {textInput(
        'providers.openai_compatible.asrModel',
        settings.asrModel,
        'providers.openai_compatible.asrModelPlaceholder',
        (asrModel) => update({ asrModel }),
      )}

      {/* 3. Translation Model */}
      {textInput(
        'providers.openai_compatible.translateModel',
        settings.translateModel,
        'providers.openai_compatible.translateModelPlaceholder',
        (translateModel) => update({ translateModel }),
      )}

      {/* 4. My Voice */}
      <VoiceInput
        labelKey="providers.openai_compatible.voice"
        value={settings.voice}
        voices={voices}
        onChange={(voice) => update({ voice })}
        disabled={disabled}
      />

      {/* 5. Other's Voice */}
      <VoiceInput
        labelKey="providers.openai_compatible.participantVoice"
        value={settings.participantVoice}
        voices={voices}
        onChange={(participantVoice) => update({ participantVoice })}
        disabled={disabled}
      />

      {/* 6. Turn detection (the same components as OpenAI Realtime — they read the same field names). */}
      <RealtimeTurnDetectionSummary settings={settings as never} update={() => {}} />
      <RealtimeTurnDetectionHelp settings={settings as never} update={() => {}} />
      <RealtimeTurnDetectionControls
        settings={settings as never}
        update={(patch) => update(patch as Partial<CompatibleSettings>)}
        disabled={disabled}
      />

      {/* 7. Noise reduction */}
      <NoiseReductionField
        value={settings.noiseReduction}
        options={NOISE_REDUCTIONS}
        onChange={(noiseReduction) => update({ noiseReduction })}
        disabled={disabled}
      />

      {/* 8. Max tokens */}
      <ModelConfigurationField
        maxTokens={settings.maxTokens}
        maxTokensRange={REALTIME_MAX_TOKENS_RANGE}
        onChange={({ maxTokens }) => { if (maxTokens !== undefined) update({ maxTokens }); }}
        disabled={disabled}
      />

      {/* 9. Instructions */}
      <InstructionsField
        value={settings as never}
        onChange={(patch) => update(patch as Partial<CompatibleSettings>)}
        preview={preview}
        disabled={disabled}
      />
    </>
  );
}
