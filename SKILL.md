---
name: dagger-execution
description: Use when an agent should hand a supplied DAG plan to Dagger v1 in order to delegate a separable slice of work to specialist models like Codex or Cursor, especially for structured design, review, extraction, or validation work inside an existing chat thread. Also use when authoring or revising Dagger v1 YAML plans, choosing model roles, or deciding whether Dagger is actually the right tool.
---

# Dagger Execution

Use this skill when the current chat agent should stay focused on one slice of a complicated task while Dagger executes another slice through a supplied DAG plan.

Dagger is not a planner. It is an execution engine for plans you already have or can write quickly.

## Reach For Dagger When

- The work has a cleanly separable subtree with a different ideal model than the one in the current thread.
- Intermediate artifacts are useful on their own: design specs, review findings, implementation targets, structured extraction.
- The current chat risks context rot if it tries to do every slice itself.
- You want explicit observability, resumability, and cache reuse across repeated runs.

## Do Not Reach For Dagger When

- One strong model can just do the task in a single coherent pass.
- The graph would mostly be “read a lot, then write one smart thing.”
- The tail is dominated by a single integration node.
- The task has no meaningful intermediate artifacts.

## Default Workflow

1. Decide whether there is a real separable subtree.
2. Write a YAML plan with small explicit tasks and structured outputs.
3. Route by role, not by vendor slug, unless you intentionally want to pin a specific model.
4. Run `dagger run plan.yaml --dry-run` first.
5. Execute with `dagger run plan.yaml --profile balanced`.
6. Hand the resulting artifacts or changed files back to the current chat thread for integration if needed.

## Authoring Rules

- Prefer `model`, `reduce`, `command`, and `assert` only. If you think you need more kinds, the plan is probably too clever.
- Keep prompts local to the task. Never ask a task to reconstruct the whole run.
- Make `model` tasks produce JSON or tightly scoped markdown artifacts.
- Use `reduce` for deterministic merging; do not spend model tokens to concatenate or shallow-merge data.
- Use `assert` for artifact presence, acceptance commands, and diff-scope rules.
- Keep synthesis tails short. A wide graph that ends in one giant prose node is usually a trap.

## Role Heuristics

- `designer`: use for visual systems, hierarchy, copy direction, component-level design guidance.
- `frontend_implementer`: use for file-targeted UI implementation work.
- `backend_implementer`: use for invariants, data flow, and correctness-heavy backend tasks.
- `reviewer`: use for risk finding, implementation targets, and critique.
- `cheap_reader`: use for extraction, inventory, and structured source-grounded findings.

Balanced defaults are documented in [docs/v1-plan-format.md](docs/v1-plan-format.md).

## Best Example

If you are redesigning a site in Codex and the business logic still belongs in the current thread, delegate the design subtree to Dagger:

- current Codex thread keeps ownership of product logic and final integration
- Dagger runs `cheap_reader -> designer -> reviewer` on Cursor/Codex according to role
- Dagger returns structured design artifacts and implementation targets

Start from:

- [examples/site-redesign.plan.yaml](examples/site-redesign.plan.yaml)

## Audit Example

For structured source-grounded extraction with cheap readers and deterministic packing, start from:

- [examples/structured-audit.plan.yaml](examples/structured-audit.plan.yaml)

## Command Patterns

```sh
dagger run examples/site-redesign.plan.yaml --dry-run
dagger run examples/site-redesign.plan.yaml --profile balanced --max-concurrency 3
dagger run examples/site-redesign.plan.yaml --resume
```

## If You Are Writing A New Plan

- Read [docs/v1-plan-format.md](docs/v1-plan-format.md) first.
- Keep outputs explicit and named.
- Keep file inputs narrow.
- Prefer one clean subtree over a sprawling graph.
