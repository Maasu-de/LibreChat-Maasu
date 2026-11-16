import { Schema } from 'mongoose';
import type { Model } from 'mongoose';

interface MCPGovernanceIdentity {
  tenantId: string;
  source: string;
  serverName: string;
}

/** Persistent references for operator connections that have no MCPServer document. */
export function createMCPGovernanceIdentityModel(
  mongoose: typeof import('mongoose'),
): Model<MCPGovernanceIdentity> {
  if (mongoose.models.MCPGovernanceIdentity) {
    return mongoose.models.MCPGovernanceIdentity;
  }
  const schema = new Schema<MCPGovernanceIdentity>({
    tenantId: { type: String, required: true },
    source: { type: String, required: true },
    serverName: { type: String, required: true },
  });
  return mongoose.model<MCPGovernanceIdentity>('MCPGovernanceIdentity', schema);
}
