import { Schema } from "effect"

import { TaskGraph } from "../domain/task-graph"

export const TaskStatusSchema = Schema.Literals([
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped"
])
export type TaskStatus = typeof TaskStatusSchema.Type

export const RunStatusSchema = Schema.Literals([
  "running",
  "succeeded",
  "failed"
])
export type RunStatus = typeof RunStatusSchema.Type

export class TaskSnapshot extends Schema.Class<TaskSnapshot>("TaskSnapshot")({
  id: Schema.String,
  prompt: Schema.String,
  status: TaskStatusSchema,
  notes: Schema.Array(Schema.String),
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  skipReason: Schema.optional(Schema.String)
}) {}

export class TaskQueuedEvent extends Schema.TaggedClass<TaskQueuedEvent>()("TaskQueuedEvent", {
  taskId: Schema.String,
  timestamp: Schema.String
}) {}

export class TaskStartedEvent extends Schema.TaggedClass<TaskStartedEvent>()("TaskStartedEvent", {
  taskId: Schema.String,
  timestamp: Schema.String,
  note: Schema.optional(Schema.String)
}) {}

export class TaskSucceededEvent extends Schema.TaggedClass<TaskSucceededEvent>()("TaskSucceededEvent", {
  taskId: Schema.String,
  timestamp: Schema.String,
  note: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String)
}) {}

export class TaskFailedEvent extends Schema.TaggedClass<TaskFailedEvent>()("TaskFailedEvent", {
  taskId: Schema.String,
  timestamp: Schema.String,
  message: Schema.String,
  note: Schema.optional(Schema.String)
}) {}

export class TaskSkippedEvent extends Schema.TaggedClass<TaskSkippedEvent>()("TaskSkippedEvent", {
  taskId: Schema.String,
  timestamp: Schema.String,
  reason: Schema.String
}) {}

export const RunEventSchema = Schema.Union([
  TaskQueuedEvent,
  TaskStartedEvent,
  TaskSucceededEvent,
  TaskFailedEvent,
  TaskSkippedEvent
])
export type RunEvent = typeof RunEventSchema.Type

export class RunState extends Schema.Class<RunState>("RunState")({
  version: Schema.Int,
  runId: Schema.String,
  status: RunStatusSchema,
  graph: TaskGraph,
  tasks: Schema.Array(TaskSnapshot),
  events: Schema.Array(RunEventSchema)
}) {}

const appendNote = (task: TaskSnapshot, note: string | undefined) =>
  note === undefined ? task.notes : [...task.notes, note]

const makeTaskSnapshotInput = (input: {
  readonly id: string
  readonly prompt: string
  readonly status: TaskStatus
  readonly notes: ReadonlyArray<string>
  readonly startedAt: string | undefined
  readonly finishedAt: string | undefined
  readonly result: string | undefined
  readonly error: string | undefined
  readonly skipReason: string | undefined
}) => ({
  id: input.id,
  prompt: input.prompt,
  status: input.status,
  notes: input.notes,
  ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
  ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
  ...(input.result === undefined ? {} : { result: input.result }),
  ...(input.error === undefined ? {} : { error: input.error }),
  ...(input.skipReason === undefined ? {} : { skipReason: input.skipReason })
})

const mergeTask = (
  task: TaskSnapshot,
  patch: {
    readonly status?: TaskStatus
    readonly notes?: ReadonlyArray<string>
    readonly startedAt?: string
    readonly finishedAt?: string
    readonly result?: string
    readonly error?: string
    readonly skipReason?: string
  }
) =>
  new TaskSnapshot((() => {
    const startedAt = patch.startedAt ?? task.startedAt
    const finishedAt = patch.finishedAt ?? task.finishedAt
    const result = patch.result ?? task.result
    const error = patch.error ?? task.error
    const skipReason = patch.skipReason ?? task.skipReason

    return makeTaskSnapshotInput({
      id: task.id,
      prompt: task.prompt,
      status: patch.status ?? task.status,
      notes: patch.notes ?? task.notes,
      startedAt,
      finishedAt,
      result,
      error,
      skipReason
    })
  })())

const overallStatusFromTasks = (tasks: ReadonlyArray<TaskSnapshot>): RunStatus =>
  tasks.some((task) => task.status === "failed")
    ? "failed"
    : tasks.every((task) => ["succeeded", "skipped"].includes(task.status))
      ? "succeeded"
      : "running"

export const makeInitialRunState = (options: {
  readonly runId: string
  readonly graph: TaskGraph
}) =>
  new RunState({
    version: 1,
    runId: options.runId,
    status: "running",
    graph: options.graph,
    tasks: options.graph.tasks.map(
      (task) =>
        new TaskSnapshot(makeTaskSnapshotInput({
          id: task.id,
          prompt: task.prompt,
          status: "pending",
          notes: [],
          startedAt: undefined,
          finishedAt: undefined,
          result: undefined,
          error: undefined,
          skipReason: undefined
        }))
    ),
    events: []
  })

export const applyRunEvent = (state: RunState, event: RunEvent) => {
  const tasks = state.tasks.map((task): TaskSnapshot => {
    if (task.id !== event.taskId) {
      return task
    }

    switch (event._tag) {
      case "TaskQueuedEvent":
        return mergeTask(task, {
          status: "queued"
        })
      case "TaskStartedEvent":
        return mergeTask(task, {
          status: "running",
          startedAt: task.startedAt ?? event.timestamp,
          notes: appendNote(task, event.note)
        })
      case "TaskSucceededEvent":
        return mergeTask(
          task,
          {
            status: "succeeded",
            finishedAt: event.timestamp,
            notes: appendNote(task, event.note),
            ...(event.summary === undefined ? {} : { result: event.summary })
          }
        )
      case "TaskFailedEvent":
        return mergeTask(task, {
          status: "failed",
          finishedAt: event.timestamp,
          error: event.message,
          notes: appendNote(task, event.note)
        })
      case "TaskSkippedEvent":
        return mergeTask(task, {
          status: "skipped",
          finishedAt: event.timestamp,
          skipReason: event.reason
        })
    }
  })

  return new RunState({
    ...state,
    status: overallStatusFromTasks(tasks),
    tasks,
    events: [...state.events, event]
  })
}
