import { Effect } from "effect"

import { type TaskDefinition } from "../domain/task-graph"
import { type RunState } from "../state/run-state"
import {
  type HarnessShape,
  HarnessError,
  type SummaryHarnessInput,
  type TaskHarnessInput
} from "./harness"
import { TaskFinishNoteEvent, TaskStartNoteEvent, parseHarnessOutput } from "./protocol"

const defaultCursorCommand = "cursor-agent"

const compact = (parts: ReadonlyArray<string | undefined>) =>
  parts.filter((part): part is string => part !== undefined && part.length > 0)

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
  compact([
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
  compact([
    "You are executing one task in a Dagger run.",
    renderTaskBody(input.task),
    renderStateInstructions(input.statePath),
    input.runConfig.model === undefined ? undefined : `Preferred model: ${input.runConfig.model}`,
    input.runConfig.thinking === undefined
      ? undefined
      : `Preferred thinking level: ${input.runConfig.thinking}`
  ]).join("\n\n")

const summarizeTasks = (runState: RunState) =>
  runState.tasks
    .map((task) => `- ${task.id}: ${task.status}`)
    .join("\n")

const makeSummaryPrompt = (input: SummaryHarnessInput) =>
  compact([
    "Summarize this completed Dagger run for the CLI user.",
    `State file: ${input.statePath}`,
    "Keep the summary concise and outcome-focused.",
    "Task statuses:",
    summarizeTasks(input.runState)
  ]).join("\n\n")

const runCommand = (command: string, cwd: string, prompt: string) =>
  Effect.tryPromise({
    try: async () => {
      const subprocess = Bun.spawn(["sh", "-lc", command], {
        cwd,
        stdin: new Blob([prompt]),
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
    },
    catch: (error) =>
      new HarnessError({
        message: error instanceof Error ? error.message : "Unable to start harness command"
      })
  })

const ensureSuccessfulExit = (result: {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}) =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(
        new HarnessError({
          message: compact([
            `Harness command failed with exit code ${result.exitCode}.`,
            result.stderr.trim()
          ]).join("\n")
        })
      )

export const makeCursorHarness = (options?: {
  readonly command?: string
}): HarnessShape => {
  const command = options?.command ?? process.env.DAGGER_CURSOR_COMMAND ?? defaultCursorCommand

  return {
    executeTask: (input) =>
      runCommand(command, input.cwd, makeTaskPrompt(input)).pipe(
        Effect.flatMap(ensureSuccessfulExit),
        Effect.map(({ stdout }) => {
          const parsed = parseHarnessOutput(stdout)
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
      runCommand(command, input.cwd, makeSummaryPrompt(input)).pipe(
        Effect.flatMap(ensureSuccessfulExit),
        Effect.map(({ stdout }) => {
          const parsed = parseHarnessOutput(stdout)
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
