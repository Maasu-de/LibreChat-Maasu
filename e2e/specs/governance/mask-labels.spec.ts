import { expect, test } from '@playwright/test';
import { isAgentsStream, messagesView, sendMessage } from '../mock/helpers';
import { newGovernedChat } from './helpers';

test('custom mask labels are shown in the review without changing governed content', async ({
  page,
}) => {
  await newGovernedChat(page);
  await sendMessage(page, 'Discuss PROJECT-FRIENDLY-MASK today');

  const dialog = page.getByRole('dialog');
  const prompt = dialog.getByRole('region', { name: 'Masked prompt' });
  await expect(prompt.getByText('Codenames', { exact: true })).toBeVisible();
  await expect(prompt.getByText('[REDACTED]', { exact: true })).toHaveCount(0);

  const [approved] = await Promise.all([
    page.waitForResponse(isAgentsStream),
    dialog.getByRole('button', { name: 'Send masked' }).click(),
  ]);
  expect(approved.request().postDataJSON()).toMatchObject({
    text: 'Discuss [REDACTED] today',
  });

  const reply = messagesView(page).getByText(
    'E2E gateway reply [attachment=no iban=none email=no history-iban=none codename=masked]',
  );
  await expect(reply).toBeVisible();

  await expect(messagesView(page)).toContainText('Discuss [REDACTED] today');
  await expect(messagesView(page)).not.toContainText('PROJECT-FRIENDLY-MASK');
});
