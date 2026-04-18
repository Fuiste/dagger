import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"

import { Effect } from "effect"

import { computeExecutionLevels } from "../domain/task-graph"
import { parseMarkdownGraph } from "../parse/markdown-graph"
import {
  benchmarkArms,
  benchmarkRepoRoots,
  benchmarkTasks,
  buildRunQueue,
  getBenchmarkArm,
  getBenchmarkTask,
  getRepoRootForTask,
  type BenchmarkArm,
  type BenchmarkArmId,
  type BenchmarkCommand,
  type BenchmarkRunSpec,
  type BenchmarkTask,
  type ContextPackMode,
  type DaggerHarnessName,
  type DaggerPlanMode,
  validatePlanPolicy,
} from "./catalog"
import {
  renderBlindReviewPrompt,
  renderDirectPrompt,
  renderPlanAuthoringPrompt,
  renderPlanRepairPrompt,
} from "./prompts"
import { makeDaggerCliInvocation } from "./dagger-cli"

const benchmarkRepoRoot = resolve(import.meta.dir, "../..")
const defaultResultsRoot = join(benchmarkRepoRoot, "benchmark-results")
const runTimeoutMs = 20 * 60 * 1000
const acceptanceTimeoutMs = 5 * 60 * 1000

type ProcessResult = {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly timedOut: boolean
  readonly durationMs: number
}

type GitSourceSnapshot = {
  readonly branch: string
  readonly commit: string
  readonly dirty: boolean
}

type AcceptanceResult = {
  readonly name: string
  readonly command: string
  readonly exitCode: number
  readonly timedOut: boolean
  readonly durationMs: number
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly passed: boolean
}

type ArtifactCheck = {
  readonly passed: boolean
  readonly notes: ReadonlyArray<string>
}

type UsagePayload =
  | {
      readonly provider: "codex"
      readonly raw: unknown
    }
  | {
      readonly provider: "cursor"
      readonly raw: unknown
    }

export type BenchmarkRunResult = {
  readonly runId: string
  readonly taskId: BenchmarkTask["id"]
  readonly armId: BenchmarkArmId
  readonly repetition: number
  readonly contextPackMode: ContextPackMode
  readonly repoRoot: string
  readonly source: GitSourceSnapshot
  readonly artifactDir: string
  readonly promptPath: string
  readonly planPath?: string
  readonly planningDurationMs: number
  readonly executionDurationMs: number
  readonly totalDurationMs: number
  readonly runnerSuccess: boolean
  readonly acceptancePassed: boolean
  readonly artifactSuccess: boolean
  readonly salvageSuccess: boolean
  readonly changedFiles: ReadonlyArray<string>
  readonly changedFileCount: number
  readonly diffStatPath: string
  readonly diffPatchPath: string
  readonly acceptanceResults: ReadonlyArray<AcceptanceResult>
  readonly artifactCheck: ArtifactCheck
  readonly execution: ProcessResult
  readonly planning?: ProcessResult
  readonly usagePayloads: ReadonlyArray<UsagePayload>
  readonly daggerGraph?: {
    readonly width: number
    readonly depth: number
    readonly taskCount: number
  }
  readonly blindReviewPromptPath: string
}

type CampaignSummary = {
  readonly runCount: number
  readonly byArm: ReadonlyArray<{
    readonly armId: BenchmarkArmId
    readonly medianTotalDurationMs: number | null
    readonly acceptanceRate: number
    readonly runnerSuccessRate: number
    readonly salvageRate: number
    readonly artifactRate: number
  }>
  readonly bestDaggerArm: BenchmarkArmId | null
}

type PreflightCheck = {
  readonly name: string
  readonly passed: boolean
  readonly details: string
}

type PreflightResult = {
  readonly startedAt: string
  readonly checks: ReadonlyArray<PreflightCheck>
}

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message)
  }
}

const compact = <A>(values: ReadonlyArray<A | undefined>) =>
  values.filter((value): value is A => value !== undefined)

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const slugify = (value: string) =>
  value
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()

const timestampSlug = () => new Date().toISOString().replace(/[:.]/g, "-")

const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) {
    return null
  }

  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 1) {
    return sorted[middle]!
  }

  return (sorted[middle - 1]! + sorted[middle]!) / 2
}

const ratio = (passed: number, total: number) => (total === 0 ? 0 : passed / total)

const repoRelative = (path: string) => relative(benchmarkRepoRoot, path) || "."

const writeText = async (path: string, contents: string) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

const runBinary = async (options: {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly stdin?: string
  readonly timeoutMs?: number
}) => {
  const env = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(options.env ?? {}).filter(([, value]) => value !== undefined)
    ),
  }
  const started = performance.now()
  const subprocess = Bun.spawn([...options.argv], {
    cwd: options.cwd,
    env,
    stdin: options.stdin === undefined ? undefined : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    subprocess.kill()
  }, options.timeoutMs ?? runTimeoutMs)
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])

  clearTimeout(timer)

  return {
    argv: options.argv,
    cwd: options.cwd,
    stdout,
    stderr,
    exitCode,
    timedOut,
    durationMs: performance.now() - started,
  } satisfies ProcessResult
}

const runShell = async (options: {
  readonly command: string
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
}) =>
  runBinary({
    argv: [process.env.SHELL ?? "/bin/zsh", "-lc", options.command],
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })

const readSnippet = async (root: string, snippet: NonNullable<BenchmarkTask["contextPackSnippets"]>[number]) => {
  const absolute = join(root, snippet.path)
  const contents = await readFile(absolute, "utf8")
  const lines = contents.split("\n")
  const start = Math.max(1, snippet.startLine ?? 1)
  const end = Math.min(lines.length, snippet.endLine ?? lines.length)
  const slice = lines.slice(start - 1, end)
  const rendered = slice
    .map((line, index) => `${String(start + index).padStart(4, " ")} ${line}`)
    .join("\n")

  return [
    `### ${snippet.path}`,
    "",
    snippet.description,
    "",
    `Lines ${start}-${end}:`,
    "",
    "```",
    rendered,
    "```",
  ].join("\n")
}

type PreparedDaggerPlan = {
  readonly promptPath: string
  readonly plan: string
  readonly planning: ProcessResult
  readonly usagePayloads: ReadonlyArray<UsagePayload>
  readonly graph: Awaited<ReturnType<typeof validateDaggerPlan>>["graph"]
  readonly levels: ReadonlyArray<ReadonlyArray<string>>
}

const renderContextPack = async (task: BenchmarkTask, repoRoot: string) => {
  if (task.contextPackSnippets === undefined || task.contextPackSnippets.length === 0) {
    return undefined
  }

  const sections = await Promise.all(
    task.contextPackSnippets.map((snippet) => readSnippet(repoRoot, snippet))
  )

  return [
    `# Deterministic Context Pack: ${task.title}`,
    "",
    "## File Inventory",
    "",
    ...task.relevantFiles.map((path) => `- ${path}`),
    "",
    "## Acceptance Commands",
    "",
    ...(task.acceptanceCommands.length === 0
      ? ["- No shell acceptance commands; validate artifact scope exactly."]
      : task.acceptanceCommands.map(
          (command) => `- ${command.name}: \`${command.command}\``
        )),
    "",
    sections.join("\n\n"),
  ].join("\n")
}

const extractCodexUsage = (stdout: string): UsagePayload | undefined => {
  const parsed = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { readonly type?: string; readonly usage?: unknown }]
      } catch {
        return []
      }
    })
    .reverse()
    .find((event) => event.type === "turn.completed" && event.usage !== undefined)

  return parsed?.usage === undefined
    ? undefined
    : {
        provider: "codex",
        raw: parsed.usage,
      }
}

const extractCursorUsage = (stdout: string): UsagePayload | undefined => {
  const parsed = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { readonly usage?: unknown }]
      } catch {
        return []
      }
    })
    .reverse()
    .find((event) => event.usage !== undefined)

  return parsed?.usage === undefined
    ? undefined
    : {
        provider: "cursor",
        raw: parsed.usage,
      }
}

const writeProcessArtifacts = async (
  artifactDir: string,
  prefix: string,
  result: ProcessResult
) => {
  const stdoutPath = join(artifactDir, `${prefix}.stdout.txt`)
  const stderrPath = join(artifactDir, `${prefix}.stderr.txt`)
  const metaPath = join(artifactDir, `${prefix}.json`)

  await Promise.all([
    writeText(stdoutPath, result.stdout),
    writeText(stderrPath, result.stderr),
    writeText(metaPath, json(result)),
  ])
}

const resolvePromptAndContext = async (
  task: BenchmarkTask,
  repoRoot: string,
  contextPackMode: ContextPackMode
) => {
  const contextPack =
    contextPackMode === "deterministic"
      ? await renderContextPack(task, repoRoot)
      : undefined

  return { contextPack }
}

const readJsonFile = async <A>(path: string) => JSON.parse(await readFile(path, "utf8")) as A

const captureGitSnapshot = async (repoRoot: string): Promise<GitSourceSnapshot> => {
  const [branch, commit, status] = await Promise.all([
    runBinary({
      argv: ["git", "-C", repoRoot, "branch", "--show-current"],
      cwd: benchmarkRepoRoot,
      timeoutMs: 5_000,
    }),
    runBinary({
      argv: ["git", "-C", repoRoot, "rev-parse", "HEAD"],
      cwd: benchmarkRepoRoot,
      timeoutMs: 5_000,
    }),
    runBinary({
      argv: ["git", "-C", repoRoot, "status", "--porcelain"],
      cwd: benchmarkRepoRoot,
      timeoutMs: 5_000,
    }),
  ])

  return {
    branch: branch.stdout.trim(),
    commit: commit.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
  }
}

const createDisposableWorktree = async (repoRoot: string) => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), `dagger-benchmark-${slugify(relative("/", repoRoot))}-`))
  const addResult = await runBinary({
    argv: ["git", "-C", repoRoot, "worktree", "add", "--detach", worktreeRoot, "HEAD"],
    cwd: benchmarkRepoRoot,
    timeoutMs: 30_000,
  })

  if (addResult.exitCode !== 0) {
    throw new Error(`Unable to create disposable worktree for ${repoRoot}:\n${addResult.stderr}`)
  }

  return worktreeRoot
}

const cleanupDisposableWorktree = async (repoRoot: string, worktreeRoot: string) => {
  await runBinary({
    argv: ["git", "-C", repoRoot, "worktree", "remove", "--force", worktreeRoot],
    cwd: benchmarkRepoRoot,
    timeoutMs: 30_000,
  })
  await rm(worktreeRoot, { recursive: true, force: true })
}

const collectDiffArtifacts = async (worktreeRoot: string, artifactDir: string) => {
  const [changedFiles, untrackedFiles, diffStat, diffPatch] = await Promise.all([
    runBinary({
      argv: ["git", "-C", worktreeRoot, "diff", "--name-only", "--diff-filter=ACMR"],
      cwd: benchmarkRepoRoot,
      timeoutMs: 10_000,
    }),
    runBinary({
      argv: ["git", "-C", worktreeRoot, "ls-files", "--others", "--exclude-standard"],
      cwd: benchmarkRepoRoot,
      timeoutMs: 10_000,
    }),
    runBinary({
      argv: ["git", "-C", worktreeRoot, "diff", "--stat"],
      cwd: benchmarkRepoRoot,
      timeoutMs: 10_000,
    }),
    runBinary({
      argv: ["git", "-C", worktreeRoot, "diff", "--binary"],
      cwd: benchmarkRepoRoot,
      timeoutMs: 10_000,
    }),
  ])
  const changed = changedFiles.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const untracked = untrackedFiles.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const uniqueChanged = [...new Set([...changed, ...untracked])]
  const untrackedStats = await Promise.all(
    untracked.map(async (path) => {
      const result = await runBinary({
        argv: [
          "git",
          "-C",
          worktreeRoot,
          "diff",
          "--no-index",
          "--stat",
          "--",
          "/dev/null",
          join(worktreeRoot, path),
        ],
        cwd: benchmarkRepoRoot,
        timeoutMs: 10_000,
      })

      return result.stdout.trim()
    })
  )
  const untrackedPatches = await Promise.all(
    untracked.map(async (path) => {
      const result = await runBinary({
        argv: [
          "git",
          "-C",
          worktreeRoot,
          "diff",
          "--no-index",
          "--binary",
          "--",
          "/dev/null",
          join(worktreeRoot, path),
        ],
        cwd: benchmarkRepoRoot,
        timeoutMs: 10_000,
      })

      return result.stdout.trim()
    })
  )
  const diffStatPath = join(artifactDir, "diff.stat.txt")
  const diffPatchPath = join(artifactDir, "diff.patch")

  await Promise.all([
    writeText(
      diffStatPath,
      [diffStat.stdout.trimEnd(), ...untrackedStats.filter((stat) => stat.length > 0)]
        .filter((part) => part.length > 0)
        .join("\n")
    ),
    writeText(
      diffPatchPath,
      [diffPatch.stdout.trimEnd(), ...untrackedPatches.filter((patch) => patch.length > 0)]
        .filter((part) => part.length > 0)
        .join("\n\n")
    ),
  ])

  return {
    changedFiles: uniqueChanged,
    diffStatPath,
    diffPatchPath,
  }
}

const runAcceptance = async (
  task: BenchmarkTask,
  worktreeRoot: string,
  artifactDir: string
) => {
  const acceptanceDir = join(artifactDir, "acceptance")
  await mkdir(acceptanceDir, { recursive: true })
  const results: AcceptanceResult[] = []

  for (const command of task.acceptanceCommands) {
    const result = await runShell({
      command: command.command,
      cwd: worktreeRoot,
      timeoutMs: acceptanceTimeoutMs,
    })
    const base = slugify(command.name)
    const stdoutPath = join(acceptanceDir, `${base}.stdout.txt`)
    const stderrPath = join(acceptanceDir, `${base}.stderr.txt`)

    await Promise.all([
      writeText(stdoutPath, result.stdout),
      writeText(stderrPath, result.stderr),
    ])

    results.push({
      name: command.name,
      command: command.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutPath,
      stderrPath,
      passed: result.exitCode === 0 && !result.timedOut,
    })
  }

  return results
}

const checkArtifacts = async (
  task: BenchmarkTask,
  worktreeRoot: string,
  changedFiles: ReadonlyArray<string>
) => {
  const notes: string[] = []

  if (task.requiredArtifactPath !== undefined) {
    const absolute = join(worktreeRoot, task.requiredArtifactPath)
    const exists = await Bun.file(absolute).exists()

    if (!exists) {
      notes.push(`Missing required artifact ${task.requiredArtifactPath}.`)
    }
  }

  if (task.allowedChangedPaths !== undefined) {
    const unexpected = changedFiles.filter((path) => !task.allowedChangedPaths?.includes(path))

    if (unexpected.length > 0) {
      notes.push(`Unexpected changed paths: ${unexpected.join(", ")}`)
    }
  }

  if (task.requiredFileSubstrings !== undefined) {
    for (const fileCheck of task.requiredFileSubstrings) {
      const absolute = join(worktreeRoot, fileCheck.path)
      const exists = await Bun.file(absolute).exists()

      if (!exists) {
        notes.push(`Required file check failed because ${fileCheck.path} does not exist.`)
        continue
      }

      const contents = await readFile(absolute, "utf8")
      const missing = fileCheck.substrings.filter((substring) => !contents.includes(substring))

      if (missing.length > 0) {
        notes.push(`Missing required substrings in ${fileCheck.path}: ${missing.join(", ")}`)
      }
    }
  }

  return {
    passed: notes.length === 0,
    notes,
  } satisfies ArtifactCheck
}

const writeBlindReviewPacket = async (
  task: BenchmarkTask,
  artifactDir: string,
  changedFiles: ReadonlyArray<string>,
  acceptanceResults: ReadonlyArray<AcceptanceResult>
) => {
  const path = join(artifactDir, "blind-review.md")
  const summary = acceptanceResults.map((result) =>
    `${result.name}: ${result.passed ? "passed" : "failed"}`
  )

  await writeText(
    path,
    renderBlindReviewPrompt({
      task,
      changedFiles,
      acceptanceSummary: summary,
    })
  )

  return path
}

const runDirectCodex = async (options: {
  readonly cwd: string
  readonly model: string
  readonly prompt: string
  readonly artifactDir: string
  readonly label: string
}) => {
  const outputPath = join(options.artifactDir, `${options.label}.last-message.txt`)
  const result = await runBinary({
    argv: [
      "codex",
      "exec",
      "--full-auto",
      "--ephemeral",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--json",
      "--cd",
      options.cwd,
      "--model",
      options.model,
      "-o",
      outputPath,
    ],
    cwd: options.cwd,
    stdin: options.prompt,
  })
  const finalMessage = (await Bun.file(outputPath).exists())
    ? await readFile(outputPath, "utf8")
    : ""

  await writeProcessArtifacts(options.artifactDir, options.label, result)

  return {
    result,
    finalMessage,
    usage: extractCodexUsage(result.stdout),
    outputPath,
  }
}

const runDirectCursor = async (options: {
  readonly cwd: string
  readonly model: string
  readonly prompt: string
  readonly artifactDir: string
  readonly label: string
}) => {
  const result = await runBinary({
    argv: [
      "cursor-agent",
      "-p",
      "--output-format",
      "json",
      "--force",
      "--workspace",
      options.cwd,
      "--model",
      options.model,
      options.prompt,
    ],
    cwd: options.cwd,
  })

  await writeProcessArtifacts(options.artifactDir, options.label, result)

  const parsed = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { readonly result?: string }]
      } catch {
        return []
      }
    })
    .reverse()
    .find((entry) => entry.result !== undefined)

  return {
    result,
    finalMessage: parsed?.result ?? "",
    usage: extractCursorUsage(result.stdout),
  }
}

const runPlanAuthoringHarness = async (options: {
  readonly harness: DaggerHarnessName
  readonly cwd: string
  readonly model: string
  readonly prompt: string
  readonly artifactDir: string
  readonly label: string
}) =>
  options.harness === "codex"
    ? runDirectCodex({
        cwd: options.cwd,
        model: options.model,
        prompt: options.prompt,
        artifactDir: options.artifactDir,
        label: options.label,
      })
    : runDirectCursor({
        cwd: options.cwd,
        model: options.model,
        prompt: options.prompt,
        artifactDir: options.artifactDir,
        label: options.label,
      })

const validateDaggerPlan = async (
  planText: string,
  arm: Extract<BenchmarkArm, { family: "dagger" }>
) => {
  const graph = await Effect.runPromise(parseMarkdownGraph(planText))
  const policyErrors = validatePlanPolicy(arm, graph)

  if (policyErrors.length > 0) {
    return {
      graph,
      levels: [] as ReadonlyArray<ReadonlyArray<string>>,
      errors: policyErrors,
    }
  }

  const levels = await Effect.runPromise(computeExecutionLevels(graph))

  return {
    graph,
    levels,
    errors: [] as ReadonlyArray<string>,
  }
}

const runDaggerExecution = async (options: {
  readonly worktreeRoot: string
  readonly planPath: string
  readonly arm: Extract<BenchmarkArm, { family: "dagger" }>
  readonly artifactDir: string
}) => {
  const telemetryDir = join(options.artifactDir, "telemetry")
  await mkdir(telemetryDir, { recursive: true })

  const codexWrapper = resolve(benchmarkRepoRoot, "bin/benchmark-codex-wrapper.js")
  const cursorWrapper = resolve(benchmarkRepoRoot, "bin/benchmark-cursor-wrapper.js")
  const env = {
    DAGGER_CODEX_COMMAND: codexWrapper,
    DAGGER_CURSOR_COMMAND: cursorWrapper,
    DAGGER_BENCH_TELEMETRY_DIR: telemetryDir,
    DAGGER_CODEX_EXTRA_ARGS: "--json",
  }
  const invocation = makeDaggerCliInvocation({
    cwd: options.worktreeRoot,
    planPath: options.planPath,
    harness: options.arm.summaryHarness,
    model: options.arm.summaryModel,
  })
  const result = await runBinary({
    argv: invocation.argv,
    cwd: invocation.cwd,
    env,
  })

  await writeProcessArtifacts(options.artifactDir, "dagger-execution", result)

  const usagePayloads: UsagePayload[] = []
  const telemetryFiles = await Bun.file(telemetryDir).exists()
    ? [...new Bun.Glob("*.json").scanSync({ cwd: telemetryDir })]
    : []

  for (const file of telemetryFiles) {
    const record = await readJsonFile<{ readonly stdout: string }>(join(telemetryDir, file))
    const maybeCodexUsage = extractCodexUsage(record.stdout)
    const maybeCursorUsage = extractCursorUsage(record.stdout)

    if (maybeCodexUsage !== undefined) {
      usagePayloads.push(maybeCodexUsage)
    }

    if (maybeCursorUsage !== undefined) {
      usagePayloads.push(maybeCursorUsage)
    }
  }

  return {
    result,
    usagePayloads,
  }
}

const generatePlanForArm = async (options: {
  readonly task: BenchmarkTask
  readonly arm: Extract<BenchmarkArm, { family: "dagger" }>
  readonly worktreeRoot: string
  readonly artifactDir: string
  readonly contextPackMode: ContextPackMode
  readonly plannerHarness: DaggerHarnessName
  readonly plannerModel: string
}): Promise<PreparedDaggerPlan> => {
  const { contextPack } = await resolvePromptAndContext(
    options.task,
    options.worktreeRoot,
    options.contextPackMode
  )
  const prompt = renderPlanAuthoringPrompt({
    task: options.task,
    arm: options.arm,
    contextPackMode: options.contextPackMode,
    ...(contextPack === undefined ? {} : { contextPack }),
  })
  const promptPath = join(options.artifactDir, "dagger-plan.prompt.md")

  await writeText(promptPath, prompt)
  if (contextPack !== undefined) {
    await writeText(join(options.artifactDir, "context-pack.md"), contextPack)
  }

  const first = await runPlanAuthoringHarness({
    harness: options.plannerHarness,
    cwd: options.worktreeRoot,
    model: options.plannerModel,
    prompt,
    artifactDir: options.artifactDir,
    label: "dagger-plan-attempt-1",
  })
  const firstValidation = await validateDaggerPlan(first.finalMessage, options.arm).catch((error) => ({
    graph: undefined,
    levels: [],
    errors: [error instanceof Error ? error.message : String(error)],
  }))

  if (firstValidation.errors.length === 0 && firstValidation.graph !== undefined) {
    return {
      promptPath,
      plan: first.finalMessage,
      planning: first.result,
      usagePayloads: compact([first.usage]),
      graph: firstValidation.graph,
      levels: firstValidation.levels,
    }
  }

  const repairPrompt = renderPlanRepairPrompt({
    previousPlan: first.finalMessage,
    validationErrors: firstValidation.errors,
  })

  await writeText(join(options.artifactDir, "dagger-plan-repair.prompt.md"), repairPrompt)

  const second = await runPlanAuthoringHarness({
    harness: options.plannerHarness,
    cwd: options.worktreeRoot,
    model: options.plannerModel,
    prompt: repairPrompt,
    artifactDir: options.artifactDir,
    label: "dagger-plan-attempt-2",
  })
  const secondValidation = await validateDaggerPlan(second.finalMessage, options.arm)

  if (secondValidation.errors.length > 0) {
    throw new Error(
      `Dagger plan generation failed validation twice:\n${secondValidation.errors.join("\n")}`
    )
  }

  return {
    promptPath,
    plan: second.finalMessage,
    planning: {
      ...second.result,
      durationMs: first.result.durationMs + second.result.durationMs,
    } satisfies ProcessResult,
    usagePayloads: compact([first.usage, second.usage]),
    graph: secondValidation.graph,
    levels: secondValidation.levels,
  }
}

const loadSuppliedPlanForArm = async (options: {
  readonly arm: Extract<BenchmarkArm, { family: "dagger" }>
  readonly artifactDir: string
  readonly planFile: string
}): Promise<PreparedDaggerPlan> => {
  const resolvedPlanPath = isAbsolute(options.planFile)
    ? options.planFile
    : resolve(benchmarkRepoRoot, options.planFile)
  const plan = await readFile(resolvedPlanPath, "utf8")
  const validation = await validateDaggerPlan(plan, options.arm)

  if (validation.errors.length > 0 || validation.graph === undefined) {
    throw new Error(
      `Supplied dagger plan failed validation:\n${validation.errors.join("\n")}`
    )
  }

  const copiedPlanPath = join(options.artifactDir, "dagger-plan.supplied.md")
  await writeText(copiedPlanPath, plan)

  return {
    promptPath: copiedPlanPath,
    plan,
    planning: {
      argv: [],
      cwd: dirname(resolvedPlanPath),
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 0,
    },
    usagePayloads: [],
    graph: validation.graph,
    levels: validation.levels,
  }
}

const runDirectArm = async (options: {
  readonly task: BenchmarkTask
  readonly arm: Extract<BenchmarkArm, { family: "direct" }>
  readonly worktreeRoot: string
  readonly artifactDir: string
  readonly contextPackMode: ContextPackMode
}) => {
  const { contextPack } = await resolvePromptAndContext(
    options.task,
    options.worktreeRoot,
    options.contextPackMode
  )
  const prompt = renderDirectPrompt({
    task: options.task,
    contextPackMode: options.contextPackMode,
    ...(contextPack === undefined ? {} : { contextPack }),
  })
  const promptPath = join(options.artifactDir, "direct.prompt.md")

  await writeText(promptPath, prompt)
  if (contextPack !== undefined) {
    await writeText(join(options.artifactDir, "context-pack.md"), contextPack)
  }

  if (options.arm.harness === "codex") {
    const execution = await runDirectCodex({
      cwd: options.worktreeRoot,
      model: options.arm.model,
      prompt,
      artifactDir: options.artifactDir,
      label: "direct-execution",
    })

    return {
      promptPath,
      execution: execution.result,
      usagePayloads: compact([execution.usage]),
      planningDurationMs: 0,
      planPath: undefined,
      daggerGraph: undefined,
    }
  }

  const execution = await runDirectCursor({
    cwd: options.worktreeRoot,
    model: options.arm.model,
    prompt,
    artifactDir: options.artifactDir,
    label: "direct-execution",
  })

  return {
    promptPath,
    execution: execution.result,
    usagePayloads: compact([execution.usage]),
    planningDurationMs: 0,
    planPath: undefined,
    daggerGraph: undefined,
  }
}

const runDaggerArm = async (options: {
  readonly task: BenchmarkTask
  readonly arm: Extract<BenchmarkArm, { family: "dagger" }>
  readonly worktreeRoot: string
  readonly artifactDir: string
  readonly contextPackMode: ContextPackMode
  readonly plannerHarness: DaggerHarnessName
  readonly plannerModel: string
  readonly preparedPlan?: PreparedDaggerPlan
}) => {
  const generated =
    options.preparedPlan ??
    (await generatePlanForArm({
      task: options.task,
      arm: options.arm,
      worktreeRoot: options.worktreeRoot,
      artifactDir: options.artifactDir,
      contextPackMode: options.contextPackMode,
      plannerHarness: options.plannerHarness,
      plannerModel: options.plannerModel,
    }))
  const planPath = join(options.artifactDir, "plan.generated.md")

  await writeText(planPath, generated.plan)

  const dryRunInvocation = makeDaggerCliInvocation({
    cwd: options.worktreeRoot,
    planPath,
    harness: options.arm.summaryHarness,
    model: options.arm.summaryModel,
    dryRun: true,
  })
  const dryRun = await runBinary({
    argv: dryRunInvocation.argv,
    cwd: dryRunInvocation.cwd,
  })

  await writeProcessArtifacts(options.artifactDir, "dagger-dry-run", dryRun)
  assert(dryRun.exitCode === 0, `Generated plan failed dagger dry-run validation:\n${dryRun.stderr}`)

  const execution = await runDaggerExecution({
    worktreeRoot: options.worktreeRoot,
    planPath,
    arm: options.arm,
    artifactDir: options.artifactDir,
  })

  return {
    promptPath: generated.promptPath,
    execution: execution.result,
    usagePayloads:
      options.preparedPlan === undefined
        ? [...generated.usagePayloads, ...execution.usagePayloads]
        : execution.usagePayloads,
    planningDurationMs: options.preparedPlan === undefined ? generated.planning.durationMs : 0,
    ...(options.preparedPlan === undefined ? { planning: generated.planning } : {}),
    planPath,
    daggerGraph: {
      width: Math.max(...generated.levels.map((level) => level.length)),
      depth: generated.levels.length,
      taskCount: generated.graph.tasks.length,
    },
  }
}

const artifactSuccessForTask = (
  task: BenchmarkTask,
  changedFiles: ReadonlyArray<string>,
  artifactCheck: ArtifactCheck
) =>
  artifactCheck.passed &&
  (task.requiredArtifactPath !== undefined ? true : changedFiles.length > 0)

const acceptancePassed = (task: BenchmarkTask, results: ReadonlyArray<AcceptanceResult>) =>
  task.acceptanceCommands.length === 0 || results.every((result) => result.passed)

const stringifyCommand = (argv: ReadonlyArray<string>) =>
  argv.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ")

const renderCampaignSummaryMarkdown = (summary: CampaignSummary) =>
  [
    "# Benchmark Campaign Summary",
    "",
    `- Total runs: ${summary.runCount}`,
    `- Best Dagger arm: ${summary.bestDaggerArm ?? "n/a"}`,
    "",
    "## By Arm",
    "",
    "| Arm | Median Total ms | Acceptance | Runner Success | Artifact | Salvage |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...summary.byArm.map(
      (arm) =>
        `| ${arm.armId} | ${arm.medianTotalDurationMs ?? "n/a"} | ${arm.acceptanceRate.toFixed(2)} | ${arm.runnerSuccessRate.toFixed(2)} | ${arm.artifactRate.toFixed(2)} | ${arm.salvageRate.toFixed(2)} |`
    ),
  ].join("\n")

export const summarizeCampaignResults = (results: ReadonlyArray<BenchmarkRunResult>): CampaignSummary => {
  const byArm = benchmarkArms.map((arm) => {
    const matching = results.filter((result) => result.armId === arm.id)

    return {
      armId: arm.id,
      medianTotalDurationMs: median(matching.map((result) => result.totalDurationMs)),
      acceptanceRate: ratio(
        matching.filter((result) => result.acceptancePassed).length,
        matching.length
      ),
      runnerSuccessRate: ratio(
        matching.filter((result) => result.runnerSuccess).length,
        matching.length
      ),
      artifactRate: ratio(
        matching.filter((result) => result.artifactSuccess).length,
        matching.length
      ),
      salvageRate: ratio(
        matching.filter((result) => result.salvageSuccess).length,
        matching.length
      ),
    }
  })
  const daggerOnly = byArm.filter((arm) => arm.armId.startsWith("dagger-"))
  const bestDaggerArm =
    [...daggerOnly].sort((left, right) => {
      if (right.acceptanceRate !== left.acceptanceRate) {
        return right.acceptanceRate - left.acceptanceRate
      }
      const leftDuration = left.medianTotalDurationMs ?? Number.POSITIVE_INFINITY
      const rightDuration = right.medianTotalDurationMs ?? Number.POSITIVE_INFINITY

      return leftDuration - rightDuration
    })[0]?.armId ?? null

  return {
    runCount: results.length,
    byArm,
    bestDaggerArm,
  }
}

export const runBenchmarkPreflight = async (resultsRoot = defaultResultsRoot) => {
  const checks: PreflightCheck[] = []
  const startedAt = new Date().toISOString()
  const preflightDir = join(resultsRoot, "preflight")

  await mkdir(preflightDir, { recursive: true })

  const install = await runBinary({
    argv: ["bun", "install"],
    cwd: benchmarkRepoRoot,
    timeoutMs: 60_000,
  })
  await writeProcessArtifacts(preflightDir, "bun-install", install)
  checks.push({
    name: "bun install",
    passed: install.exitCode === 0 && !install.timedOut,
    details: install.exitCode === 0 ? "Dependencies installed." : install.stderr.trim(),
  })

  const daggerHelp = await runBinary({
    argv: ["bun", "run", "src/index.ts", "do", "--help"],
    cwd: benchmarkRepoRoot,
    timeoutMs: 30_000,
  })
  await writeProcessArtifacts(preflightDir, "dagger-help", daggerHelp)
  checks.push({
    name: "local dagger CLI",
    passed: daggerHelp.exitCode === 0 && daggerHelp.stdout.includes("dagger do"),
    details: daggerHelp.exitCode === 0 ? "CLI help rendered." : daggerHelp.stderr.trim(),
  })

  const codexSmoke = await runDirectCodex({
    cwd: "/tmp",
    model: "gpt-5.4",
    prompt: "Reply with exactly OK and no other text.",
    artifactDir: preflightDir,
    label: "codex-gpt-5-4-smoke",
  })
  checks.push({
    name: "codex:gpt-5.4",
    passed: codexSmoke.result.exitCode === 0 && codexSmoke.finalMessage.trim() === "OK",
    details: codexSmoke.finalMessage.trim() || codexSmoke.result.stderr.trim(),
  })

  const cursorHigh = await runDirectCursor({
    cwd: "/tmp",
    model: "claude-opus-4-7-high",
    prompt: "Reply with exactly OK and no other text.",
    artifactDir: preflightDir,
    label: "cursor-claude-opus-4-7-high-smoke",
  })
  checks.push({
    name: "cursor:claude-opus-4-7-high",
    passed: cursorHigh.result.exitCode === 0 && cursorHigh.finalMessage.trim() === "OK",
    details: cursorHigh.finalMessage.trim() || cursorHigh.result.stderr.trim(),
  })

  const cursorThinking = await runDirectCursor({
    cwd: "/tmp",
    model: "claude-opus-4-7-thinking-high",
    prompt: "Reply with exactly OK and no other text.",
    artifactDir: preflightDir,
    label: "cursor-claude-opus-4-7-thinking-high-smoke",
  })
  checks.push({
    name: "cursor:claude-opus-4-7-thinking-high",
    passed:
      cursorThinking.result.exitCode === 0 && cursorThinking.finalMessage.trim() === "OK",
    details: cursorThinking.finalMessage.trim() || cursorThinking.result.stderr.trim(),
  })

  const cursorCheap = await runDirectCursor({
    cwd: "/tmp",
    model: "composer-2",
    prompt: "Reply with exactly OK and no other text.",
    artifactDir: preflightDir,
    label: "cursor-composer-2-smoke",
  })
  checks.push({
    name: "cursor:composer-2",
    passed: cursorCheap.result.exitCode === 0 && cursorCheap.finalMessage.trim() === "OK",
    details: cursorCheap.finalMessage.trim() || cursorCheap.result.stderr.trim(),
  })

  const result = { startedAt, checks } satisfies PreflightResult

  await writeText(join(preflightDir, `preflight-${timestampSlug()}.json`), json(result))

  return result
}

const renderPreflightMarkdown = (result: PreflightResult) =>
  [
    "# Benchmark Preflight",
    "",
    `Started: ${result.startedAt}`,
    "",
    "| Check | Passed | Details |",
    "| --- | --- | --- |",
    ...result.checks.map(
      (check) =>
        `| ${check.name} | ${check.passed ? "yes" : "no"} | ${check.details.replace(/\|/g, "\\|")} |`
    ),
  ].join("\n")

export const runBenchmarkCampaign = async (options?: {
  readonly resultsRoot?: string
  readonly tasks?: string
  readonly arms?: string
  readonly repetitions?: number
  readonly contextPackMode?: ContextPackMode
  readonly seed?: number
  readonly limit?: number
  readonly skipPreflight?: boolean
  readonly keepWorktrees?: boolean
  readonly daggerPlanMode?: DaggerPlanMode
  readonly daggerPlanHarness?: DaggerHarnessName
  readonly daggerPlanModel?: string
  readonly daggerPlanFile?: string
}) => {
  const resultsRoot = options?.resultsRoot ?? defaultResultsRoot
  await mkdir(resultsRoot, { recursive: true })

  const preflight = options?.skipPreflight
    ? undefined
    : await runBenchmarkPreflight(resultsRoot)
  if (preflight !== undefined) {
    await writeText(join(resultsRoot, "latest-preflight.md"), renderPreflightMarkdown(preflight))
    assert(
      preflight.checks.every((check) => check.passed),
      "Benchmark preflight failed. See benchmark-results/latest-preflight.md."
    )
  }

  const { seed, runs } = buildRunQueue({
    ...(options?.tasks === undefined ? {} : { tasks: options.tasks }),
    ...(options?.arms === undefined ? {} : { arms: options.arms }),
    ...(options?.repetitions === undefined ? {} : { repetitions: options.repetitions }),
    ...(options?.contextPackMode === undefined
      ? {}
      : { contextPackMode: options.contextPackMode }),
    ...(options?.seed === undefined ? {} : { seed: options.seed }),
  })
  const limitedRuns = options?.limit === undefined ? runs : runs.slice(0, options.limit)
  const daggerPlanMode = options?.daggerPlanMode ?? "precomputed"
  const daggerPlanHarness = options?.daggerPlanHarness ?? "codex"
  const campaignId = `${timestampSlug()}-seed-${seed}`
  const campaignRoot = join(resultsRoot, "campaigns", campaignId)
  const runsRoot = join(campaignRoot, "runs")

  await mkdir(runsRoot, { recursive: true })
  await writeText(
    join(campaignRoot, "campaign.json"),
    json({
      campaignId,
      seed,
      resultsRoot: repoRelative(resultsRoot),
      runs: limitedRuns,
    })
  )

  const results: BenchmarkRunResult[] = []

  for (const run of limitedRuns) {
    const task = getBenchmarkTask(run.taskId)
    const arm = getBenchmarkArm(run.armId)
    const repoRoot = getRepoRootForTask(task)
    const source = await captureGitSnapshot(repoRoot)
    const runId = `${slugify(task.id)}-${slugify(arm.id)}-r${run.repetition}`
    const artifactDir = join(runsRoot, runId)
    let worktreeRoot: string | undefined

    await mkdir(artifactDir, { recursive: true })

    try {
      worktreeRoot = await createDisposableWorktree(repoRoot)
      await writeText(join(artifactDir, "source.json"), json(source))
      await writeText(join(artifactDir, "worktree.txt"), `${worktreeRoot}\n`)
      const preparedPlan =
        arm.family === "dagger"
          ? options?.daggerPlanFile !== undefined
            ? await loadSuppliedPlanForArm({
                arm,
                artifactDir,
                planFile: options.daggerPlanFile,
              })
            : daggerPlanMode === "precomputed"
              ? await generatePlanForArm({
                  task,
                  arm,
                  worktreeRoot,
                  artifactDir,
                  contextPackMode: run.contextPackMode,
                  plannerHarness: daggerPlanHarness,
                  plannerModel: options?.daggerPlanModel ?? arm.planningModel,
                })
              : undefined
          : undefined
      if (arm.family === "dagger") {
        await writeText(
          join(artifactDir, "dagger-plan-source.json"),
          json({
            mode: options?.daggerPlanFile !== undefined ? "supplied" : daggerPlanMode,
            plannerHarness: options?.daggerPlanFile !== undefined ? undefined : daggerPlanHarness,
            plannerModel:
              options?.daggerPlanFile !== undefined
                ? undefined
                : options?.daggerPlanModel ?? arm.planningModel,
            suppliedPlanFile: options?.daggerPlanFile,
            countedInMetrics:
              options?.daggerPlanFile === undefined && daggerPlanMode === "inline",
          })
        )
      }
      const started = performance.now()

      const executed =
        arm.family === "direct"
          ? await runDirectArm({
              task,
              arm,
              worktreeRoot,
              artifactDir,
              contextPackMode: run.contextPackMode,
            })
          : await runDaggerArm({
              task,
              arm,
              worktreeRoot,
              artifactDir,
              contextPackMode: run.contextPackMode,
              plannerHarness: daggerPlanHarness,
              plannerModel: options?.daggerPlanModel ?? arm.planningModel,
              ...(preparedPlan === undefined ? {} : { preparedPlan }),
            })
      const { changedFiles, diffStatPath, diffPatchPath } = await collectDiffArtifacts(
        worktreeRoot,
        artifactDir
      )
      const acceptanceResults = await runAcceptance(task, worktreeRoot, artifactDir)
      const artifactCheck = await checkArtifacts(task, worktreeRoot, changedFiles)
      const blindReviewPromptPath = await writeBlindReviewPacket(
        task,
        artifactDir,
        changedFiles,
        acceptanceResults
      )
      const runnerSuccess = executed.execution.exitCode === 0 && !executed.execution.timedOut
      const accepted = acceptancePassed(task, acceptanceResults)
      const artifactSuccess = artifactSuccessForTask(task, changedFiles, artifactCheck)
      const totalDurationMs = performance.now() - started
      const result = {
        runId,
        taskId: task.id,
        armId: arm.id,
        repetition: run.repetition,
        contextPackMode: run.contextPackMode,
        repoRoot,
        source,
        artifactDir,
        promptPath: executed.promptPath,
        ...(executed.planPath === undefined ? {} : { planPath: executed.planPath }),
        planningDurationMs: executed.planningDurationMs,
        executionDurationMs: executed.execution.durationMs,
        totalDurationMs,
        runnerSuccess,
        acceptancePassed: accepted,
        artifactSuccess,
        salvageSuccess: !runnerSuccess && artifactSuccess,
        changedFiles,
        changedFileCount: changedFiles.length,
        diffStatPath,
        diffPatchPath,
        acceptanceResults,
        artifactCheck,
        execution: executed.execution,
        ...(arm.family === "dagger" && "planning" in executed && executed.planning !== undefined
          ? { planning: executed.planning }
          : {}),
        usagePayloads: executed.usagePayloads,
        ...(executed.daggerGraph === undefined ? {} : { daggerGraph: executed.daggerGraph }),
        blindReviewPromptPath,
      } satisfies BenchmarkRunResult

      await writeText(join(artifactDir, "result.json"), json(result))
      results.push(result)
    } finally {
      if (!options?.keepWorktrees && worktreeRoot !== undefined) {
        await cleanupDisposableWorktree(repoRoot, worktreeRoot)
      }
    }
  }

  const summary = summarizeCampaignResults(results)
  await writeText(join(campaignRoot, "summary.json"), json(summary))
  await writeText(join(campaignRoot, "summary.md"), renderCampaignSummaryMarkdown(summary))
  await writeText(join(resultsRoot, "latest-campaign.txt"), `${campaignRoot}\n`)

  return {
    campaignRoot,
    summary,
    results,
  }
}

export const renderTaskCatalog = () =>
  benchmarkTasks
    .map((task) =>
      [
        `## ${task.id}`,
        `Title: ${task.title}`,
        `Repo: ${benchmarkRepoRoots[task.repoId]}`,
        `Summary: ${task.summary}`,
        `Deliverable: ${task.deliverable}`,
        "Acceptance:",
        ...(task.acceptanceCommands.length === 0
          ? ["- No shell commands; artifact and change-scope checks only."]
          : task.acceptanceCommands.map(
              (command) => `- ${command.name}: \`${command.command}\``
            )),
      ].join("\n")
    )
    .join("\n\n")

export const rerenderLatestCampaignReport = async (resultsRoot = defaultResultsRoot) => {
  const latestPath = join(resultsRoot, "latest-campaign.txt")
  const exists = await Bun.file(latestPath).exists()

  assert(exists, `No latest campaign pointer found at ${latestPath}.`)

  const campaignRoot = (await readFile(latestPath, "utf8")).trim()
  const resultFiles = [...new Bun.Glob("runs/*/result.json").scanSync({ cwd: campaignRoot })]
  const results = await Promise.all(
    resultFiles.map((path) => readJsonFile<BenchmarkRunResult>(join(campaignRoot, path)))
  )
  const summary = summarizeCampaignResults(results)

  await writeText(join(campaignRoot, "summary.json"), json(summary))
  await writeText(join(campaignRoot, "summary.md"), renderCampaignSummaryMarkdown(summary))

  return { campaignRoot, summary }
}

export {
  defaultResultsRoot,
  extractCodexUsage,
  extractCursorUsage,
  renderPreflightMarkdown,
  stringifyCommand,
}
