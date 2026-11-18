import React from 'react';
import { render } from '@testing-library/react';
import MaskedText from '../MaskedText';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    [key, ...Object.values(values ?? {})].join(' '),
}));

describe('MaskedText', () => {
  it('marks each replacement at its code-point range, named by its category', () => {
    const { container } = render(
      <MaskedText
        text="🙂 Mail [EMAIL] about [Projects]"
        masks={[
          { start: 7, end: 14, category: 'EMAIL_ADDRESS' },
          { start: 21, end: 31, category: 'CUSTOM_8F14E45F', label: 'Projects' },
        ]}
      />,
    );

    const [email, project] = Array.from(container.querySelectorAll('mark'));
    expect(email).toHaveTextContent('[EMAIL]');
    expect(email).toHaveAttribute('title', 'com_ui_dlp_category_email_address');
    expect(project).toHaveTextContent('[Projects]');
    expect(project).toHaveAttribute('title', 'Projects');
    expect(container.textContent).toBe(
      '🙂 Mail [EMAIL] (com_ui_dlp_masked_value com_ui_dlp_category_email_address) ' +
        'about [Projects] (com_ui_dlp_masked_value Projects)',
    );
  });

  it('leaves out a mask that overlaps an earlier one or runs past the text', () => {
    const { container } = render(
      <MaskedText
        text="Mail [EMAIL]"
        masks={[
          { start: 5, end: 12, category: 'EMAIL_ADDRESS' },
          { start: 8, end: 10, category: 'EMAIL_ADDRESS' },
          { start: 10, end: 40, category: 'EMAIL_ADDRESS' },
        ]}
      />,
    );

    expect(container.querySelectorAll('mark')).toHaveLength(1);
  });
});
