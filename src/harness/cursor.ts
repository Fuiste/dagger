import { Effect } from "effect"

import { type TaskDefinition } from "../domain/task-graph"
import { type RunState } from "../state/run-state"
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
import { TaskFinishNoteEvent, TaskStartNoteEvent, parseAssistantMessage } from "./protocol"

const defaultCursorCommand = "cursor-agent"
const defaultCursorArgs = ["-p", "--force", "--output-format", "text"] as const

const compactTaskResult = (result: {
  readonly note: string | undefined
  readonly summary: string | undefined
}) => ({
  ...(result.note === undefined ? {} : { note: result.note }),
  ...(result.summary === undefined ? {} : { summary: result.summary })
})

const findLastEvent = <A>(
  values: ReadonlyArray<A>,
  predicate: (value: A) => boolean
) => [...values].reverse().find(predicate)

const renderTaskBody = (task: TaskDefinition) =>
  compactStrings([
    `Task ID: ${task.id}`,
    `Task Prompt: ${task.prompt}`,
    task.instructions === undefined ? undefined : `Additional Instructions:\n${task.instructions}`
  ]).join("\n\n")

const renderStateInstructions = (statePath: string) =>
  [
    `Use the ephemeral state document at \`${statePath}\` for context only.`,
    "Do not edit the state file directly.",
    `When you are ready to start, print exactly one line beginning with \`${"DAGGER_EVENT "}\` followed by JSON for {"_tag":"TaskStartNoteEvent","note":"..."}.`,
    `When you are completely finished, print exactly one line beginning with \`${"DAGGER_EVENT "}\` followed by JSON for {"_tag":"TaskFinishNoteEvent","note":"...","summary":"..."}.`
  ].join("\n")

const makeTaskPrompt = (input: TaskHarnessInput) =>
  compactStrings([
    "You are executing one task in a Dagger run.",
    renderTaskBody(input.task),
    renderStateInstructions(input.statePath),
    input.taskRunConfig.model === undefined
      ? undefined
      : `Preferred model: ${input.taskRunConfig.model}`,
    // cursor-agent doesn't expose a dedicated thinking flag, so this remains advisory prompt context.
    input.taskRunConfig.thinking === undefined
      ? undefined
      : `Preferred thinking level: ${input.taskRunConfig.thinking}`
  ]).join("\n\n")

const summarizeTasks = (runState: RunState) =>
  runState.tasks
    .map((task) => `- ${task.id}: ${task.status}`)
    .join("\n")

const makeSummaryPrompt = (input: SummaryHarnessInput) =>
  compactStrings([
    "Summarize this completed Dagger run for the CLI user.",
    `State file: ${input.statePath}`,
    "Keep the summary concise and outcome-focused.",
    "Task statuses:",
    summarizeTasks(input.runState)
  ]).join("\n\n")

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
        stdin: makeTaskPrompt(input)
      }).pipe(
        Effect.flatMap((result) => ensureSuccessfulExit(result, "Cursor harness command")),
        Effect.map(({ stdout }) => {
          const parsed = parseAssistantMessage(stdout)
          const startNote = parsed.events.find((event) => event instanceof TaskStartNoteEvent)
          const finishNote = findLastEvent(
            parsed.events,
            (event): event is TaskFinishNoteEvent => event instanceof TaskFinishNoteEvent
          )
          const summaryText = parsed.plainText.join("\n").trim()

          return compactTaskResult({
            note:
              finishNote instanceof TaskFinishNoteEvent
                ? finishNote.note
                : startNote instanceof TaskStartNoteEvent
                  ? startNote.note
                  : undefined,
            summary:
              finishNote instanceof TaskFinishNoteEvent
                ? finishNote.summary ?? summaryText
                : summaryText.length > 0
                  ? summaryText
                  : undefined
          })
        })
      ),
    summarizeRun: (input) =>
      runHarnessCommand({
        command,
        args: makeArgs(input.runConfig),
        cwd: input.runConfig.cwd,
        stdin: makeSummaryPrompt(input)
      }).pipe(
        Effect.flatMap((result) => ensureSuccessfulExit(result, "Cursor harness command")),
        Effect.map(({ stdout }) => {
          const parsed = parseAssistantMessage(stdout)
          const finishNote = findLastEvent(
            parsed.events,
            (event): event is TaskFinishNoteEvent => event instanceof TaskFinishNoteEvent
          )
          const summaryText = parsed.plainText.join("\n").trim()

          return finishNote instanceof TaskFinishNoteEvent
            ? finishNote.summary ?? finishNote.note ?? summaryText
            : summaryText
        })
      )
  }
}
