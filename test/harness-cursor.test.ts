import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { Effect, Option } from "effect"

import { makeRunConfig } from "../src/domain/config"
import { TaskDefinition } from "../src/domain/task-graph"
import { resolveTaskRunConfig } from "../src/harness/harness"
import { makeCursorHarness } from "../src/harness/cursor"

const makeRecordingHarness = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dagger-harness-"))
  const argvPath = join(workspace, "argv.txt")
  const stdinPath = join(workspace, "stdin.txt")
  const scriptPath = join(workspace, "record-harness.sh")

  await writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$DAGGER_RECORD_ARGS_PATH"',
      'cat > "$DAGGER_RECORD_STDIN_PATH"',
      'printf \'DAGGER_EVENT {"_tag":"TaskFinishNoteEvent","summary":"shim summary"}\\n\''
    ].join("\n")
  )
  await chmod(scriptPath, 0o755)

  return { argvPath, scriptPath, stdinPath, workspace }
}

const withEnv = async <A>(
  env: Readonly<Record<string, string>>,
  thunk: () => Promise<A>
) => {
  const previous = new Map(
    Object.keys(env).map((key) => [key, process.env[key]] as const)
  )

  Object.entries(env).forEach(([key, value]) => {
    process.env[key] = value
  })

  try {
    return await thunk()
  } finally {
    previous.forEach((value, key) => {
      if (value === undefined) {
        delete process.env[key]
        return
      }

      process.env[key] = value
    })
  }
}

const makeTaskInput = async (options: { readonly model: Option.Option<string> }) => {
  const workspace = await mkdtemp(join(tmpdir(), "dagger-cursor-input-"))
  const runConfig = await Effect.runPromise(
    makeRunConfig({
      planPath: join(workspace, "plan.md"),
      harness: "cursor",
      model: options.model,
      thinking: Option.some("medium"),
      maxConcurrency: Option.none(),
      dryRun: false,
      cwd: workspace
    })
  )
  const task = new TaskDefinition({
    id: "hello-task",
    prompt: "Write a greeting file."
  })

  return {
    taskRunConfig: resolveTaskRunConfig(runConfig, task),
    statePath: join(workspace, ".dagger", "runs", "state.json"),
    task
  } as const
}

describe("makeCursorHarness", () => {
  test("passes headless args, model, and stdin prompt to cursor-agent", async () => {
    const recording = await makeRecordingHarness()
    const input = await makeTaskInput({ model: Option.some("composer-2") })

    await withEnv(
      {
        DAGGER_CURSOR_COMMAND: recording.scriptPath,
        DAGGER_RECORD_ARGS_PATH: recording.argvPath,
        DAGGER_RECORD_STDIN_PATH: recording.stdinPath
      },
      () => Effect.runPromise(makeCursorHarness().executeTask(input))
    )

    const argv = (await readFile(recording.argvPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
    const stdin = await readFile(recording.stdinPath, "utf8")

    expect(argv).toContain("-p")
    expect(argv).toContain("--force")
    expect(argv).toContain("--output-format")
    expect(argv).toContain("text")
    expect(argv).toContain("--model")
    expect(argv).toContain("composer-2")
    expect(stdin).toContain("Task ID: hello-task")
    expect(stdin).toContain("Task Prompt: Write a greeting file.")
    expect(stdin).toContain("Preferred model: composer-2")
    expect(stdin).toContain("Preferred thinking level: medium")
  })

  test("omits the model flag when no model is configured", async () => {
    const recording = await makeRecordingHarness()
    const input = await makeTaskInput({ model: Option.none() })

    await withEnv(
      {
        DAGGER_CURSOR_COMMAND: recording.scriptPath,
        DAGGER_RECORD_ARGS_PATH: recording.argvPath,
        DAGGER_RECORD_STDIN_PATH: recording.stdinPath
      },
      () => Effect.runPromise(makeCursorHarness().executeTask(input))
    )

    const argv = (await readFile(recording.argvPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)

    expect(argv).not.toContain("--model")
    expect(argv).not.toContain("composer-2")
    expect(argv).toContain("-p")
    expect(argv).toContain("--force")
  })
})
