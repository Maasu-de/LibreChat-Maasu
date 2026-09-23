import { isValidElementType } from 'react-is';
import { SettingsTabValues } from 'librechat-data-provider';
import type { SettingsContextValue } from '../types';
import en from '~/locales/en/translation.json';
import { filterSettings } from '../search';
import { registry } from '../registry';
import { TABS } from '../types';

const validTabSections = new Map(TABS.map((t) => [t.id, new Set(t.sections.map((s) => s.id))]));

describe('settings registry', () => {
  it('has unique ids', () => {
    const ids = registry.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('references a valid tab and section for every entry', () => {
    for (const entry of registry) {
      const sections = validTabSections.get(entry.tab);
      expect(sections).toBeDefined();
      expect(sections!.has(entry.section)).toBe(true);
    }
  });

  it('uses label keys that exist in the English locale', () => {
    for (const entry of registry) {
      expect(en).toHaveProperty(entry.labelKey);
    }
  });

  it('has a renderable Component for every entry', () => {
    for (const entry of registry) {
      expect(isValidElementType(entry.Component)).toBe(true);
    }
  });
});

it('omits unsupported actions from pilot settings, including search results', () => {
  const ctx: SettingsContextValue = {
    governancePilot: true,
    balanceEnabled: false,
    hasAnyPersonalizationFeature: false,
    hasMemoryOptOut: false,
    hasRemoteAgents: false,
    hasUserProvidedEndpoints: false,
    hasMultiConvo: false,
    hasPrompts: true,
    isLocalProvider: false,
    twoFactorEnabled: false,
    allowAccountDeletion: false,
    aboutEnabled: true,
    engineTTS: 'browser',
  };
  expect(TABS.find((tab) => tab.id === SettingsTabValues.SPEECH)?.show?.(ctx)).toBe(false);
  const entries = filterSettings(registry, '', ctx, (key) => key).map((result) => result.entry);
  expect(entries.some((entry) => entry.tab === SettingsTabValues.SPEECH)).toBe(false);
  expect(entries.some((entry) => entry.id === 'importConversations')).toBe(false);
  expect(entries.some((entry) => entry.id === 'avatar')).toBe(false);
  expect(entries.some((entry) => entry.id === 'revokeKeys')).toBe(false);
  const revokeKeys = registry.find((entry) => entry.id === 'revokeKeys');
  expect(revokeKeys?.show?.(ctx)).toBe(false);
  expect(revokeKeys?.show?.({ ...ctx, governancePilot: false })).toBe(true);
  expect(registry.find((entry) => entry.id === 'avatar')?.show?.(ctx)).toBe(false);
  expect(
    registry.find((entry) => entry.id === 'avatar')?.show?.({ ...ctx, governancePilot: false }),
  ).toBe(true);
});
