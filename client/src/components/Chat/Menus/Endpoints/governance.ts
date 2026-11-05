import type { GovernanceModel, GovernanceTier } from 'librechat-data-provider';

export function groupGovernanceModels(models: GovernanceModel[]) {
  const groups = new Map<string, { tier: GovernanceTier | null; models: GovernanceModel[] }>();
  const seen = new Set<string>();
  for (const model of models) {
    if (!model.id || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    const metadata = model.governance_tier;
    const tier =
      metadata &&
      ['S1', 'S2'].includes(metadata.code) &&
      typeof metadata.name === 'string' &&
      metadata.name.trim() &&
      typeof metadata.description === 'string' &&
      metadata.description.trim()
        ? metadata
        : null;
    const key = tier?.code ?? '';
    const group = groups.get(key) ?? { tier, models: [] };
    group.models.push(model);
    groups.set(key, group);
  }
  return ['S1', 'S2', ''].flatMap((code) => {
    const group = groups.get(code);
    return group ? [group] : [];
  });
}
