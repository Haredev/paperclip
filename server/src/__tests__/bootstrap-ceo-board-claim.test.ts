import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

const autoClaimBoardIfPendingMock = vi.fn();

vi.mock("../board-claim.js", () => ({
  autoClaimBoardIfPending: (...args: unknown[]) => autoClaimBoardIfPendingMock(...args),
  initializeBoardClaimChallenge: vi.fn(),
  getBoardClaimWarningUrl: vi.fn().mockReturnValue(null),
  inspectBoardClaimChallenge: vi.fn(),
  claimBoardOwnership: vi.fn(),
}));

const isInstanceAdminMock = vi.fn();
const promoteInstanceAdminMock = vi.fn();

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    isInstanceAdmin: (...args: unknown[]) => isInstanceAdminMock(...args),
    promoteInstanceAdmin: (...args: unknown[]) => promoteInstanceAdminMock(...args),
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({ getById: vi.fn() }),
  boardAuthService: () => ({
    createChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn(),
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

function createBootstrapInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: "invite-bootstrap-1",
    companyId: null,
    inviteType: "bootstrap_ceo",
    allowedJoinTypes: "human",
    tokenHash: "hash",
    defaultsPayload: null,
    expiresAt: new Date("2027-12-31T00:00:00.000Z"),
    invitedByUserId: null,
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createDbStub(invite = createBootstrapInvite()) {
  const updateInviteMock = vi.fn();
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve([invite]);
            },
          };
        },
      };
    },
    update(...args: unknown[]) {
      updateInviteMock(...args);
      return {
        set() {
          return {
            where() {
              return {
                returning() {
                  return Promise.resolve([{ ...invite, acceptedAt: new Date() }]);
                },
              };
            },
          };
        },
      };
    },
  };
  return { db, updateInviteMock };
}

function createApp(db: Record<string, unknown>, userId = "user-bootstrap-1") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "session",
      userId,
      companyIds: [],
      memberships: [],
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /invites/:token/accept — bootstrap_ceo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isInstanceAdminMock.mockResolvedValue(false);
    promoteInstanceAdminMock.mockResolvedValue(undefined);
    autoClaimBoardIfPendingMock.mockResolvedValue(true);
  });

  it("calls autoClaimBoardIfPending with the signed-in userId after accepting", async () => {
    const { db } = createDbStub();
    const app = createApp(db, "user-bootstrap-1");

    const res = await request(app)
      .post("/api/invites/pcp_bootstrap_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body.bootstrapAccepted).toBe(true);
    expect(autoClaimBoardIfPendingMock).toHaveBeenCalledWith(db, "user-bootstrap-1");
  });

  it("promotes to instance_admin before auto-claiming", async () => {
    const { db } = createDbStub();
    const app = createApp(db, "user-bootstrap-1");

    await request(app)
      .post("/api/invites/pcp_bootstrap_test/accept")
      .send({ requestType: "human" });

    expect(promoteInstanceAdminMock).toHaveBeenCalledWith("user-bootstrap-1");
    const promoteOrder = promoteInstanceAdminMock.mock.invocationCallOrder[0];
    const claimOrder = autoClaimBoardIfPendingMock.mock.invocationCallOrder[0];
    expect(promoteOrder).toBeLessThan(claimOrder);
  });

  it("skips promoteInstanceAdmin when user is already an instance admin", async () => {
    isInstanceAdminMock.mockResolvedValue(true);
    const { db } = createDbStub();
    const app = createApp(db, "user-bootstrap-1");

    const res = await request(app)
      .post("/api/invites/pcp_bootstrap_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(promoteInstanceAdminMock).not.toHaveBeenCalled();
    expect(autoClaimBoardIfPendingMock).toHaveBeenCalledWith(db, "user-bootstrap-1");
  });

  it("still returns 202 when no pending board claim exists", async () => {
    autoClaimBoardIfPendingMock.mockResolvedValue(false);
    const { db } = createDbStub();
    const app = createApp(db, "user-bootstrap-1");

    const res = await request(app)
      .post("/api/invites/pcp_bootstrap_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body.bootstrapAccepted).toBe(true);
  });

  it("rejects agent requestType on bootstrap_ceo invite", async () => {
    const { db } = createDbStub();
    const app = createApp(db);

    const res = await request(app)
      .post("/api/invites/pcp_bootstrap_test/accept")
      .send({ requestType: "agent", agentName: "bot" });

    expect(res.status).toBe(400);
    expect(autoClaimBoardIfPendingMock).not.toHaveBeenCalled();
  });

  it("rejects an already-accepted bootstrap_ceo invite", async () => {
    const { db } = createDbStub(createBootstrapInvite({ acceptedAt: new Date("2026-05-01T00:00:00.000Z") }));
    const app = createApp(db);

    const res = await request(app)
      .post("/api/invites/pcp_bootstrap_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(404);
    expect(autoClaimBoardIfPendingMock).not.toHaveBeenCalled();
  });
});
