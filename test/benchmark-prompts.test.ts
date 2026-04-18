import { describe, expect, test } from "bun:test"

import { benchmarkArms, benchmarkTasks } from "../src/benchmark/catalog"
import {
  renderBlindReviewPrompt,
  renderDirectPrompt,
  renderPlanAuthoringPrompt,
} from "../src/benchmark/prompts"

describe("benchmark prompts", () => {
  test("direct prompt includes the task brief and acceptance commands", () => {
    const task = benchmarkTasks.find((candidate) => candidate.id === "optics-filter-combinator")

    if (task === undefined) {
      throw new Error("Missing optics-filter-combinator task")
    }

    const prompt = renderDirectPrompt({
      task,
      contextPackMode: "none",
    })

    expect(prompt).toContain("Optics Filter Traversal")
    expect(prompt).toContain("pnpm test")
    expect(prompt).toContain("README.md")
  })

  test("plan authoring prompt encodes the arm policy and deterministic context pack", () => {
    const task = benchmarkTasks.find(
      (candidate) => candidate.id === "contact-sheet-transformations-ui"
    )
    const arm = benchmarkArms.find((candidate) => candidate.id === "dagger-mixed")

    if (task === undefined || arm === undefined || arm.family !== "dagger") {
      throw new Error("Missing benchmark fixtures")
    }

    const prompt = renderPlanAuthoringPrompt({
      task,
      arm,
      contextPackMode: "deterministic",
      contextPack: "# Deterministic Context Pack",
    })

    expect(prompt).toContain("claude-opus-4-7-thinking-high")
    expect(prompt).toContain("gpt-5.4")
    expect(prompt).toContain("# Deterministic Context Pack")
  })

  test("blind review prompt hides the arm and uses rubric dimensions", () => {
    const task = benchmarkTasks.find(
      (candidate) => candidate.id === "contact-sheet-transformations-ui"
    )

    if (task === undefined) {
      throw new Error("Missing transformations task")
    }

    const prompt = renderBlindReviewPrompt({
      task,
      changedFiles: ["apps/site/app/routes/transformations.tsx"],
      acceptanceSummary: ["route tests: passed"],
    })

    expect(prompt).not.toContain("dagger-mixed")
    expect(prompt).toContain("ctaClarity")
    expect(prompt).toContain("apps/site/app/routes/transformations.tsx")
  })
})
