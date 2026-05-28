// Flat ESLint config (ESLint v9+). Replaces the legacy .eslintrc format the
// `lint` script previously assumed (it referenced `--ext .ts`, removed in v9).
// Uses the @typescript-eslint parser + plugin directly so no extra meta-package
// is required.
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // The codebase intentionally uses `any` in a handful of well-commented
      // spots (MCP SDK index signatures, dynamic ML responses). Warn, don't error.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];
