## Tasks

### compose-semantics
- prompt: Audit `src/compose.ts` for compose/combinator semantics, including `resultTag`, `allValues`, `collectAll`, `modThrough`, and the `iso`/`fold`/`getter`/`traversal`/`lens`/`prism` implementation branches. Produce concrete findings about semantic risks or surprising behavior with file references and line numbers where useful. Do not edit any repository files.
- harness: codex
- model: gpt-5.4

### combinator-semantics
- prompt: Audit `src/combinators.ts` with emphasis on how `guard`, `at`, `index`, and `each` interact with composition semantics and identity-preserving updates. Produce concrete findings about edge cases or semantic risks relevant to compose behavior, with file references and line numbers where useful. Do not edit any repository files.
- harness: codex
- model: gpt-5.4

### test-coverage
- prompt: Audit `test/compose.test.ts`, `test/compose-matrix.test.ts`, and `test/laws.test.ts` for compose-related coverage. Identify what semantics are already asserted, what cases are only type-tag checked, and what semantic gaps or missing tests remain, with concrete file references. Do not modify tests.
- harness: codex
- model: gpt-5.4

### readme-audit
- prompt: Audit the compose and combinator examples in `README.md` against `src/compose.ts`, `src/combinators.ts`, `test/compose.test.ts`, `test/compose-matrix.test.ts`, and `test/laws.test.ts`. Record any documentation mismatches, ambiguous claims, or unsupported implications with concrete file references. Do not edit `README.md`.
- harness: codex
- model: gpt-5.4

### write-report
- prompt: Write `benchmark-results/optics-compose-audit.md`. The report must synthesize the audits of `src/compose.ts`, `src/combinators.ts`, `test/compose.test.ts`, `test/compose-matrix.test.ts`, `test/laws.test.ts`, and `README.md`, and must call out semantic risks, missing tests, and documentation mismatches with concrete file references. Include sections named `Scope`, `Semantic Risks`, `Missing Tests`, `Documentation Mismatches`, and `Recommended Follow-up`. Keep library source and tests unchanged.
- harness: codex
- model: gpt-5.4

### validate-scope
- prompt: Validate the acceptance criteria for this benchmark task. There are no shell acceptance commands, so verify directly that `benchmark-results/optics-compose-audit.md` exists, that it is the only intended task artifact, and that `src/compose.ts`, `src/combinators.ts`, `test/compose.test.ts`, `test/compose-matrix.test.ts`, `test/laws.test.ts`, and `README.md` remain unchanged. If the report needs correction, update only `benchmark-results/optics-compose-audit.md`.
- harness: codex
- model: gpt-5.4

## Dependencies

- compose-semantics -> write-report
- combinator-semantics -> write-report
- test-coverage -> write-report
- readme-audit -> write-report
- write-report -> validate-scope
