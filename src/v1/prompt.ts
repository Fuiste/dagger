import { resolve } from "node:path"

import { type ModelTask } from "./plan"

const roleDirective = (role: ModelTask["role"]) => {
  switch (role) {
    case "designer":
      return "You are the design specialist. Focus on layout systems, visual hierarchy, typography, color, interaction intent, and high-leverage design artifacts."
    case "frontend_implementer":
      return "You are the frontend implementation specialist. Favor precise file changes, accessible UI, responsive behavior, and tests that lock in the result."
    case "backend_implementer":
      return "You are the backend implementation specialist. Favor correctness, invariants, data flow clarity, and targeted validation."
    case "reviewer":
      return "You are the reviewer specialist. Favor correctness, regressions, edge cases, and concise structured findings."
    case "cheap_reader":
      return "You are the extraction specialist. Read only the declared inputs and emit compact structured artifacts."
  }
}

export const renderModelPrompt = (options: {
  readonly task: ModelTask
  readonly cwd: string
  readonly inputFiles: ReadonlyArray<string>
  readonly artifactInputs: ReadonlyArray<{
    readonly ref: string
    readonly path: string
    readonly format: string
  }>
  readonly outputFiles: ReadonlyArray<{
    readonly id: string
    readonly path: string
    readonly format: string
  }>
}) =>
  [
    "You are executing one Dagger v1 task.",
    roleDirective(options.task.role),
    `Task id: ${options.task.id}`,
    `Working directory: ${options.cwd}`,
    "Objective:",
    options.task.prompt.trim(),
    options.inputFiles.length === 0
      ? undefined
      : ["Allowed workspace files:", ...options.inputFiles.map((file) => `- ${resolve(options.cwd, file)}`)].join(
          "\n"
        ),
    options.artifactInputs.length === 0
      ? undefined
      : [
          "Available upstream artifacts:",
          ...options.artifactInputs.map((artifact) => `- ${artifact.ref}: ${artifact.path} (${artifact.format})`)
        ].join("\n"),
    [
      "Required outputs:",
      ...options.outputFiles.map((output) => `- ${output.id}: ${resolve(options.cwd, output.path)} (${output.format})`)
    ].join("\n"),
    [
      "Rules:",
      "- Use only the declared files and upstream artifacts unless a directly connected import or file is strictly necessary.",
      "- Write every declared output to the exact path shown above.",
      "- JSON outputs must be plain JSON, not fenced markdown.",
      "- Keep your final assistant message short and mention only what you wrote."
    ].join("\n")
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n")
