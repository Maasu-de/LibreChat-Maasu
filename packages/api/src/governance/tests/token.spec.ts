import type { JwtPayload } from 'jsonwebtoken';
import { hasGovernanceTokenSource } from '../token';

const proof = '1700000000.gwchWxU57uYGSzNj9RZwqL0LMg_TAdyGVTlwkgq0Ua0';
const environment = process.env;

beforeEach(() => {
  process.env = { ...environment, LIBRECHAT_SERVICE_CREDENTIAL: 'test-credential' };
  jest.useFakeTimers().setSystemTime(1700000000000);
});
afterEach(() => {
  process.env = environment;
  jest.useRealTimers();
});

it('verifies the shared Gateway/Python proof vector', () => {
  expect(hasGovernanceTokenSource('signed-token', {}, 'JWT', 'id', proof)).toBe(true);
});

it.each(['access', 'id', 'userinfo'])('rejects untyped JWTs without proof for %s', (source) => {
  expect(hasGovernanceTokenSource('signed-token', {}, 'JWT', source)).toBe(false);
});

it('binds proof to the token, source, secret and a short validity window', () => {
  expect(hasGovernanceTokenSource('other-token', {}, 'JWT', 'id', proof)).toBe(false);
  expect(hasGovernanceTokenSource('signed-token', {}, 'JWT', 'access', proof)).toBe(false);
  process.env.LIBRECHAT_SERVICE_CREDENTIAL = 'other-secret';
  expect(hasGovernanceTokenSource('signed-token', {}, 'JWT', 'id', proof)).toBe(false);
  process.env.LIBRECHAT_SERVICE_CREDENTIAL = 'test-credential';
  jest.setSystemTime(1699999994000);
  expect(hasGovernanceTokenSource('signed-token', {}, 'JWT', 'id', proof)).toBe(false);
  jest.setSystemTime(1700000061000);
  expect(hasGovernanceTokenSource('signed-token', {}, 'JWT', 'id', proof)).toBe(false);
});

it.each(['malformed', proof.slice(0, -1), proof.slice(0, -1) + 'x'])(
  'rejects invalid proof %s',
  (value) => {
    expect(hasGovernanceTokenSource('signed-token', {}, 'JWT', 'id', value)).toBe(false);
  },
);

it.each<[JwtPayload, string, string, boolean]>([
  [{ typ: 'ID' }, 'JWT', 'id', true],
  [{ typ: 'Bearer' }, 'JWT', 'id', false],
  [{ typ: 'ID' }, 'JWT', 'access', false],
  [{ typ: 'Bearer' }, 'JWT', 'access', true],
  [{ token_use: 'id' }, 'JWT', 'id', true],
  [{ token_use: 'access' }, 'JWT', 'id', false],
  [{ token_use: 'id' }, 'JWT', 'access', false],
  [{ token_use: 'access' }, 'JWT', 'access', true],
  [{}, 'at+jwt', 'access', true],
  [{}, 'at+jwt', 'id', false],
  [{ typ: 'ID', token_use: 'access' }, 'JWT', 'id', false],
  [{ typ: 'Refresh' }, 'JWT', 'access', false],
  [{ typ: null }, 'JWT', 'id', false],
  [{ token_use: null }, 'JWT', 'id', false],
])('honors signed token kind %j / %s for %s', (claims, header, source, allowed) => {
  expect(hasGovernanceTokenSource('signed-token', claims, header, source, proof)).toBe(allowed);
});
