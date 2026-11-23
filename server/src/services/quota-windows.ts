import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { redactDiagnosticText } from "@paperclipai/adapter-utils";
import { listServerAdapters } from "../adapters/registry.js";
import { logger } from "../middleware/logger.js";
import { createHash } from "node:crypto";
import { eq, inArray, and } from "drizzle-orm";
import { companySecrets, companySecretVersions, userSecretDefinitions, type Db } from "@paperclipai/db";
import { fetchCodexQuota } from "@paperclipai/adapter-codex-local/server";
import { fetchClaudeQuota } from "@paperclipai/adapter-claude-local/server";
import { aiConnectionService } from "./ai-connections.js";
import { trackIdleWork } from "./task-admission.js";

const accountRequests = new Map<string, { expires: number; result: Promise<ProviderQuotaResult> }>();
const publicError = "Subscription quota is currently unavailable. Check usage with your provider.";

/** Managed connections use their own credentials regardless of where agents run.
 * Never silently substitute the control-plane host's login for a remote account. */
export async function fetchCompanyQuotaWindows(db: Db, companyId: string, userId: string): Promise<ProviderQuotaResult[]> {
  const service = aiConnectionService(db);
  const accounts = await service.quotaAccounts(companyId, userId);
  if (!accounts.length) {
    return ["anthropic", "openai"].map(provider => ({ provider, ok: false,
      accountKey: `unconnected:${companyId}:${provider}`, source: "managed-connection",
      errorFamily: "credentials_unavailable", error: "Connect a subscription account in AI connections to view its quota.", windows: [] }));
  }
  // Resolve revision metadata before consulting the cache, so rotation and
  // revocation cannot serve windows associated with an old credential.
  const secretIds = accounts.flatMap(row => row.grant.credentialSecretRefs.map(ref => ref.secretId));
  const readRevisions = async (ids: string[]) => ids.length ? await db.select({ id: companySecrets.id, latestVersion: companySecrets.latestVersion, status: companySecrets.status, versionStatus: companySecretVersions.status, revokedAt: companySecretVersions.revokedAt, definitionId: companySecrets.userSecretDefinitionId, definitionStatus: userSecretDefinitions.status, definitionDeletedAt: userSecretDefinitions.deletedAt })
    .from(companySecrets).leftJoin(companySecretVersions, and(eq(companySecretVersions.secretId, companySecrets.id), eq(companySecretVersions.version, companySecrets.latestVersion))).leftJoin(userSecretDefinitions, and(eq(userSecretDefinitions.id, companySecrets.userSecretDefinitionId), eq(userSecretDefinitions.companyId, companyId))).where(and(eq(companySecrets.companyId, companyId), inArray(companySecrets.id, ids))) : [];
  const revisions = await readRevisions(secretIds);
  const identity = (row: (typeof accounts)[number], metadata: typeof revisions) => ({
    provider: row.summary.provider,
    accountKey: createHash("sha256").update(JSON.stringify([companyId, row.connection.id, row.grant.id,
      row.connection.updatedAt, row.grant.updatedAt,
      row.grant.credentialSecretRefs.map(ref => [ref.secretId, metadata.find(r => r.id === ref.secretId)]),
    ])).digest("hex"),
    accountLabel: row.summary.name, source: "managed-connection",
  });
  async function readAccount(row: (typeof accounts)[number]): Promise<ProviderQuotaResult> {
    let base = identity(row, revisions);
    const { accountKey } = base;
    const definitionUnavailable = row.grant.credentialSecretRefs.some(ref => {
      const revision = revisions.find(value => value.id === ref.secretId);
      return revision && (revision.status !== "active" || revision.versionStatus === "disabled" || revision.revokedAt != null
        || (revision.definitionId && (revision.definitionStatus !== "active" || revision.definitionDeletedAt !== null)));
    });
    if (row.summary.status !== "connected" || definitionUnavailable) {
      return { ...base, ok: false, errorFamily: "credentials_unavailable", error: publicError, windows: [] };
    }
    const key = `${userId}:${accountKey}`;
    let pending = accountRequests.get(key);
    if (!pending || pending.expires <= Date.now()) {
      const controller = new AbortController();
      // The HTTP deadline can expire while an OAuth exchange still needs to
      // save its consumed token. Track the actual work, not its timeout wrapper.
      const result = trackIdleWork((async (): Promise<ProviderQuotaResult> => {
        let credentialResolved = false;
        try {
          const value = await service.credential(row);
          controller.signal.throwIfAborted();
          credentialResolved = true;
          let windows;
          if (base.provider === "openai") {
            let auth;
            try { auth = JSON.parse(value); } catch { throw new Error("credentials_unavailable"); }
            const token = auth.tokens?.access_token ?? auth.accessToken;
            if (typeof token !== "string" || !token) {
              return { ...base, ok: false, errorFamily: "credentials_unavailable", error: publicError, windows: [] };
            }
            const read = (auth: { tokens?: { access_token?: string; account_id?: string | null }; accessToken?: string; accountId?: string | null }) =>
              fetchCodexQuota(auth.tokens?.access_token ?? auth.accessToken!, auth.tokens?.account_id ?? auth.accountId ?? null, controller.signal);
            try { windows = await read(auth); }
            catch (error) {
              if (!(error instanceof Error) || !/\b401\b/.test(error.message)) throw error;
              auth = JSON.parse(await service.refreshQuotaCredential(row, value, controller.signal));
              // Rotation changes both the grant and secret revision. Return and
              // cache the observation under the identity the next poll will see.
              const refreshed = (await service.quotaAccounts(companyId, userId)).find(candidate =>
                candidate.connection.id === row.connection.id && candidate.grant.id === row.grant.id);
              if (!refreshed || refreshed.summary.status !== "connected") throw new Error("credentials_unavailable");
              base = identity(refreshed, await readRevisions(refreshed.grant.credentialSecretRefs.map(ref => ref.secretId)));
              // A reconnect can race the completed refresh. Bind the value and
              // cache identity to one revision, rather than label old quota with
              // a newer account's key. A concurrent change defers this poll.
              const refreshedValue = await service.credential(refreshed);
              const verified = (await service.quotaAccounts(companyId, userId)).find(candidate =>
                candidate.connection.id === row.connection.id && candidate.grant.id === row.grant.id);
              if (!verified || verified.summary.status !== "connected") throw new Error("credentials_unavailable");
              const verifiedIdentity = identity(verified, await readRevisions(verified.grant.credentialSecretRefs.map(ref => ref.secretId)));
              if (verifiedIdentity.accountKey !== base.accountKey) throw new Error("provider_unavailable");
              auth = JSON.parse(refreshedValue);
              controller.signal.throwIfAborted();
              windows = await read(auth);
            }
          } else {
            windows = await fetchClaudeQuota(value, controller.signal);
          }
          return { ...base, ok: true, windows, capturedAt: new Date().toISOString() };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Quota unavailable";
          const missing = message === "credentials_unavailable";
          const invalid = message === "authentication_required" || (credentialResolved && /\b401\b|refresh_token_(?:reused|expired|invalidated)/i.test(message));
          const errorFamily = missing ? "credentials_unavailable" : invalid ? "authentication_required"
            : credentialResolved && /\b403\b/.test(message) ? "permission_denied" : "provider_unavailable";
          logger.warn({ companyId, accountKey, provider: base.provider, authenticationFailed: invalid }, "Connected account quota unavailable");
          return { ...base, ok: false, windows: [], error: publicError,
            errorFamily };
        }
      })());
      const bounded: Promise<ProviderQuotaResult> = withQuotaTimeout(base.provider, result, () => controller.abort()).then(quota => {
        const observation = { ...base, ...quota, ...(quota.ok ? {} : { error: publicError }) };
        if (observation.ok && observation.accountKey !== accountKey) {
          if (accountRequests.get(key)?.result === bounded) accountRequests.delete(key);
          if (accountRequests.size >= 500) accountRequests.delete(accountRequests.keys().next().value!);
          accountRequests.set(`${userId}:${observation.accountKey}`, { result: Promise.resolve(observation), expires: Date.now() + 30_000 });
        }
        return observation;
      });
      pending = { result: bounded, expires: Date.now() + 30_000 };
      if (accountRequests.size >= 500) accountRequests.delete(accountRequests.keys().next().value!);
      accountRequests.set(key, pending);
    }
    return pending.result;
  }
  const results: ProviderQuotaResult[] = new Array(accounts.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, async () => {
    while (next < accounts.length) {
      const index = next++;
      results[index] = await readAccount(accounts[index]);
    }
  }));
  return results;
}

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * How long a provider quota snapshot stays fresh for enforcement reads.
 * Provider usage endpoints are rate limited (the Anthropic OAuth usage endpoint
 * allows about one read per minute per account, shared with every other client
 * of that account), and the Claude CLI fallback runs a multi-second terminal
 * probe, so enforcement never fetches on every dispatch and the default
 * cadence stays well under that ceiling.
 */
export const QUOTA_SNAPSHOT_TTL_MS = readPositiveIntEnv("PAPERCLIP_QUOTA_SNAPSHOT_TTL_MS", 120_000);

/**
 * How soon a throttled read (HTTP 429) is retried, and how many such retries
 * one refresh cycle may make before waiting out the full TTL. A 429 means the
 * endpoint is healthy and another client used this minute's read, so a short
 * wait usually clears it; the cap keeps a sustained throttle from turning into
 * the retry loops that public reports say can get a token flagged.
 */
export const QUOTA_SNAPSHOT_THROTTLE_RETRY_MS = readPositiveIntEnv("PAPERCLIP_QUOTA_SNAPSHOT_THROTTLE_RETRY_MS", 20_000);
export const QUOTA_SNAPSHOT_THROTTLE_RETRIES = readPositiveIntEnv("PAPERCLIP_QUOTA_SNAPSHOT_THROTTLE_RETRIES", 2);

/**
 * How long the last successful read of a provider keeps standing in for a
 * failed refresh. The Anthropic usage endpoint is rate limited and the Claude
 * CLI fallback scrapes a terminal, so single reads fail now and then; without
 * this bound each blip would report the provider as unknown for one TTL and
 * flip budget summaries between a measured percent and "unavailable". A
 * provider that stays unreadable past this bound is reported as unavailable.
 * The dispatch gate never clears a run on a stale result (it may only defer
 * on one), so the reuse serves the summaries; unreadable and stale-below-limit
 * usage both hold runs under a limit for a re-check.
 */
export const QUOTA_SNAPSHOT_MAX_STALE_MS = readPositiveIntEnv(
  "PAPERCLIP_QUOTA_SNAPSHOT_MAX_STALE_MS",
  10 * 60_000,
);

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    default:
      return type;
  }
}

/**
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 */
export async function fetchAllQuotaWindows(): Promise<ProviderQuotaResult[]> {
  const adapters = listServerAdapters().filter((a) => a.getQuotaWindows != null);

  const settled = await Promise.allSettled(
    adapters.map((adapter) => withQuotaTimeout(adapter.type, Promise.resolve().then(() => adapter.getQuotaWindows!()))),
  );

  return settled.map((result, i) => {
    const adapterType = adapters[i]!.type;
    const quota: ProviderQuotaResult = result.status === "fulfilled" ? result.value : {
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    };
    if (quota.ok) return { ...quota, error: undefined };
    logger.warn({
      adapterType,
      errorFamily: quota.errorFamily,
      diagnostic: redactDiagnosticText(quota.error ?? "Quota probe failed").slice(0, 2_000),
    }, "Provider subscription quota unavailable");
    return { ...quota, error: "Subscription quota is currently unavailable. Check usage with your provider." };
  });
}

export type QuotaSnapshot = {
  results: ProviderQuotaResult[];
  fetchedAt: Date;
};

/** One provider window observed outside the probe, e.g. from a live run's stream. */
export type QuotaWindowObservation = {
  provider: string;
  window: QuotaWindow;
  observedAt: Date;
  /** Where the observation came from, recorded as the row's source when it starts one. */
  source?: string | null;
};

export type QuotaSnapshotReader = ((input?: { now?: Date }) => Promise<QuotaSnapshot>) & {
  /**
   * Folds an observation into the snapshot immediately: the provider's last
   * good row gains or replaces that window, is stamped with the observation
   * time, and stands as a fresh (not stale) result until the next probe.
   * Returns false when the observation was dropped because it would lower
   * usage within the same window.
   */
  observe?: (observation: QuotaWindowObservation) => boolean;
};

/**
 * Two readings of one window can report reset times a moment apart (header
 * seconds versus endpoint microseconds); only a clearly later reset means a
 * new window.
 */
const WINDOW_ROLLOVER_TOLERANCE_MS = 60_000;

function parseObservedAt(result: ProviderQuotaResult): number | null {
  if (!result.observedAt) return null;
  const parsed = new Date(result.observedAt).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Builds a memoized reader over `fetchAllQuotaWindows`. One fetch is shared by
 * all concurrent callers, and the result is reused until `ttlMs` has elapsed.
 * The reader never throws: a failed fetch yields per-provider `ok: false` rows,
 * which the gate treats as unknown usage (runs under a limit wait for a
 * re-check; scopes without a limit proceed).
 *
 * A provider whose refresh fails keeps its last successful result, marked
 * `stale` and carrying the new error, until that result is older than
 * `maxStaleMs`. Every ok row is stamped with `observedAt` so consumers can say
 * how old the usage is.
 */
export function isRateLimitedQuotaResult(result: ProviderQuotaResult): boolean {
  if (result.ok) return false;
  if (result.rateLimited === true) return true;
  return typeof result.error === "string" && /\b429\b/.test(result.error);
}

export function createQuotaSnapshotReader(options: {
  fetch?: () => Promise<ProviderQuotaResult[]>;
  ttlMs?: number;
  maxStaleMs?: number;
  throttleRetryMs?: number;
  maxThrottleRetries?: number;
} = {}): QuotaSnapshotReader {
  const fetch = options.fetch ?? fetchAllQuotaWindows;
  const ttlMs = options.ttlMs ?? QUOTA_SNAPSHOT_TTL_MS;
  const maxStaleMs = options.maxStaleMs ?? QUOTA_SNAPSHOT_MAX_STALE_MS;
  const throttleRetryMs = options.throttleRetryMs ?? QUOTA_SNAPSHOT_THROTTLE_RETRY_MS;
  const maxThrottleRetries = options.maxThrottleRetries ?? QUOTA_SNAPSHOT_THROTTLE_RETRIES;
  let cached: QuotaSnapshot | null = null;
  /** When the cached snapshot may be refreshed: the TTL, or sooner after a throttle. */
  let refreshAt = 0;
  let throttleRetries = 0;
  let inFlight: Promise<QuotaSnapshot> | null = null;
  /** Last ok result per provider, reused while that provider's refresh fails. */
  const lastGood = new Map<string, ProviderQuotaResult>();
  /**
   * Windows observed from live runs, per provider and window key, with the
   * time each was observed. A probe's data is as old as the moment the probe
   * started, so a window observed after that moment outranks the probe's copy
   * of it; older observations are dropped once a probe supersedes them.
   */
  const harvested = new Map<string, Map<string, { window: QuotaWindow; observedAt: number }>>();

  function mergeNewerObservations(result: ProviderQuotaResult, probeStartedAt: Date): QuotaWindow[] {
    const newer = harvested.get(result.provider);
    if (!newer) return result.windows;
    let windows = result.windows;
    for (const [key, entry] of newer) {
      if (entry.observedAt <= probeStartedAt.getTime()) {
        newer.delete(key);
        continue;
      }
      windows = windows.filter((window) => window.key !== key);
      windows.push(entry.window);
    }
    return windows;
  }

  function reconcile(results: ProviderQuotaResult[], fetchedAt: Date, probeStartedAt: Date): ProviderQuotaResult[] {
    const observedAt = fetchedAt.toISOString();
    return results.map((result) => {
      if (result.ok) {
        const fresh: ProviderQuotaResult = {
          ...result,
          windows: mergeNewerObservations(result, probeStartedAt),
          observedAt,
        };
        lastGood.set(result.provider, fresh);
        return fresh;
      }
      const previous = lastGood.get(result.provider);
      const previousObservedAt = previous ? parseObservedAt(previous) : null;
      if (
        !previous
        || previousObservedAt == null
        || fetchedAt.getTime() - previousObservedAt >= maxStaleMs
      ) {
        lastGood.delete(result.provider);
        return result;
      }
      return {
        ...previous,
        stale: true,
        error: result.error,
        errorFamily: result.errorFamily ?? null,
        rateLimited: result.rateLimited === true,
      };
    });
  }

  /**
   * Within one provider window usage only rises; it drops when the window
   * resets. A harvested reading below the current one is therefore accepted
   * only when the window has rolled over: the current reading's reset time
   * has passed, or the new reading resets clearly later. Anything else is
   * dropped, so a misreporting stream cannot open a saturated window.
   */
  function acceptsObservation(observation: QuotaWindowObservation): boolean {
    const next = observation.window;
    if (next.usedPercent == null) return false;
    const current = lastGood.get(observation.provider)?.windows.find((window) => window.key === next.key);
    if (!current || current.usedPercent == null || next.usedPercent >= current.usedPercent) return true;
    const currentReset = current.resetsAt ? Date.parse(current.resetsAt) : Number.NaN;
    if (Number.isNaN(currentReset)) return false;
    if (currentReset <= observation.observedAt.getTime()) return true;
    const nextReset = next.resetsAt ? Date.parse(next.resetsAt) : Number.NaN;
    return !Number.isNaN(nextReset) && nextReset > currentReset + WINDOW_ROLLOVER_TOLERANCE_MS;
  }

  function observe(observation: QuotaWindowObservation): boolean {
    if (!acceptsObservation(observation)) return false;
    const observedAt = observation.observedAt.toISOString();
    const key = observation.window.key ?? "";
    const perProvider = harvested.get(observation.provider) ?? new Map();
    perProvider.set(key, { window: observation.window, observedAt: observation.observedAt.getTime() });
    harvested.set(observation.provider, perProvider);
    const previous = lastGood.get(observation.provider);
    const windows = (previous?.windows ?? []).filter((window) => window.key !== observation.window.key);
    windows.push(observation.window);
    const fresh: ProviderQuotaResult = {
      provider: observation.provider,
      ok: true,
      source: previous?.source ?? observation.source ?? null,
      windows,
      observedAt,
    };
    lastGood.set(observation.provider, fresh);
    // Readers see it at once. The probe schedule is untouched: a run's stream
    // reports one window at a time, so the probe still fills in the rest.
    const results = (cached?.results ?? []).filter((row) => row.provider !== observation.provider);
    results.push(fresh);
    cached = { results, fetchedAt: cached?.fetchedAt ?? observation.observedAt };
    return true;
  }

  const read: QuotaSnapshotReader = async (input = {}) => {
    const now = input.now ?? new Date();
    if (cached && now.getTime() < refreshAt) return cached;
    if (inFlight) return inFlight;
    const probeStartedAt = new Date();
    inFlight = fetch()
      .then(
        (results) => results,
        (error: unknown): ProviderQuotaResult[] => {
          // The whole fetch threw, so no provider reported anything. Report the
          // failure against every provider we have seen so their last good
          // read can stand in; with no history there is nothing to attribute.
          const failure = { ok: false as const, error: String(error), windows: [] };
          const known = [...lastGood.keys()];
          return known.length > 0
            ? known.map((provider) => ({ provider, ...failure }))
            : [{ provider: "unknown", ...failure }];
        },
      )
      .then((results) => {
        const fetchedAt = new Date();
        const throttled = results.some(isRateLimitedQuotaResult);
        if (throttled && throttleRetries < maxThrottleRetries) {
          throttleRetries += 1;
          refreshAt = fetchedAt.getTime() + throttleRetryMs;
        } else {
          throttleRetries = 0;
          refreshAt = fetchedAt.getTime() + ttlMs;
        }
        const snapshot: QuotaSnapshot = { results: reconcile(results, fetchedAt, probeStartedAt), fetchedAt };
        cached = snapshot;
        return snapshot;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  read.observe = observe;
  return read;
}

let sharedQuotaSnapshotReader: QuotaSnapshotReader | null = null;

/** Process-wide memoized quota reader used by budget enforcement and summaries. */
export function readQuotaSnapshot(input?: { now?: Date }): Promise<QuotaSnapshot> {
  sharedQuotaSnapshotReader ??= createQuotaSnapshotReader();
  return sharedQuotaSnapshotReader(input);
}

/** Folds an observation into the process-wide snapshot (see QuotaSnapshotReader.observe). */
export function observeQuotaWindow(observation: QuotaWindowObservation): boolean {
  sharedQuotaSnapshotReader ??= createQuotaSnapshotReader();
  return sharedQuotaSnapshotReader.observe?.(observation) ?? false;
}

/** Claude Code `rate_limit_event` window types that map onto known quota windows. */
const CLAUDE_RATE_LIMIT_WINDOWS: Record<string, { key: string; label: string }> = {
  five_hour: { key: "five_hour", label: "Current session" },
  seven_day: { key: "seven_day", label: "Current week (all models)" },
  seven_day_sonnet: { key: "seven_day_sonnet", label: "Current week (Sonnet only)" },
  seven_day_opus: { key: "seven_day_opus", label: "Current week (Opus only)" },
};

function rateLimitPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  // The SDK reports utilization as the API's ratio, so at most 1 means a
  // fraction; larger values are already percents (a defensive reading).
  const percent = value <= 1 ? value * 100 : value;
  return Math.min(100, Math.round(percent));
}

function rateLimitResetsAt(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Epoch seconds unless it already looks like milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/**
 * Normalizes Claude Code's `rate_limit_info` (from the SDK's `rate_limit_event`,
 * forwarded by the Claude ACP bridge as usage-update meta) into a quota
 * window. Overage and unknown window types yield null.
 */
export function claudeRateLimitInfoToWindow(info: Record<string, unknown>): QuotaWindow | null {
  const type = typeof info.rateLimitType === "string" ? info.rateLimitType : null;
  const known = type ? CLAUDE_RATE_LIMIT_WINDOWS[type] : undefined;
  if (!known) return null;
  return {
    key: known.key,
    label: known.label,
    usedPercent: rateLimitPercent(info.utilization),
    resetsAt: rateLimitResetsAt(info.resetsAt),
    valueLabel: null,
    detail: null,
  };
}

const CLAUDE_RUN_STREAM_SOURCE = "claude-run-stream";
const harvestedProviderWindows = new Set<string>();

/**
 * Records a Claude rate-limit observation from a live run against `provider`.
 * Returns the window it became, and whether this process has seen that
 * provider window before, so the caller can log the first one for operators
 * to confirm the payload's scale.
 */
export function observeClaudeRateLimitInfo(
  provider: string,
  info: Record<string, unknown>,
  observedAt: Date,
): { window: QuotaWindow; first: boolean } | null {
  const window = claudeRateLimitInfoToWindow(info);
  if (!window || window.usedPercent == null) return null;
  if (!observeQuotaWindow({ provider, window, observedAt, source: CLAUDE_RUN_STREAM_SOURCE })) return null;
  const seenKey = `${provider}:${window.key}`;
  const first = !harvestedProviderWindows.has(seenKey);
  harvestedProviderWindows.add(seenKey);
  return { window, first };
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult>,
  onTimeout?: () => void,
): Promise<ProviderQuotaResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
          onTimeout?.();
          resolve({
            provider: providerSlugForAdapterType(adapterType),
            ok: false,
            error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
            windows: [],
          });
        }, QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
