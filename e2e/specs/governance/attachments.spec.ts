import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getAccessToken, messagesView, sendMessage } from '../mock/helpers';
import { newGovernedChat } from './helpers';

/**
 * Text attachments in the governed pilot (#150), end to end through the fork's DLP review
 * against `e2e/setup/fake-governance-gateway.js`. The fake gateway masks IBANs, warns on email
 * addresses and blocks `PROJECT-NIGHTSHADE`, and its reply states what reached the model.
 */

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

async function expectUnclippedPopup(popup: Locator) {
  await expect
    .poll(() =>
      popup.evaluate((element) => {
        const { left, top, right, bottom } = element.getBoundingClientRect();
        const points = [
          [left + 8, top + 8],
          [right - 8, top + 8],
          [left + 8, bottom - 8],
          [right - 8, bottom - 8],
        ];
        return (
          left >= 0 &&
          top >= 0 &&
          right <= window.innerWidth &&
          bottom <= window.innerHeight &&
          points.every(([x, y]) => element.contains(document.elementFromPoint(x, y)))
        );
      }),
    )
    .toBe(true);
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

test.describe('governed attachment findings', () => {
  test.beforeEach(async ({ page }) => {
    await newGovernedChat(page);
  });

  test('an attachment still requires a typed message before sending', async ({ page }) => {
    await attach(page, textFile('agenda.txt', 'Agenda: budget review and hiring plan.'));

    await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveValue('');
    await expect(page.getByTestId('send-button')).toBeDisabled();
    await expect(composerFile(page, 'agenda.txt')).toBeVisible();
  });

  test('finding values expand and collapse without approving or closing the review', async ({
    page,
  }) => {
    const emails = Array.from({ length: 55 }, (_, i) => `qa.user${i + 1}@example.com`);
    await attach(
      page,
      textFile('many-values.txt', [...emails, emails[0], emails[0].toUpperCase()].join('\n')),
    );
    await sendMessage(page, 'Review the attached contacts');

    const dialog = page.getByRole('dialog', { name: 'Sensitive information detected' });
    const badge = dialog.getByRole('button', { name: 'Email address · Warn' });
    await badge.click();
    const popup = page.getByRole('dialog', { name: 'Email address · Warn' });
    await expect(popup.getByText(emails[9], { exact: true })).toBeVisible();
    await expect(popup.getByText(emails[10], { exact: true })).toHaveCount(0);
    const expand = popup.getByRole('button', { name: /45 more/ });
    await expand.focus();
    await page.keyboard.press('Enter');
    await expect(popup.getByText(emails[54], { exact: true })).toBeAttached();
    const collapse = popup.getByRole('button', { name: 'Show fewer' });
    await collapse.focus();
    await page.keyboard.press('Space');
    await expect(popup.getByText(emails[10], { exact: true })).toHaveCount(0);
    await expect(popup.getByRole('button', { name: /45 more/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(popup).not.toBeVisible();
    await expect(badge).toBeFocused();
    await expect(dialog).toBeVisible();
    await expect(messagesView(page).getByText('E2E gateway reply')).not.toBeVisible();
  });

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
    { width: 900, height: 440 },
  ]) {
    test(`finding popup stays visible at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      const emails = Array.from({ length: 55 }, (_, i) => `qa.layout${i + 1}@example.com`);
      await attach(page, textFile('popup-layout.txt', emails.join('\n')));
      if (viewport.height < 500) {
        await sendMessage(
          page,
          Array.from({ length: 50 }, (_, i) => `Review note ${i + 1}: summarize the file.`).join(
            '\n',
          ),
        );
      } else {
        await sendMessage(page, 'Review the attached contacts');
      }

      const dialog = page.getByRole('dialog', { name: 'Sensitive information detected' });
      await expect(dialog).toBeVisible();
      await page.setViewportSize(viewport);
      await expect
        .poll(() =>
          dialog.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
          }),
        )
        .toBe(true);
      const badge = dialog.getByRole('button', { name: 'Email address · Warn' });
      await badge.click();
      const popup = page.getByRole('dialog', { name: 'Email address · Warn' });
      await expectUnclippedPopup(popup);
      await expect(popup.getByText(emails[0], { exact: true })).toBeInViewport();
      await expect(popup.getByRole('button', { name: /45 more/ })).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath('popup-collapsed.png') });

      await popup.getByRole('button', { name: /45 more/ }).click();
      await expectUnclippedPopup(popup);
      await popup.getByText(emails[54], { exact: true }).scrollIntoViewIfNeeded();
      await expect(popup.getByText(emails[54], { exact: true })).toBeInViewport();
      await expectUnclippedPopup(popup);
      await expect(popup.getByRole('button', { name: 'Show fewer' })).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath('popup-expanded.png') });
      await page.keyboard.press('Escape');
      await expect(badge).toBeFocused();
      await expect(dialog).toBeVisible();
    });
  }
});

test.describe('governed prompts', () => {
  test.beforeEach(async ({ page }) => {
    await newGovernedChat(page);
  });

  test('mask: the review shows friendly labels before sending governed content', async ({
    page,
  }) => {
    await sendMessage(page, `Pay ${IBAN} or ${IBAN} today`);
    const dialog = page.getByRole('dialog');
    const prompt = dialog.getByRole('region', { name: 'Masked prompt' });
    const labels = prompt.getByText('IBAN', { exact: true });
    await expect(labels).toHaveCount(2);
    await expect(labels.first()).toBeVisible();
    await expect(labels.last()).toBeVisible();
    await expect(prompt.getByText('[IBAN]', { exact: true })).toHaveCount(0);

    await labels.first().hover();
    await expect(prompt.getByText(IBAN, { exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(labels.first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('mask-friendly-labels.png') });
    await dialog.getByRole('button', { name: 'Send masked' }).click();
    await expect(reply(page, 'attachment=no iban=masked email=no history-iban=none')).toBeVisible();

    await expect(messagesView(page)).not.toContainText(IBAN);
  });

  test('mask: focused values stay revealed when the pointer moves between masks and outside', async ({
    page,
  }) => {
    const text = `Pay ${IBAN} or ${IBAN} today`;
    await sendMessage(page, text);
    const dialog = page.getByRole('dialog');
    const prompt = dialog.getByRole('region', { name: 'Masked prompt' });
    const first = prompt.locator('mark').first();
    const second = prompt.locator('mark').last();

    await first.focus();
    await expect(first.getByText(IBAN, { exact: true })).toBeVisible();
    await second.hover();
    await expect(first).toBeFocused();
    await expect(first.getByText(IBAN, { exact: true })).toBeVisible();
    await expect(second.getByText(IBAN, { exact: true })).toBeVisible();

    await page.mouse.move(0, 0);
    await expect(first).toBeFocused();
    await expect(first.getByText(IBAN, { exact: true })).toBeVisible();
    await expect(second.getByText('IBAN', { exact: true })).toBeVisible();

    await second.focus();
    await page.mouse.move(1, 1);
    await expect(first.getByText('IBAN', { exact: true })).toBeVisible();
    await expect(second).toBeFocused();
    await expect(second.getByText(IBAN, { exact: true })).toBeVisible();
    await expect(messagesView(page).getByText('E2E gateway reply')).not.toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveValue(text);
  });

  test('keyboard: Escape puts the prompt back, Enter sends it, a held Enter does not', async ({
    page,
  }) => {
    const prompt = `Pay ${IBAN} today`;
    const composer = page.getByRole('textbox', { name: 'Message input' });
    const dialog = page.getByRole('dialog');
    const send = dialog.getByRole('button', { name: 'Send masked' });

    await sendMessage(page, prompt);
    await expect(send).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(composer).toHaveValue(prompt);

    await composer.focus();
    await page.keyboard.down('Enter');
    await expect(send).toBeFocused();
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await expect(dialog).toBeVisible();
    await expect(messagesView(page).getByText('E2E gateway reply')).not.toBeVisible();

    await dialog.getByText('IBAN', { exact: true }).click();
    await page.keyboard.press('Enter');
    await expect(reply(page, 'attachment=no iban=masked email=no history-iban=none')).toBeVisible();
    await expect(dialog).not.toBeVisible();
  });
});
