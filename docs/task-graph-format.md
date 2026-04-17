# Task Graph Format

`dagger do` reads a markdown document with two required sections: `## Tasks` and `## Dependencies`.

## Rules

- `dagger do` requires `--harness <cursor|codex>`; that CLI choice supplies the run defaults and the final summary harness.
- Each task is declared as an `### <task-id>` heading under `## Tasks`.
- Every task must include a `- prompt: ...` metadata line.
- Supported task metadata keys are `prompt`, `harness`, `model`, and `thinking`.
- Supported task harness values are `cursor` and `codex`.
- Any paragraphs or fenced code blocks inside a task section become additional task instructions.
- Dependencies are declared under `## Dependencies` as bullet list items in the form `from -> to`.
- Task ids must be unique and use a simple slug-like shape such as `parser`, `build-runtime`, or `task_1`.
- Task metadata overrides the CLI defaults on a per-task basis: `task harness/model/thinking > dagger do flags`.

## Example

````md
# Build Dagger

## Tasks

### scaffold
- prompt: Set up the Bun and Effect baseline for the CLI.
- thinking: medium

Keep the initial command surface small and typed.

### parser
- prompt: Implement the markdown task-graph parser.
- model: gpt-5.4

```md
Add focused fixtures first, then tighten validation errors.
```

### runtime
- prompt: Implement the scheduler and state writer.
- harness: codex

## Dependencies

- scaffold -> parser
- scaffold -> runtime
- parser -> runtime
````

## Notes

- `## Dependencies` may be empty when all tasks can start immediately.
- Dependency edges only point from parent to child. `a -> b` means `b` starts after `a` succeeds.
- Mixed-harness graphs are allowed. The CLI `--harness` still decides which harness writes the final run summary.
