import { type TaskDefinition } from "../domain/task-graph"
import { type RunState } from "../state/run-state"
import { type SummaryHarnessInput, type TaskHarnessInput } from "./harness"
import { compactStrings } from "./process"

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

const summarizeTasks = (runState: RunState) =>
  runState.tasks
    .map((task) => `- ${task.id}: ${task.status}`)
    .join("\n")

export const renderTaskPrompt = (input: TaskHarnessInput) =>
  compactStrings([
    "You are executing one task in a Dagger run.",
    renderTaskBody(input.task),
    renderStateInstructions(input.statePath),
    input.taskRunConfig.model === undefined
      ? undefined
      : `Preferred model: ${input.taskRunConfig.model}`,
    // Harnesses may expose different provider-specific controls, so this stays advisory for now.
    input.taskRunConfig.thinking === undefined
      ? undefined
      : `Preferred thinking level: ${input.taskRunConfig.thinking}`
  ]).join("\n\n")

export const renderSummaryPrompt = (input: SummaryHarnessInput) =>
  compactStrings([
    "Summarize this completed Dagger run for the CLI user.",
    `State file: ${input.statePath}`,
    "Keep the summary concise and outcome-focused.",
    "Task statuses:",
    summarizeTasks(input.runState)
  ]).join("\n\n")
