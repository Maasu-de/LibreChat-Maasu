import type { TCustomConfig, TEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { GOVERNANCE_ENDPOINT, isGovernancePilotEnabled } from './mode';
import { isEnabled } from '~/utils/common';

function restrictGovernanceInterface(interfaceConfig: TCustomConfig['interface']) {
  const disabled = { use: false, create: false, share: false, public: false };
  return {
    ...interfaceConfig,
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
  };
}

type GovernanceTitleConfig = Pick<TEndpoint, 'titleModel' | 'titleTiming' | 'titlePrompt'> & {
  titleConvo: boolean;
};

/**
 * Keep only the title settings the deployment configured for the governed endpoint.
 * Title calls reuse that endpoint, so they pass the same DLP, audit, and usage path
 * as chat. Titles stay disabled unless the deployment opts in, and `titleEndpoint`
 * is never carried over so titles cannot be routed to another provider.
 */
function getGovernanceTitleConfig(config: Partial<TCustomConfig>): GovernanceTitleConfig {
  const configured = config.endpoints?.custom?.find(
    (endpoint) => endpoint?.name === GOVERNANCE_ENDPOINT,
  ) as Record<string, unknown> | undefined;
  if (configured?.titleConvo !== true) {
    return { titleConvo: false };
  }
  const title: GovernanceTitleConfig = { titleConvo: true };
  for (const key of ['titleModel', 'titlePrompt'] as const) {
    const value = configured[key];
    if (typeof value === 'string' && value.trim()) {
      title[key] = value;
    }
  }
  if (configured.titleTiming === 'immediate' || configured.titleTiming === 'final') {
    title.titleTiming = configured.titleTiming;
  }
  return title;
}

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
          ...getGovernanceTitleConfig(config),
        },
      ],
      agents: { capabilities: [], allowedProviders: [GOVERNANCE_ENDPOINT] },
    },
    interface: restrictGovernanceInterface(config.interface),
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
    interfaceConfig: restrictGovernanceInterface(app.interfaceConfig),
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
