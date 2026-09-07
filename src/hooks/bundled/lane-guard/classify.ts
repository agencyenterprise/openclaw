// What an exec command spends: a config-extensible regex table maps a command
// line to the lane action classes it charges, so a new launcher is a config
// entry rather than a code change. Class names are exactly the lane.py
// `allowed_actions` they authorize against.
import { formatErrorMessage } from "../../../infra/errors.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("hooks/lane-guard");

export const LANE_ACTION_CLASSES = [
  "runpod",
  "silico",
  "spark_gpu",
  "local_cpu",
  "api_calls",
  "publish_external",
] as const;

export type LaneActionClass = (typeof LANE_ACTION_CLASSES)[number];

export type LanePatternTable = Record<LaneActionClass, string[]>;
export type LaneEstimateTable = Record<LaneActionClass, number>;

export const DEFAULT_LANE_PATTERNS: LanePatternTable = {
  runpod: ["runpod_spawn\\.sh", "runpod_pod\\.py\\s+(?:create|start)\\b", "\\brunpodctl\\b"],
  silico: ["silico_slurm\\.sh\\s+(?:submit|sbatch)\\b"],
  // `scripts/dgx` is the one entry point onto the Spark box, so any invocation of
  // it leaves the sandbox. The lookahead keeps neighbours like `scripts/dgx-notes.md` out.
  spark_gpu: ["(?:^|[\\s/\"'])scripts/dgx(?![\\w.-])"],
  local_cpu: ["\\bsystemd-run\\b"],
  api_calls: ["\\bcodex\\s+exec\\b", "\\bhcom\\s+codex\\b"],
  // Publishing to the outside world. The `git push` pattern accepts git global
  // options (`git -C <dir> push`), push flags and the `--` end-of-options marker
  // before the remote, and an optional quote around it; it rejects only the
  // remote named exactly `origin`, so the refspec-shaped `origin/main` still
  // counts. `--repo=<remote>` names the remote in a flag instead, so it gets its
  // own pattern and is kept out of the positional one.
  publish_external: [
    "\\bgh\\s+release\\b",
    "\\bgh\\s+pr\\s+create\\b",
    "\\bgit\\s+(?:-[\\w-]+(?:=\\S+)?\\s+(?:[^-\\s]\\S*\\s+)?)*push\\b(?:\\s+(?:--|--?(?!repo=)\\w[\\w-]*(?:=\\S+)?))*\\s+[\"']?(?![\"'-])(?!origin(?![\\w./@:~-]))[\\w./@:~-]+",
    "\\bgit\\s+push\\b[^&|;\\n]*--repo=[\"']?(?!origin(?![\\w./@:~-]))\\S+",
    "\\bnpm\\s+publish\\b",
    "\\bpip\\s+upload\\b",
    "\\btwine\\s+upload\\b",
  ],
};

/** USD a classified command is assumed to cost until the real spend is debited. */
export const DEFAULT_LANE_ESTIMATES: LaneEstimateTable = {
  runpod: 5,
  silico: 0,
  spark_gpu: 0,
  local_cpu: 0,
  api_calls: 1,
  // Publishing books no budget: it is gated for leaving the sandbox, not for costing money.
  publish_external: 0,
};

export type CompiledLanePattern = {
  actionClass: LaneActionClass;
  source: string;
  pattern: RegExp;
};

function compilePattern(
  actionClass: LaneActionClass,
  source: string,
): CompiledLanePattern | undefined {
  try {
    return { actionClass, source, pattern: new RegExp(source, "i") };
  } catch (err) {
    // `before_tool_call` is fail-closed (src/plugins/hook-runner-global.ts): throwing
    // here would block every exec call, not just the spending ones.
    log.error(
      `lane-guard: invalid ${actionClass} pattern ${JSON.stringify(source)}: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

/**
 * Compile one class. A class whose configured patterns are all unparseable falls
 * back to its defaults rather than silently ceasing to be gated; a class
 * configured as an empty list stays off, because that is an explicit choice.
 */
function compileClass(actionClass: LaneActionClass, sources: string[]): CompiledLanePattern[] {
  const compiled = sources.flatMap((source) => compilePattern(actionClass, source) ?? []);
  if (sources.length > 0 && compiled.length === 0) {
    log.error(`lane-guard: no usable ${actionClass} pattern in config; falling back to defaults`);
    return DEFAULT_LANE_PATTERNS[actionClass].flatMap(
      (source) => compilePattern(actionClass, source) ?? [],
    );
  }
  return compiled;
}

/** Compile the table in declared class order. */
export function compileLanePatterns(table: LanePatternTable): CompiledLanePattern[] {
  return LANE_ACTION_CLASSES.flatMap((actionClass) =>
    compileClass(actionClass, table[actionClass]),
  );
}

/**
 * Every class the command charges, in declared order. A chained command
 * (`runpodctl create ... && codex exec ...`) spends on both, so both must be
 * authorized and both must be booked; taking only the first match would let a
 * lane that forbids one of them run it anyway.
 */
export function classifyCommand(
  command: string,
  compiled: CompiledLanePattern[],
): LaneActionClass[] {
  const matched = new Set<LaneActionClass>();
  for (const entry of compiled) {
    if (entry.pattern.test(command)) {
      matched.add(entry.actionClass);
    }
  }
  return LANE_ACTION_CLASSES.filter((actionClass) => matched.has(actionClass));
}

const EXPLICIT_LANE_RE = /#\s*lane:\s*([a-z0-9][a-z0-9_-]{0,63})/i;

/** An operator can pin the lane inside the command itself with `# lane:<id>`. */
export function extractExplicitLaneId(command: string): string | undefined {
  return command.match(EXPLICIT_LANE_RE)?.[1]?.toLowerCase();
}
