import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, getAccessToken, messagesView, sendMessage } from '../mock/helpers';

/**
 * Text attachments in the governed pilot (#150), end to end through the fork's DLP review
 * against `e2e/setup/fake-governance-gateway.js`. The fake gateway masks IBANs, warns on email
 * addresses and blocks `PROJECT-NIGHTSHADE`, and its reply states what reached the model.
 * A masked prompt keeps its replacements as bars in the chat history.
 */

const GOVERNED_ENDPOINT = 'AI Governance Gateway';
const GOVERNED_MODEL = 'e2e-governed-model';
const IBAN = 'DE89370400440532013000';

type UploadFile = { name: string; mimeType: string; buffer: Buffer };

const textFile = (name: string, text: string, mimeType = 'text/plain'): UploadFile => ({
  name,
  mimeType,
  buffer: Buffer.from(text, 'utf8'),
});

const reply = (page: Page, state: string) =>
  messagesView(page).getByText(`E2E gateway reply [${state}]`);

const composerFile = (page: Page, filename: string) =>
  page.getByRole('button', { name: filename, exact: true });

const isUpload = (url: string, method: string) =>
  method === 'POST' && new URL(url).pathname === '/api/files';

/** Opens a new chat on the governed endpoint, selecting its model if none is preselected. */
async function newGovernedChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 30000 });
  const trigger = page.getByRole('button', { name: 'Select a model' }).first();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  if (await trigger.isVisible({ timeout: 2000 }).catch(() => false)) {
    await trigger.click();
    await page.getByRole('option', { name: GOVERNED_ENDPOINT }).click();
    const model = page.getByRole('option', { name: GOVERNED_MODEL, exact: true });
    if (await model.isVisible({ timeout: 1000 }).catch(() => false)) {
      await model.click();
    }
  }
}

async function chooseUploadFile(page: Page, file: UploadFile) {
  await page.getByRole('button', { name: 'Attach File Options' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: 'Upload File' }).click(),
  ]);
  await chooser.setFiles(file);
}

/** Attaches a file with "Upload File" and waits until the server has stored its text. */
async function attach(page: Page, file: UploadFile) {
  const uploaded = page.waitForResponse((r) => isUpload(r.url(), r.request().method()));
  await chooseUploadFile(page, file);
  expect((await uploaded).status()).toBe(200);
  await expect(composerFile(page, file.name)).toBeVisible();
}

async function listFileNames(page: Page): Promise<string[]> {
  const token = await getAccessToken(page);
  const files = await page.evaluate(async (accessToken) => {
    const response = await fetch('/api/files', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return (await response.json()) as { filename: string }[];
  }, token);
  return files.map(({ filename }) => filename);
}

test.describe('governed text attachments', () => {
  test.beforeEach(async ({ page }) => {
    await newGovernedChat(page);
  });

  test('allow: a clean attachment reaches the model without a review', async ({ page }) => {
    await attach(page, textFile('agenda.txt', 'Agenda: budget review and hiring plan.'));

    await sendMessage(page, 'Summarize the attached agenda');

    await expect(reply(page, 'attachment=yes iban=none email=no history-iban=none')).toBeVisible();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('warn: the user sees the file finding and continues', async ({ page }) => {
    await attach(page, textFile('contacts.csv', 'name,email\nMax,max@example.com\n', 'text/csv'));

    await sendMessage(page, 'Who is on this list?');

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Sensitive information detected')).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'contacts.csv' })).toBeVisible();
    await expect(dialog.getByText('max@example.com')).not.toBeVisible();
    await dialog.getByRole('button', { name: 'Email address · Warn' }).hover();
    await expect(
      dialog.getByRole('dialog', { name: 'Email address · Warn' }).getByText('max@example.com'),
    ).toBeVisible();
    await expect(messagesView(page).getByText('E2E gateway reply')).not.toBeVisible();

    await dialog.getByRole('button', { name: 'Continue anyway' }).click();

    await expect(reply(page, 'attachment=yes iban=none email=yes history-iban=none')).toBeVisible();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('mask: the model gets the masked attachment, also in later turns', async ({ page }) => {
    await attach(
      page,
      textFile('invoice.md', `# Invoice\n\nPay to ${IBAN} or ${IBAN}.\n`, 'text/markdown'),
    );

    await sendMessage(page, 'Check this invoice');

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Sensitive information will be masked')).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'invoice.md' })).toBeVisible();
    const badge = dialog.getByRole('button', { name: 'IBAN · Mask', exact: true });
    await badge.click();
    await page.mouse.move(0, 0);
    await expect(dialog.getByRole('dialog', { name: 'IBAN · Mask' }).getByText(IBAN)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog.getByText(IBAN)).not.toBeVisible();
    await expect(dialog.getByText('Sensitive information will be masked')).toBeVisible();

    await dialog.getByRole('button', { name: 'Send masked' }).click();

    await expect(
      reply(page, 'attachment=yes iban=masked email=no history-iban=none'),
    ).toBeVisible();

    await sendMessage(page, 'What is the total?');

    await expect(reply(page, 'attachment=no iban=none email=no history-iban=masked')).toBeVisible();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('block: a blocked attachment is deleted and the clean one returns', async ({ page }) => {
    await attach(page, textFile('launch-plan.txt', 'PROJECT-NIGHTSHADE launches in May.'));
    await attach(page, textFile('notes.txt', 'Press kit is ready.'));

    await sendMessage(page, 'Draft an announcement');

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Sensitive prompt blocked')).toBeVisible();
    await expect(dialog.getByText('launch-plan.txt')).toBeVisible();
    await expect(dialog.getByText('Code name · Block')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Send masked' })).not.toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Continue anyway' })).not.toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();

    await expect(
      page.getByLabel('Notifications (F8)').getByText('Attachments with blocked content'),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveValue(
      'Draft an announcement',
    );
    await expect(composerFile(page, 'notes.txt')).toBeVisible();
    await expect(composerFile(page, 'launch-plan.txt')).not.toBeVisible();
    await expect.poll(() => listFileNames(page)).not.toContain('launch-plan.txt');
    expect(await listFileNames(page)).toContain('notes.txt');
    await expect(messagesView(page).getByText('E2E gateway reply')).not.toBeVisible();
  });

  test('unsupported: other file types are refused in the browser', async ({ page }) => {
    let uploads = 0;
    page.on('request', (request) => {
      if (isUpload(request.url(), request.method())) {
        uploads += 1;
      }
    });

    await chooseUploadFile(page, {
      name: 'slides.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: Buffer.from('PK\u0003\u0004 not really a deck'),
    });

    await expect(
      page
        .getByLabel('Notifications (F8)')
        .getByText(
          'Unsupported file type: application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ),
    ).toBeVisible();
    await expect(composerFile(page, 'slides.pptx')).not.toBeVisible();
    expect(uploads).toBe(0);
  });

  test('unsupported: the server refuses other file types whatever endpoint is named', async ({
    page,
  }) => {
    const token = await getAccessToken(page);

    const result = await page.evaluate(async (accessToken) => {
      const form = new FormData();
      form.append('endpoint', 'agents');
      form.append('endpointType', 'agents');
      form.append('file_id', crypto.randomUUID());
      form.append('tool_resource', 'context');
      form.append('message_file', 'true');
      form.append('file', new Blob(['\u0089PNG fake'], { type: 'image/png' }), 'photo.png');
      const response = await fetch('/api/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });
      return { status: response.status, body: await response.text() };
    }, token);

    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ message: 'Unsupported file type: image/png' });
    expect(await listFileNames(page)).not.toContain('photo.png');
  });
});

test.describe('governed prompts', () => {
  test.beforeEach(async ({ page }) => {
    await newGovernedChat(page);
  });

  test('mask: the sent message shows its replacements as bars, also after a reload', async ({
    page,
  }) => {
    await sendMessage(page, `Pay ${IBAN} or ${IBAN} today`);
    await page.getByRole('dialog').getByRole('button', { name: 'Send masked' }).click();
    await expect(reply(page, 'attachment=no iban=masked email=no history-iban=none')).toBeVisible();

    const bars = messagesView(page).locator('mark', { hasText: '[IBAN]' });
    await expect(bars).toHaveCount(2);
    await expect(bars.first()).toHaveClass(/bg-text-primary/);
    await expect(bars.first()).not.toHaveAttribute('tabindex');
    await bars.first().hover();
    await expect(messagesView(page).getByText(IBAN)).toHaveCount(0);

    await page.reload();

    await expect(reply(page, 'attachment=no iban=masked email=no history-iban=none')).toBeVisible();
    await expect(messagesView(page).locator('mark', { hasText: '[IBAN]' })).toHaveCount(2);
    await expect(messagesView(page).getByText(IBAN)).toHaveCount(0);
  });
});
