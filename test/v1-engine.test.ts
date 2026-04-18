import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { executePlan } from "../src/v1/engine"
import { resolvePlan } from "../src/v1/plan"

const collectEvents = async (events: AsyncIterable<unknown>) => {
  const values: Array<unknown> = []

  for await (const event of events) {
    values.push(event)
  }

  return values
}

const previousCursorCommand = process.env.DAGGER_CURSOR_COMMAND

afterEach(() => {
  if (previousCursorCommand === undefined) {
    delete process.env.DAGGER_CURSOR_COMMAND
  } else {
    process.env.DAGGER_CURSOR_COMMAND = previousCursorCommand
  }
})

describe("v1 engine", () => {
  test("executes a structured model -> reduce -> assert plan and reuses cache", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "dagger-v1-engine-"))
    const invocationFile = join(workspace, "invocations.log")
    const fakeCursor = join(workspace, "fake-cursor.sh")
    const planPath = join(workspace, "plan.yaml")

    await writeFile(
      fakeCursor,
      [
        "#!/bin/sh",
        "prompt=$(cat)",
        "output_path=$(printf '%s' \"$prompt\" | sed -n 's/^- design_spec: \\(.*\\) (json)$/\\1/p' | head -n 1)",
        "mkdir -p \"$(dirname \"$output_path\")\"",
        "printf '{\"palette\":\"sunrise\",\"cta\":\"Try Dagger\"}\\n' > \"$output_path\"",
        `printf 'hit\\n' >> "${invocationFile}"`,
        "printf 'DAGGER_USAGE {\"provider\":\"cursor\",\"model\":\"claude-opus-4-7-thinking-high\",\"input_tokens\":12,\"output_tokens\":3}\\n'",
        "printf 'wrote design spec\\n'"
      ].join("\n")
    )
    await Bun.$`chmod +x ${fakeCursor}`.quiet()

    const planSource = `
version: 1
tasks:
  - id: design
    kind: model
    role: designer
    prompt: Create a design system artifact for the marketing site.
    outputs:
      - id: design_spec
        path: artifacts/design.json
        format: json
  - id: pack
    kind: reduce
    dependsOn: [design]
    operation: json-array
    inputs:
      artifacts:
        - taskId: design
          artifactId: design_spec
    outputs:
      - id: design_bundle
        path: artifacts/bundle.json
        format: json
  - id: verify
    kind: assert
    dependsOn: [pack]
    requiredArtifacts:
      - taskId: pack
        artifactId: design_bundle
    commands:
      - test -f artifacts/bundle.json
`

    await writeFile(planPath, planSource)
    process.env.DAGGER_CURSOR_COMMAND = fakeCursor

    const resolvedPlan = resolvePlan({
      planPath,
      source: planSource,
      cwd: workspace
    })

    const firstHandle = executePlan({
      resolvedPlan,
      maxConcurrency: 2
    })
    const [firstEvents, firstResult] = await Promise.all([
      collectEvents(firstHandle.events),
      firstHandle.result
    ])

    expect(firstResult.status).toBe("succeeded")
    expect(firstResult.projection.usage.inputTokens).toBe(12)
    expect(firstEvents.some((event) => (event as { readonly _tag?: string })._tag === "TaskStartedEvent")).toBe(
      true
    )
    expect(JSON.parse(await readFile(join(workspace, "artifacts/bundle.json"), "utf8"))).toEqual([
      {
        palette: "sunrise",
        cta: "Try Dagger"
      }
    ])

    const secondHandle = executePlan({
      resolvedPlan,
      maxConcurrency: 2
    })
    const [, secondResult] = await Promise.all([
      collectEvents(secondHandle.events),
      secondHandle.result
    ])

    expect(secondResult.status).toBe("succeeded")
    expect((await readFile(invocationFile, "utf8")).trim().split("\n")).toHaveLength(1)

    await rm(workspace, { recursive: true, force: true })
  })
})
