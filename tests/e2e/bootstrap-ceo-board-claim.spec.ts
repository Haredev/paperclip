import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.PAPERCLIP_E2E_BASE_URL ?? "http://127.0.0.1:3108";
const DATA_DIR = process.env.PAPERCLIP_E2E_DATA_DIR!;
const CONFIG_PATH = process.env.PAPERCLIP_E2E_CONFIG_PATH ?? path.join(DATA_DIR, ".paperclip", "config.json");
const BOOTSTRAP_SCRIPT = path.resolve(process.cwd(), "packages/db/scripts/create-auth-bootstrap-invite.ts");

const TEST_USER = {
  name: "Bootstrap Owner",
  email: `bootstrap-owner-${Date.now()}@paperclip.local`,
  password: "paperclip-test-password",
};

function generateBootstrapInviteUrl(): string {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return execFileSync(
    pnpm,
    ["--filter", "@paperclipai/db", "exec", "tsx", BOOTSTRAP_SCRIPT, "--config", CONFIG_PATH, "--base-url", BASE],
    { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

async function fillSignUpForm(page: Page, user: typeof TEST_USER) {
  const nameField = page.getByTestId("invite-inline-auth").getByLabel("Name");
  const emailField = page.getByTestId("invite-inline-auth").getByLabel("Email");
  const passwordField = page.getByTestId("invite-inline-auth").getByLabel("Password");
  await nameField.fill(user.name);
  await emailField.fill(user.email);
  await passwordField.fill(user.password);
}

test("bootstrap-ceo invite: signup completes without visiting board-claim URL", async ({ page }) => {
  const inviteUrl = generateBootstrapInviteUrl();
  expect(inviteUrl).toMatch(/\/invite\/pcp_bootstrap_/);

  const visitedUrls: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) visitedUrls.push(frame.url());
  });

  await page.goto(inviteUrl);
  await expect(page.getByRole("heading", { name: "Set up Paperclip" })).toBeVisible();

  await fillSignUpForm(page, TEST_USER);
  await page.getByTestId("invite-inline-auth").getByRole("button", { name: /create account/i }).click();

  await expect(page).not.toHaveURL(/\/invite\//, { timeout: 30_000 });
  await expect(page).not.toHaveURL(/\/board-claim\//, { timeout: 5_000 });
  await expect(page).toHaveURL(new RegExp(`^${BASE}/?`), { timeout: 30_000 });

  const boardClaimVisited = visitedUrls.some((u) => u.includes("/board-claim/"));
  expect(boardClaimVisited, "board-claim URL should never be visited").toBe(false);
});

test("bootstrap-ceo invite: /api/companies returns 200 after signup", async ({ page }) => {
  const inviteUrl = generateBootstrapInviteUrl();

  await page.goto(inviteUrl);
  await expect(page.getByRole("heading", { name: "Set up Paperclip" })).toBeVisible();

  await fillSignUpForm(page, { ...TEST_USER, email: `bootstrap-owner2-${Date.now()}@paperclip.local` });
  await page.getByTestId("invite-inline-auth").getByRole("button", { name: /create account/i }).click();

  await expect(page).not.toHaveURL(/\/invite\//, { timeout: 30_000 });

  const result = await page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/companies`, { credentials: "include" });
    return { status: res.status, body: await res.json() };
  }, BASE);

  expect(result.status, "/api/companies must not return 403").toBe(200);
  expect(Array.isArray(result.body), "/api/companies must return an array").toBe(true);
});
