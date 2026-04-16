import { Cause, Deferred, Effect, Exit, Queue, Ref } from "effect"

import {
  type TaskDefinition,
  type TaskGraph,
  makeChildrenMap,
  makeDependencyCountMap,
  makeTaskMap
} from "../domain/task-graph"
import { type StateService } from "../state/state-service"
import {
  TaskFailedEvent,
  TaskQueuedEvent,
  TaskSkippedEvent,
  TaskStartedEvent,
  TaskSucceededEvent,
  type RunState,
  type TaskStatus
} from "../state/run-state"

export type TaskExecutionResult = {
  readonly note?: string
  readonly summary?: string
}

type LocalTaskStatus = Extract<TaskStatus, "pending" | "queued" | "running" | "succeeded" | "failed" | "skipped">

const nowIso = () => new Date().toISOString()

const toFailureMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const makeInitialStatusMap = (graph: TaskGraph) =>
  new Map<string, LocalTaskStatus>(
    graph.tasks.map((task) => [task.id, "pending" satisfies LocalTaskStatus] as const)
  )

export const runScheduler = <R>(options: {
  readonly graph: TaskGraph
  readonly stateService: StateService
  readonly executeTask: (task: TaskDefinition) => Effect.Effect<TaskExecutionResult, unknown, R>
  readonly maxConcurrency?: number
}) =>
  Effect.gen(function*() {
    const tasks = makeTaskMap(options.graph)
    const children = makeChildrenMap(options.graph)
    const initialDependencyCounts = makeDependencyCountMap(options.graph)
    const dependencyCounts = yield* Ref.make(makeDependencyCountMap(options.graph))
    const statuses = yield* Ref.make(makeInitialStatusMap(options.graph))
    const outstandingCount = yield* Ref.make(options.graph.tasks.length)
    const runningCount = yield* Ref.make(0)
    const failureMessageRef = yield* Ref.make<string | undefined>(undefined)
    const completedRef = yield* Ref.make(false)
    const readyQueue = yield* Queue.unbounded<string>()
    const done = yield* Deferred.make<RunState>()
    const workerCount = Math.max(1, options.maxConcurrency ?? options.graph.tasks.length)

    const finishRun = () =>
      Effect.gen(function*() {
        const shouldFinish = yield* Ref.modify(completedRef, (completed) => [!completed, true] as const)

        if (!shouldFinish) {
          return
        }

        yield* Queue.shutdown(readyQueue)
        yield* options.stateService.flush
        const snapshot = yield* options.stateService.snapshot

        yield* Deferred.succeed(done, snapshot)
      })

    const markStatus = (taskId: string, status: LocalTaskStatus) =>
      Ref.update(statuses, (current) => new Map<string, LocalTaskStatus>(current).set(taskId, status))

    const completeTask = (taskId: string, status: Extract<LocalTaskStatus, "succeeded" | "failed" | "skipped">) =>
      Effect.gen(function*() {
        yield* markStatus(taskId, status)
        const remaining = yield* Ref.updateAndGet(outstandingCount, (count) => count - 1)

        if (remaining === 0) {
          yield* finishRun()
        }
      })

    const skipPendingTasks = (reason: string) =>
      Effect.gen(function*() {
        const currentStatuses = yield* Ref.get(statuses)
        const skippedTaskIds = [...currentStatuses.entries()]
          .filter(([, status]) => status === "pending" || status === "queued")
          .map(([taskId]) => taskId)

        yield* Effect.forEach(skippedTaskIds, (taskId) =>
          Effect.gen(function*() {
            yield* options.stateService.append(
              new TaskSkippedEvent({
                taskId,
                timestamp: nowIso(),
                reason
              })
            )
            yield* completeTask(taskId, "skipped")
          })
        )

        yield* finishRun()
      })

    const maybeFinishAfterFailure = () =>
      Effect.gen(function*() {
        const failureMessage = yield* Ref.get(failureMessageRef)
        const running = yield* Ref.get(runningCount)

        if (failureMessage !== undefined && running === 0) {
          yield* skipPendingTasks(failureMessage)
        }
      })

    const enqueueTask = (taskId: string) =>
      Effect.gen(function*() {
        const shouldQueue = yield* Ref.modify(statuses, (current) => {
          if (current.get(taskId) !== "pending") {
            return [false, current] as const
          }

          return [true, new Map<string, LocalTaskStatus>(current).set(taskId, "queued")] as const
        })

        if (!shouldQueue) {
          return
        }

        yield* options.stateService.append(
          new TaskQueuedEvent({
            taskId,
            timestamp: nowIso()
          })
        )
        yield* Queue.offer(readyQueue, taskId)
      })

    const processSuccess = (task: TaskDefinition, result: TaskExecutionResult) =>
      Effect.gen(function*() {
        yield* options.stateService.append(
          new TaskSucceededEvent({
            taskId: task.id,
            timestamp: nowIso(),
            note: result.note,
            summary: result.summary
          })
        )
        yield* completeTask(task.id, "succeeded")

        const failureMessage = yield* Ref.get(failureMessageRef)

        if (failureMessage !== undefined) {
          return
        }

        const readyChildren = yield* Ref.modify(dependencyCounts, (current) => {
          const next = new Map(current)
          const newlyReady = (children.get(task.id) ?? []).flatMap((childId) => {
            const nextCount = (next.get(childId) ?? 1) - 1

            next.set(childId, nextCount)
            return nextCount === 0 ? [childId] : []
          })

          return [newlyReady, next] as const
        })

        yield* Effect.forEach(readyChildren, enqueueTask)
      })

    const processFailure = (taskId: string, error: unknown) =>
      Effect.gen(function*() {
        const message = toFailureMessage(error)

        yield* Ref.set(failureMessageRef, message)
        yield* options.stateService.append(
          new TaskFailedEvent({
            taskId,
            timestamp: nowIso(),
            message
          })
        )
        yield* completeTask(taskId, "failed")
      })

    const runTask = (taskId: string) =>
      Effect.gen(function*() {
        const failureMessage = yield* Ref.get(failureMessageRef)

        if (failureMessage !== undefined) {
          yield* options.stateService.append(
            new TaskSkippedEvent({
              taskId,
              timestamp: nowIso(),
              reason: failureMessage
            })
          )
          yield* completeTask(taskId, "skipped")
          return
        }

        const task = tasks.get(taskId)

        if (task === undefined) {
          yield* processFailure(taskId, new Error(`Unknown task "${taskId}"`))
          yield* maybeFinishAfterFailure()
          return
        }

        yield* markStatus(taskId, "running")
        yield* Ref.update(runningCount, (count) => count + 1)
        yield* options.stateService.append(
          new TaskStartedEvent({
            taskId,
            timestamp: nowIso()
          })
        )

        const exit = yield* Effect.exit(options.executeTask(task))

        yield* Ref.update(runningCount, (count) => count - 1)

        if (Exit.isSuccess(exit)) {
          yield* processSuccess(task, exit.value)
        } else {
          yield* processFailure(taskId, Cause.squash(exit.cause))
        }

        yield* maybeFinishAfterFailure()
      })

    yield* Effect.forEach(
      options.graph.tasks
        .map((task) => task.id)
        .filter((taskId) => (initialDependencyCounts.get(taskId) ?? 0) === 0),
      enqueueTask
    )

    yield* Effect.forEach(
      Array.from({ length: workerCount }, () => readyQueue),
      () =>
        Queue.take(readyQueue).pipe(
          Effect.flatMap(runTask),
          Effect.forever,
          Effect.catch(() => Effect.void),
          Effect.forkScoped
        ),
      {
        concurrency: "unbounded"
      }
    )

    const maybeNothingToDo = yield* Ref.get(outstandingCount)

    if (maybeNothingToDo === 0) {
      yield* finishRun()
    }

    return yield* Deferred.await(done)
  })
