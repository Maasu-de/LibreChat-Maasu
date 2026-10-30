import { render, screen } from '@testing-library/react';
import translation from '~/locales/en/translation.json';
import Error from '../Error';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    [key, ...Object.values(values ?? {})].join(' '),
}));

describe('Error', () => {
  it.each([
    ['AUTHENTICATION_REQUIRED', 'com_error_authentication_required'],
    ['ACCESS_DENIED', 'com_error_access_denied'],
    ['AUTHENTICATION_SERVICE_UNAVAILABLE', 'com_error_authentication_service_unavailable'],
  ])('shows a readable message for the SSO gateway code %s', (code, key) => {
    render(<>{Error({ text: JSON.stringify({ code }) })}</>);

    expect(screen.getByText(key)).toBeInTheDocument();
    expect(translation).toHaveProperty(key);
  });

  it.each([
    ['EU Sovereign, EU Hosted', 'com_error_governance_model_not_allowed'],
    ['', 'com_error_governance_no_model_allowed'],
  ])('explains a model the content does not allow, given the tiers "%s"', (info, key) => {
    const text = `403 ${JSON.stringify({ type: 'governance_model_not_allowed', info })}`;
    render(<>{Error({ text })}</>);

    expect(screen.getByText(`${key} ${info}`.trim())).toBeInTheDocument();
    expect(translation).toHaveProperty(key);
  });

  it('still shows unknown JSON errors verbatim', () => {
    const text = JSON.stringify({ code: 'SOMETHING_ELSE' });
    render(<>{Error({ text })}</>);

    expect(screen.getByText(/Something went wrong/)).toHaveTextContent(text);
  });
});
