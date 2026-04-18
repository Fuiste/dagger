import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import {
  appendEvent,
  copyToCache,
  hasCacheEntry,
  initializeRunStore,
  loadProjectionFromEvents,
  makeRunPaths,
  readPlanIndex,
  restoreFromCache,
  statFile,
  writeCacheManifest,
  writePlanIndex,
  writeTranscriptFiles
} from "./event-log"
import { applyRunEvent, makeInitialProjection, type RunEvent, type RunProjection, type TaskStatus } from "./events"
import {
  computeExecutionLevels,
  type ArtifactRef,
  type AssertTask,
  type DaggerPlan,
  type PlanTask,
  type ReduceTask,
  type ResolvedPlan
} from "./plan"
import { renderModelPrompt } from "./prompt"
import { runModelProvider } from "./provider"
import { resolveModelRoute } from "./routing"

const nowIso = () => new Date().toISOString()

export type RunResult = {
  readonly runId: string
  readonly status: RunProjection["status"]
  readonly projection: RunProjection
  readonly criticalPathMs: number
  readonly runRoot: string
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: Array<T> = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T) {
    const waiter = this.waiters.shift()

    if (waiter !== undefined) {
      waiter({ done: false, value })
      return
    }

    this.values.push(value)
  }

  close() {
    this.closed = true

    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined as never })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift()

        if (value !== undefined) {
          return Promise.resolve({ done: false, value })
        }

        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined as never })
        }

        return new Promise<IteratorResult<T>>((resolveNext) => {
          this.waiters.push(resolveNext)
        })
      }
    }
  }
}

export type RunHandle = {
  readonly runId: string
  readonly events: AsyncIterable<RunEvent>
  readonly result: Promise<RunResult>
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`
  }

  return JSON.stringify(value)
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

const fileDigest = async (path: string) => sha256(new Uint8Array(await Bun.file(path).arrayBuffer()))

const runShell = async (cwd: string, command: string) => {
  const subprocess = Bun.spawn(["zsh", "-lc", command], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text()
  ])

  return {
    exitCode,
    stdout,
    stderr
  }
}

const resolveTaskOutputs = (cwd: string, task: PlanTask) =>
  ("outputs" in task ? task.outputs ?? [] : []).map((output) => ({
    ...output,
    absolutePath: resolve(cwd, output.path)
  }))

const dependencyMap = (plan: DaggerPlan) =>
  new Map(plan.tasks.map((task) => [task.id, task.dependsOn ?? []] as const))

const isSuccessfulStatus = (status: TaskStatus | undefined) => status === "succeeded" || status === "cached"

const normalizeResumeStatus = (status: TaskStatus): TaskStatus =>
  status === "queued" || status === "running" ? "pending" : status

const taskStatesFromProjection = (projection: RunProjection) =>
  new Map<string, TaskStatus>(
    projection.tasks.map((task) => [task.id, normalizeResumeStatus(task.status)] as const)
  )

const artifactByRef = (projection: RunProjection, ref: ArtifactRef) =>
  projection.tasks
    .find((task) => task.id === ref.taskId)
    ?.artifacts.find((artifact) => artifact.id === ref.artifactId)

const computeCriticalPath = (plan: DaggerPlan, projection: RunProjection) => {
  const deps = dependencyMap(plan)
  const durations = new Map(projection.tasks.map((task) => [task.id, task.durationMs ?? 0] as const))
  const memo = new Map<string, number>()

  const visit = (taskId: string): number => {
    const cached = memo.get(taskId)

    if (cached !== undefined) {
      return cached
    }

    const value =
      (durations.get(taskId) ?? 0) +
      Math.max(0, ...(deps.get(taskId) ?? []).map((dependency) => visit(dependency)))

    memo.set(taskId, value)
    return value
  }

  return Math.max(0, ...plan.tasks.map((task) => visit(task.id)))
}

const parseUsageEvents = (text: string, taskId: string): Array<RunEvent> =>
  text
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^DAGGER_USAGE\s+(.+)$/.exec(line.trim())

      if (match === null || match[1] === undefined) {
        return []
      }

      try {
        const parsed = JSON.parse(match[1]) as {
          readonly provider?: string
          readonly model?: string
          readonly input_tokens?: number
          readonly cached_input_tokens?: number
          readonly output_tokens?: number
        }

        return [
          {
            _tag: "UsageReportedEvent",
            taskId,
            timestamp: nowIso(),
            provider: parsed.provider ?? "unknown",
            model: parsed.model ?? "unknown",
            ...(parsed.input_tokens === undefined ? {} : { inputTokens: parsed.input_tokens }),
            ...(parsed.cached_input_tokens === undefined
              ? {}
              : { cachedInputTokens: parsed.cached_input_tokens }),
            ...(parsed.output_tokens === undefined ? {} : { outputTokens: parsed.output_tokens })
          } satisfies RunEvent
        ]
      } catch {
        return []
      }
    })

const computeTaskCacheKey = async (options: {
  readonly task: PlanTask
  readonly projection: RunProjection
  readonly cwd: string
  readonly profile: ResolvedPlan["profile"]
}) => {
  const files = await Promise.all(
    (options.task.inputs?.files ?? []).map(async (file) => ({
      path: file,
      digest: await fileDigest(resolve(options.cwd, file))
    }))
  )
  const artifacts = (options.task.inputs?.artifacts ?? []).map((ref) => ({
    ref: `${ref.taskId}.${ref.artifactId}`,
    digest: artifactByRef(options.projection, ref)?.digest ?? "missing"
  }))

  return sha256(
    stableJson({
      profile: options.profile,
      task: options.task,
      files,
      artifacts
    })
  )
}

const publishOutputs = async (options: {
  readonly cwd: string
  readonly task: PlanTask
  readonly append: (event: RunEvent) => Promise<void>
}) => {
  const outputs = resolveTaskOutputs(options.cwd, options.task)

  for (const output of outputs) {
    const exists = await Bun.file(output.absolutePath).exists()

    if (!exists) {
      throw new Error(`Expected output "${output.id}" at ${output.path}`)
    }

    if (output.format === "json") {
      JSON.parse(await readFile(output.absolutePath, "utf8"))
    }

    const stats = await statFile(output.absolutePath)

    await options.append({
      _tag: "ArtifactPublishedEvent",
      taskId: options.task.id,
      artifactId: output.id,
      timestamp: nowIso(),
      path: relative(options.cwd, output.absolutePath),
      format: output.format,
      digest: await fileDigest(output.absolutePath),
      sizeBytes: stats.size
    })
  }

  return outputs.map((output) => ({ relativePath: output.path }))
}

const deepMerge = (left: unknown, right: unknown): unknown => {
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const result: Record<string, unknown> = { ...(left as Record<string, unknown>) }

    for (const [key, value] of Object.entries(right as Record<string, unknown>)) {
      result[key] = key in result ? deepMerge(result[key], value) : value
    }

    return result
  }

  return right
}

const runReduceTask = async (options: {
  readonly cwd: string
  readonly task: ReduceTask
  readonly projection: RunProjection
}) => {
  const inputs = await Promise.all(
    (options.task.inputs.artifacts ?? []).map(async (ref) => {
      const artifact = artifactByRef(options.projection, ref)

      if (artifact === undefined) {
        throw new Error(`Missing artifact "${ref.taskId}.${ref.artifactId}"`)
      }

      return readFile(resolve(options.cwd, artifact.path), "utf8")
    })
  )
  const [output] = resolveTaskOutputs(options.cwd, options.task)

  if (output === undefined) {
    throw new Error(`Reduce task "${options.task.id}" must declare one output`)
  }

  await mkdir(dirname(output.absolutePath), { recursive: true })

  switch (options.task.operation) {
    case "text-concat":
      await writeFile(output.absolutePath, `${inputs.map((input) => input.trim()).join("\n\n")}\n`)
      return
    case "json-array":
      await writeFile(output.absolutePath, `${JSON.stringify(inputs.map((input) => JSON.parse(input)), null, 2)}\n`)
      return
    case "json-merge":
      await writeFile(
        output.absolutePath,
        `${JSON.stringify(inputs.reduce<unknown>((acc, input) => deepMerge(acc, JSON.parse(input)), {}), null, 2)}\n`
      )
  }
}

const collectChangedFiles = async (cwd: string) => {
  const tracked = await runShell(cwd, "git diff --name-only")
  const untracked = await runShell(cwd, "git ls-files --others --exclude-standard")

  if (tracked.exitCode !== 0 || untracked.exitCode !== 0) {
    throw new Error("Unable to collect changed files with git")
  }

  return [...tracked.stdout.split(/\r?\n/), ...untracked.stdout.split(/\r?\n/)].filter(
    (path) => path.trim().length > 0
  )
}

const runAssertTask = async (options: {
  readonly cwd: string
  readonly task: AssertTask
  readonly projection: RunProjection
}) => {
  for (const ref of options.task.requiredArtifacts ?? []) {
    const artifact = artifactByRef(options.projection, ref)

    if (artifact === undefined) {
      throw new Error(`Missing required artifact "${ref.taskId}.${ref.artifactId}"`)
    }

    const exists = await Bun.file(resolve(options.cwd, artifact.path)).exists()

    if (!exists) {
      throw new Error(`Required artifact file missing at ${artifact.path}`)
    }
  }

  for (const command of options.task.commands ?? []) {
    const result = await runShell(options.cwd, command)

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Assertion command failed: ${command}`)
    }
  }

  if ((options.task.allowedChangedFiles ?? []).length > 0) {
    const changedFiles = await collectChangedFiles(options.cwd)
    const allowed = new Set(options.task.allowedChangedFiles ?? [])
    const unexpected = changedFiles.filter((file) => !allowed.has(file))

    if (unexpected.length > 0) {
      throw new Error(`Unexpected changed files: ${unexpected.join(", ")}`)
    }
  }
}

const skipPendingTasks = async (options: {
  readonly taskStates: Map<string, TaskStatus>
  readonly append: (event: RunEvent) => Promise<void>
  readonly reason: string
}) => {
  for (const [taskId, status] of options.taskStates) {
    if (status === "pending" || status === "queued") {
      options.taskStates.set(taskId, "skipped")
      await options.append({
        _tag: "TaskSkippedEvent",
        taskId,
        timestamp: nowIso(),
        reason: options.reason
      })
    }
  }
}

export const renderDryRunPreview = (resolvedPlan: ResolvedPlan) => {
  const levels = computeExecutionLevels(resolvedPlan.plan)
  const lines = [
    `Dry run for ${resolvedPlan.planPath}`,
    `Profile: ${resolvedPlan.profile}`,
    `Working directory: ${resolvedPlan.cwd}`,
    `Tasks: ${resolvedPlan.plan.tasks.length}`
  ]

  for (const [index, level] of levels.entries()) {
    lines.push(`Level ${index + 1}: ${level.join(", ")}`)
  }

  for (const task of resolvedPlan.plan.tasks) {
    if (task.kind === "model") {
      const route = resolveModelRoute({
        profile: resolvedPlan.profile,
        role: task.role,
        ...(task.provider === undefined ? {} : { providerOverride: task.provider }),
        ...(task.model === undefined ? {} : { modelOverride: task.model })
      })
      lines.push(`Model task ${task.id}: ${task.role} -> ${route.provider}/${route.model}`)
    }
  }

  return lines.join("\n")
}

const runPlanInternal = async (options: {
  readonly resolvedPlan: ResolvedPlan
  readonly maxConcurrency: number
  readonly resume: boolean
  readonly emit: (event: RunEvent) => void
}): Promise<RunResult> => {
  const planSource = await readFile(options.resolvedPlan.planPath, "utf8")
  const planDigest = sha256(
    stableJson({
      planPath: options.resolvedPlan.planPath,
      profile: options.resolvedPlan.profile,
      source: planSource
    })
  )
  const indexPaths = makeRunPaths(options.resolvedPlan.cwd, options.resolvedPlan.artifactsDir, "index")
  const existing = options.resume ? await readPlanIndex({ paths: indexPaths, planDigest }) : undefined
  const runId = existing?.runId ?? randomUUID()
  const paths = makeRunPaths(options.resolvedPlan.cwd, options.resolvedPlan.artifactsDir, runId)
  await initializeRunStore(paths)
  await writePlanIndex({ paths, planDigest, runId })

  let projection = await loadProjectionFromEvents({
    paths,
    runId,
    cwd: options.resolvedPlan.cwd,
    profile: options.resolvedPlan.profile,
    planPath: options.resolvedPlan.planPath,
    plan: options.resolvedPlan.plan
  })

  if (projection.tasks.length === 0) {
    projection = makeInitialProjection({
      runId,
      cwd: options.resolvedPlan.cwd,
      profile: options.resolvedPlan.profile,
      planPath: options.resolvedPlan.planPath,
      tasks: options.resolvedPlan.plan.tasks.map((task) => ({
        id: task.id,
        kind: task.kind,
        ...(task.kind === "model" ? { role: task.role } : {})
      }))
    })
  }

  const append = async (event: RunEvent) => {
    projection = await appendEvent(paths, projection, event)
    options.emit(event)
  }

  const hasExistingEvents = await Bun.file(paths.eventsPath).exists()

  if (!hasExistingEvents) {
    await append({
      _tag: "RunStartedEvent",
      runId,
      timestamp: nowIso(),
      cwd: options.resolvedPlan.cwd,
      profile: options.resolvedPlan.profile,
      planPath: options.resolvedPlan.planPath
    })
  } else if (options.resume && projection.status === "running") {
    await append({
      _tag: "RunResumedEvent",
      runId,
      timestamp: nowIso()
    })
  } else if (options.resume && projection.status !== "running") {
    return {
      runId,
      status: projection.status,
      projection,
      criticalPathMs: computeCriticalPath(options.resolvedPlan.plan, projection),
      runRoot: paths.runRoot
    }
  }

  const dependencies = dependencyMap(options.resolvedPlan.plan)
  const taskStates = taskStatesFromProjection(projection)
  const running = new Set<Promise<void>>()
  let failureReason: string | undefined

  const launchTask = (task: PlanTask) => {
    const runner = (async () => {
      const cacheKey = await computeTaskCacheKey({
        task,
        projection,
        cwd: options.resolvedPlan.cwd,
        profile: options.resolvedPlan.profile
      })
      const cacheRoot = join(paths.cacheDir, task.id, cacheKey)
      taskStates.set(task.id, "queued")
      await append({
        _tag: "TaskQueuedEvent",
        taskId: task.id,
        timestamp: nowIso(),
        cacheKey
      })

      if (await hasCacheEntry(cacheRoot)) {
        const outputs = resolveTaskOutputs(options.resolvedPlan.cwd, task)

        if (outputs.length > 0) {
          await restoreFromCache({
            cacheRoot,
            outputs: outputs.map((output) => ({ relativePath: output.path })),
            cwd: options.resolvedPlan.cwd
          })
          await publishOutputs({
            cwd: options.resolvedPlan.cwd,
            task,
            append
          })
        }

        taskStates.set(task.id, "cached")
        await append({
          _tag: "TaskCachedEvent",
          taskId: task.id,
          timestamp: nowIso(),
          cacheKey
        })
        await append({
          _tag: "TaskSucceededEvent",
          taskId: task.id,
          timestamp: nowIso(),
          durationMs: 0
        })
        return
      }

      const startedAt = Date.now()
      taskStates.set(task.id, "running")

      try {
        if (task.kind === "model") {
          const route = resolveModelRoute({
            profile: options.resolvedPlan.profile,
            role: task.role,
            ...(task.provider === undefined ? {} : { providerOverride: task.provider }),
            ...(task.model === undefined ? {} : { modelOverride: task.model })
          })
          await append({
            _tag: "TaskStartedEvent",
            taskId: task.id,
            timestamp: nowIso(),
            kind: task.kind,
            role: task.role,
            provider: route.provider,
            model: route.model
          })

          const result = await runModelProvider({
            provider: route.provider,
            model: route.model,
            cwd: options.resolvedPlan.cwd,
            prompt: renderModelPrompt({
              task,
              cwd: options.resolvedPlan.cwd,
              inputFiles: task.inputs?.files ?? [],
              artifactInputs: (task.inputs?.artifacts ?? []).flatMap((ref) => {
                const artifact = artifactByRef(projection, ref)
                return artifact === undefined
                  ? []
                  : [
                      {
                        ref: `${ref.taskId}.${ref.artifactId}`,
                        path: resolve(options.resolvedPlan.cwd, artifact.path),
                        format: artifact.format
                      }
                    ]
              }),
              outputFiles: resolveTaskOutputs(options.resolvedPlan.cwd, task).map((output) => ({
                id: output.id,
                path: output.path,
                format: output.format
              }))
            })
          })
          await writeTranscriptFiles({
            paths,
            taskId: task.id,
            stdout: result.stdout,
            stderr: result.stderr,
            assistantMessage: result.assistantMessage
          })
          for (const event of parseUsageEvents(`${result.stdout}\n${result.stderr}`, task.id)) {
            await append(event)
          }
        } else if (task.kind === "command") {
          await append({
            _tag: "TaskStartedEvent",
            taskId: task.id,
            timestamp: nowIso(),
            kind: task.kind
          })
          const result = await runShell(options.resolvedPlan.cwd, task.command)
          await writeTranscriptFiles({
            paths,
            taskId: task.id,
            stdout: result.stdout,
            stderr: result.stderr
          })

          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim() || `Command task failed: ${task.command}`)
          }
        } else if (task.kind === "reduce") {
          await append({
            _tag: "TaskStartedEvent",
            taskId: task.id,
            timestamp: nowIso(),
            kind: task.kind
          })
          await runReduceTask({
            cwd: options.resolvedPlan.cwd,
            task,
            projection
          })
        } else {
          await append({
            _tag: "TaskStartedEvent",
            taskId: task.id,
            timestamp: nowIso(),
            kind: task.kind
          })
          await runAssertTask({
            cwd: options.resolvedPlan.cwd,
            task,
            projection
          })
        }

        const outputCopies = await publishOutputs({
          cwd: options.resolvedPlan.cwd,
          task,
          append
        })

        if (outputCopies.length > 0) {
          await copyToCache({
            cacheRoot,
            outputs: outputCopies,
            cwd: options.resolvedPlan.cwd
          })
        }

        await writeCacheManifest({
          cacheRoot,
          cacheKey,
          taskId: task.id
        })
        taskStates.set(task.id, "succeeded")
        await append({
          _tag: "TaskSucceededEvent",
          taskId: task.id,
          timestamp: nowIso(),
          durationMs: Date.now() - startedAt
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failureReason = failureReason ?? message
        taskStates.set(task.id, "failed")
        await append({
          _tag: "TaskFailedEvent",
          taskId: task.id,
          timestamp: nowIso(),
          durationMs: Date.now() - startedAt,
          message
        })
      }
    })().finally(() => {
      running.delete(runner)
    })

    running.add(runner)
  }

  while (true) {
    if (failureReason !== undefined && running.size === 0) {
      await skipPendingTasks({
        taskStates,
        append,
        reason: failureReason
      })
      break
    }

    const readyTasks = options.resolvedPlan.plan.tasks.filter((task) => {
      if (taskStates.get(task.id) !== "pending") {
        return false
      }

      return (dependencies.get(task.id) ?? []).every((dependency) =>
        isSuccessfulStatus(taskStates.get(dependency))
      )
    })

    let launched = false

    for (const task of readyTasks) {
      if (failureReason !== undefined || running.size >= options.maxConcurrency) {
        break
      }

      launchTask(task)
      launched = true
    }

    const remainingPending = [...taskStates.values()].filter((status) => status === "pending").length

    if (running.size === 0) {
      if (!launched && remainingPending === 0) {
        break
      }

      if (!launched && failureReason === undefined) {
        failureReason = "No executable tasks remained"
        continue
      }
    }

    if (running.size > 0) {
      await Promise.race(running)
    }
  }

  const finalStatus = failureReason === undefined ? "succeeded" : "failed"
  await append({
    _tag: "RunFinishedEvent",
    runId,
    timestamp: nowIso(),
    status: finalStatus,
    durationMs: Date.now() - new Date(projection.startedAt).getTime()
  })

  return {
    runId,
    status: finalStatus,
    projection,
    criticalPathMs: computeCriticalPath(options.resolvedPlan.plan, projection),
    runRoot: paths.runRoot
  }
}

export const executePlan = (options: {
  readonly resolvedPlan: ResolvedPlan
  readonly maxConcurrency?: number
  readonly resume?: boolean
}): RunHandle => {
  const queue = new AsyncEventQueue<RunEvent>()
  const runId = randomUUID()
  const result = runPlanInternal({
    resolvedPlan: options.resolvedPlan,
    maxConcurrency: Math.max(1, options.maxConcurrency ?? options.resolvedPlan.plan.tasks.length),
    resume: options.resume ?? false,
    emit: (event) => {
      queue.push(event)
    }
  }).finally(() => {
    queue.close()
  })

  return {
    runId,
    events: queue,
    result
  }
}
