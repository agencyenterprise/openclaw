// Does anything already authorize starting the promised step. The lane records are
// the authority, so this asks the same `scripts/lane.py` a human asks, through the
// seam lane-guard opened (src/hooks/bundled/lane-guard/lane-cli.ts).
//
// Two rules make this safe to run on model prose rather than on a command:
//
//   * the lane is only ever one the thread's own origin covers, matched by
//     lane-guard's shared lookup (src/hooks/bundled/lane-guard/lane-lookup.ts).
//     That lookup also honours a `# lane:<id>` marker, but only in
//     `resolveLanesForCommand`, because an operator typed that command; here the
//     text is the model's own, so a marker in it would let the model name its own
//     lane. This calls `resolveLanesForThread`, which never looks at the promise
//     text. Which covering lane authorizes the work is then lane-guard's
//     `selectAuthorizingLane`, so the gate and the guard cannot disagree.
//   * a promise whose command cannot be classified is refused. "A lane exists"
//     is not authorization to spend on work nobody classified, so an unreadable
//     promise gets the correction branch, never the start branch.
//
// Nothing here reserves budget and nothing here creates a lane.
import {
  classifyCommand,
  compileLanePatterns,
  DEFAULT_LANE_ESTIMATES,
  DEFAULT_LANE_PATTERNS,
  type LaneActionClass,
} from "../lane-guard/classify.js";
import { createLaneCliRunner, type LaneCliRunner } from "../lane-guard/lane-cli.js";
import { type LaneThread, resolveLanesForThread } from "../lane-guard/lane-lookup.js";
import { selectAuthorizingLane } from "../lane-guard/lane-selection.js";

const NO_COVERING_LANE = "no active lane covers this thread";

export type LaneAuthorization = {
  /** The active lane covering this thread, or undefined when the thread has none. */
  laneId?: string;
  authorized: boolean;
  /** Why the lane allows this, or why it does not. */
  reason: string;
};

export type LaneAuthorizer = (params: {
  workspaceDir: string;
  thread: LaneThread;
  promiseText: string;
}) => Promise<LaneAuthorization>;

function classifyPromise(promiseText: string): LaneActionClass[] {
  return classifyCommand(promiseText, compileLanePatterns(DEFAULT_LANE_PATTERNS));
}

/**
 * One lookup, then one check per class the promise names, against each lane
 * covering the thread until one allows them all. The first refusal decides that
 * lane; a check that could not run is a refusal too, because an unanswered
 * question never becomes permission.
 */
export function createLaneAuthorizer(
  createRunner: (workspaceDir: string) => LaneCliRunner = createLaneCliRunner,
): LaneAuthorizer {
  return async ({ workspaceDir, thread, promiseText }) => {
    const run = createRunner(workspaceDir);
    const laneIds = await resolveLanesForThread({ workspaceDir, thread, run });
    const coveringLane = laneIds[0];
    if (!coveringLane) {
      return { authorized: false, reason: NO_COVERING_LANE };
    }
    const actionClasses = classifyPromise(promiseText);
    if (actionClasses.length === 0) {
      return {
        laneId: coveringLane,
        authorized: false,
        reason: `lane ${coveringLane} covers this thread, but the promise names no command this gate can classify`,
      };
    }
    const selection = await selectAuthorizingLane({
      laneIds,
      actionClasses,
      estimates: DEFAULT_LANE_ESTIMATES,
      run,
    });
    return selection
      ? { laneId: selection.laneId, authorized: selection.allowed, reason: selection.reason }
      : { authorized: false, reason: NO_COVERING_LANE };
  };
}
