import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    rules: {
      "no-console": "warn",
      "lines-between-class-members": ["error", "always", { exceptAfterSingleLine: true }],
      "padding-line-between-statements": [
        "error",
        {
          blankLine: "always",
          prev: "import",
          next: ["export", "expression", "class", "function", "const", "let", "var"],
        },
        { blankLine: "always", prev: "*", next: "export" },
        { blankLine: "always", prev: "multiline-expression", next: "multiline-expression" },
      ],
    },
  },
);
