import { describe, expect, test } from "bun:test"

import { benchmarkCliEntry, makeDaggerCliInvocation } from "../src/benchmark/dagger-cli"

describe("benchmark dagger cli invocation", () => {
  test("runs the local dagger entry from the disposable target worktree", () => {
    const invocation = makeDaggerCliInvocation({
      cwd: "/tmp/optics-worktree",
      planPath: "/tmp/results/plan.generated.md",
      harness: "codex",
      model: "gpt-5.4",
      dryRun: true,
    })

    expect(invocation).toEqual({
      argv: [
        "bun",
        benchmarkCliEntry,
        "do",
        "/tmp/results/plan.generated.md",
        "--harness",
        "codex",
        "--model",
        "gpt-5.4",
        "--max-concurrency",
        "3",
        "--dry-run",
      ],
      cwd: "/tmp/optics-worktree",
    })
  })
})
