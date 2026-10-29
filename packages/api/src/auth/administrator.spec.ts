import { Types } from 'mongoose';
import type { IUser } from '@librechat/data-schemas';
import type { RefreshTokenset } from './refresh';
import {
  applyGovernanceAdministratorRole,
  assertOidcAdministratorConfigured,
  hasOidcAdministratorClaim,
  hasStaleGovernanceAdministratorRole,
  syncOidcAdministrator,
} from './administrator';

const environment = process.env;
const user = (role = 'USER') =>
  ({
    _id: new Types.ObjectId(),
    provider: 'openid',
    role,
  }) as IUser;

beforeEach(() => {
  process.env = {
    ...environment,
    GOVERNANCE_PILOT_ENABLED: 'true',
    OPENID_ADMIN_ROLE: 'company-admin',
    OPENID_ADMIN_ROLE_PARAMETER_PATH: 'company.permissions',
  };
});

afterEach(() => {
  process.env = environment;
});

it.each([
  ['a matching string', { company: { permissions: 'company-admin' } }, true],
  ['a matching string array', { company: { permissions: ['reader', 'company-admin'] } }, true],
  ['a different string', { company: { permissions: 'reader' } }, false],
  ['a combined string', { company: { permissions: 'reader,company-admin' } }, false],
  ['a boolean', { company: { permissions: true } }, false],
  ['a missing claim', {}, false],
])('handles %s', (_label, claims, expected) => {
  expect(hasOidcAdministratorClaim(claims)).toBe(expected);
});

it.each(['OPENID_ADMIN_ROLE', 'OPENID_ADMIN_ROLE_PARAMETER_PATH'])(
  'fails closed without %s in governed mode',
  (key) => {
    delete process.env[key];

    expect(() => assertOidcAdministratorConfigured()).toThrow(key);
  },
);

it('does not require the mapping outside governed mode', () => {
  delete process.env.GOVERNANCE_PILOT_ENABLED;
  delete process.env.OPENID_ADMIN_ROLE;
  delete process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH;

  expect(() => assertOidcAdministratorConfigured()).not.toThrow();
});

it('maps an entitled OpenID user to the restricted administrator role', () => {
  const current = user();

  expect(
    applyGovernanceAdministratorRole(current, {
      company: { permissions: ['company-admin'] },
    }),
  ).toBe(true);
  expect(current.role).toBe('GOVERNANCE_ADMIN');
});

it.each(['ADMIN', 'GOVERNANCE_ADMIN'])(
  'demotes a no-longer-entitled %s user',
  (role) => {
    const current = user(role);

    expect(applyGovernanceAdministratorRole(current, {})).toBe(false);
    expect(current.role).toBe('USER');
  },
);

it('persists a refresh-time role change from validated ID-token claims', async () => {
  const current = user();
  const tokenset = {
    access_token: 'access-token',
    claims: () => ({ sub: 'subject', company: { permissions: ['company-admin'] } }),
  } as RefreshTokenset;
  const updateUser = jest.fn().mockResolvedValue(current);

  await syncOidcAdministrator(current, tokenset, updateUser);

  expect(updateUser).toHaveBeenCalledWith(current._id.toString(), {
    role: 'GOVERNANCE_ADMIN',
  });
  expect(current.role).toBe('GOVERNANCE_ADMIN');
});

it('does not persist when refresh leaves the role unchanged', async () => {
  const current = user('GOVERNANCE_ADMIN');
  const tokenset = {
    access_token: 'access-token',
    claims: () => ({ sub: 'subject', company: { permissions: 'company-admin' } }),
  } as RefreshTokenset;
  const updateUser = jest.fn();

  await syncOidcAdministrator(current, tokenset, updateUser);

  expect(updateUser).not.toHaveBeenCalled();
});

it('identifies legacy OpenID ADMIN sessions without rewriting them', () => {
  expect(hasStaleGovernanceAdministratorRole(user('ADMIN'))).toBe(true);
  expect(hasStaleGovernanceAdministratorRole(user('GOVERNANCE_ADMIN'))).toBe(false);
  expect(
    hasStaleGovernanceAdministratorRole({ ...user('ADMIN'), provider: 'local' }),
  ).toBe(false);
});
