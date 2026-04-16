import { Effect, Schema } from "effect"

import { HarnessNameSchema, ThinkingLevelSchema } from "./config"

export class TaskDefinition extends Schema.Class<TaskDefinition>("TaskDefinition")({
  id: Schema.String,
  prompt: Schema.String,
  instructions: Schema.optional(Schema.String),
  harness: Schema.optional(HarnessNameSchema),
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(ThinkingLevelSchema)
}) {}

export class TaskDependency extends Schema.Class<TaskDependency>("TaskDependency")({
  from: Schema.String,
  to: Schema.String
}) {}

export class TaskGraph extends Schema.Class<TaskGraph>("TaskGraph")({
  tasks: Schema.Array(TaskDefinition),
  dependencies: Schema.Array(TaskDependency)
}) {}

export class TaskGraphError extends Schema.TaggedErrorClass<TaskGraphError>()("TaskGraphError", {
  message: Schema.String
}) {}

export const decodeTaskGraph = (input: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(TaskGraph)(input),
    catch: (error) =>
      new TaskGraphError({
        message: error instanceof Error ? error.message : "Invalid task graph"
      })
  })

export const failTaskGraph = (message: string) =>
  Effect.fail(new TaskGraphError({ message }))

export const makeTaskMap = (graph: TaskGraph) =>
  new Map(graph.tasks.map((task) => [task.id, task] as const))

export const makeChildrenMap = (graph: TaskGraph) =>
  graph.dependencies.reduce((children, dependency) => {
    const existing = children.get(dependency.from) ?? []

    return children.set(dependency.from, [...existing, dependency.to])
  }, new Map<string, ReadonlyArray<string>>())

export const makeDependencyCountMap = (graph: TaskGraph) =>
  graph.dependencies.reduce(
    (counts, dependency) => counts.set(dependency.to, (counts.get(dependency.to) ?? 0) + 1),
    graph.tasks.reduce((counts, task) => counts.set(task.id, 0), new Map<string, number>())
  )

export const computeExecutionLevels = (graph: TaskGraph) =>
  Effect.gen(function*() {
    const children = makeChildrenMap(graph)
    const counts = new Map(makeDependencyCountMap(graph))
    const remaining = new Set(graph.tasks.map((task) => task.id))
    const levels: Array<ReadonlyArray<string>> = []
    let ready = [...remaining].filter((taskId) => (counts.get(taskId) ?? 0) === 0).sort()

    let completedCount = 0

    while (ready.length > 0) {
      levels.push(ready)
      completedCount += ready.length
      ready.forEach((taskId) => remaining.delete(taskId))

      ready.forEach((taskId) => {
        const childIds = children.get(taskId) ?? []

        childIds.forEach((childId) => {
          counts.set(childId, (counts.get(childId) ?? 1) - 1)
        })
      })

      ready = [...remaining].filter((taskId) => (counts.get(taskId) ?? 0) === 0).sort()
    }

    if (completedCount !== graph.tasks.length) {
      return yield* new TaskGraphError({
        message: "Task graph contains a dependency cycle"
      })
    }

    return levels
  })
