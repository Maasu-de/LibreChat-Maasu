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

async function attach(page: Page, name: string, text: string, mimeType = 'text/plain') {
  await page.getByRole('button', { name: 'Attach File Options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Upload to Provider' })).toHaveCount(0);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: 'Upload File', exact: true }).click(),
  ]);
  const uploaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/files' && response.request().method() === 'POST',
  );
  await chooser.setFiles({ name, mimeType, buffer: Buffer.from(text, 'utf8') });
  expect((await uploaded).status()).toBe(200);
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
}

test('agents accept governed attachments while classic chat keeps text uploads', async ({
  page,
}) => {
  await openAgent(page, 'Summarize clearly.');
  await attach(page, 'agent-agenda.txt', 'Agenda: budget review and hiring plan.');
  await sendMessage(page, 'Summarize the attached agenda');
  await expect(
    messagesView(page).getByText(/E2E gateway reply \[attachment=yes iban=none email=no/),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();

  await newGovernedChat(page);
  await page.getByRole('button', { name: 'Attach File Options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Upload File', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Upload to Provider' })).toHaveCount(0);
});

test('agent attachments require warning approval before reaching the model', async ({ page }) => {
  await openAgent(page, 'Summarize clearly.');
  await attach(page, 'agent-contacts.csv', 'name,email\nMax,max@example.com\n', 'text/csv');
  await sendMessage(page, 'Who is on this list?');

  const dialog = page.getByRole('dialog', { name: 'Sensitive information detected' });
  await expect(dialog.getByRole('heading', { name: 'agent-contacts.csv' })).toBeVisible();
  await expect(messagesView(page).getByText(/E2E gateway reply/)).not.toBeVisible();
  await dialog.getByRole('button', { name: 'Continue anyway' }).click();
  await expect(
    messagesView(page).getByText(/E2E gateway reply \[attachment=yes iban=none email=yes/),
  ).toBeVisible();
});

test('agent attachments stay masked in the completion and later history', async ({ page }) => {
  const iban = 'DE89370400440532013000';
  await openAgent(page, 'Summarize clearly.');
  await attach(page, 'agent-invoice.md', `# Invoice\n\nPay to ${iban}.\n`, 'text/markdown');
  await sendMessage(page, 'Check this invoice');

  const dialog = page.getByRole('dialog', { name: 'Sensitive information will be masked' });
  await expect(dialog.getByRole('heading', { name: 'agent-invoice.md' })).toBeVisible();
  await expect(messagesView(page).getByText(/E2E gateway reply/)).not.toBeVisible();
  await dialog.getByRole('button', { name: 'Send masked' }).click();
  await expect(
    messagesView(page).getByText(/E2E gateway reply \[attachment=yes iban=masked email=no/),
  ).toBeVisible();

  await sendMessage(page, 'What is the total?');
  await expect(
    messagesView(page).getByText(/attachment=no iban=none email=no history-iban=masked/),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('blocked agent attachments stop before a model response', async ({ page }) => {
  await openAgent(page, 'Summarize clearly.');
  await attach(page, 'agent-launch-plan.txt', 'PROJECT-NIGHTSHADE launches in May.');
  await sendMessage(page, 'Summarize the launch plan');

  const dialog = page.getByRole('dialog', { name: 'Sensitive prompt blocked' });
  await expect(dialog.getByRole('heading', { name: 'agent-launch-plan.txt' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Continue anyway' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Send masked' })).toHaveCount(0);
  await expect(messagesView(page).getByText(/E2E gateway reply/)).not.toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'agent-launch-plan.txt', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveValue(
    'Summarize the launch plan',
  );
});

test('dropped agent attachments use governed text context', async ({ page }) => {
  await openAgent(page, 'Summarize clearly.');
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(['Agenda: budget review.'], 'agent-dropped-agenda.txt', { type: 'text/plain' }),
    );
    return transfer;
  });
  await page.locator('main').dispatchEvent('dragenter', { dataTransfer });
  await page.locator('main').dispatchEvent('dragover', { dataTransfer });
  await page.locator('main').dispatchEvent('drop', { dataTransfer });

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Upload File', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Upload to Provider' })).toHaveCount(0);
  const uploaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/files' && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Upload File', exact: true }).click();
  expect((await uploaded).status()).toBe(200);
  await expect(
    page.getByRole('button', { name: 'agent-dropped-agenda.txt', exact: true }),
  ).toBeVisible();

  await sendMessage(page, 'Summarize the dropped agenda');
  await expect(
    messagesView(page).getByText(/E2E gateway reply \[attachment=yes iban=none email=no/),
  ).toBeVisible();
  await dataTransfer.dispose();
});

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
