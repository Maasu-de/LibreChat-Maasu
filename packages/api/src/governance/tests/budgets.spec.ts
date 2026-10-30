import { APIError } from 'openai';
import { getBudgetErrorMessage } from '../budgets';

describe('budget errors', () => {
  it.each(['tenant', 'group'])(
    'preserves a Gateway %s rejection through the provider SDK',
    (scope) => {
      const error = APIError.generate(
        403,
        {
          error: { code: 'budget_exceeded', scope, message: 'Monthly limit reached.' },
        },
        undefined,
        new Headers(),
      );
      expect(getBudgetErrorMessage(error)).toBe(JSON.stringify({ code: 'budget_exceeded', scope }));
    },
  );

  it('leaves other errors to the existing error handler', () => {
    expect(getBudgetErrorMessage({ code: 'some_other_error' })).toBeUndefined();
  });
});
