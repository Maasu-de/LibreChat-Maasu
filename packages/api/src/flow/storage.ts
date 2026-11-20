import type { Keyv } from 'keyv';
import { encryptV2, decryptV2 } from '@librechat/data-schemas';
import type { FlowState } from './types';
import { isGovernancePilotEnabled } from '~/governance/mode';

interface EncryptedFlowState {
  encrypted: string;
}

interface BoundFlowState<T> {
  key: string;
  state: FlowState<T>;
}

const encryptedPattern = /^[a-f\d]{32}:(?:[a-f\d]{32})+$/i;

function isProtectedFlow(key: string): boolean {
  return (
    isGovernancePilotEnabled() &&
    (key.startsWith('mcp_oauth:') || key.startsWith('mcp_get_tokens:'))
  );
}

/** Keep governed MCP credentials encrypted at the shared cache boundary. */
export class FlowStateStorage<T> {
  constructor(
    private readonly cache: Keyv,
    private readonly ttl: number,
  ) {}

  async get(key: string): Promise<FlowState<T> | undefined> {
    const stored = await this.cache.get<FlowState<T> | EncryptedFlowState>(key);
    if (!stored) return;
    if ('encrypted' in stored) {
      try {
        if (!encryptedPattern.test(stored.encrypted)) throw new Error();
        const decoded: BoundFlowState<T> = JSON.parse(await decryptV2(stored.encrypted));
        if (decoded.key !== key || !decoded.state || !key.startsWith(`${decoded.state.type}:`))
          throw new Error();
        return decoded.state;
      } catch {
        throw new Error('MCP flow state could not be decrypted');
      }
    }
    if (isProtectedFlow(key)) {
      await this.cache.delete(key);
      return;
    }
    return stored;
  }

  async set(key: string, state: FlowState<T>): Promise<void> {
    if (!isProtectedFlow(key)) {
      await this.cache.set(key, state, this.ttl);
      return;
    }
    let encrypted: string;
    try {
      encrypted = await encryptV2(JSON.stringify({ key, state }));
    } catch {
      throw new Error('MCP flow state could not be encrypted');
    }
    await this.cache.set(key, { encrypted }, this.ttl);
  }
}
