import { exactCentsSchema } from "../accounting.js";
import { z } from "zod";
import {
  BUDGET_INCIDENT_RESOLUTION_ACTIONS,
  BUDGET_METRICS,
  BUDGET_SCOPE_TYPES,
  BUDGET_WINDOW_KINDS,
  isSubscriptionBudgetWindowKind,
} from "../constants.js";

export const upsertBudgetPolicySchema = z.object({
  scopeType: z.enum(BUDGET_SCOPE_TYPES),
  scopeId: z.string().guid(),
  metric: z.enum(BUDGET_METRICS).optional().default("billed_cents"),
  windowKind: z.enum(BUDGET_WINDOW_KINDS).optional().default("calendar_month_utc"),
  amount: z.number().int().nonnegative().max(2_147_483_647).optional(),
  reservationCents: exactCentsSchema.optional(),
  warnPercent: z.number().int().min(1).max(99).optional(),
  hardStopEnabled: z.boolean().optional(),
  unpricedUsagePolicy: z.enum(["block", "allow"]).optional(),
  notifyEnabled: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).superRefine((value, ctx) => {
  // Subscription-window budgets (PR #13379): metric and window kind must agree,
  // and a subscription limit is a whole percent of the provider window.
  const subscriptionWindow = isSubscriptionBudgetWindowKind(value.windowKind);
  if (value.metric === "subscription_percent") {
    if (!subscriptionWindow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "subscription_percent budgets require a provider_session or provider_week window",
        path: ["windowKind"],
      });
    }
    if (value.amount !== undefined && value.amount > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "subscription_percent budgets are a percentage and cannot exceed 100",
        path: ["amount"],
      });
    }
  } else if (subscriptionWindow) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "provider_session and provider_week windows require the subscription_percent metric",
      path: ["windowKind"],
    });
  }
});

export type UpsertBudgetPolicy = z.infer<typeof upsertBudgetPolicySchema>;

export const resolveBudgetIncidentSchema = z.object({
  action: z.enum(BUDGET_INCIDENT_RESOLUTION_ACTIONS),
  amount: z.number().int().nonnegative().max(2_147_483_647).optional(),
  decisionNote: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.action === "raise_budget_and_resume" && typeof value.amount !== "number") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "amount is required when raising a budget",
      path: ["amount"],
    });
  }
});

export type ResolveBudgetIncident = z.infer<typeof resolveBudgetIncidentSchema>;
