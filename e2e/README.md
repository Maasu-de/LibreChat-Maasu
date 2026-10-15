# LibreChat e2e

The mock e2e profile is the safest default for generated tests. It starts LibreChat with `e2e/config/librechat.e2e.yaml`, injects an in-process fake LLM (via `LIBRECHAT_TEST_RUN_HOOK`), creates an authenticated e2e user, and avoids real provider credentials.

## Recording Tests

Use Playwright codegen when you want to turn an exploratory browser session into a draft test:

```sh
npm run e2e:record
```

That command builds the app, starts the LibreChat test server (with an in-process fake LLM) when needed, writes `e2e/storageState.json`, and opens Playwright codegen at `/c/new`. The npm script uses `http://localhost:3333` so it does not collide with a normal dev server on `3080`. Raw recordings are written to `e2e/recordings/` and ignored by git.

For a real local LibreChat config instead of the mock profile:

```sh
npm run e2e:record:local
```

Useful direct options:

```sh
node e2e/setup/record.js --url=http://localhost:3080/c/new
node e2e/setup/record.js --profile=local --no-output
node e2e/setup/record.js --auth-only
node e2e/setup/record.js --output=e2e/recordings/settings-draft.spec.ts
```

## LLM-Assisted Loop

1. Start `npm run e2e:record`.
2. Let the LLM use Computer Use to operate the headed Playwright browser.
3. Stop codegen after the workflow is captured.
4. Move the useful parts from `e2e/recordings/` into a committed spec under `e2e/specs/mock/`.
5. Replace brittle generated selectors with role, label, text, or `data-testid` locators.
6. Add assertions that prove the behavior, not just the clicked path.
7. Run the finished spec with `npm run e2e:mock -- <spec name>`.

Generated recordings are a draft, not the final test. The committed version should use the shared helpers in `e2e/specs/mock/helpers.ts` where possible, wait on network or visible UI state instead of fixed sleeps, and keep test data deterministic.

## Governed Pilot Profile

`npm run e2e:governance` runs `e2e/specs/governance/` with LibreChat in governed pilot mode and text attachments enabled. No fake model is injected: every chat goes through the fork's governed fetch to the fake gateway in `e2e/setup/fake-governance-gateway.js`, which follows the real gateway's review protocol. Its DLP is deterministic: an IBAN (`DE` + 20 digits) is masked, an email address is a warning, and `PROJECT-NIGHTSHADE` is blocked. Each completion states what reached the model, for example `E2E gateway reply [attachment=yes iban=masked email=no history-iban=none]`, so specs can assert on the governed content.
