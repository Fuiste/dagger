import { type ArtifactFormat, type Provider, type RuntimeProfile, type TaskKind, type TaskRole } from "./plan"

export type RunStatus = "running" | "succeeded" | "failed"
export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "cached"
  | "succeeded"
  | "failed"
  | "skipped"

export type RunStartedEvent = {
  readonly _tag: "RunStartedEvent"
  readonly runId: string
  readonly timestamp: string
  readonly cwd: string
  readonly profile: RuntimeProfile
  readonly planPath: string
}

export type RunResumedEvent = {
  readonly _tag: "RunResumedEvent"
  readonly runId: string
  readonly timestamp: string
}

export type TaskQueuedEvent = {
  readonly _tag: "TaskQueuedEvent"
  readonly taskId: string
  readonly timestamp: string
  readonly cacheKey: string
}

export type TaskStartedEvent = {
  readonly _tag: "TaskStartedEvent"
  readonly taskId: string
  readonly timestamp: string
  readonly kind: TaskKind
  readonly role?: TaskRole
  readonly provider?: Provider
  readonly model?: string
}

export type TaskCachedEvent = {
  readonly _tag: "TaskCachedEvent"
  readonly taskId: string
  readonly timestamp: string
  readonly cacheKey: string
}

export type ArtifactPublishedEvent = {
  readonly _tag: "ArtifactPublishedEvent"
  readonly taskId: string
  readonly artifactId: string
  readonly timestamp: string
  readonly path: string
  readonly format: ArtifactFormat
  readonly digest: string
  readonly sizeBytes: number
}

export type UsageReportedEvent = {
  readonly _tag: "UsageReportedEvent"
  readonly taskId: string
  readonly timestamp: string
  readonly provider: string
  readonly model: string
  readonly inputTokens?: number
  readonly cachedInputTokens?: number
  readonly outputTokens?: number
}

export type TaskSucceededEvent = {
  readonly _tag: "TaskSucceededEvent"
  readonly taskId: string
  readonly timestamp: string
  readonly durationMs: number
}

export type TaskFailedEvent = {
  readonly _tag: "TaskFailedEvent"
  readonly taskId: string
  readonly timestamp: string
  readonly durationMs: number
  readonly message: string
}

export type TaskSkippedEvent = {
  readonly _tag: "TaskSkippedEvent"
  readonly taskId: string
  readonly timestamp: string
  readonly reason: string
}

export type RunFinishedEvent = {
  readonly _tag: "RunFinishedEvent"
  readonly runId: string
  readonly timestamp: string
  readonly status: RunStatus
  readonly durationMs: number
}

export type RunEvent =
  | RunStartedEvent
  | RunResumedEvent
  | TaskQueuedEvent
  | TaskStartedEvent
  | TaskCachedEvent
  | ArtifactPublishedEvent
  | UsageReportedEvent
  | TaskSucceededEvent
  | TaskFailedEvent
  | TaskSkippedEvent
  | RunFinishedEvent

export type TaskProjection = {
  readonly id: string
  readonly kind: TaskKind
  readonly role?: TaskRole
  readonly status: TaskStatus
  readonly provider?: Provider
  readonly model?: string
  readonly cacheKey?: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly durationMs?: number
  readonly error?: string
  readonly artifacts: ReadonlyArray<{
    readonly id: string
    readonly path: string
    readonly format: ArtifactFormat
    readonly digest: string
    readonly sizeBytes: number
  }>
}

export type RunProjection = {
  readonly runId: string
  readonly cwd: string
  readonly planPath: string
  readonly profile: RuntimeProfile
  readonly status: RunStatus
  readonly startedAt: string
  readonly finishedAt?: string
  readonly durationMs?: number
  readonly tasks: ReadonlyArray<TaskProjection>
  readonly usage: {
    readonly inputTokens: number
    readonly cachedInputTokens: number
    readonly outputTokens: number
  }
}

export const makeInitialProjection = (options: {
  readonly runId: string
  readonly cwd: string
  readonly profile: RuntimeProfile
  readonly planPath: string
  readonly tasks: ReadonlyArray<{
    readonly id: string
    readonly kind: TaskKind
    readonly role?: TaskRole
  }>
}): RunProjection => ({
  runId: options.runId,
  cwd: options.cwd,
  planPath: options.planPath,
  profile: options.profile,
  status: "running",
  startedAt: new Date().toISOString(),
  tasks: options.tasks.map((task) => ({
    id: task.id,
    kind: task.kind,
    ...(task.role === undefined ? {} : { role: task.role }),
    status: "pending",
    artifacts: []
  })),
  usage: {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0
  }
})

const updateTask = (
  projection: RunProjection,
  taskId: string,
  update: (task: TaskProjection) => TaskProjection
): RunProjection => ({
  ...projection,
  tasks: projection.tasks.map((task) => (task.id === taskId ? update(task) : task))
})

export const applyRunEvent = (projection: RunProjection, event: RunEvent): RunProjection => {
  switch (event._tag) {
    case "RunStartedEvent":
      return {
        ...projection,
        startedAt: event.timestamp
      }
    case "RunResumedEvent":
      return projection
    case "TaskQueuedEvent":
      return updateTask(projection, event.taskId, (task) => ({
        ...task,
        status: "queued",
        cacheKey: event.cacheKey
      }))
    case "TaskStartedEvent":
      return updateTask(projection, event.taskId, (task) => ({
        ...task,
        status: "running",
        startedAt: event.timestamp,
        ...(event.provider === undefined ? {} : { provider: event.provider }),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.role === undefined ? {} : { role: event.role })
      }))
    case "TaskCachedEvent":
      return updateTask(projection, event.taskId, (task) => ({
        ...task,
        status: "cached",
        finishedAt: event.timestamp,
        cacheKey: event.cacheKey
      }))
    case "ArtifactPublishedEvent":
      return updateTask(projection, event.taskId, (task) => ({
        ...task,
        artifacts: [
          ...task.artifacts.filter((artifact) => artifact.id !== event.artifactId),
          {
            id: event.artifactId,
            path: event.path,
            format: event.format,
            digest: event.digest,
            sizeBytes: event.sizeBytes
          }
        ]
      }))
    case "UsageReportedEvent":
      return {
        ...projection,
        usage: {
          inputTokens: projection.usage.inputTokens + (event.inputTokens ?? 0),
          cachedInputTokens: projection.usage.cachedInputTokens + (event.cachedInputTokens ?? 0),
          outputTokens: projection.usage.outputTokens + (event.outputTokens ?? 0)
        }
      }
    case "TaskSucceededEvent":
      return updateTask(projection, event.taskId, (task) => ({
        ...task,
        status: task.status === "cached" ? "cached" : "succeeded",
        finishedAt: event.timestamp,
        durationMs: event.durationMs
      }))
    case "TaskFailedEvent":
      return {
        ...updateTask(projection, event.taskId, (task) => ({
          ...task,
          status: "failed",
          finishedAt: event.timestamp,
          durationMs: event.durationMs,
          error: event.message
        })),
        status: "failed"
      }
    case "TaskSkippedEvent":
      return updateTask(projection, event.taskId, (task) => ({
        ...task,
        status: "skipped",
        finishedAt: event.timestamp,
        error: event.reason
      }))
    case "RunFinishedEvent":
      return {
        ...projection,
        status: event.status,
        finishedAt: event.timestamp,
        durationMs: event.durationMs
      }
  }
}
