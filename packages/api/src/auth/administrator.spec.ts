import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import type { IUser } from '@librechat/data-schemas';
import { applyAdminRefresh } from './refresh';
import { hasOidcAdministratorClaim, syncOidcAdministrator } from './administrator';

const environment = process.env;
beforeEach(() => {
  process.env = {
    ...environment,
    OPENID_ADMIN_ROLE: 'company-admin',
    OPENID_ADMIN_ROLE_PARAMETER_PATH: 'company.permissions',
    OPENID_ADMIN_ROLE_TOKEN_KIND: 'access',
  };
});
afterEach(() => {
  process.env = environment;
  jest.restoreAllMocks();
});

it.each([['company-admin'], 'reader,company-admin', 'reader company-admin', true])(
  'supports claim shape %s',
  (value) => {
    expect(hasOidcAdministratorClaim({ company: { permissions: value } })).toBe(true);
  },
);
it.each([false, null, 'reader', ['reader'], {}])('denies absent entitlement %s', (value) => {
  expect(hasOidcAdministratorClaim({ company: { permissions: value } })).toBe(false);
});

it('uses resolved overage groups instead of stale embedded claims', () => {
  expect(hasOidcAdministratorClaim({}, ['company-admin'])).toBe(true);
  expect(hasOidcAdministratorClaim({ company: { permissions: ['company-admin'] } }, [])).toBe(
    false,
  );
});

function user(): IUser {
  return {
    _id: new Types.ObjectId(),
    role: 'ADMIN',
    provider: 'openid',
    openidId: 'subject',
    openidIssuer: 'https://id.example',
  } as IUser;
}
function tokens(value: string[]) {
  return {
    access_token: jwt.sign({ sub: 'subject', company: { permissions: value } }, 'test-only'),
    claims: () => ({ sub: 'subject', company: { permissions: value } }),
  };
}

it.each(['access', 'id', 'userinfo'])('removes stored ADMIN on next %s refresh', async (source) => {
  process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = source;
  const actor = user();
  const update = jest.fn(async () => actor);
  const getUserInfo = jest.fn(async () => ({ sub: 'subject', company: { permissions: [] } }));
  await syncOidcAdministrator(actor, tokens([]), update, getUserInfo);
  expect(actor.role).toBe('USER');
  expect(update).toHaveBeenCalledWith(actor._id.toString(), { role: 'USER' });
});

it('synchronizes before deciding whether to mint an admin bearer', async () => {
  const actor = user();
  const update = jest.fn(async () => actor);
  const mintToken = jest.fn();
  await expect(
    applyAdminRefresh(
      tokens([]),
      {
        findUsers: async () => [actor],
        getUserById: async () => actor,
        mintToken,
        synchronizeAdministrator: (resolved, refreshed) =>
          syncOidcAdministrator(resolved, refreshed, update),
        canAccessAdmin: async (resolved) => resolved.role === 'ADMIN',
      },
      { userId: actor._id.toString(), expectedIssuer: actor.openidIssuer },
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(actor.role).toBe('USER');
  expect(mintToken).not.toHaveBeenCalled();
});

it('rejects userinfo for a different subject', async () => {
  process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'userinfo';
  const getUserInfo = async () => ({ sub: 'other', company: { permissions: ['company-admin'] } });
  const update = jest.fn();
  await expect(syncOidcAdministrator(user(), tokens([]), update, getUserInfo)).rejects.toThrow(
    'subject mismatch',
  );
  expect(update).not.toHaveBeenCalled();
});

it('uses provider userinfo instead of token roles to grant administrator access', async () => {
  process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'userinfo';
  const actor = user();
  actor.role = 'USER';
  const refreshed = tokens([]);
  const update = jest.fn(async () => actor);
  const getUserInfo = jest.fn(async () => ({
    sub: 'subject',
    company: { permissions: ['company-admin'] },
  }));

  await syncOidcAdministrator(actor, refreshed, update, getUserInfo);

  expect(getUserInfo).toHaveBeenCalledWith(refreshed.access_token, 'subject');
  expect(actor.role).toBe('ADMIN');
  expect(update).toHaveBeenCalledWith(actor._id.toString(), { role: 'ADMIN' });
});

it('does not mint an admin bearer when provider userinfo is unavailable', async () => {
  process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'userinfo';
  const actor = user();
  const update = jest.fn(async () => actor);
  const mintToken = jest.fn();

  await expect(
    applyAdminRefresh(
      tokens(['company-admin']),
      {
        findUsers: async () => [actor],
        getUserById: async () => actor,
        mintToken,
        synchronizeAdministrator: (resolved, refreshed) =>
          syncOidcAdministrator(resolved, refreshed, update, async () => null),
      },
      { userId: actor._id.toString(), expectedIssuer: actor.openidIssuer },
    ),
  ).rejects.toThrow('OIDC userinfo unavailable');

  expect(update).not.toHaveBeenCalled();
  expect(mintToken).not.toHaveBeenCalled();
});

it('rejects missing subjects before requesting userinfo', async () => {
  process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'userinfo';
  const refreshed = { ...tokens([]), claims: () => ({}) };
  const getUserInfo = jest.fn();
  const update = jest.fn();

  await expect(syncOidcAdministrator(user(), refreshed, update, getUserInfo)).rejects.toThrow(
    'Missing OIDC subject',
  );

  expect(getUserInfo).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

it.each([undefined, '', '   '])(
  'rejects pilot admin refresh with role setting %j',
  async (value) => {
    process.env.GOVERNANCE_PILOT_ENABLED = ' TRUE ';
    if (value === undefined) delete process.env.OPENID_ADMIN_ROLE;
    else process.env.OPENID_ADMIN_ROLE = value;
    const actor = user();
    const update = jest.fn(async () => actor);
    const mintToken = jest.fn();

    await expect(
      applyAdminRefresh(
        tokens([]),
        {
          findUsers: async () => [actor],
          getUserById: async () => actor,
          mintToken,
          synchronizeAdministrator: (resolved, refreshed) =>
            syncOidcAdministrator(resolved, refreshed, update),
          canAccessAdmin: async (resolved) => resolved.role === 'ADMIN',
        },
        { userId: actor._id.toString(), expectedIssuer: actor.openidIssuer },
      ),
    ).rejects.toThrow('OPENID_ADMIN_ROLE');

    expect(update).not.toHaveBeenCalled();
    expect(mintToken).not.toHaveBeenCalled();
  },
);

it.each(['OPENID_ADMIN_ROLE_PARAMETER_PATH', 'OPENID_ADMIN_ROLE_TOKEN_KIND'])(
  'rejects pilot synchronization without %s',
  async (key) => {
    process.env.GOVERNANCE_PILOT_ENABLED = 'true';
    delete process.env[key];
    const update = jest.fn();

    await expect(syncOidcAdministrator(user(), tokens([]), update)).rejects.toThrow(key);
    expect(update).not.toHaveBeenCalled();
  },
);

it('preserves optional administrator mapping outside pilot mode', async () => {
  process.env.GOVERNANCE_PILOT_ENABLED = 'false';
  delete process.env.OPENID_ADMIN_ROLE;
  const actor = user();
  const update = jest.fn();

  await syncOidcAdministrator(actor, tokens([]), update);

  expect(update).not.toHaveBeenCalled();
  expect(actor.role).toBe('ADMIN');
});
