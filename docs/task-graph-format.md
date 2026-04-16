# Task Graph Format

`dagger do` reads a markdown document with two required sections: `## Tasks` and `## Dependencies`.

## Rules

- Each task is declared as an `### <task-id>` heading under `## Tasks`.
- Every task must include a `- prompt: ...` metadata line.
- Supported task metadata keys are `prompt`, `harness`, `model`, and `thinking`.
- Any paragraphs or fenced code blocks inside a task section become additional task instructions.
- Dependencies are declared under `## Dependencies` as bullet list items in the form `from -> to`.
- Task ids must be unique and use a simple slug-like shape such as `parser`, `build-runtime`, or `task_1`.

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
- harness: cursor

## Dependencies

- scaffold -> parser
- scaffold -> runtime
- parser -> runtime
````

## Notes

- `## Dependencies` may be empty when all tasks can start immediately.
- Dependency edges only point from parent to child. `a -> b` means `b` starts after `a` succeeds.
