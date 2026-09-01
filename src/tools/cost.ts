import type { PodPrice } from '../client.js';

/**
 * Minutes the API divides a monthly pod price by to derive its per-minute
 * metered rate (30 days x 24 hours x 60 minutes). Mirrors
 * `BillingService.getPerMinuteRate` and is only used as a fallback when a
 * pricing response predates the server-side `perMinute` field.
 */
const MINUTES_PER_MONTH = 30 * 24 * 60;

/**
 * Deploy types the platform meters per run instead of charging a flat month.
 *
 * @remarks
 * A cronjob (recurring or one-shot) receives a metered billing assignment at
 * creation and is never charged up front — each run is debited on its actual
 * duration. Quoting one a monthly price overstates the cost by orders of
 * magnitude.
 */
const METERED_DEPLOY_TYPES = new Set(['cronjob']);

/** How a service's compute is charged. */
export type BillingModel = 'flat_monthly' | 'metered';

/** Whether `deployType` is billed per run rather than per month. */
export function isMeteredDeployType(deployType: unknown): boolean {
  return typeof deployType === 'string' && METERED_DEPLOY_TYPES.has(deployType);
}

/** Round a currency amount to cents. */
function toCents(value: number): number {
  return Number(value.toFixed(2));
}

/** Clamp an optional count to the minimum the API accepts. */
function atLeastOne(value: unknown): number {
  const n = typeof value === 'number' ? value : 1;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Flat monthly quote for a continuously running service. */
export interface FlatCostEstimate {
  billing_model: 'flat_monthly';
  /** Price of ONE pod for one month. */
  pod_unit_monthly: number;
  /** Pods per region. */
  replica_count: number;
  /** Regions the service runs in. */
  region_count: number;
  /** `pod_unit_monthly` x `replica_count` x `region_count`. */
  pod_monthly: number;
  /** Volume cost per month; a volume is one copy and does not scale. */
  disk_monthly?: number;
  /** `pod_monthly` + `disk_monthly`. */
  total_monthly: number;
  currency: 'EUR';
}

/** Per-run quote for a metered batch workload. */
export interface MeteredCostEstimate {
  billing_model: 'metered';
  /** Rate charged per minute of actual run time. */
  per_minute: number;
  /**
   * Worst case for a single run: the whole active deadline, billed. `null`
   * when no deadline was supplied, since nothing bounds the run.
   */
  max_cost_per_run: number | null;
  /**
   * Volume cost per month. A volume is charged a flat month on EVERY deploy
   * type, so it is the entire recurring charge for a metered service — the
   * compute is not billed monthly at all.
   */
  disk_monthly?: number;
  currency: 'EUR';
  note: string;
}

export type CostEstimate = FlatCostEstimate | MeteredCostEstimate;

/**
 * Resolve a pod's price row from a pricing response.
 *
 * @returns The row, or `null` when the pod is absent from the response.
 *   `null` rather than a zero price on purpose: a custom pod that was not
 *   named in the `pods` query param comes back missing, and falling back to
 *   zero would quote a paid pod as free.
 */
export function findPodPrice(
  pods: PodPrice[] | undefined,
  podId: string | null | undefined,
): PodPrice | null {
  if (!podId) return null;
  return pods?.find((p) => p.fk_pod === podId) ?? null;
}

/** Facts a quote is derived from. */
export interface QuoteInput {
  /** Deploy type, which decides the billing model. */
  deployType?: string | null;
  /**
   * Price of one pod for one month, or `null` when it could not be resolved.
   * `null` yields no quote at all — absent means unknown, never free.
   */
  podMonthly: number | null;
  /** Server-provided per-minute rate; derived from `podMonthly` when absent. */
  perMinute?: number;
  /** Pods per region. Ignored for a metered type, which is always 1. */
  replicaCount?: number;
  /** Regions the service runs in. Ignored for a metered type. */
  regionCount?: number;
  /** Volume cost per month, if any. Applies to both billing models. */
  diskMonthly?: number;
  /** A run's hard timeout, used for the metered worst case. */
  activeDeadlineSeconds?: number;
}

/**
 * Build a cost estimate from raw facts.
 *
 * @returns The estimate, or `null` when the pod could not be priced.
 *
 * @remarks
 * This is the ONLY place that decides which billing model applies. Call sites
 * pass facts and render the result; none of them branch on deploy type. That
 * is deliberate — when the branch was duplicated at each call site, the
 * `current` and `new` sides of an update delta drifted apart and reported a
 * cronjob as already paying a monthly charge it never paid.
 */
export function quote(input: QuoteInput): CostEstimate | null {
  const { podMonthly } = input;
  if (podMonthly === null || podMonthly === undefined) return null;

  const disk =
    input.diskMonthly === undefined ? undefined : toCents(input.diskMonthly);

  if (isMeteredDeployType(input.deployType)) {
    // A metered pod's rate comes from the server when available; the custom-pod
    // path has no price row to read it from, so derive it from the monthly.
    const rate = Number(input.perMinute) || podMonthly / MINUTES_PER_MONTH;
    // Billing rounds a run UP to the whole minute with a 1-minute floor, so
    // this ceiling matches what the customer would actually be charged.
    const billedMinutes =
      input.activeDeadlineSeconds && input.activeDeadlineSeconds > 0
        ? Math.max(1, Math.ceil(input.activeDeadlineSeconds / 60))
        : null;
    return {
      billing_model: 'metered',
      per_minute: Number(rate.toFixed(8)),
      max_cost_per_run:
        billedMinutes === null
          ? null
          : Number((rate * billedMinutes).toFixed(8)),
      ...(disk !== undefined ? { disk_monthly: disk } : {}),
      currency: 'EUR',
      note:
        'Cronjobs are NOT billed monthly. Nothing is charged at creation; each run is debited on its actual duration, rounded up to the whole minute with a 1-minute floor. Monthly spend is the number of runs times their real duration, so it is bounded by max_cost_per_run x runs per month.' +
        (disk
          ? ' An attached volume IS billed a flat month — disk_monthly is the entire recurring charge for this service.'
          : ''),
    };
  }

  // Every region runs `replicaCount` pods and each is billed a full pod month,
  // so the pod line is the product of all three.
  const replicaCount = atLeastOne(input.replicaCount);
  const regionCount = atLeastOne(input.regionCount);
  // Round each component ONCE, then sum the rounded values, so the parts a
  // caller reads always add up to the total it reads.
  const podTotal = toCents(podMonthly * replicaCount * regionCount);
  return {
    billing_model: 'flat_monthly',
    pod_unit_monthly: toCents(podMonthly),
    replica_count: replicaCount,
    region_count: regionCount,
    pod_monthly: podTotal,
    ...(disk !== undefined ? { disk_monthly: disk } : {}),
    total_monthly: toCents(podTotal + (disk ?? 0)),
    currency: 'EUR',
  };
}

/**
 * The recurring monthly charge an estimate represents.
 *
 * @remarks
 * For a metered service this is the volume cost alone — the compute carries no
 * monthly charge whatsoever. Reducing both models to one comparable number is
 * what lets a delta span a billing-model switch.
 */
export function recurringMonthly(estimate: CostEstimate | null): number {
  if (!estimate) return 0;
  return estimate.billing_model === 'flat_monthly'
    ? estimate.total_monthly
    : (estimate.disk_monthly ?? 0);
}

/** The billing change between two configurations of a service. */
export interface CostDelta {
  current_billing_model: BillingModel;
  new_billing_model: BillingModel;
  /** Recurring monthly charge today. Zero for a metered pod with no volume. */
  current_monthly: number;
  /** Recurring monthly charge after the update. */
  new_monthly: number;
  delta_monthly: number;
  /** Present when the current side is metered. */
  current_per_minute?: number;
  /** Present when the new side is metered. */
  new_per_minute?: number;
  currency: 'EUR';
  /** Set when the billing model itself changes. */
  note?: string;
}

/**
 * Diff two quotes.
 *
 * @returns The delta, or `null` when either side could not be priced.
 *
 * @remarks
 * A delta is always the difference of two quotes, each built from its OWN
 * side's deploy type. Computing one side with the other side's billing model
 * is what produced a `delta_monthly: 0` for a cronjob converting to a
 * flat-billed service that genuinely starts costing a month.
 */
export function delta(
  current: CostEstimate | null,
  next: CostEstimate | null,
): CostDelta | null {
  if (!current || !next) return null;

  const currentMonthly = recurringMonthly(current);
  const newMonthly = recurringMonthly(next);
  const switched = current.billing_model !== next.billing_model;

  return {
    current_billing_model: current.billing_model,
    new_billing_model: next.billing_model,
    current_monthly: currentMonthly,
    new_monthly: newMonthly,
    delta_monthly: toCents(newMonthly - currentMonthly),
    ...(current.billing_model === 'metered'
      ? { current_per_minute: current.per_minute }
      : {}),
    ...(next.billing_model === 'metered'
      ? { new_per_minute: next.per_minute }
      : {}),
    currency: 'EUR',
    ...(switched
      ? {
          note:
            next.billing_model === 'flat_monthly'
              ? 'Billing model changes: runs were debited per minute; the service now carries a flat monthly charge.'
              : 'Billing model changes: the flat monthly charge ends; each run is debited on its actual duration instead.',
        }
      : {}),
  };
}
