import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, values?: Record<string, unknown>) => {
      const text = typeof fallback === 'string' ? fallback : key;
      const options = typeof fallback === 'object' ? fallback : values;
      return options ? text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? '')) : text;
    },
  }),
}));

vi.mock('../../components/Tooltip/Tooltip', () => ({
  default: ({ content }: { content: unknown }) => { void content; return null; },
}));

// Suppress real fetch in the useEndpointVoices hook.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import type { SettingsProps, ProviderAccount } from '../../lib/provider/types';
import { CompatibleSettingsView, CompatibleVoiceSummary } from './RealtimeSettings';
import { COMPATIBLE_DEFAULTS, type CompatibleSettings } from './settings';

function props(patch: Partial<SettingsProps<CompatibleSettings>> = {}): SettingsProps<CompatibleSettings> {
  return {
    settings: COMPATIBLE_DEFAULTS,
    update: vi.fn(),
    pair: { source: 'en', target: 'zh-CN' },
    account: { credentials: { apiKey: 'sk-test' }, auth: { signedIn: false, getToken: async () => null } } as unknown as ProviderAccount,
    ...patch,
  };
}

function withVoices(): void {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => [{ id: 'voice-a', name: 'Voice A' }, { id: 'voice-b', name: 'Voice B' }],
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('CompatibleSettingsView', () => {
  it('renders the endpoint field; typing calls update with the new value', () => {
    const update = vi.fn();
    const { container } = render(<CompatibleSettingsView {...props({ update, settings: { ...COMPATIBLE_DEFAULTS, endpoint: 'https://host.com' } })} />);
    const endpointInput = container.querySelector('input[aria-label="providers.openai_compatible.endpoint"]') as HTMLInputElement;
    expect(endpointInput).not.toBeNull();
    expect(endpointInput!.value).toBe('https://host.com');
    fireEvent.change(endpointInput!, { target: { value: 'https://new-host.com' } });
    expect(update).toHaveBeenCalledWith({ endpoint: 'https://new-host.com' });
  });

  it('renders the asrModel field; typing calls update with the new value', () => {
    const update = vi.fn();
    const { container } = render(<CompatibleSettingsView {...props({ update })} />);
    const asrInput = container.querySelector('input[aria-label="providers.openai_compatible.asrModel"]') as HTMLInputElement;
    expect(asrInput).not.toBeNull();
    fireEvent.change(asrInput!, { target: { value: 'qwen3-asr' } });
    expect(update).toHaveBeenCalledWith({ asrModel: 'qwen3-asr' });
  });

  it('renders the translateModel field; typing calls update with the new value', () => {
    const update = vi.fn();
    const { container } = render(<CompatibleSettingsView {...props({ update })} />);
    const translateInput = container.querySelector('input[aria-label="providers.openai_compatible.translateModel"]') as HTMLInputElement;
    expect(translateInput).not.toBeNull();
    fireEvent.change(translateInput!, { target: { value: 'qwen3-translate' } });
    expect(update).toHaveBeenCalledWith({ translateModel: 'qwen3-translate' });
  });

  it('shows a free-text input for voice when the fetch fails or is skipped', () => {
    // No endpoint: the fetch is skipped, so the voice fields render as free-text inputs.
    const update = vi.fn();
    const { container } = render(<CompatibleSettingsView {...props({ update })} />);
    const voiceInput = container.querySelector('input[aria-label="providers.openai_compatible.voice"]') as HTMLInputElement;
    expect(voiceInput).not.toBeNull();
    fireEvent.change(voiceInput!, { target: { value: 'custom-voice' } });
    expect(update).toHaveBeenCalledWith({ voice: 'custom-voice' });
  });

  it('shows a select for voice when the endpoint and key are set and the fetch succeeds', async () => {
    withVoices();
    const update = vi.fn();
    const p = props({
      update,
      settings: { ...COMPATIBLE_DEFAULTS, endpoint: 'https://host.com' },
      account: { credentials: { apiKey: 'sk-test' }, auth: { signedIn: false, getToken: async () => null } } as unknown as ProviderAccount,
    });
    const { container, rerender } = render(<CompatibleSettingsView {...p} />);

    // Wait for the async fetch to complete and re-render.
    await act(async () => {
      // Trigger a state update by re-rendering
      rerender(<CompatibleSettingsView {...p} />);
    });

    const voiceSelect = container.querySelector('select[aria-label="providers.openai_compatible.voice"]') as HTMLSelectElement;
    expect(voiceSelect).not.toBeNull();
    expect(voiceSelect!.options.length).toBeGreaterThanOrEqual(3); // "Use default" + 2 voices
  });

  it('changing the participant voice calls update with participantVoice', () => {
    const update = vi.fn();
    const { container } = render(<CompatibleSettingsView {...props({ update })} />);
    const participantInput = container.querySelector('input[aria-label="providers.openai_compatible.participantVoice"]') as HTMLInputElement;
    expect(participantInput).not.toBeNull();
    fireEvent.change(participantInput!, { target: { value: 'participant-v1' } });
    expect(update).toHaveBeenCalledWith({ participantVoice: 'participant-v1' });
  });

  it('renders the noise reduction field', () => {
    const update = vi.fn();
    const { container } = render(<CompatibleSettingsView {...props({ update })} />);
    const noiseSelect = container.querySelector('select[aria-label="settings.noiseReduction"]') as HTMLSelectElement;
    expect(noiseSelect).not.toBeNull();
  });

  it('renders the instructions field', () => {
    const { container } = render(<CompatibleSettingsView {...props()} />);
    // InstructionsField renders a section with an instructions heading
    expect(container.textContent).toMatch(/instructions/i);
  });
});

describe('CompatibleVoiceSummary', () => {
  it('names the voice value, or "default" when empty', () => {
    const renderVoice = (voice: string, leg: 'speaker' | 'participant') =>
      render(
        <CompatibleVoiceSummary
          settings={{ ...COMPATIBLE_DEFAULTS, voice, participantVoice: voice === '' ? '' : 'other-voice' }}
          update={() => {}}
          leg={leg}
        />,
      ).container.textContent;
    expect(renderVoice('my-voice', 'speaker')).toContain('my-voice');
    expect(renderVoice('', 'speaker')).toContain('default');
  });
});
