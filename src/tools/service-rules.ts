import { isMeteredDeployType } from './cost.js';

/**
 * A single configuration rule evaluated against a proposed service.
 */
export interface ServiceRule {
  /** Identifier of the field or aspect checked (e.g. `'source'`). */
  field: string;
  /** Whether the rule passed. */
  ok: boolean;
  /** Human-readable explanation of the result. */
  message: string;
  /**
   * Whether a failure must stop `create_service`.
   *
   * `true` mirrors something the API itself rejects, so forwarding the request
   * would only earn a raw 400. `false` is advisory — stricter than the API,
   * surfaced because the configuration probably will not build or start, but
   * never a reason to refuse the call.
   *
   * Verify against the API before marking a rule blocking. `deploy_type/static`
   * with a registry source looks like a hard rule and is documented as one, but
   * `ServicesService` only forces `runtime = 'static'` and accepts the request,
   * so blocking it here would make the MCP refuse something the platform allows.
   */
  blocking: boolean;
  /** Optional next step, surfaced as the `toolError` hint. */
  hint?: string;
}

/**
 * Deploy types that need a start command when built from a repository.
 *
 * A registry-sourced service of the same type can rely on its image's
 * `CMD`/`ENTRYPOINT` instead, so this only applies alongside a repo source.
 */
const NEEDS_RUN_COMMAND = new Set([
  'webservice',
  'private-service',
  'worker',
  'cronjob',
]);

/**
 * Evaluate every configuration rule shared by `create_service` and
 * `validate_service`.
 *
 * @param args - Raw camelCase tool arguments.
 * @returns One entry per rule, in a stable order.
 *
 * @remarks
 * This exists because the two tools used to implement the same rules
 * separately and drifted apart twice: `validate_service` rejected the
 * `cronjob` deploy type that `create_service` accepted, and later reported a
 * config valid when it set both `fkPod` and `customPod`, which
 * `create_service` refuses. Preflight that disagrees with the operation it
 * preflights is worse than no preflight, so both now read this one list.
 *
 * Rules that belong to a Zod schema (name length, enum membership, UUID
 * shape) are NOT repeated here — the schema already rejects those before a
 * handler runs. Reachability probing stays in `validate_service`, since it is
 * an outbound network call rather than a rule.
 */
export function serviceRules(args: Record<string, unknown>): ServiceRule[] {
  const rules: ServiceRule[] = [];
  const rule = (
    field: string,
    ok: boolean,
    message: string,
    blocking: boolean,
    hint?: string,
  ) => {
    rules.push({ field, ok, message, blocking, ...(hint ? { hint } : {}) });
  };

  const deployType = (args.deployType as string) ?? '';
  const hasRepo = !!(args.repositoryUrl as string | undefined)?.trim();
  const hasRegistry = !!(args.registryUrl as string | undefined)?.trim();
  const hasPod = !!(args.fkPod as string | undefined);
  const hasCustomPod = !!args.customPod;

  // The API accepts a sourceless or dual-source body and only fails later at
  // deploy time, so the XOR has to be enforced here.
  rule(
    'source',
    hasRepo !== hasRegistry,
    hasRepo && hasRegistry
      ? 'Provide only one source: repositoryUrl OR registryUrl, not both.'
      : 'A source is required: provide repositoryUrl (git) or registryUrl (container image).',
    true,
    'Use validate_service to preflight the configuration.',
  );

  // The API takes custom_pod in place of fk_pod and silently prefers it, so
  // sending both would discard the pod the caller named.
  rule(
    'fk_pod',
    hasPod !== hasCustomPod,
    hasPod && hasCustomPod
      ? 'Provide only one size: fkPod (a catalogue pod) OR customPod (cores and memory), not both.'
      : 'A size is required: provide fkPod (a catalogue pod) or customPod (cores and memory).',
    true,
    'Use list_pods for catalogue pods, or get_custom_pod_options for the custom size range.',
  );

  // Advisory, not blocking: the API accepts this body and merely forces
  // runtime = 'static' (ServicesService), so refusing it here would block
  // something the platform allows. Reported because static hosting builds from
  // a repository and the deployment is very unlikely to be what was intended.
  if (deployType === 'static' && hasRegistry) {
    rule(
      'deploy_type/static',
      false,
      "deploy_type 'static' only supports repository source (not registry)",
      false,
    );
  }

  // Cronjob rules, mirroring ServicesService. The deadline bounds the metered
  // cost of a single run, and metered billing resolves exactly one pod
  // assignment per cronjob, so a second replica would go unbilled.
  if (isMeteredDeployType(deployType)) {
    rule(
      'cronjob_active_deadline_seconds',
      args.cronjobActiveDeadlineSeconds !== undefined,
      'cronjobActiveDeadlineSeconds is required for a cronjob: each run is billed on its duration, and this bounds the worst case.',
      true,
      'See the partiri://docs/services/cronjob resource for the full cronjob contract.',
    );
    rule(
      'replica_count',
      args.replicaCount === undefined || (args.replicaCount as number) === 1,
      'cronjob services always run a single replica — omit replicaCount or set it to 1.',
      true,
      'See the partiri://docs/services/cronjob resource for the full cronjob contract.',
    );
  }

  // Advisory from here down: stricter than the API, which does not require
  // these for webservice/static/private-service. Surfaced because a repo
  // source that omits them generally will not build or start.
  if (hasRepo) {
    rule(
      'build_command',
      !!(args.buildCommand as string | undefined)?.trim(),
      'build_command is required for repository-sourced services',
      false,
    );

    if (NEEDS_RUN_COMMAND.has(deployType)) {
      rule(
        'run_command',
        !!(args.runCommand as string | undefined)?.trim(),
        'run_command is required for webservice, private-service, worker, and cronjob deploy types',
        false,
      );
    }
  }

  return rules;
}

/**
 * The first blocking rule a configuration violates.
 *
 * @returns The failing rule, or `null` when nothing blocking failed.
 *
 * @remarks
 * `create_service` refuses on this; `validate_service` ignores it and renders
 * every rule instead. That asymmetry is the whole point of the `blocking`
 * flag — the two tools stay behaviourally different without their rule sets
 * being able to disagree.
 */
export function firstBlockingFailure(
  args: Record<string, unknown>,
): ServiceRule | null {
  return serviceRules(args).find((r) => r.blocking && !r.ok) ?? null;
}
