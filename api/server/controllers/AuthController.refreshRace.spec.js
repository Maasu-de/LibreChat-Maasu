/**
 * CHARACTERIZATION TEST of current behavior, not a spec of desired/fixed behavior.
 *
 * Integration-level, Mongo-backed reproduction of a suspected refresh-token race:
 * two concurrent calls to POST /api/auth/refresh using the SAME still-valid refresh
 * token (mirroring useSSE.ts / useResumableSSE.ts calling request.refreshToken()
 * directly, bypassing the axios interceptor's isRefreshing/failedQueue lock).
 * See issue #116 (bug 3: users occasionally logged out unexpectedly).
 *
 * Original hypothesis (unconfirmed, based on reading generateRefreshToken/findSession):
 * the second caller's findSession lookup would miss because the first caller had
 * already rotated refreshTokenHash, producing a hard 401 for the "loser".
 *
 * Observed instead, reproduced identically across 4 manual runs against a real
 * MongoMemoryServer-backed Session: BOTH concurrent calls receive 200 with a valid
 * token, and exactly one Session document remains afterward. Both callers' findSession
 * reads apparently complete before either call's session.save() write commits, so
 * neither observes the other's rotation; both independently succeed, and the DB's
 * final refreshTokenHash reflects whichever save() happened to land last (no
 * Mongoose version-conflict, since the schema does not use optimisticConcurrency).
 *
 * This pins CURRENT behavior under this specific interleaving (in-process
 * Promise.all + MongoMemoryServer's low latency). It does NOT prove the underlying
 * lack of a shared client-side refresh lock is harmless in production, where real
 * network latency/jitter between the two callers' requests could produce a different
 * interleaving (e.g. one call's save() landing before the other's read). If this
 * assertion ever starts failing, that is a meaningful signal the race's shape has
 * changed, re-observe before re-asserting, per the same reasoning used here.
 */
jest.mock('~/strategies', () => ({ getOpenIdConfig: jest.fn(), getOpenIdEmail: jest.fn() }));
jest.mock('~/server/services/GraphTokenService', () => ({ getGraphApiToken: jest.fn() }));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const { refreshController } = require('./AuthController');

describe('refreshController - concurrent refresh with same token (OBSERVATIONAL)', () => {
  let mongoServer;
  let User, Session;
  let createSession;
  let nodeEnv;

  beforeAll(async () => {
    // Backend CI sets NODE_ENV=CI, which makes refreshController skip the session lookup under test.
    nodeEnv = jest.replaceProperty(process.env, 'NODE_ENV', 'test');
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    ({ User, Session } = require('~/db/models'));
    ({ createSession } = require('~/models'));
  });

  afterAll(async () => {
    nodeEnv.restore();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await Session.deleteMany({});
  });

  async function seedUserAndSession() {
    const user = await User.create({
      email: `race-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      provider: 'local',
    });
    const { refreshToken } = await createSession(user._id.toString());
    return { user, refreshToken };
  }

  function buildReqRes(refreshToken) {
    const req = { headers: { cookie: `refreshToken=${refreshToken}` } };
    const res = {
      statusCode: undefined,
      body: undefined,
      redirectUrl: undefined,
      cookie: jest.fn(),
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(body) {
        this.body = body;
        return this;
      },
      redirect(url) {
        this.redirectUrl = url;
        return this;
      },
    };
    return { req, res };
  }

  async function fireConcurrentRefresh() {
    const { refreshToken } = await seedUserAndSession();
    const { req: req1, res: res1 } = buildReqRes(refreshToken);
    const { req: req2, res: res2 } = buildReqRes(refreshToken);

    await Promise.all([refreshController(req1, res1), refreshController(req2, res2)]);

    const sessionsRemaining = await Session.countDocuments({});

    return {
      call1: { statusCode: res1.statusCode, hasToken: !!res1.body?.token, body: res1.body },
      call2: { statusCode: res2.statusCode, hasToken: !!res2.body?.token, body: res2.body },
      sessionsRemaining,
    };
  }

  it.each([1, 2, 3, 4])(
    'characterizes run %i: both concurrent refreshes with the same token currently succeed',
    async (run) => {
      const outcome = await fireConcurrentRefresh();
      // eslint-disable-next-line no-console
      console.log(`RACE OUTCOME run ${run}:`, JSON.stringify(outcome));

      // Pins the behavior actually observed (see file header), not the original
      // "one call fails ungracefully" hypothesis, which this reproduction did not confirm.
      expect(outcome.call1.statusCode).toBe(200);
      expect(outcome.call2.statusCode).toBe(200);
      expect(outcome.call1.hasToken).toBe(true);
      expect(outcome.call2.hasToken).toBe(true);
      expect(outcome.sessionsRemaining).toBe(1);
    },
  );
});
