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
  delete process.env.KEYCLOAK_ADMIN_ROLE;
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
  'uses a default when %s is omitted in governed mode',
  (key) => {
    delete process.env[key];

    expect(() => assertOidcAdministratorConfigured()).not.toThrow();
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

it.each(['ADMIN', 'GOVERNANCE_ADMIN'])('demotes a no-longer-entitled %s user', (role) => {
  const current = user(role);

  expect(applyGovernanceAdministratorRole(current, {})).toBe(false);
  expect(current.role).toBe('USER');
});

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
  expect(hasStaleGovernanceAdministratorRole({ ...user('ADMIN'), provider: 'local' })).toBe(false);
});

it.each<[object, boolean]>([
  [{ 'company.permissions': 'company-admin', company: { permissions: 'reader' } }, true],
  [{ 'company.permissions': 'reader', company: { permissions: 'company-admin' } }, false],
  ...[null, false, '', {}, []].map((value): [object, boolean] => [
    { 'company.permissions': value, company: { permissions: 'company-admin' } },
    false,
  ]),
])('prefers an existing exact key: %j', (claims, expected) => {
  expect(hasOidcAdministratorClaim(claims)).toBe(expected);
});

it.each(['permissions', 'https://example.com/roles'])('resolves a top-level %s key', (path) => {
  process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = path;
  expect(hasOidcAdministratorClaim({ [path]: 'company-admin' })).toBe(true);
});

it.each([
  [{ groups: ['company-admin'] }, false],
  [{ groups: { '0': 'company-admin' } }, true],
  [{ 'groups.0': 'company-admin', groups: ['reader'] }, true],
])('traverses object keys only: %j', (claims, expected) => {
  process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'groups.0';
  expect(hasOidcAdministratorClaim(claims)).toBe(expected);
});

it.each([
  ['', false],
  ['   ', false],
  [null, false],
  [12, false],
  [{}, false],
  [[], false],
  [[null, true, 12, {}, '', ' '], false],
  [[null, true, 12, {}, '', ' ', ' company-admin '], true],
  ['reader company-admin', false],
])('ignores blank and invalid claim values: %j', (value, expected) => {
  expect(hasOidcAdministratorClaim({ company: { permissions: value } })).toBe(expected);
});

it.each([' company-admin ', [' reader ', ' company-admin ']])(
  'trims configuration and claims: %j',
  (value) => {
    process.env.OPENID_ADMIN_ROLE = ' company-admin ';
    process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = ' company.permissions ';
    expect(hasOidcAdministratorClaim({ company: { permissions: value } })).toBe(true);
  },
);

it.each(['\uFEFF', '\x1c', '\x1d', '\x1e', '\x1f', '\u0085'])(
  'matches Gateway trim rules: %j',
  (character) => {
    const expected = character === '\uFEFF';
    const paddedRole = `${character}company-admin${character}`;
    for (const value of [paddedRole, [paddedRole]]) {
      expect(hasOidcAdministratorClaim({ company: { permissions: value } })).toBe(expected);
    }
    process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = `${character}company.permissions${character}`;
    expect(hasOidcAdministratorClaim({ company: { permissions: 'company-admin' } })).toBe(expected);
    process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'company.permissions';
    process.env.OPENID_ADMIN_ROLE = paddedRole;
    expect(hasOidcAdministratorClaim({ company: { permissions: 'company-admin' } })).toBe(expected);
  },
);

it('uses bundled defaults without requiring ordinary users to be administrators', () => {
  delete process.env.OPENID_ADMIN_ROLE;
  delete process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH;
  expect(() => assertOidcAdministratorConfigured()).not.toThrow();
  expect(
    applyGovernanceAdministratorRole(user(), { realm_access: { roles: ['governance-admin'] } }),
  ).toBe(true);
  const ordinaryUser = user();
  expect(
    applyGovernanceAdministratorRole(ordinaryUser, {
      realm_access: { roles: ['governance-user'] },
    }),
  ).toBe(false);
  expect(ordinaryUser.role).toBe('USER');
});

it('uses the trimmed legacy alias only when the canonical role is omitted', () => {
  delete process.env.OPENID_ADMIN_ROLE;
  process.env.KEYCLOAK_ADMIN_ROLE = ' legacy-admin ';
  expect(hasOidcAdministratorClaim({ company: { permissions: 'legacy-admin' } })).toBe(true);
  process.env.OPENID_ADMIN_ROLE = 'company-admin';
  expect(hasOidcAdministratorClaim({ company: { permissions: 'legacy-admin' } })).toBe(false);
  expect(hasOidcAdministratorClaim({ company: { permissions: 'company-admin' } })).toBe(true);
});

it.each(['OPENID_ADMIN_ROLE', 'OPENID_ADMIN_ROLE_PARAMETER_PATH', 'KEYCLOAK_ADMIN_ROLE'])(
  'rejects explicit blanks without fallback: %s',
  (key) => {
    for (const blank of ['', '   ', '\uFEFF']) {
      process.env.OPENID_ADMIN_ROLE = 'company-admin';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'company.permissions';
      process.env.KEYCLOAK_ADMIN_ROLE = 'company-admin';
      if (key === 'KEYCLOAK_ADMIN_ROLE') delete process.env.OPENID_ADMIN_ROLE;
      process.env[key] = blank;
      expect(hasOidcAdministratorClaim({ company: { permissions: ['', 'company-admin'] } })).toBe(
        false,
      );
      expect(() => assertOidcAdministratorConfigured()).toThrow(key);
      expect(() => applyGovernanceAdministratorRole(user(), {})).toThrow(key);
    }
  },
);
