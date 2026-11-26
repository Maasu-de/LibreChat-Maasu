import { SettingsTabValues } from 'librechat-data-provider';
import type { SettingsContextValue } from '../types';
import { render, screen } from 'test/layout-test-utils';
import Content from '../Content';

const ctx: SettingsContextValue = {
  governancePilot: true,
  balanceEnabled: false,
  hasAnyPersonalizationFeature: false,
  hasMemoryOptOut: false,
  hasRemoteAgents: false,
  hasUserProvidedEndpoints: false,
  hasMultiConvo: false,
  hasPrompts: false,
  isLocalProvider: false,
  twoFactorEnabled: false,
  allowAccountDeletion: false,
  aboutEnabled: false,
  engineTTS: 'browser',
};

describe('governed account deletion settings', () => {
  it.each(['', 'Delete Account'])('hides Delete Account with search query "%s"', (query) => {
    const { rerender } = render(
      <Content
        activeTab={SettingsTabValues.ACCOUNT}
        query={query}
        ctx={{ ...ctx, allowAccountDeletion: true }}
      />,
    );
    expect(screen.getByRole('button', { name: /^delete account$/i })).toBeInTheDocument();

    rerender(<Content activeTab={SettingsTabValues.ACCOUNT} query={query} ctx={ctx} />);
    expect(screen.queryByRole('button', { name: /^delete account$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^delete account$/i)).not.toBeInTheDocument();
  });
});
