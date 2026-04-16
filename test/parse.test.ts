import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"

import { computeExecutionLevels } from "../src/domain/task-graph"
import { parseMarkdownGraph } from "../src/parse/markdown-graph"

const validGraphMarkdown = `
# Build Dagger

## Tasks

### scaffold
- prompt: Set up the Bun and Effect baseline.

Keep the CLI shell small and typed.

### parser
- prompt: Implement the markdown parser.
- thinking: high

\`\`\`md
Start with fixtures and validation errors.
\`\`\`

### runtime
- prompt: Build the scheduler.

## Dependencies

- scaffold -> parser
- scaffold -> runtime
- parser -> runtime
`

describe("parseMarkdownGraph", () => {
  test("parses a valid edge-list task graph", async () => {
    const graph = await Effect.runPromise(parseMarkdownGraph(validGraphMarkdown))

    expect(graph.tasks.map((task) => task.id)).toEqual(["scaffold", "parser", "runtime"])
    expect(graph.dependencies.map((dependency) => `${dependency.from}->${dependency.to}`)).toEqual([
      "scaffold->parser",
      "scaffold->runtime",
      "parser->runtime"
    ])
    expect(graph.tasks.find((task) => task.id === "parser")?.instructions).toContain(
      "Start with fixtures"
    )
  })

  test("computes execution levels from the validated graph", async () => {
    const graph = await Effect.runPromise(parseMarkdownGraph(validGraphMarkdown))
    const levels = await Effect.runPromise(computeExecutionLevels(graph))

    expect(levels).toEqual([["scaffold"], ["parser"], ["runtime"]])
  })

  test("fails when a dependency references a missing task", async () => {
    const result = await Effect.runPromiseExit(
      parseMarkdownGraph(`
## Tasks

### scaffold
- prompt: Set up the project.

## Dependencies

- scaffold -> parser
`)
    )

    expect(Exit.isFailure(result)).toBe(true)

    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain('Unknown dependency target "parser"')
    }
  })

  test("fails when the graph contains a cycle", async () => {
    const result = await Effect.runPromiseExit(
      parseMarkdownGraph(`
## Tasks

### a
- prompt: First task.

### b
- prompt: Second task.

## Dependencies

- a -> b
- b -> a
`)
    )

    expect(Exit.isFailure(result)).toBe(true)

    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain("Task graph contains a dependency cycle")
    }
  })
})
