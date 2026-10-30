import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../mock/helpers';

const GOVERNED_MODEL = 'e2e-governed-model';

/** Opens a new chat on the governed model, selecting it if it is not preselected. */
export async function newGovernedChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 30000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Select a model' }).first();
  if (!(await trigger.textContent())?.includes(GOVERNED_MODEL)) {
    await trigger.click();
    await page.getByRole('option', { name: GOVERNED_MODEL, exact: true }).click();
  }
  await expect(trigger).toContainText(GOVERNED_MODEL);
}
