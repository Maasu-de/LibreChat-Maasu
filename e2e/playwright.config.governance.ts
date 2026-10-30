import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { getLocalE2EEnv, getE2EBaseURL } from './setup/env';

/**
 * Governed-pilot e2e profile: LibreChat runs in pilot mode with text attachments enabled and
 * talks to the fake gateway in `setup/fake-governance-gateway.js`. Unlike the mock profile, no
 * fake model is injected, so every chat goes through the fork's governed fetch and DLP review.
 */
const rootPath = path.resolve(__dirname, '..');
const serverPath = path.resolve(rootPath, 'e2e/setup/start-server.js');
const gatewayPath = path.resolve(rootPath, 'e2e/setup/fake-governance-gateway.js');
const configPath = path.resolve(rootPath, 'e2e/config/librechat.governance.yaml');
const reportPath = path.resolve(rootPath, 'e2e/playwright-report');
const GATEWAY_PORT = process.env.E2E_GOVERNANCE_GATEWAY_PORT || '8766';

const baseURL = getE2EBaseURL();
const chromiumChannel = process.env.E2E_CHROMIUM_CHANNEL || undefined;

const governanceEnv = {
  ...getLocalE2EEnv(),
  CONFIG_PATH: configPath,
  TENANT_ISOLATION_STRICT: 'false',
  OPENID_CLIENT_ID: '',
  OPENID_ISSUER: '',
  OPENID_AUTO_REDIRECT: 'false',
  OPENID_REUSE_TOKENS: 'true',
  OPENID_ADMIN_ROLE: 'e2e-admin',
  OPENID_ADMIN_ROLE_PARAMETER_PATH: 'realm_access.roles',
  ALLOW_SOCIAL_LOGIN: 'false',
  ALLOW_SOCIAL_REGISTRATION: 'false',
  STREAM_KEEP_COMPLETED_JOBS: 'true',
  GOVERNANCE_PILOT_ENABLED: 'true',
  GOVERNANCE_DLP_ENABLED: 'true',
  GOVERNANCE_ATTACHMENTS_ENABLED: 'true',
  GOVERNANCE_API_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}/api/v1/dlp`,
  LIBRECHAT_SERVICE_CREDENTIAL: 'e2e-service-credential',
  OPENAI_MODERATION: 'false',
  DOCLING_URL: '',
  LIBRECHAT_TEST_RUN_HOOK: '',
};
Object.assign(process.env, governanceEnv);

export default defineConfig({
  globalSetup: require.resolve('./setup/global-setup'),
  globalTeardown: require.resolve('./setup/global-teardown'),
  testDir: 'specs/governance/',
  outputDir: 'specs/.test-results',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['html', { outputFolder: reportPath, open: 'never' }], ['line']]
    : [['html', { outputFolder: reportPath, open: 'never' }], ['list']],
  use: {
    baseURL,
    video: 'on-first-retry',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: true,
    headless: true,
    storageState: path.resolve(process.cwd(), 'e2e/storageState.json'),
    screenshot: 'only-on-failure',
  },
  expect: {
    timeout: 10000,
  },
  projects: [
    {
      name: chromiumChannel ?? 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumChannel ? { channel: chromiumChannel } : {}),
      },
    },
  ],
  webServer: [
    {
      command: `node ${gatewayPath}`,
      cwd: rootPath,
      env: { ...process.env, E2E_GOVERNANCE_GATEWAY_PORT: GATEWAY_PORT },
      url: `http://127.0.0.1:${GATEWAY_PORT}/`,
      stdout: 'pipe',
      timeout: 30_000,
      reuseExistingServer: false,
    },
    {
      command: `node ${serverPath}`,
      cwd: rootPath,
      url: baseURL,
      stdout: 'pipe',
      ignoreHTTPSErrors: true,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
