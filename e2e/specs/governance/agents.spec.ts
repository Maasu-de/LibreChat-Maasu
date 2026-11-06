import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getAccessToken, messagesView, sendMessage } from '../mock/helpers';
import { newGovernedChat } from './helpers';

async function openAgent(page: Page, instructions: string) {
  await newGovernedChat(page);
  const token = await getAccessToken(page);
  const result = await page.evaluate(
    async ({ token, instructions }) => {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Instruction review agent',
          provider: 'AI Governance Gateway',
          model: 'e2e-governed-model',
          instructions,
          tools: [],
        }),
      });
      return { status: response.status, agent: (await response.json()) as { id: string } };
    },
    { token, instructions },
  );
  expect(result.status).toBe(201);
  await page.goto(`/c/new?agent_id=${encodeURIComponent(result.agent.id)}`);
  await expect(page.getByRole('button', { name: 'Select a model' })).toContainText(
    'Instruction review agent',
  );
}

test('new agent instructions require warning approval before the model is called', async ({
  page,
}) => {
  await openAgent(page, 'Write to jane@example.com');
  await sendMessage(page, 'Hello');

  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Sensitive information detected' }),
  ).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Agent instructions' })).toContainText(
    'jane@example.com',
  );
  await expect(messagesView(page).getByText(/E2E gateway reply/)).not.toBeVisible();

  await dialog.getByRole('button', { name: 'Continue anyway' }).click();
  await expect(messagesView(page).getByText(/instruction-email=yes/)).toBeVisible();
  await expect(messagesView(page).getByText('Hello', { exact: true })).toBeVisible();
});

test('instruction masking keeps the draft separate and sends only masked instructions', async ({
  page,
}) => {
  const iban = 'DE89370400440532013000';
  await openAgent(page, `Pay to ${iban}`);
  await sendMessage(page, 'Hello');

  const dialog = page.getByRole('dialog');
  const instructions = dialog.getByRole('region', { name: 'Agent instructions' });
  await expect(instructions).toContainText('IBAN');
  await expect(dialog.getByText(iban)).not.toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Masked prompt' })).toHaveText('Hello');
  await expect(messagesView(page).getByText(/E2E gateway reply/)).not.toBeVisible();

  await dialog.getByRole('button', { name: 'Send masked' }).click();
  await expect(messagesView(page).getByText(/instruction-iban=masked/)).toBeVisible();
  await expect(messagesView(page).getByText('Hello', { exact: true })).toBeVisible();
  await expect(messagesView(page).getByText(iban)).not.toBeVisible();
});

test('blocked agent instructions stop the run before a model response', async ({ page }) => {
  await openAgent(page, 'Discuss PROJECT-NIGHTSHADE');
  await sendMessage(page, 'Hello');

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Sensitive prompt blocked' })).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Agent instructions' })).toContainText(
    'PROJECT-NIGHTSHADE',
  );
  await expect(dialog.getByRole('button', { name: 'Continue anyway' })).not.toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Send masked' })).not.toBeVisible();
  await expect(messagesView(page).getByText(/E2E gateway reply/)).not.toBeVisible();
});
