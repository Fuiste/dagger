import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { Effect } from "effect"

import {
  HarnessError,
  type HarnessShape,
  type SummaryHarnessInput,
  type TaskHarnessInput
} from "./harness"
import {
  compactStrings,
  ensureSuccessfulExit,
  type HarnessCommandResult,
  runHarnessCommand,
  tokenizeArgs
} from "./process"
import { renderSummaryPrompt, renderTaskPrompt } from "./prompts"
import {
  summaryFromAssistantMessage,
  taskResultFromAssistantMessage
} from "./protocol"

const defaultCodexCommand = "codex"
const defaultCodexArgs = [
  "exec",
  "--full-auto",
  "--ephemeral",
  "--skip-git-repo-check",
  "--color",
  "never"
] as const

const makeTempOutputLocation = () =>
  Effect.tryPromise({
    try: async () => {
      const directory = await mkdtemp(join(tmpdir(), "dagger-codex-"))

      return {
        directory,
        outputPath: join(directory, "last-message.txt")
      } as const
    },
    catch: (error) =>
      new HarnessError({
        message: error instanceof Error ? error.message : "Unable to create Codex temp directory"
      })
  })

const cleanupTempOutputLocation = (directory: string) =>
  Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(
    Effect.catch(() => Effect.void)
  )

const readAssistantMessageFile = (
  outputPath: string,
  commandResult: HarnessCommandResult
) =>
  Effect.tryPromise({
    try: async () => await readFile(outputPath, "utf8"),
    catch: (error) =>
      new HarnessError({
        message: compactStrings([
          "Codex harness did not write a final assistant message.",
          error instanceof Error ? error.message : `Unable to read ${outputPath}`,
          commandResult.stderr.trim(),
          commandResult.stdout.trim()
        ]).join("\n")
      })
  }).pipe(
    Effect.flatMap((message) =>
      message.trim().length > 0
        ? Effect.succeed(message)
        : Effect.fail(
            new HarnessError({
              message: compactStrings([
                "Codex harness wrote an empty final assistant message.",
                commandResult.stderr.trim(),
                commandResult.stdout.trim()
              ]).join("\n")
            })
          )
    )
  )

const runCodexCommand = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  stdin: string
) =>
  runHarnessCommand({
    command,
    args,
    cwd,
    stdin
  }).pipe(Effect.flatMap((result) => ensureSuccessfulExit(result, "Codex harness command")))

export const makeCodexHarness = (options?: {
  readonly command?: string
}): HarnessShape => {
  const command = options?.command ?? process.env.DAGGER_CODEX_COMMAND ?? defaultCodexCommand
  const extraArgs = tokenizeArgs(process.env.DAGGER_CODEX_EXTRA_ARGS)
  const makeArgs = (
    runConfig: TaskHarnessInput["taskRunConfig"] | SummaryHarnessInput["runConfig"],
    outputPath: string
  ) =>
    compactStrings([
      ...defaultCodexArgs,
      ...extraArgs,
      "--cd",
      runConfig.cwd,
      "-o",
      outputPath,
      runConfig.model === undefined ? undefined : "--model",
      runConfig.model
    ])

  const runWithOutputFile = <A>(
    runConfig: TaskHarnessInput["taskRunConfig"] | SummaryHarnessInput["runConfig"],
    stdin: string,
    decode: (message: string) => A
  ) =>
    Effect.gen(function*() {
      const tempOutput = yield* makeTempOutputLocation()

      return yield* runCodexCommand(
        command,
        makeArgs(runConfig, tempOutput.outputPath),
        runConfig.cwd,
        stdin
      ).pipe(
        Effect.flatMap((commandResult) =>
          readAssistantMessageFile(tempOutput.outputPath, commandResult).pipe(
            Effect.map(decode)
          )
        ),
        Effect.ensuring(cleanupTempOutputLocation(tempOutput.directory))
      )
    })

  return {
    executeTask: (input) =>
      runWithOutputFile(
        input.taskRunConfig,
        renderTaskPrompt(input),
        taskResultFromAssistantMessage
      ),
    summarizeRun: (input) =>
      runWithOutputFile(input.runConfig, renderSummaryPrompt(input), summaryFromAssistantMessage)
  }
}
