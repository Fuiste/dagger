import {
  benchmarkArms,
  benchmarkTasks,
  type ContextPackMode,
  type DaggerHarnessName,
  type DaggerPlanMode,
} from "./catalog"
import {
  defaultResultsRoot,
  renderPreflightMarkdown,
  renderTaskCatalog,
  rerenderLatestCampaignReport,
  runBenchmarkCampaign,
  runBenchmarkPreflight,
} from "./core"

type ParsedFlags = {
  readonly values: Readonly<Record<string, string>>
  readonly booleans: ReadonlySet<string>
}

const usage = () =>
  [
    "Benchmark CLI",
    "",
    "Usage:",
    "  bun run src/benchmark/cli.ts tasks",
    "  bun run src/benchmark/cli.ts preflight [--results-root PATH]",
    "  bun run src/benchmark/cli.ts run [--results-root PATH] [--tasks id1,id2] [--arms id1,id2] [--repetitions N] [--context-pack none|deterministic] [--seed N] [--limit N] [--dagger-plan-mode precomputed|inline] [--dagger-plan-harness codex|cursor] [--dagger-plan-model MODEL] [--dagger-plan-file PATH] [--skip-preflight] [--keep-worktrees]",
    "  bun run src/benchmark/cli.ts report [--results-root PATH]",
    "",
    "Task ids:",
    ...benchmarkTasks.map((task) => `  - ${task.id}`),
    "",
    "Arm ids:",
    ...benchmarkArms.map((arm) => `  - ${arm.id}`),
  ].join("\n")

const parseFlags = (argv: ReadonlyArray<string>): ParsedFlags => {
  const values: Record<string, string> = {}
  const booleans = new Set<string>()

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]

    if (current === undefined || !current.startsWith("--")) {
      throw new Error(`Unexpected argument "${current ?? ""}".`)
    }

    const key = current.slice(2)
    const next = argv[index + 1]

    if (next === undefined || next.startsWith("--")) {
      booleans.add(key)
      continue
    }

    values[key] = next
    index += 1
  }

  return {
    values,
    booleans,
  }
}

const getNumberFlag = (flags: ParsedFlags, key: string) => {
  const value = flags.values[key]

  if (value === undefined) {
    return undefined
  }

  const parsed = Number(value)

  if (!Number.isFinite(parsed)) {
    throw new Error(`Flag --${key} must be numeric, received "${value}".`)
  }

  return parsed
}

const getContextPackMode = (flags: ParsedFlags): ContextPackMode | undefined => {
  const value = flags.values["context-pack"]

  if (value === undefined) {
    return undefined
  }

  if (value !== "none" && value !== "deterministic") {
    throw new Error(`Flag --context-pack must be none or deterministic, received "${value}".`)
  }

  return value
}

const getDaggerPlanMode = (flags: ParsedFlags): DaggerPlanMode | undefined => {
  const value = flags.values["dagger-plan-mode"]

  if (value === undefined) {
    return undefined
  }

  if (value !== "precomputed" && value !== "inline") {
    throw new Error(
      `Flag --dagger-plan-mode must be precomputed or inline, received "${value}".`
    )
  }

  return value
}

const getDaggerPlanHarness = (flags: ParsedFlags): DaggerHarnessName | undefined => {
  const value = flags.values["dagger-plan-harness"]

  if (value === undefined) {
    return undefined
  }

  if (value !== "codex" && value !== "cursor") {
    throw new Error(
      `Flag --dagger-plan-harness must be codex or cursor, received "${value}".`
    )
  }

  return value
}

const main = async () => {
  const [command, ...rest] = Bun.argv.slice(2)

  if (command === undefined || command === "--help" || command === "-h") {
    console.log(usage())
    return
  }

  switch (command) {
    case "tasks":
      console.log(renderTaskCatalog())
      return
    case "preflight": {
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(usage())
        return
      }
      const flags = parseFlags(rest)
      const resultsRoot = flags.values["results-root"] ?? defaultResultsRoot
      const result = await runBenchmarkPreflight(resultsRoot)

      console.log(renderPreflightMarkdown(result))
      return
    }
    case "run": {
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(usage())
        return
      }
      const flags = parseFlags(rest)
      const resultsRoot = flags.values["results-root"]
      const tasks = flags.values.tasks
      const arms = flags.values.arms
      const repetitions = getNumberFlag(flags, "repetitions")
      const contextPackMode = getContextPackMode(flags)
      const daggerPlanMode = getDaggerPlanMode(flags)
      const daggerPlanHarness = getDaggerPlanHarness(flags)
      const daggerPlanModel = flags.values["dagger-plan-model"]
      const daggerPlanFile = flags.values["dagger-plan-file"]
      const seed = getNumberFlag(flags, "seed")
      const limit = getNumberFlag(flags, "limit")
      const result = await runBenchmarkCampaign({
        ...(resultsRoot === undefined ? {} : { resultsRoot }),
        ...(tasks === undefined ? {} : { tasks }),
        ...(arms === undefined ? {} : { arms }),
        ...(repetitions === undefined ? {} : { repetitions }),
        ...(contextPackMode === undefined ? {} : { contextPackMode }),
        ...(daggerPlanMode === undefined ? {} : { daggerPlanMode }),
        ...(daggerPlanHarness === undefined ? {} : { daggerPlanHarness }),
        ...(daggerPlanModel === undefined ? {} : { daggerPlanModel }),
        ...(daggerPlanFile === undefined ? {} : { daggerPlanFile }),
        ...(seed === undefined ? {} : { seed }),
        ...(limit === undefined ? {} : { limit }),
        skipPreflight: flags.booleans.has("skip-preflight"),
        keepWorktrees: flags.booleans.has("keep-worktrees"),
      })

      console.log(`Campaign root: ${result.campaignRoot}`)
      console.log(`Best Dagger arm: ${result.summary.bestDaggerArm ?? "n/a"}`)
      return
    }
    case "report": {
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(usage())
        return
      }
      const flags = parseFlags(rest)
      const result = await rerenderLatestCampaignReport(
        flags.values["results-root"] ?? defaultResultsRoot
      )

      console.log(`Re-rendered ${result.campaignRoot}`)
      console.log(`Best Dagger arm: ${result.summary.bestDaggerArm ?? "n/a"}`)
      return
    }
    default:
      throw new Error(`Unknown command "${command}".\n\n${usage()}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
