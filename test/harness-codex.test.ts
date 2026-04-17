import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { Cause, Effect, Exit, Option } from "effect"

import { makeRunConfig } from "../src/domain/config"
import { TaskDefinition, TaskGraph } from "../src/domain/task-graph"
import { makeCodexHarness } from "../src/harness/codex"
import { HarnessError, resolveTaskRunConfig } from "../src/harness/harness"
import { makeInitialRunState } from "../src/state/run-state"

const makeRecordingCodex = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dagger-codex-harness-"))
  const argvPath = join(workspace, "argv.txt")
  const stdinPath = join(workspace, "stdin.txt")
  const scriptPath = join(workspace, "record-codex.sh")

  await writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$DAGGER_RECORD_ARGS_PATH"',
      'cat > "$DAGGER_RECORD_STDIN_PATH"',
      'output_path=""',
      'previous=""',
      'for arg in "$@"; do',
      '  if [ "$previous" = "-o" ]; then',
      '    output_path="$arg"',
      "  fi",
      '  previous="$arg"',
      "done",
      'case "${DAGGER_CODEX_TEST_MODE:-success}" in',
      "  fail)",
      '    printf "codex exploded\\n" >&2',
      "    exit 17",
      "    ;;",
      "  missing-output)",
      "    ;;",
      "  empty-output)",
      '    : > "$output_path"',
      "    ;;",
      "  invalid-event)",
      '    printf \'DAGGER_EVENT {not-json}\\nplain fallback\\n\' > "$output_path"',
      "    ;;",
      "  summary)",
      '    printf \'DAGGER_EVENT {"_tag":"TaskFinishNoteEvent","summary":"run summary"}\\n\' > "$output_path"',
      "    ;;",
      "  *)",
      '    printf \'DAGGER_EVENT {"_tag":"TaskStartNoteEvent","note":"starting"}\\nplain work\\nDAGGER_EVENT {"_tag":"TaskFinishNoteEvent","note":"done","summary":"task complete"}\\n\' > "$output_path"',
      "    ;;",
      "esac"
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

const readRecordedArgs = async (argvPath: string) =>
  (await readFile(argvPath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)

const findOutputPath = (argv: ReadonlyArray<string>) => {
  const index = argv.indexOf("-o")

  return index === -1 ? undefined : argv[index + 1]
}

const makeTaskInput = async (options: { readonly model: Option.Option<string> }) => {
  const workspace = await mkdtemp(join(tmpdir(), "dagger-codex-task-"))
  const runConfig = await Effect.runPromise(
    makeRunConfig({
      planPath: join(workspace, "plan.md"),
      harness: "codex",
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
    task,
    taskRunConfig: resolveTaskRunConfig(runConfig, task),
    statePath: join(workspace, ".dagger", "runs", "state.json")
  } as const
}

const makeSummaryInput = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dagger-codex-summary-"))
  const runConfig = await Effect.runPromise(
    makeRunConfig({
      planPath: join(workspace, "plan.md"),
      harness: "codex",
      model: Option.some("gpt-5-codex"),
      thinking: Option.none(),
      maxConcurrency: Option.none(),
      dryRun: false,
      cwd: workspace
    })
  )
  const graph = new TaskGraph({
    tasks: [
      new TaskDefinition({
        id: "scaffold",
        prompt: "Set up the project."
      })
    ],
    dependencies: []
  })

  return {
    runConfig,
    runState: makeInitialRunState({
      runId: "summary-run",
      graph
    }),
    statePath: join(workspace, ".dagger", "runs", "summary-state.json")
  } as const
}

describe("makeCodexHarness", () => {
  test("passes codex exec args, prompt text, and reads the final assistant message file", async () => {
    const recording = await makeRecordingCodex()
    const input = await makeTaskInput({ model: Option.some("gpt-5-codex") })

    const result = await withEnv(
      {
        DAGGER_CODEX_COMMAND: recording.scriptPath,
        DAGGER_RECORD_ARGS_PATH: recording.argvPath,
        DAGGER_RECORD_STDIN_PATH: recording.stdinPath
      },
      () => Effect.runPromise(makeCodexHarness().executeTask(input))
    )

    const argv = await readRecordedArgs(recording.argvPath)
    const stdin = await readFile(recording.stdinPath, "utf8")
    const outputPath = findOutputPath(argv)

    expect(argv).toContain("exec")
    expect(argv).toContain("--full-auto")
    expect(argv).toContain("--ephemeral")
    expect(argv).toContain("--skip-git-repo-check")
    expect(argv).toContain("--color")
    expect(argv).toContain("never")
    expect(argv).toContain("--cd")
    expect(argv).toContain(input.taskRunConfig.cwd)
    expect(argv).toContain("-o")
    expect(argv).toContain("--model")
    expect(argv).toContain("gpt-5-codex")
    expect(stdin).toContain("Task ID: hello-task")
    expect(stdin).toContain("Task Prompt: Write a greeting file.")
    expect(stdin).toContain("Preferred model: gpt-5-codex")
    expect(stdin).toContain("Preferred thinking level: medium")
    expect(result).toEqual({
      note: "done",
      summary: "task complete"
    })
    expect(outputPath).toBeDefined()
    if (outputPath !== undefined) {
      expect(await Bun.file(outputPath).exists()).toBe(false)
    }
  })

  test("omits the model flag when no model is configured", async () => {
    const recording = await makeRecordingCodex()
    const input = await makeTaskInput({ model: Option.none() })

    await withEnv(
      {
        DAGGER_CODEX_COMMAND: recording.scriptPath,
        DAGGER_RECORD_ARGS_PATH: recording.argvPath,
        DAGGER_RECORD_STDIN_PATH: recording.stdinPath
      },
      () => Effect.runPromise(makeCodexHarness().executeTask(input))
    )

    const argv = await readRecordedArgs(recording.argvPath)

    expect(argv).not.toContain("--model")
    expect(argv).not.toContain("gpt-5-codex")
  })

  test("surfaces stderr when codex exits non-zero", async () => {
    const recording = await makeRecordingCodex()
    const input = await makeTaskInput({ model: Option.none() })

    const exit = await withEnv(
      {
        DAGGER_CODEX_COMMAND: recording.scriptPath,
        DAGGER_RECORD_ARGS_PATH: recording.argvPath,
        DAGGER_RECORD_STDIN_PATH: recording.stdinPath,
        DAGGER_CODEX_TEST_MODE: "fail"
      },
      () => Effect.runPromiseExit(makeCodexHarness().executeTask(input))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)

      expect(error).toBeInstanceOf(HarnessError)
      if (!(error instanceof HarnessError)) {
        throw error
      }
      expect(error.message).toContain("Codex harness command failed with exit code 17.")
      expect(error.message).toContain("codex exploded")
    }
  })

  test("fails when codex does not write the final assistant message file", async () => {
    const recording = await makeRecordingCodex()
    const input = await makeTaskInput({ model: Option.none() })

    const exit = await withEnv(
      {
        DAGGER_CODEX_COMMAND: recording.scriptPath,
        DAGGER_RECORD_ARGS_PATH: recording.argvPath,
        DAGGER_RECORD_STDIN_PATH: recording.stdinPath,
        DAGGER_CODEX_TEST_MODE: "missing-output"
      },
      () => Effect.runPromiseExit(makeCodexHarness().executeTask(input))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)

      expect(error).toBeInstanceOf(HarnessError)
      if (!(error instanceof HarnessError)) {
        throw error
      }
      expect(error.message).toContain("Codex harness did not write a final assistant message.")
    }
  })

  test("fails when codex writes an empty final assistant message", async () => {
    const recording = await makeRecordingCodex()
    const input = await makeTaskInput({ model: Option.none() })

    const exit = await withEnv(
      {
        DAGGER_CODEX_COMMAND: recording.scriptPath,
        DAGGER_RECORD_ARGS_PATH: recording.argvPath,
        DAGGER_RECORD_STDIN_PATH: recording.stdinPath,
        DAGGER_CODEX_TEST_MODE: "empty-output"
      },
      () => Effect.runPromiseExit(makeCodexHarness().executeTask(input))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)

      expect(error).toBeInstanceOf(HarnessError)
      if (!(error instanceof HarnessError)) {
        throw error
      }
      expect(error.message).toContain("Codex harness wrote an empty final assistant message.")
    }
  })

  test("falls back to plain assistant text when event lines are malformed", async () => {
    const recording = await makeRecordingCodex()
    const input = await makeTaskInput({ model: Option.none() })

    const result = await withEnv(
      {
        DAGGER_CODEX_COMMAND: recording.scriptPath,
        DAGGER_RECORD_ARGS_PATH: recording.argvPath,
        DAGGER_RECORD_STDIN_PATH: recording.stdinPath,
        DAGGER_CODEX_TEST_MODE: "invalid-event"
      },
      () => Effect.runPromise(makeCodexHarness().executeTask(input))
    )

    expect(result).toEqual({
      summary: 'DAGGER_EVENT {not-json}\nplain fallback'
    })
  })

  test("summarizeRun reads the final assistant message file", async () => {
    const recording = await makeRecordingCodex()
    const input = await makeSummaryInput()

    const result = await withEnv(
      {
        DAGGER_CODEX_COMMAND: recording.scriptPath,
        DAGGER_RECORD_ARGS_PATH: recording.argvPath,
        DAGGER_RECORD_STDIN_PATH: recording.stdinPath,
        DAGGER_CODEX_TEST_MODE: "summary"
      },
      () => Effect.runPromise(makeCodexHarness().summarizeRun(input))
    )

    const argv = await readRecordedArgs(recording.argvPath)

    expect(argv).toContain("exec")
    expect(argv).toContain("--model")
    expect(argv).toContain("gpt-5-codex")
    expect(result).toBe("run summary")
  })
})

const runLiveCodexSmoke =
  process.env.DAGGER_LIVE_CODEX_SMOKE === "1" ? test : test.skip

describe("makeCodexHarness live smoke", () => {
  runLiveCodexSmoke("runs a tiny prompt through the installed codex CLI", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "dagger-live-codex-"))
    const task = new TaskDefinition({
      id: "smoke",
      prompt: "Reply with exactly: smoke ok"
    })
    const runConfig = await Effect.runPromise(
      makeRunConfig({
        planPath: join(workspace, "plan.md"),
        harness: "codex",
        model: Option.none(),
        thinking: Option.none(),
        maxConcurrency: Option.none(),
        dryRun: false,
        cwd: workspace
      })
    )

    const result = await Effect.runPromise(
      makeCodexHarness().executeTask({
        task,
        taskRunConfig: resolveTaskRunConfig(runConfig, task),
        statePath: join(workspace, ".dagger", "runs", "smoke-state.json")
      })
    )

    expect(result.summary).toBeDefined()
    expect(result.summary?.length ?? 0).toBeGreaterThan(0)
  })
})
