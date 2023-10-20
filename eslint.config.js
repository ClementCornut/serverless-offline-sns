import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";
import prettier from "eslint-plugin-prettier";

/**
 * @type {import("eslint").Linter.FlatConfig[]}
 */
export default [
  {
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: ["./src/tsconfig.json"],
      },
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      "@typescript-eslint": typescriptEslint,
      prettier,
    },
    files: ["./src/**/*.ts"],
    rules: {
      ...typescriptEslint.configs["eslint-recommended"].rules,
      ...typescriptEslint.configs["recommended-type-checked"].rules,
      ...typescriptEslint.configs["stylistic-type-checked"].rules,
      "prettier/prettier": "error",
    },
  },
];
