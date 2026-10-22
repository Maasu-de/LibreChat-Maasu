import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, messagesView, sendMessage } from '../mock/helpers';

/**
 * The composer around a DLP review (#235), against `e2e/setup/fake-governance-gateway.js`.
 * Sending a reviewed message clears the composer only while it still shows that message; text
 * typed for the next message while the review was pending stays.
 */

const GOVERNED_ENDPOINT = 'AI Governance Gateway';
const GOVERNED_MODEL = 'e2e-governed-model';
const IBAN = 'DE89370400440532013000';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message input' });

const reply = (page: Page, state: string) =>
  messagesView(page).getByText(`E2E gateway reply [${state}]`);

/** Opens a new chat on the governed endpoint, selecting its model if none is preselected. */
async function newGovernedChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 30000 });
  const trigger = page.getByRole('button', { name: 'Select a model' }).first();
  await expect(composer(page)).toBeVisible();
  if (await trigger.isVisible({ timeout: 2000 }).catch(() => false)) {
    await trigger.click();
    await page.getByRole('option', { name: GOVERNED_ENDPOINT }).click();
    const model = page.getByRole('option', { name: GOVERNED_MODEL, exact: true });
    if (await model.isVisible({ timeout: 1000 }).catch(() => false)) {
      await model.click();
    }
  }
}

test.describe('governed composer drafts', () => {
  test.beforeEach(async ({ page }) => {
    await newGovernedChat(page);
  });

  test('warn: text typed while the review was pending stays after continuing', async ({ page }) => {
    await sendMessage(page, 'Hello');
    await expect(reply(page, 'attachment=no iban=none email=no history-iban=none')).toBeVisible();

    await sendMessage(page, 'Mail me at max@example.com E2E-SLOW');
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill('My next question');

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Sensitive information detected')).toBeVisible();
    await dialog.getByRole('button', { name: 'Continue anyway' }).click();

    await expect(reply(page, 'attachment=no iban=none email=yes history-iban=none')).toBeVisible();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(composer(page)).toHaveValue('My next question');
  });

  test('mask: sending the masked message clears it from the composer', async ({ page }) => {
    await sendMessage(page, `My IBAN is ${IBAN}`);

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Sensitive information will be masked')).toBeVisible();
    await dialog.getByRole('button', { name: 'Send masked' }).click();

    await expect(reply(page, 'attachment=no iban=masked email=no history-iban=none')).toBeVisible();
    await expect(composer(page)).toHaveValue('');
  });
});
