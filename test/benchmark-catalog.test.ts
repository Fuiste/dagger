import { describe, expect, test } from "bun:test"

import {
  benchmarkArms,
  benchmarkTasks,
  buildRunQueue,
  validatePlanPolicy,
} from "../src/benchmark/catalog"

describe("benchmark catalog", () => {
  test("defines the four benchmark tasks and five benchmark arms", () => {
    expect(benchmarkTasks).toHaveLength(4)
    expect(benchmarkArms).toHaveLength(5)
  })

  test("uses the verified model ids in the benchmark arms", () => {
    expect(
      benchmarkArms.map((arm) =>
        arm.family === "direct" ? arm.model : arm.summaryModel
      )
    ).toEqual(
      expect.arrayContaining([
        "gpt-5.4",
        "claude-opus-4-7-high",
        "composer-2",
      ])
    )
  })

  test("buildRunQueue is deterministic for a given seed", () => {
    const first = buildRunQueue({
      tasks: "optics-compose-audit",
      arms: "direct-codex,direct-cursor",
      repetitions: 2,
      seed: 42,
    })
    const second = buildRunQueue({
      tasks: "optics-compose-audit",
      arms: "direct-codex,direct-cursor",
      repetitions: 2,
      seed: 42,
    })

    expect(first).toEqual(second)
    expect(first.runs).toHaveLength(4)
  })

  test("mixed-specialist policy requires both cursor and codex tasks", () => {
    const arm = benchmarkArms.find((candidate) => candidate.id === "dagger-mixed")

    if (arm === undefined || arm.family !== "dagger") {
      throw new Error("Missing dagger-mixed arm")
    }

    const errors = validatePlanPolicy(arm, {
      tasks: [
        {
          harness: "codex",
          model: "gpt-5.4",
          prompt: "Implement the feature.",
        },
      ],
    })

    expect(errors).toEqual(
      expect.arrayContaining([
        "Generated graph must contain 4-7 tasks, found 1.",
        "Mixed-specialist graph must contain at least one Cursor task.",
      ])
    )
  })

  test("optics compose audit validates the documentation mismatches heading", () => {
    const task = benchmarkTasks.find((candidate) => candidate.id === "optics-compose-audit")

    if (task === undefined || task.requiredFileSubstrings === undefined) {
      throw new Error("Missing optics-compose-audit task requirements")
    }

    expect(task.requiredFileSubstrings).toContainEqual({
      path: "benchmark-results/optics-compose-audit.md",
      substrings: ["Semantic Risks", "Missing Tests", "Documentation Mismatches"],
    })
  })
})
