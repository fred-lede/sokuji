import { InstructionsField } from '../../components/providers/fields/InstructionsField';
import { ModelConfigurationField } from '../../components/providers/fields/ModelConfigurationField';
import { NoiseReductionField } from '../../components/providers/fields/NoiseReductionField';
import { PresetVoiceField, presetVoice, presetVoiceSummary } from '../../components/providers/fields/PresetVoiceField';
import { resolveInstructions } from '../../lib/provider/instructions';
import type { SettingsProps } from '../../lib/provider/types';
import { previewRealtimeVoice } from '../openai/preview';
import { TextField } from '../../components/providers/fields/TextField';
import {
  NOISE_REDUCTIONS, realtimeLanguageName, realtimeLanguages, realtimeParticipantVoice, realtimeSpeakerVoice, REALTIME_MAX_TOKENS_RANGE, REALTIME_VOICES,
  type CompatibleSettings as S,
} from './settings';
import { CompatibleTurnDetectionSummary, CompatibleTurnDetectionControls, CompatibleTurnDetectionHelp } from './RealtimeTurnDetection';

const VOICES = REALTIME_VOICES.map(presetVoice);

/** Each leg's voice as its run speaks it (`config.ts`). */
export const CompatibleVoiceSummary = presetVoiceSummary<S>(REALTIME_VOICES, ({ settings, leg }) =>
  leg === 'participant' ? realtimeParticipantVoice(settings) : realtimeSpeakerVoice(settings));

/**
 * OpenAI Compatible's settings (D18): its instructions, the voice — in the
 * voice library with OpenAI's published samples (preset voice preview) — the
 * endpoint, the ASR model, the translation model, the noise reduction,
 * the max tokens, and the automatic-detection knobs (TurnDetection). No
 * single model, no transcription model, no reasoning effort, no transport
 * (WebSocket only). No temperature (ruling 6).
 */
export function CompatibleSettingsView({ settings, update, disabled = false, pair, models = [], participantSpeaks = false, preview: port }: SettingsProps<S>) {
  const initial = realtimeLanguages.initial?.(settings);
  const source = pair?.source ?? initial?.source ?? '';
  const target = pair?.target ?? initial?.target ?? '';
  const preview = resolveInstructions(settings, { participant: false, source: realtimeLanguageName(source), target: realtimeLanguageName(target) });
  return (
    <>
      <InstructionsField value={settings} onChange={update} preview={preview} disabled={disabled} />
      <PresetVoiceField
        voices={VOICES} value={settings.voice} onChange={(voice) => update({ voice })} onPreview={previewRealtimeVoice} preview={port} disabled={disabled}
        participant={participantSpeaks ? { value: settings.participantVoice, effective: realtimeParticipantVoice(settings), onChange: (participantVoice) => update({ participantVoice }) } : undefined}
      />
      <div className="settings-section">
        <h2>
          {settings.leg === 'participant' ? 'Endpoint' : 'Endpoint'}
        </h2>
        <TextField
          id="compatible-endpoint"
          label="settings.endpoint"
          tooltip="settings.endpointTooltip"
          value={settings.endpoint}
          onChange={(endpoint) => update({ endpoint })}
          disabled={disabled}
          link={{ href: 'https://github.com/openai/openai-realtime-api-beta', label: 'OpenAI Realtime API docs' }}
        />
      </div>
      <div className="settings-section">
        <h2>ASR Model</h2>
        <TextField
          id="compatible-asr-model"
          label="settings.asrModel"
          tooltip="settings.asrModelTooltip"
          value={settings.asrModel}
          onChange={(asrModel) => update({ asrModel })}
          disabled={disabled}
        />
      </div>
      <div className="settings-section">
        <h2>Translation Model</h2>
        <TextField
          id="compatible-translate-model"
          label="settings.translateModel"
          tooltip="settings.translateModelTooltip"
          value={settings.translateModel}
          onChange={(translateModel) => update({ translateModel })}
          disabled={disabled}
        />
      </div>
      <NoiseReductionField value={settings.noiseReduction} options={NOISE_REDUCTIONS} onChange={(noiseReduction) => update({ noiseReduction })} disabled={disabled} />
      <ModelConfigurationField maxTokens={settings.maxTokens} maxTokensRange={REALTIME_MAX_TOKENS_RANGE} onChange={({ maxTokens }) => { if (maxTokens !== undefined) update({ maxTokens }); }} disabled={disabled} />
    </>
  );
}