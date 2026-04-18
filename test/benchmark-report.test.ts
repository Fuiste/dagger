import { describe, expect, test } from "bun:test"

import {
  extractCodexUsage,
  extractCursorUsage,
  summarizeCampaignResults,
  type BenchmarkRunResult,
} from "../src/benchmark/core"

const makeResult = (
  overrides: Partial<BenchmarkRunResult>
): BenchmarkRunResult => ({
  runId: "run",
  taskId: "optics-compose-audit",
  armId: "direct-codex",
  repetition: 1,
  contextPackMode: "none",
  repoRoot: "/tmp/repo",
  source: {
    branch: "main",
    commit: "abc123",
    dirty: false,
  },
  artifactDir: "/tmp/artifacts",
  promptPath: "/tmp/artifacts/prompt.md",
  planningDurationMs: 0,
  executionDurationMs: 1000,
  totalDurationMs: 1000,
  runnerSuccess: true,
  acceptancePassed: true,
  artifactSuccess: true,
  salvageSuccess: false,
  changedFiles: ["README.md"],
  changedFileCount: 1,
  diffStatPath: "/tmp/artifacts/diff.stat.txt",
  diffPatchPath: "/tmp/artifacts/diff.patch",
  acceptanceResults: [],
  artifactCheck: {
    passed: true,
    notes: [],
  },
  execution: {
    argv: ["echo", "ok"],
    cwd: "/tmp/repo",
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
  },
  usagePayloads: [],
  blindReviewPromptPath: "/tmp/artifacts/blind-review.md",
  ...overrides,
})

describe("benchmark reporting helpers", () => {
  test("extractCodexUsage reads turn.completed jsonl output", () => {
    const usage = extractCodexUsage(
      [
        '{"type":"thread.started"}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4}}',
      ].join("\n")
    )

    expect(usage).toEqual({
      provider: "codex",
      raw: {
        input_tokens: 10,
        output_tokens: 4,
      },
    })
  })

  test("extractCursorUsage reads usage from json output", () => {
    const usage = extractCursorUsage(
      '{"type":"result","usage":{"inputTokens":20,"outputTokens":5}}'
    )

    expect(usage).toEqual({
      provider: "cursor",
      raw: {
        inputTokens: 20,
        outputTokens: 5,
      },
    })
  })

  test("summarizeCampaignResults prefers acceptance rate before speed for best dagger arm", () => {
    const summary = summarizeCampaignResults([
      makeResult({
        armId: "dagger-codex",
        totalDurationMs: 1500,
        acceptancePassed: true,
      }),
      makeResult({
        armId: "dagger-mixed",
        totalDurationMs: 1200,
        acceptancePassed: true,
      }),
      makeResult({
        armId: "dagger-cheap-swarm",
        totalDurationMs: 800,
        acceptancePassed: false,
      }),
    ])

    expect(summary.bestDaggerArm).toBe("dagger-mixed")
  })
})
