import { Effect } from "effect"

import {
  type HarnessShape,
  type SummaryHarnessInput,
  type TaskHarnessInput
} from "./harness"
import {
  compactStrings,
  ensureSuccessfulExit,
  runHarnessCommand,
  tokenizeArgs
} from "./process"
import { renderSummaryPrompt, renderTaskPrompt } from "./prompts"
import {
  summaryFromAssistantMessage,
  taskResultFromAssistantMessage
} from "./protocol"

const defaultCursorCommand = "cursor-agent"
const defaultCursorArgs = ["-p", "--force", "--output-format", "text"] as const

export const makeCursorHarness = (options?: {
  readonly command?: string
}): HarnessShape => {
  const command = options?.command ?? process.env.DAGGER_CURSOR_COMMAND ?? defaultCursorCommand
  const extraArgs = tokenizeArgs(process.env.DAGGER_CURSOR_EXTRA_ARGS)
  const makeArgs = (
    runConfig: TaskHarnessInput["taskRunConfig"] | SummaryHarnessInput["runConfig"]
  ) =>
    compactStrings([
      ...defaultCursorArgs,
      ...extraArgs,
      runConfig.model === undefined ? undefined : "--model",
      runConfig.model
    ])

  return {
    executeTask: (input) =>
      runHarnessCommand({
        command,
        args: makeArgs(input.taskRunConfig),
        cwd: input.taskRunConfig.cwd,
        stdin: renderTaskPrompt(input)
      }).pipe(
        Effect.flatMap((result) => ensureSuccessfulExit(result, "Cursor harness command")),
        Effect.map(({ stdout }) => taskResultFromAssistantMessage(stdout))
      ),
    summarizeRun: (input) =>
      runHarnessCommand({
        command,
        args: makeArgs(input.runConfig),
        cwd: input.runConfig.cwd,
        stdin: renderSummaryPrompt(input)
      }).pipe(
        Effect.flatMap((result) => ensureSuccessfulExit(result, "Cursor harness command")),
        Effect.map(({ stdout }) => summaryFromAssistantMessage(stdout))
      )
  }
}
