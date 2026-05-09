import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3108);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const INSTANCE_ID = "bootstrap-claim-e2e";

// Guard against re-evaluation in Playwright worker processes: workers inherit the
// main process's env, so if PAPERCLIP_E2E_HOME is already set we reuse it instead
// of creating a new temp dir that won't match the already-running webServer.
const home =
  process.env.PAPERCLIP_E2E_HOME ??
  fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-bc-e2e-"));

const DB_PORT = process.env.PAPERCLIP_E2E_DB_PORT
  ? Number(process.env.PAPERCLIP_E2E_DB_PORT)
  : 54332 + Math.floor(Math.random() * 10);

const instanceDir = path.join(home, "instances", INSTANCE_ID);

if (!process.env.PAPERCLIP_E2E_HOME) {
  fs.mkdirSync(path.join(instanceDir, "secrets"), { recursive: true });
  fs.mkdirSync(path.join(instanceDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(instanceDir, "data", "storage"), { recursive: true });

  const jwtSecret = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(instanceDir, ".env"), `PAPERCLIP_AGENT_JWT_SECRET=${jwtSecret}\n`);

  const masterKey = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(instanceDir, "secrets", "master.key"), masterKey);

  const configPath = path.join(instanceDir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        $meta: { version: 1, updatedAt: new Date().toISOString(), source: "onboard" },
        database: {
          mode: "embedded-postgres",
          embeddedPostgresDataDir: path.join(instanceDir, "db"),
          embeddedPostgresPort: DB_PORT,
          backup: {
            enabled: false,
            intervalMinutes: 60,
            retentionDays: 7,
            dir: path.join(instanceDir, "data", "backups"),
          },
        },
        server: {
          deploymentMode: "authenticated",
          exposure: "private",
          bind: "loopback",
          host: "127.0.0.1",
          port: PORT,
        },
        auth: { baseUrlMode: "auto" },
        logging: { mode: "file", dir: path.join(instanceDir, "logs") },
        storage: {
          provider: "local_disk",
          localDisk: { baseDir: path.join(instanceDir, "data", "storage") },
        },
        secrets: {
          provider: "local_encrypted",
          localEncrypted: { keyFilePath: path.join(instanceDir, "secrets", "master.key") },
        },
      },
      null,
      2,
    ),
  );

  // Expose to both the webServer process and the test workers.
  process.env.PAPERCLIP_E2E_HOME = home;
  process.env.PAPERCLIP_E2E_DB_PORT = String(DB_PORT);
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = INSTANCE_ID;
  process.env.PAPERCLIP_PUBLIC_URL = BASE_URL;
  process.env.PAPERCLIP_E2E_DATA_DIR = home;
  process.env.PAPERCLIP_E2E_CONFIG_PATH = configPath;
  process.env.PAPERCLIP_E2E_BASE_URL = BASE_URL;
  process.env.PAPERCLIP_E2E_PORT = String(PORT);
}

const configPath = path.join(instanceDir, "config.json");

export default defineConfig({
  testDir: ".",
  testMatch: "bootstrap-ceo-board-claim.spec.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `pnpm paperclipai run`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(PORT),
      PAPERCLIP_HOME: home,
      PAPERCLIP_INSTANCE_ID: INSTANCE_ID,
      PAPERCLIP_PUBLIC_URL: BASE_URL,
      PAPERCLIP_CONFIG: configPath,
      DATABASE_URL: "",
      DATABASE_MIGRATION_URL: "",
    },
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
