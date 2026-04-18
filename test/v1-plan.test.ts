import { describe, expect, test } from "bun:test"

import { computeExecutionLevels, parsePlanYaml, PlanError, resolvePlan } from "../src/v1/plan"

const validPlan = `
version: 1
defaults:
  profile: balanced
tasks:
  - id: design
    kind: model
    role: designer
    prompt: Redesign the homepage hero.
    outputs:
      - id: design_spec
        path: artifacts/design.json
        format: json
  - id: merge
    kind: reduce
    dependsOn: [design]
    operation: json-array
    inputs:
      artifacts:
        - taskId: design
          artifactId: design_spec
    outputs:
      - id: merged
        path: artifacts/merged.json
        format: json
`

describe("v1 plan parser", () => {
  test("parses YAML plans and computes execution levels", () => {
    const plan = parsePlanYaml(validPlan)

    expect(plan.version).toBe(1)
    expect(plan.tasks).toHaveLength(2)
    expect(computeExecutionLevels(plan)).toEqual([["design"], ["merge"]])
  })

  test("fails when referenced artifacts do not exist", () => {
    expect(() =>
      parsePlanYaml(`
version: 1
tasks:
  - id: read
    kind: model
    role: cheap_reader
    prompt: Read files.
    outputs:
      - id: facts
        path: artifacts/facts.json
        format: json
  - id: assert
    kind: assert
    requiredArtifacts:
      - taskId: read
        artifactId: missing
`)
    ).toThrow(PlanError)
  })

  test("resolves cwd and artifactsDir relative to the plan file", () => {
    const resolved = resolvePlan({
      planPath: "examples/site-redesign.plan.yaml",
      source: validPlan,
      cwd: "/tmp/dagger-v1"
    })

    expect(resolved.profile).toBe("balanced")
    expect(resolved.planPath).toBe("/tmp/dagger-v1/examples/site-redesign.plan.yaml")
    expect(resolved.artifactsDir).toBe("/tmp/dagger-v1/.dagger/runs")
  })
})
