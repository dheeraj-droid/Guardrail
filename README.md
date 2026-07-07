# Guardrail

> Automated API contract enforcement across repositories. Guardrail intercepts backend
> PRs that alter an OpenAPI spec, diffs the contract for deleted/type-mutated fields,
> AST-scans the linked frontend repo for live usage, and blocks the merge via the GitHub
> Checks API with exact file/line locations when it would break the UI.

## Documentation

- [CLAUDE.md](CLAUDE.md) — agent constitution: architecture laws every contributor/agent follows
- [docs/PLAN.md](docs/PLAN.md) — master implementation plan (waves, dependency graph, orchestration loops)
- [docs/specs/](docs/specs/) — per-track implementation specs (W0, A–J)
- [.claude/agents/](.claude/agents/) — subagent definitions (module-builder, ast-specialist, spec-auditor)

## Getting Started

Implementation follows the wave protocol in [docs/PLAN.md](docs/PLAN.md) §4. Wave 0
scaffolds the project (`npm install`, frozen types); Waves 1–2 build the modules in
parallel; Wave 3 runs the verification/audit loop.

## License

TBD
