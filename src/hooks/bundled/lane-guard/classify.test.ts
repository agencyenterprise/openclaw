import { describe, expect, it } from "vitest";
import {
  classifyCommand,
  compileLanePatterns,
  DEFAULT_LANE_PATTERNS,
  extractExplicitLaneId,
  type LaneActionClass,
  type LanePatternTable,
} from "./classify.js";

const compiled = compileLanePatterns(DEFAULT_LANE_PATTERNS);

function classify(command: string): LaneActionClass[] {
  return classifyCommand(command, compiled);
}

describe("lane-guard classification table", () => {
  it.each([
    ["bash scripts/runpod_spawn.sh --gpu a100", "runpod"],
    ["python3 scripts/runpod_pod.py create --name harvest", "runpod"],
    ["python3 scripts/runpod_pod.py start pod-7", "runpod"],
    ["runpodctl get pod", "runpod"],
    ["scripts/silico_slurm.sh submit job.sbatch", "silico"],
    ["scripts/silico_slurm.sh sbatch job.sbatch", "silico"],
    ["./scripts/dgx 'nvidia-smi'", "spark_gpu"],
    ["bash /home/ubuntu/.openclaw/workspace/scripts/dgx --check", "spark_gpu"],
    ["systemd-run --user --scope ./harvest.sh", "local_cpu"],
    ["codex exec --model gpt-5.6-sol -C /repo", "api_calls"],
    ["hcom codex --prompt 'review the diff'", "api_calls"],
  ])("classifies %s as %s", (command, expected) => {
    expect(classify(command)).toEqual([expected]);
  });

  it.each([
    ["git status --short"],
    ["python3 scripts/runpod_pod.py stop pod-7"],
    ["cat scripts/dgx-notes.md"],
    ["rg runpodctl_docs README.md"],
    ["scripts/silico_slurm.sh status 4412"],
  ])("leaves %s unclassified", (command) => {
    expect(classify(command)).toEqual([]);
  });

  it("returns every class a chained command charges, in declared order", () => {
    expect(classify("codex exec --model gpt-5.6-sol && runpodctl create pod")).toEqual([
      "runpod",
      "api_calls",
    ]);
  });

  it("does not repeat a class a command matches twice", () => {
    expect(classify("runpodctl stop pod-1 && bash scripts/runpod_spawn.sh")).toEqual(["runpod"]);
  });

  it("takes an added launcher from the config table without a code change", () => {
    const table: LanePatternTable = {
      ...DEFAULT_LANE_PATTERNS,
      runpod: [...DEFAULT_LANE_PATTERNS.runpod, "\\bvast\\s+create\\b"],
    };
    expect(classifyCommand("vast create --gpu h100", compileLanePatterns(table))).toEqual([
      "runpod",
    ]);
  });

  it("keeps a class gated on its defaults when every configured pattern is unparseable", () => {
    const table: LanePatternTable = { ...DEFAULT_LANE_PATTERNS, local_cpu: ["("] };
    const partial = compileLanePatterns(table);
    expect(classifyCommand("systemd-run --user --scope ./harvest.sh", partial)).toEqual([
      "local_cpu",
    ]);
  });

  it("keeps the valid patterns of a class that has one bad entry", () => {
    const table: LanePatternTable = { ...DEFAULT_LANE_PATTERNS, runpod: ["(", "\\brunpodctl\\b"] };
    expect(classifyCommand("runpodctl get pod", compileLanePatterns(table))).toEqual(["runpod"]);
  });

  it("lets an operator switch a class off with an empty pattern list", () => {
    const table: LanePatternTable = { ...DEFAULT_LANE_PATTERNS, local_cpu: [] };
    expect(classifyCommand("systemd-run --user ./harvest.sh", compileLanePatterns(table))).toEqual(
      [],
    );
  });

  it("reads an operator's inline lane marker in any casing", () => {
    expect(extractExplicitLaneId("runpodctl get pod  # lane:Paper-Sprint")).toBe("paper-sprint");
    expect(extractExplicitLaneId("runpodctl get pod # lane: kv_mat_2")).toBe("kv_mat_2");
    expect(extractExplicitLaneId("runpodctl get pod")).toBeUndefined();
  });
});

describe("lane-guard publish_external class", () => {
  it.each([
    ["gh release create v1.2.0 --notes-file notes.md"],
    // `gh release` counts in every subcommand form, not only the publishing ones:
    // an alwaysCancel class is cheaper to over-gate than to miss.
    ["gh release upload v1.2.0 dist/app.tgz"],
    ["gh release list"],
    ["gh pr create --fill --base main"],
    ["npm publish --access public"],
    ["pip upload dist/openclaw-1.0.tar.gz"],
    ["python3 -m twine upload dist/*"],
  ])("classifies %s as publishing", (command) => {
    expect(classify(command)).toEqual(["publish_external"]);
  });

  it.each([
    ["git push upstream main"],
    ["git push fork"],
    ["git push --force-with-lease fork hotfix"],
    ["git push --set-upstream fork main"],
    ["git push -u fork feature/x"],
    ["git push https://github.com/ae/other.git main"],
    ["git push git@github.com:ae/other.git main"],
    // A quoted remote, git's own global options, and the end-of-options marker.
    ['git push "fork" main'],
    ["git push 'fork' main"],
    ["git -C /repo push fork main"],
    ["git --git-dir=/repo/.git push fork main"],
    ["git push -- fork main"],
    ["git push ~/mirrors/fork.git main"],
    // `origin/main` is a refspec, not the remote named `origin`.
    ["git push origin/main main"],
    // The remote can also be named by a flag instead of a positional argument.
    ["git push --repo=fork"],
  ])("classifies %s as publishing, because the remote is not origin", (command) => {
    expect(classify(command)).toEqual(["publish_external"]);
  });

  it.each([
    // origin is the sandbox's own remote, and a bare push goes to the tracked one.
    ["git push origin main"],
    ["git push"],
    ["git push --force origin main"],
    ["git push origin --tags"],
    ["git push --repo=origin HEAD"],
    ["gh pr list --state open"],
    ["gh pr view 412"],
    ["npm pack"],
    ["pip install twine"],
  ])("leaves %s unclassified", (command) => {
    expect(classify(command)).toEqual([]);
  });

  it("charges publishing alongside the spending a command also does", () => {
    expect(classify("codex exec --model gpt-5.6-sol && gh pr create --fill")).toEqual([
      "api_calls",
      "publish_external",
    ]);
  });
});
