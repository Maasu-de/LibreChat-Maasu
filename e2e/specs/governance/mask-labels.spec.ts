import { expect, test } from '@playwright/test';
import { isAgentsStream, messagesView, sendMessage } from '../mock/helpers';
import { newGovernedChat } from './helpers';

test('custom mask labels survive approval and reload without changing governed content', async ({
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

  const expectFriendlyMask = async () => {
    const bars = messagesView(page).locator('.message-content mark');
    await expect(bars).toHaveCount(1);
    await expect(bars.getByText('Codenames', { exact: true })).toBeVisible();
    await expect(bars).not.toContainText('[REDACTED]');
    await expect(messagesView(page)).not.toContainText('PROJECT-FRIENDLY-MASK');
  };
  await expectFriendlyMask();

  await page.reload();

  await expect(reply).toBeVisible();
  await expectFriendlyMask();
});
