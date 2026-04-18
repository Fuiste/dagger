import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { Effect } from "effect"

import { benchmarkArms } from "../src/benchmark/catalog"
import { computeExecutionLevels } from "../src/domain/task-graph"
import { parseMarkdownGraph } from "../src/parse/markdown-graph"

describe("benchmark plan fixtures", () => {
  test("optics compose audit codex plan stays dagger-valid", async () => {
    const arm = benchmarkArms.find((candidate) => candidate.id === "dagger-codex")

    if (arm === undefined || arm.family !== "dagger") {
      throw new Error("Missing dagger-codex arm")
    }

    const plan = readFileSync(
      resolve(import.meta.dir, "../benchmark-plans/optics-compose-audit.codex.md"),
      "utf8"
    )
    const graph = await Effect.runPromise(parseMarkdownGraph(plan))
    const levels = await Effect.runPromise(computeExecutionLevels(graph))

    expect(graph.tasks).toHaveLength(6)
    expect(levels).toEqual([
      ["combinator-semantics", "compose-semantics", "readme-audit", "test-coverage"],
      ["write-report"],
      ["validate-scope"],
    ])
    expect(
      graph.tasks.every(
        (task) => task.harness === "codex" && task.model === "gpt-5.4"
      )
    ).toBe(true)
  })
})
