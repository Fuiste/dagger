import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { renderDryRunPreview } from "../src/v1/engine"
import { resolvePlan } from "../src/v1/plan"

const root = "/Users/rudy/.codex/worktrees/2398/dagger"

describe("v1 example plans", () => {
  test("site redesign example parses and dry-runs", async () => {
    const planPath = join(root, "examples/site-redesign.plan.yaml")
    const source = await readFile(planPath, "utf8")
    const resolved = resolvePlan({
      planPath,
      source,
      cwd: root
    })

    const preview = renderDryRunPreview(resolved)

    expect(preview).toContain("extract-constraints")
    expect(preview).toContain("design-direction")
    expect(preview).toContain("designer -> cursor/claude-opus-4-7-thinking-high")
  })

  test("structured audit example parses and dry-runs", async () => {
    const planPath = join(root, "examples/structured-audit.plan.yaml")
    const source = await readFile(planPath, "utf8")
    const resolved = resolvePlan({
      planPath,
      source,
      cwd: root
    })

    const preview = renderDryRunPreview(resolved)

    expect(preview).toContain("extract-compose-findings")
    expect(preview).toContain("cheap_reader -> cursor/composer-2")
  })
})
