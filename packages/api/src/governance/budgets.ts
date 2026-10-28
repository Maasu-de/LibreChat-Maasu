export function getBudgetErrorMessage(error: {
  code?: string | null;
  error?: object;
}): string | undefined {
  if (error.code !== 'budget_exceeded') {
    return undefined;
  }
  return JSON.stringify({
    code: 'budget_exceeded',
    scope:
      error.error && 'scope' in error.error && error.error.scope === 'group' ? 'group' : 'tenant',
  });
}
