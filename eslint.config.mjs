import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    // Git worktrees (used by isolated background agents) live under .claude/worktrees —
    // they're full checkouts of the repo, including ones other sessions may have locked
    // for in-progress work. Never lint into them.
    //
    // tests/fixtures/** is deliberately-crafted sample frontend source consumed by the
    // AST scanner (Law 7: syntactic scanning via ts.SyntaxKind, type-agnostic) — it's
    // fixture data, not maintained application code, so it isn't linted.
    ignores: [".claude/**", "tests/fixtures/**"],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // Codebase convention (predates this ESLint setup): leading-underscore
    // params/vars mark deliberately-unused mock arguments (see
    // tests/helpers/fakeGithub.ts, tests/pipeline/processPullRequest.test.ts).
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default eslintConfig;
