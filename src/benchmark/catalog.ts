const DEFAULT_OPTICS_REPO_ROOT = "/Users/rudy/work/side-projects/optics"
const DEFAULT_CONTACT_SHEET_REPO_ROOT = "/Users/rudy/work/side-projects/contact-sheet-api"

export type BenchmarkRepoId = "optics" | "contact-sheet-api"
export type BenchmarkTaskId =
  | "optics-compose-audit"
  | "optics-filter-combinator"
  | "contact-sheet-transformations-ui"
  | "contact-sheet-original-sort"
export type BenchmarkArmId =
  | "direct-codex"
  | "direct-cursor"
  | "dagger-codex"
  | "dagger-mixed"
  | "dagger-cheap-swarm"
export type ContextPackMode = "none" | "deterministic"
export type DaggerHarnessName = "codex" | "cursor"
export type DaggerPlanMode = "precomputed" | "inline"

export type BenchmarkCommand = {
  readonly name: string
  readonly command: string
}

export type ContextPackSnippet = {
  readonly path: string
  readonly description: string
  readonly startLine?: number
  readonly endLine?: number
}

export type ReviewDimension =
  | "correctness"
  | "repoFit"
  | "completeness"
  | "churn"
  | "hierarchy"
  | "responsiveness"
  | "distinctiveness"
  | "ctaClarity"

export type BenchmarkTask = {
  readonly id: BenchmarkTaskId
  readonly title: string
  readonly repoId: BenchmarkRepoId
  readonly summary: string
  readonly deliverable: string
  readonly instructions: ReadonlyArray<string>
  readonly relevantFiles: ReadonlyArray<string>
  readonly acceptanceCommands: ReadonlyArray<BenchmarkCommand>
  readonly allowedChangedPaths?: ReadonlyArray<string>
  readonly requiredArtifactPath?: string
  readonly requiredFileSubstrings?: ReadonlyArray<{
    readonly path: string
    readonly substrings: ReadonlyArray<string>
  }>
  readonly contextPackSnippets?: ReadonlyArray<ContextPackSnippet>
  readonly reviewDimensions: ReadonlyArray<ReviewDimension>
}

export type BenchmarkArm =
  | {
      readonly id: BenchmarkArmId
      readonly title: string
      readonly family: "direct"
      readonly harness: DaggerHarnessName
      readonly model: string
      readonly summary: string
    }
  | {
      readonly id: BenchmarkArmId
      readonly title: string
      readonly family: "dagger"
      readonly planningModel: string
      readonly summaryHarness: DaggerHarnessName
      readonly summaryModel: string
      readonly summary: string
      readonly nodePolicyDescription: string
    }

export type BenchmarkRunSpec = {
  readonly taskId: BenchmarkTaskId
  readonly armId: BenchmarkArmId
  readonly repetition: number
  readonly contextPackMode: ContextPackMode
}

export const benchmarkRepoRoots = {
  optics: process.env.OPTICS_REPO_ROOT ?? DEFAULT_OPTICS_REPO_ROOT,
  "contact-sheet-api":
    process.env.CONTACT_SHEET_REPO_ROOT ?? DEFAULT_CONTACT_SHEET_REPO_ROOT,
} as const satisfies Record<BenchmarkRepoId, string>

export const benchmarkTasks = [
  {
    id: "optics-compose-audit",
    title: "Optics Compose Audit Report",
    repoId: "optics",
    summary:
      "Audit compose/combinator semantics and test/documentation coverage without editing library code.",
    deliverable:
      "Write benchmark-results/optics-compose-audit.md and keep source files unchanged.",
    instructions: [
      "Audit src/compose.ts, src/combinators.ts, the compose-related tests, and the README examples.",
      "Call out semantic risks, missing tests, and docs mismatches with concrete file references.",
      "Do not modify library source or tests for this task.",
    ],
    relevantFiles: [
      "src/compose.ts",
      "src/combinators.ts",
      "test/compose.test.ts",
      "test/compose-matrix.test.ts",
      "test/laws.test.ts",
      "README.md",
    ],
    acceptanceCommands: [],
    allowedChangedPaths: ["benchmark-results/optics-compose-audit.md"],
    requiredArtifactPath: "benchmark-results/optics-compose-audit.md",
    requiredFileSubstrings: [
      {
        path: "benchmark-results/optics-compose-audit.md",
        substrings: ["Semantic Risks", "Missing Tests", "Documentation Mismatches"],
      },
    ],
    contextPackSnippets: [
      {
        path: "src/compose.ts",
        description: "Core compose implementation and result-tag logic.",
      },
      {
        path: "src/combinators.ts",
        description: "Current combinator implementations and identity-preserving update style.",
      },
      {
        path: "test/compose-matrix.test.ts",
        description: "Type-level compose matrix assertions.",
        startLine: 1,
        endLine: 140,
      },
      {
        path: "test/laws.test.ts",
        description: "Current semantic law coverage.",
      },
      {
        path: "README.md",
        description: "Public-facing composition rules and examples.",
        startLine: 110,
        endLine: 240,
      },
    ],
    reviewDimensions: ["correctness", "repoFit", "completeness", "churn"],
  },
  {
    id: "optics-filter-combinator",
    title: "Optics Filter Traversal",
    repoId: "optics",
    summary:
      "Add a filter combinator for arrays that returns a Traversal, supports predicates and type guards, and preserves identity when unchanged.",
    deliverable:
      "Implement filter, export it publicly, add tests, and document it in the README.",
    instructions: [
      "Match the repo's existing immutable update semantics and ergonomic API style.",
      "Support both plain boolean predicates and narrowing predicates.",
      "Preserve input array identity when no element changes under modify.",
    ],
    relevantFiles: [
      "src/combinators.ts",
      "src/_internal.ts",
      "src/index.ts",
      "src/types.ts",
      "test/combinators.test.ts",
      "test/types.check.ts",
      "README.md",
    ],
    acceptanceCommands: [
      { name: "unit tests", command: "pnpm test" },
      { name: "type tests", command: "pnpm test:types" },
    ],
    requiredFileSubstrings: [
      {
        path: "README.md",
        substrings: ["filter"],
      },
    ],
    reviewDimensions: ["correctness", "repoFit", "completeness", "churn"],
  },
  {
    id: "contact-sheet-transformations-ui",
    title: "Contact Sheet Transformations Redesign",
    repoId: "contact-sheet-api",
    summary:
      "Redesign the logged-out /transformations route for clearer narrative flow, hierarchy, and CTA clarity while preserving the product story.",
    deliverable:
      "Update the /transformations experience and the targeted route tests.",
    instructions: [
      "Keep the route grounded in the existing visual language rather than replacing the app wholesale.",
      "Make the page feel more intentional and editorial without breaking responsiveness.",
      "Keep the public route focused on helping visitors understand the product before signup.",
    ],
    relevantFiles: [
      "apps/site/app/routes/transformations.tsx",
      "apps/site/app/components/ui/before-after-stage.tsx",
      "apps/site/app/lib/marketing/transformations.ts",
      "apps/site/test/routes/transformations.test.tsx",
      "apps/site/test/routes/public-marketing-workflow.test.tsx",
    ],
    acceptanceCommands: [
      {
        name: "route tests",
        command:
          "cd apps/site && bun x vitest run test/routes/transformations.test.tsx test/routes/public-marketing-workflow.test.tsx",
      },
    ],
    contextPackSnippets: [
      {
        path: "apps/site/app/routes/transformations.tsx",
        description: "Current route structure and copy.",
      },
      {
        path: "apps/site/test/routes/transformations.test.tsx",
        description: "Current render expectations for the route.",
      },
      {
        path: "apps/site/test/routes/public-marketing-workflow.test.tsx",
        description: "Public navigation workflow expectations.",
      },
      {
        path: "README.md",
        description: "Product framing and core stack for the monorepo.",
        startLine: 1,
        endLine: 120,
      },
    ],
    reviewDimensions: [
      "correctness",
      "repoFit",
      "completeness",
      "churn",
      "hierarchy",
      "responsiveness",
      "distinctiveness",
      "ctaClarity",
    ],
  },
  {
    id: "contact-sheet-original-sort",
    title: "Contact Sheet Original Library Sorting",
    repoId: "contact-sheet-api",
    summary:
      "Add original-library sorting (sort=newest|oldest) across API parsing, repository/view-model plumbing, dashboard UI, and targeted tests.",
    deliverable:
      "Ship end-to-end sorting support with targeted tests instead of repo-wide test runs.",
    instructions: [
      "Thread sort through the API loader, original-library view model, dashboard UI, and storage layer where needed.",
      "Preserve the current default newest-first behavior.",
      "Keep tests focused on the touched surfaces rather than the repo-wide pretest chain.",
    ],
    relevantFiles: [
      "apps/site/app/routes/api.images.tsx",
      "apps/site/app/lib/server/original-library-view.server.ts",
      "apps/site/app/routes/dashboard.tsx",
      "apps/site/app/services/ImageRepository.ts",
      "apps/site/test/routes/api.images.test.ts",
      "apps/site/test/lib/server/view-models.test.ts",
      "apps/site/test/routes/dashboard-route.test.tsx",
      "apps/site/test/services/ImageRepository.test.ts",
    ],
    acceptanceCommands: [
      {
        name: "targeted sorting tests",
        command:
          "cd apps/site && bun x vitest run test/routes/api.images.test.ts test/lib/server/view-models.test.ts test/routes/dashboard-route.test.tsx test/services/ImageRepository.test.ts",
      },
    ],
    reviewDimensions: ["correctness", "repoFit", "completeness", "churn"],
  },
] as const satisfies ReadonlyArray<BenchmarkTask>

export const benchmarkArms = [
  {
    id: "direct-codex",
    title: "Direct Codex",
    family: "direct",
    harness: "codex",
    model: "gpt-5.4",
    summary: "Single-shot Codex baseline.",
  },
  {
    id: "direct-cursor",
    title: "Direct Cursor",
    family: "direct",
    harness: "cursor",
    model: "claude-opus-4-7-high",
    summary: "Single-shot Cursor/Opus baseline.",
  },
  {
    id: "dagger-codex",
    title: "Dagger Codex-only",
    family: "dagger",
    planningModel: "gpt-5.4",
    summaryHarness: "codex",
    summaryModel: "gpt-5.4",
    summary: "Codex authors the graph and Codex executes every node.",
    nodePolicyDescription:
      "Every task must use harness codex with model gpt-5.4, or omit overrides so the CLI defaults apply.",
  },
  {
    id: "dagger-mixed",
    title: "Dagger Mixed Specialist",
    family: "dagger",
    planningModel: "gpt-5.4",
    summaryHarness: "codex",
    summaryModel: "gpt-5.4",
    summary:
      "Codex authors the graph, Opus handles design/analysis nodes, and Codex handles implementation/integration/test nodes.",
    nodePolicyDescription:
      "Design and analysis nodes must use harness cursor with model claude-opus-4-7-thinking-high. Implementation, integration, and validation nodes must use harness codex with model gpt-5.4. The graph must contain at least one task of each kind.",
  },
  {
    id: "dagger-cheap-swarm",
    title: "Dagger Cheap Swarm",
    family: "dagger",
    planningModel: "gpt-5.4",
    summaryHarness: "cursor",
    summaryModel: "composer-2",
    summary: "Codex authors the graph and Cursor composer-2 executes every node.",
    nodePolicyDescription:
      "Every task must use harness cursor with model composer-2, or omit overrides so the CLI defaults apply.",
  },
] as const satisfies ReadonlyArray<BenchmarkArm>

export const getBenchmarkTask = (taskId: BenchmarkTaskId) => {
  const task = benchmarkTasks.find((candidate) => candidate.id === taskId)

  if (task === undefined) {
    throw new Error(`Unknown benchmark task "${taskId}"`)
  }

  return task
}

export const getBenchmarkArm = (armId: BenchmarkArmId) => {
  const arm = benchmarkArms.find((candidate) => candidate.id === armId)

  if (arm === undefined) {
    throw new Error(`Unknown benchmark arm "${armId}"`)
  }

  return arm
}

export const getRepoRootForTask = (task: BenchmarkTask) => benchmarkRepoRoots[task.repoId]

const normalizeSelection = <A extends string>(
  value: string | undefined,
  all: ReadonlyArray<A>,
  label: string
) => {
  if (value === undefined) {
    return [...all]
  }

  const selected = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0) as A[]

  const unknown = selected.filter((entry) => !all.includes(entry))

  if (unknown.length > 0) {
    throw new Error(`Unknown ${label}: ${unknown.join(", ")}`)
  }

  return selected
}

const mulberry32 = (seed: number) => {
  let current = seed >>> 0

  return () => {
    current += 0x6d2b79f5
    let next = current
    next = Math.imul(next ^ (next >>> 15), next | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)

    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

export const shuffleRunQueue = <A>(values: ReadonlyArray<A>, seed: number) => {
  const random = mulberry32(seed)
  const next = [...values]

  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    const current = next[index]!
    next[index] = next[swapIndex]!
    next[swapIndex] = current
  }

  return next
}

export const buildRunQueue = (options?: {
  readonly tasks?: string
  readonly arms?: string
  readonly repetitions?: number
  readonly contextPackMode?: ContextPackMode
  readonly seed?: number
}) => {
  const selectedTasks = normalizeSelection(
    options?.tasks,
    benchmarkTasks.map((task) => task.id),
    "benchmark task ids"
  )
  const selectedArms = normalizeSelection(
    options?.arms,
    benchmarkArms.map((arm) => arm.id),
    "benchmark arm ids"
  )
  const repetitions = Math.max(1, options?.repetitions ?? 2)
  const contextPackMode = options?.contextPackMode ?? "none"
  const seed = options?.seed ?? Date.now()
  const runs: BenchmarkRunSpec[] = []

  for (const taskId of selectedTasks) {
    for (const armId of selectedArms) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        runs.push({
          taskId,
          armId,
          repetition,
          contextPackMode,
        })
      }
    }
  }

  return {
    seed,
    runs: shuffleRunQueue(runs, seed),
  }
}

export const validatePlanPolicy = (
  arm: Extract<BenchmarkArm, { family: "dagger" }>,
  graph: {
    readonly tasks: ReadonlyArray<{
      readonly harness?: DaggerHarnessName | undefined
      readonly model?: string | undefined
      readonly prompt: string
    }>
  }
) => {
  const errors: string[] = []

  if (graph.tasks.length < 4 || graph.tasks.length > 7) {
    errors.push(`Generated graph must contain 4-7 tasks, found ${graph.tasks.length}.`)
  }

  switch (arm.id) {
    case "dagger-codex":
      graph.tasks.forEach((task, index) => {
        if (task.harness !== undefined && task.harness !== "codex") {
          errors.push(`Task ${index + 1} must use codex or omit the harness override.`)
        }
        if (task.model !== undefined && task.model !== "gpt-5.4") {
          errors.push(`Task ${index + 1} must use gpt-5.4 or omit the model override.`)
        }
      })
      break
    case "dagger-cheap-swarm":
      graph.tasks.forEach((task, index) => {
        if (task.harness !== undefined && task.harness !== "cursor") {
          errors.push(`Task ${index + 1} must use cursor or omit the harness override.`)
        }
        if (task.model !== undefined && task.model !== "composer-2") {
          errors.push(`Task ${index + 1} must use composer-2 or omit the model override.`)
        }
      })
      break
    case "dagger-mixed": {
      let sawCursor = false
      let sawCodex = false

      graph.tasks.forEach((task, index) => {
        const harness = task.harness
        const model = task.model

        if (harness === "cursor") {
          sawCursor = true
          if (model !== "claude-opus-4-7-thinking-high") {
            errors.push(
              `Cursor task ${index + 1} must pin model claude-opus-4-7-thinking-high.`
            )
          }
        }

        if (harness === "codex") {
          sawCodex = true
          if (model !== "gpt-5.4") {
            errors.push(`Codex task ${index + 1} must pin model gpt-5.4.`)
          }
        }

        if (harness === undefined) {
          errors.push(
            `Mixed-specialist task ${index + 1} must declare an explicit harness and model.`
          )
        }
      })

      if (!sawCursor) {
        errors.push("Mixed-specialist graph must contain at least one Cursor task.")
      }

      if (!sawCodex) {
        errors.push("Mixed-specialist graph must contain at least one Codex task.")
      }

      break
    }
    default:
      break
  }

  return errors
}
