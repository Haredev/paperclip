// Fork (Haredev): accepting a bootstrap-ceo invite auto-applies a pending
// board claim. Runs against a real database (no route/service mocks) so the
// interaction with upstream's claimFirstInstanceAdmin is exercised for real.
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  invites,
  principalPermissionGrants,
} from "@paperclipai/db";
import { initializeBoardClaimChallenge, hasPendingBoardClaim } from "../board-claim.js";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_BOOTSTRAP_BOARD_CLAIM_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "pcp_bootstrap_board_claim_test";

describeEmbeddedPostgres("bootstrap-ceo invite auto-applies pending board claim", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bootstrap-board-claim-");
    db = createDb(external ?? tempDb!.connectionString);
  }, 20_000);

  afterEach(async () => {
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
    await db.delete(invites);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  function createApp(userId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId, companyIds: [], memberships: [] };
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  async function seed(opts: { localBoardAdmin: boolean }) {
    const now = new Date();
    const userId = `bootstrap-user-${randomUUID()}`;
    const company = await db
      .insert(companies)
      .values({ name: "Bootstrap Co", issuePrefix: `BS${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(authUsers).values({
      id: userId,
      name: "Bootstrap User",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    if (opts.localBoardAdmin) {
      await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    }
    const invite = await db
      .insert(invites)
      .values({
        inviteType: "bootstrap_ceo",
        allowedJoinTypes: "human",
        tokenHash: createHash("sha256").update(BOOTSTRAP_TOKEN).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning()
      .then((rows) => rows[0]!);
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    return { userId, company, invite };
  }

  async function adminUserIds() {
    const rows = await db
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"));
    return rows.map((row) => row.userId).sort();
  }

  it("claims the board (admin + company owner) instead of returning 409 when local-board is the only admin", async () => {
    const { userId, company, invite } = await seed({ localBoardAdmin: true });
    expect(hasPendingBoardClaim()).toBe(true);

    const res = await request(createApp(userId))
      .post(`/api/invites/${BOOTSTRAP_TOKEN}/accept`)
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ inviteId: invite.id, bootstrapAccepted: true, userId });
    expect(hasPendingBoardClaim()).toBe(false);
    expect(await adminUserIds()).toEqual([userId]);
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalId, userId))),
    ).resolves.toMatchObject([{ status: "active", membershipRole: "owner" }]);
    const [storedInvite] = await db.select().from(invites).where(eq(invites.id, invite.id));
    expect(storedInvite?.acceptedAt).toBeInstanceOf(Date);
  });

  it("falls back to the upstream first-admin claim when no board claim is pending", async () => {
    const { userId, invite } = await seed({ localBoardAdmin: false });
    expect(hasPendingBoardClaim()).toBe(false);

    const res = await request(createApp(userId))
      .post(`/api/invites/${BOOTSTRAP_TOKEN}/accept`)
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ inviteId: invite.id, bootstrapAccepted: true, userId });
    expect(await adminUserIds()).toEqual([userId]);
  });

  it("still returns 409 when a real user already owns the instance", async () => {
    const { userId } = await seed({ localBoardAdmin: false });
    await db.insert(instanceUserRoles).values({ userId: "someone-else", role: "instance_admin" });

    const res = await request(createApp(userId))
      .post(`/api/invites/${BOOTSTRAP_TOKEN}/accept`)
      .send({ requestType: "human" });

    expect(res.status).toBe(409);
    expect(await adminUserIds()).toEqual(["someone-else"]);
  });
});
