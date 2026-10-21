import { render, screen } from '@testing-library/react';
import translation from '~/locales/en/translation.json';
import Error from '../Error';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
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

  it('still shows unknown JSON errors verbatim', () => {
    const text = JSON.stringify({ code: 'SOMETHING_ELSE' });
    render(<>{Error({ text })}</>);

    expect(screen.getByText(/Something went wrong/)).toHaveTextContent(text);
  });
});
