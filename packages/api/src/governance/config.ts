import type { TCustomConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { GOVERNANCE_ENDPOINT, isGovernancePilotEnabled } from './mode';
import { isEnabled } from '~/utils/common';

export function restrictGovernanceConfig(config: Partial<TCustomConfig>): Partial<TCustomConfig> {
  if (!isGovernancePilotEnabled()) {
    return config;
  }
  const baseURL = process.env.GOVERNANCE_API_BASE_URL;
  const apiKey = process.env.LIBRECHAT_SERVICE_CREDENTIAL;
  if (!baseURL || !apiKey || apiKey === 'user_provided') {
    throw new Error('Governed pilot requires a gateway URL and service credential');
  }
  const url = new URL(baseURL);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid governed gateway URL');
  }
  if (!isEnabled(process.env.GOVERNANCE_DLP_ENABLED) || isEnabled(process.env.OPENAI_MODERATION)) {
    throw new Error('Governed pilot requires DLP and forbids external moderation');
  }
  const disabled = { use: false, create: false, share: false, public: false };
  return {
    ...config,
    endpoints: {
      custom: [
        {
          name: GOVERNANCE_ENDPOINT,
          apiKey: '${LIBRECHAT_SERVICE_CREDENTIAL}',
          baseURL: '${GOVERNANCE_API_BASE_URL}',
          headers: { 'X-LibreChat-User-ID': '{{LIBRECHAT_USER_ID}}' },
          models: { default: [], fetch: true },
          titleConvo: false,
        },
      ],
      agents: { capabilities: [], allowedProviders: [GOVERNANCE_ENDPOINT] },
    },
    interface: {
      ...config.interface,
      modelSelect: true,
      parameters: false,
      presets: false,
      multiConvo: false,
      agents: false,
      remoteAgents: disabled,
      mcpServers: disabled,
      marketplace: { use: false },
      skills: false,
      memories: false,
      runCode: false,
      webSearch: false,
      fileSearch: false,
      fileCitations: false,
      defaultPinnedTools: [],
    },
    fileConfig: {
      endpoints: { default: { disabled: true }, [GOVERNANCE_ENDPOINT]: { disabled: true } },
    },
    speech: {
      speechTab: {
        conversationMode: false,
        advancedMode: false,
        speechToText: false,
        textToSpeech: false,
      },
    },
    includedTools: [],
    mcpServers: undefined,
    actions: undefined,
    memory: undefined,
    ocr: undefined,
    webSearch: undefined,
    modelSpecs: undefined,
    skillSync: undefined,
    summarization: { enabled: false },
  };
}

/** Reapply after database overrides and after AppService derives defaults. */
export function restrictGovernanceAppConfig(app: AppConfig): AppConfig {
  if (!isGovernancePilotEnabled()) {
    return app;
  }
  const config = restrictGovernanceConfig(app.config);
  return {
    ...app,
    config,
    endpoints: config.endpoints as AppConfig['endpoints'],
    interfaceConfig: config.interface,
    fileConfig: config.fileConfig as AppConfig['fileConfig'],
    speech: config.speech,
    availableTools: {},
    includedTools: [],
    mcpConfig: null,
    mcpSettings: null,
    actions: undefined,
    memory: undefined,
    ocr: undefined,
    webSearch: undefined,
    modelSpecs: undefined,
    skillSync: undefined,
    summarization: { enabled: false },
  };
}
