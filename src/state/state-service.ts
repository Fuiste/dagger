import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { Deferred, Effect, Queue, Ref, Schema } from "effect"

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

const makeStateServiceError = (message: string) =>
  new StateServiceError({ message })

const writeRunState = (path: string, state: RunState) =>
  Effect.tryPromise({
    try: () => Bun.write(path, `${JSON.stringify(Schema.encodeSync(RunStateSchema)(state), null, 2)}\n`),
    catch: (error) =>
      makeStateServiceError(error instanceof Error ? error.message : `Unable to write ${path}`)
  })

export const makeStateService = (options: {
  readonly graph: TaskGraph
  readonly runId: string
  readonly stateRootDir?: string
}) =>
  Effect.gen(function*() {
    const stateRootDir = options.stateRootDir ?? ".dagger/runs"
    const path = join(stateRootDir, `${options.runId}.json`)
    const initialState = makeInitialRunState({
      runId: options.runId,
      graph: options.graph
    })
    const stateRef = yield* Ref.make(initialState)
    const queue = yield* Queue.unbounded<WriterMessage>()

    yield* Effect.tryPromise({
      try: () => mkdir(stateRootDir, { recursive: true }),
      catch: (error) =>
        makeStateServiceError(
          error instanceof Error ? error.message : `Unable to create ${stateRootDir}`
        )
    })
    yield* writeRunState(path, initialState)

    const handleMessage = (message: WriterMessage) =>
      Effect.gen(function*() {
        switch (message._tag) {
          case "Event": {
            const current = yield* Ref.get(stateRef)
            const next = applyRunEvent(current, message.event)

            yield* Ref.set(stateRef, next)
            yield* writeRunState(path, next)
            return
          }
          case "Flush":
            yield* Deferred.succeed(message.deferred, void 0)
            return
        }
      })

    yield* Queue.take(queue).pipe(
      Effect.flatMap(handleMessage),
      Effect.forever,
      Effect.catch(() => Effect.void),
      Effect.forkScoped
    )

    return {
      path,
      append: (event) => Queue.offer(queue, { _tag: "Event", event }).pipe(Effect.asVoid),
      flush: Effect.gen(function*() {
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
