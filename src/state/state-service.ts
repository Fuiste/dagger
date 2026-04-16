import { join } from "node:path"

import { Deferred, Effect, FileSystem, Queue, Ref, Schema } from "effect"

import { type TaskGraph } from "../domain/task-graph"
import {
  type RunEvent,
  type RunState,
  RunState as RunStateSchema,
  applyRunEvent,
  makeInitialRunState
} from "./run-state"

export class StateServiceError extends Schema.TaggedErrorClass<StateServiceError>()("StateServiceError", {
  message: Schema.String
}) {}

type WriterMessage =
  | {
      readonly _tag: "Event"
      readonly event: RunEvent
    }
  | {
      readonly _tag: "Flush"
      readonly deferred: Deferred.Deferred<void, StateServiceError>
    }

export type StateService = {
  readonly path: string
  readonly append: (event: RunEvent) => Effect.Effect<void, StateServiceError>
  readonly flush: Effect.Effect<void, StateServiceError>
  readonly snapshot: Effect.Effect<RunState>
}

export type WriteRunStateFn = (
  path: string,
  state: RunState
) => Effect.Effect<void, StateServiceError, FileSystem.FileSystem>

const makeStateServiceError = (message: string) =>
  new StateServiceError({ message })

const mapPlatformError = (fallback: string) =>
  (error: { readonly message: string }) =>
    makeStateServiceError(error.message.length > 0 ? error.message : fallback)

const defaultWriteRunState: WriteRunStateFn = (path, state) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem

    yield* fs.writeFileString(
      path,
      `${JSON.stringify(Schema.encodeSync(RunStateSchema)(state), null, 2)}\n`
    ).pipe(Effect.mapError(mapPlatformError(`Unable to write ${path}`)))
  })

export const makeStateService = (options: {
  readonly graph: TaskGraph
  readonly runId: string
  readonly stateRootDir?: string
  readonly writeRunState?: WriteRunStateFn
}) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const stateRootDir = options.stateRootDir ?? ".dagger/runs"
    const path = join(stateRootDir, `${options.runId}.json`)
    const writeRunState = options.writeRunState ?? defaultWriteRunState
    const initialState = makeInitialRunState({
      runId: options.runId,
      graph: options.graph
    })
    const stateRef = yield* Ref.make(initialState)
    const writerError = yield* Ref.make<StateServiceError | undefined>(undefined)
    const queue = yield* Queue.unbounded<WriterMessage>()

    yield* fs.makeDirectory(stateRootDir, { recursive: true }).pipe(
      Effect.mapError(mapPlatformError(`Unable to create ${stateRootDir}`))
    )
    yield* writeRunState(path, initialState)

    const recordFailure = (error: StateServiceError) =>
      Ref.update(writerError, (current) => current ?? error)

    const handleMessage = (message: WriterMessage) =>
      Effect.gen(function*() {
        const latched = yield* Ref.get(writerError)

        switch (message._tag) {
          case "Event": {
            if (latched !== undefined) {
              return
            }

            const current = yield* Ref.get(stateRef)
            const next = applyRunEvent(current, message.event)

            yield* Ref.set(stateRef, next)
            yield* writeRunState(path, next).pipe(
              Effect.catch((error) => recordFailure(error))
            )
            return
          }
          case "Flush":
            if (latched !== undefined) {
              yield* Deferred.fail(message.deferred, latched)
            } else {
              yield* Deferred.succeed(message.deferred, void 0)
            }
            return
        }
      })

    yield* Queue.take(queue).pipe(
      Effect.flatMap(handleMessage),
      Effect.forever,
      Effect.catch(() => Effect.void),
      Effect.forkScoped
    )

    const ensureHealthy = Effect.gen(function*() {
      const error = yield* Ref.get(writerError)

      if (error !== undefined) {
        return yield* Effect.fail(error)
      }
    })

    return {
      path,
      append: (event) =>
        ensureHealthy.pipe(
          Effect.andThen(Queue.offer(queue, { _tag: "Event", event })),
          Effect.asVoid
        ),
      flush: Effect.gen(function*() {
        yield* ensureHealthy
        const deferred = yield* Deferred.make<void, StateServiceError>()

        yield* Queue.offer(queue, {
          _tag: "Flush",
          deferred
        })

        yield* Deferred.await(deferred)
      }),
      snapshot: Ref.get(stateRef)
    } satisfies StateService
  })
