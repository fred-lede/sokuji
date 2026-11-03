import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useContext } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, values?: Record<string, unknown>) => {
      const options = typeof fallback === 'object' ? fallback : values;
      const text = typeof fallback === 'string' ? fallback : key;
      return options ? text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name])) : text;
    },
  }),
}));
const tooltips: unknown[] = [];
vi.mock('../../components/Tooltip/Tooltip', () => ({ default: ({ content }: { content: unknown }) => { tooltips.push(content); return null; } }));
import type { VoiceLibrarySectionProps } from '../../components/Settings/sections/VoiceLibrarySection';
import { VoicePreviewContext } from '../../components/providers/VoicePreviewContext';
const { library, previewRealtimeVoice } = vi.hoisted(() => ({
  library: [] as Array<VoiceLibrarySectionProps & { port: unknown }>,
  previewRealtimeVoice: vi.fn(async () => null),
}));
vi.mock('../../components/Settings/sections/VoiceLibrarySection', () => ({
  default: function Library(props: VoiceLibrarySectionProps) {
    library.push({ ...props, port: useContext(VoicePreviewContext) });
    return null;
  },
}));
vi.mock('../openai/preview', () => ({ previewRealtimeVoice }));
const libraryProps = () => library[library.length - 1];

import type { SettingsProps } from '../../lib/provider/types';
import { CompatibleSettingsView, CompatibleVoiceSummary } from './RealtimeSettings';
import { COMPATIBLE_DEFAULTS, REALTIME_VOICES, type CompatibleSettings } from './settings';

const props = (patch: Partial<SettingsProps<CompatibleSettings>> = {}): SettingsProps<CompatibleSettings> => ({
  settings: COMPATIBLE_DEFAULTS,
  update: vi.fn(),
  pair: { source: 'ja', target: 'en' },
  models: [],
  ...patch,
});
beforeEach(() => {
  library.length = 0;
  previewRealtimeVoice.mockClear();
});

const headings = (container: HTMLElement) => Array.from(container.querySelectorAll('.settings-section > h2')).map((h) => h.textContent);

describe('CompatibleSettingsView', () => {
  it('draws the sections in order: instructions, voice, endpoint, ASR model, translation model, noise reduction, model configuration — no transcript model, reasoning effort, or transport', () => {
    const { container } = render(<CompatibleSettingsView {...props()} />);
    expect(headings(container)).toEqual([
      'settings.systemInstructions', 'Voice Settings', 'Endpoint', 'ASR Model', 'Translation Model',
      'settings.noiseReduction', 'settings.modelConfiguration',
    ]);
    expect(screen.queryByLabelText('settings.userTranscriptModel')).toBeNull();
    expect(screen.queryByLabelText('settings.reasoningEffort')).toBeNull();
    expect(container.textContent).not.toMatch(/WebRTC|settings\.pushToTalk|settings\.pushToTranslate/);
  });

  it("previews Quick's prompt for the pair, and edits its own instructions", () => {
    const update = vi.fn();
    const { container } = render(<CompatibleSettingsView {...props({ update })} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.preview' }));
    expect(container.querySelector('.preview-content')?.textContent).toContain('translate Japanese → English.');
    fireEvent.click(screen.getByRole('button', { name: 'settings.advanced' }));
    expect(update).toHaveBeenCalledWith({ useTemplateMode: false });
  });

  it('writes the voice, the endpoint, the ASR model, the translation model, the noise reduction and the max tokens', () => {
    const update = vi.fn();
    render(<CompatibleSettingsView {...props({ update, settings: { ...COMPATIBLE_DEFAULTS, endpoint: 'https://my.host' } })} />);
    const library = libraryProps();
    expect(library.voices.map((v) => v.id)).toEqual(REALTIME_VOICES.map((v) => v.value));
    library.onSelect('marin');
    expect(update).toHaveBeenCalledWith({ voice: 'marin' });
    const endpoint = screen.getByLabelText('settings.endpoint') as HTMLInputElement;
    expect(endpoint.value).toBe('https://my.host');
    fireEvent.change(endpoint, { target: { value: 'https://new.host' } });
    expect(update).toHaveBeenCalledWith({ endpoint: 'https://new.host' });
    const asrModel = screen.getByLabelText('settings.asrModel') as HTMLInputElement;
    fireEvent.change(asrModel, { target: { value: 'whisper-1' } });
    expect(update).toHaveBeenCalledWith({ asrModel: 'whisper-1' });
    const translateModel = screen.getByLabelText('settings.translateModel') as HTMLInputElement;
    fireEvent.change(translateModel, { target: { value: 'gpt-4o' } });
    expect(update).toHaveBeenCalledWith({ translateModel: 'gpt-4o' });
    fireEvent.change(screen.getByLabelText('settings.noiseReduction'), { target: { value: 'Near field' } });
    expect(update).toHaveBeenCalledWith({ noiseReduction: 'Near field' });
    fireEvent.click(screen.getByLabelText('Unlimited'));
    expect(update).toHaveBeenCalledWith({ maxTokens: 4096 });
  });

  it('lists each voice by its name alone and auditions it with its published sample, through the host\'s preview route (preset voice preview)', async () => {
    const port = { play: vi.fn(async () => {}), stop: vi.fn() };
    render(<CompatibleSettingsView {...props({ preview: port })} />);
    const library = libraryProps();
    expect(library.voices.find((v) => v.id === 'cedar')).toEqual({ id: 'cedar', label: 'Cedar', group: 'builtin', removable: false, previewable: true });
    expect(library.selectedId).toBe(COMPATIBLE_DEFAULTS.voice);
    expect(library.port).toBe(port);
    expect(library.manageNote).toBeUndefined();
    const signal = new AbortController().signal;
    await library.onPreview!('cedar', signal);
    expect(previewRealtimeVoice).toHaveBeenCalledWith('cedar', signal);
  });

  it('disabled locks every control', () => {
    render(<CompatibleSettingsView {...props({ disabled: true })} />);
    expect(libraryProps().isSessionActive).toBe(true);
    for (const label of ['settings.endpoint', 'settings.asrModel', 'settings.translateModel', 'settings.noiseReduction', 'Unlimited']) {
      expect(screen.getByLabelText(label), label).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'settings.advanced' })).toBeDisabled();
  });
});

describe('CompatibleVoiceSummary', () => {
  it("names the one voice under both legs by its list's name, the default when none is stored", () => {
    const text = (voice: string, leg: 'speaker' | 'participant') =>
      render(<CompatibleVoiceSummary settings={{ ...COMPATIBLE_DEFAULTS, voice }} update={() => {}} leg={leg} />).container.textContent;
    expect(text('ash', 'speaker')).toBe('Ash');
    // The participant's default is ash: my own voice, so a run swaps it.
    expect(text('ash', 'participant')).toBe('Alloy');
    expect(text('', 'speaker')).toBe('Alloy');
  });
});

describe('CompatibleSettingsView, the participant spoken', () => {
  it("adds the other party's row, auditioning the same published samples, writing its own field", () => {
    const update = vi.fn();
    render(<CompatibleSettingsView {...props({ update, participantSpeaks: true })} />);
    const [mine, theirs] = library.slice(-2);
    expect(mine.label).toBe('Voice the other side hears');
    expect(theirs.label).toBe('Voice I hear');
    expect(theirs.selectedId).toBe('ash');
    expect(theirs.onPreview).toBe(mine.onPreview);
    theirs.onSelect('coral');
    expect(update).toHaveBeenCalledWith({ participantVoice: 'coral' });
  });
});