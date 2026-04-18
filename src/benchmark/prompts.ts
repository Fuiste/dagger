import type { BenchmarkArm, BenchmarkTask, ContextPackMode } from "./catalog"

const renderList = (values: ReadonlyArray<string>) => values.map((value) => `- ${value}`).join("\n")

const renderAcceptanceCommands = (task: BenchmarkTask) =>
  task.acceptanceCommands.length === 0
    ? "- No shell acceptance commands; validate the artifact path and change scope exactly."
    : task.acceptanceCommands
        .map((command) => `- ${command.name}: \`${command.command}\``)
        .join("\n")

export const renderTaskBrief = (task: BenchmarkTask) =>
  [
    `Task: ${task.title}`,
    `Goal: ${task.summary}`,
    `Deliverable: ${task.deliverable}`,
    "Requirements:",
    renderList(task.instructions),
    "Relevant files:",
    renderList(task.relevantFiles),
    "Acceptance:",
    renderAcceptanceCommands(task),
  ].join("\n")

export const renderDirectPrompt = (options: {
  readonly task: BenchmarkTask
  readonly contextPackMode: ContextPackMode
  readonly contextPack?: string
}) =>
  [
    "You are executing one benchmark task in a disposable git worktree.",
    "Complete the task directly in this repository, run the listed validations, and leave the worktree with the final diff and artifacts in place.",
    renderTaskBrief(options.task),
    options.contextPackMode === "none"
      ? undefined
      : [
          "Deterministic context pack:",
          options.contextPack ?? "No context pack was available.",
        ].join("\n"),
    "Do not write meta commentary. Make the repository changes needed for the benchmark task and then stop.",
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n\n")

export const renderPlanAuthoringPrompt = (options: {
  readonly task: BenchmarkTask
  readonly arm: Extract<BenchmarkArm, { family: "dagger" }>
  readonly contextPackMode: ContextPackMode
  readonly contextPack?: string
}) =>
  [
    "Author a Dagger markdown task graph for the following benchmark task.",
    "Return markdown only. The response must contain exactly one ## Tasks section and one ## Dependencies section.",
    "Requirements for the graph:",
    renderList([
      "Create 4-7 tasks.",
      "Use task ids that are simple slug-like identifiers.",
      "Each task prompt must be actionable and scoped to a concrete artifact or file set.",
      "At least one task must perform validation against the acceptance commands.",
      "Avoid meta tasks like \"think more\" or \"summarize the summary\".",
      "Keep the graph source-grounded in the repository rather than inventing files or APIs.",
      options.arm.nodePolicyDescription,
    ]),
    renderTaskBrief(options.task),
    options.contextPackMode === "none"
      ? undefined
      : [
          "Deterministic context pack:",
          options.contextPack ?? "No context pack was available.",
        ].join("\n"),
    "Make the final DAG ready for `dagger do` without additional editing.",
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n\n")

export const renderPlanRepairPrompt = (options: {
  readonly previousPlan: string
  readonly validationErrors: ReadonlyArray<string>
}) =>
  [
    "Repair the previous Dagger markdown graph and return markdown only.",
    "Keep the task count between 4 and 7 and preserve as much useful decomposition as possible.",
    "Validation errors:",
    renderList(options.validationErrors.map((error) => error.trim())),
    "Previous plan:",
    options.previousPlan.trim(),
  ].join("\n\n")

export const renderBlindReviewPrompt = (options: {
  readonly task: BenchmarkTask
  readonly changedFiles: ReadonlyArray<string>
  readonly acceptanceSummary: ReadonlyArray<string>
}) =>
  [
    "# Blind Review Packet",
    "",
    "The reviewer should evaluate the completed worktree without knowing which benchmark arm produced it.",
    "",
    "## Task Brief",
    "",
    renderTaskBrief(options.task),
    "",
    "## Changed Files",
    "",
    renderList(
      options.changedFiles.length === 0 ? ["No changed files were captured."] : options.changedFiles
    ),
    "",
    "## Acceptance Summary",
    "",
    renderList(
      options.acceptanceSummary.length === 0
        ? ["No acceptance commands were defined for this task."]
        : options.acceptanceSummary
    ),
    "",
    "## Review Rubric",
    "",
    renderList(
      options.task.reviewDimensions.map(
        (dimension) => `Score ${dimension} from 1-5 and justify it with concrete evidence.`
      )
    ),
  ].join("\n")
