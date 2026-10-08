import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import i18next from "eslint-plugin-i18next";
import tseslint from "typescript-eslint";

export default defineConfig([
  { ignores: ["public/ui/**", "node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["server.ts", "lib/**/*.ts", "shared/**/*.ts", "types/**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    },
  },
  {
    files: ["lib/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { "patterns": [
        { "group": ["../services/**", "../http/**", "../persistence/**", "../create-application.js", "../notifications.js", "../history-store.js", "../application-store.js"], "message": "Domain modules must not depend on services, HTTP, persistence, infrastructure facades, or application composition." }
      ] }]
    },
  },
  {
    files: ["lib/persistence/**/*.ts", "lib/adapters/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { "patterns": [
        { "group": ["../services/**", "../http/**", "../create-application.js"], "message": "Infrastructure modules may depend only on contracts and domain utilities." }
      ] }]
    },
  },
  {
    files: ["lib/services/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { "patterns": [
        { "group": ["../http/**", "../persistence/**", "../history-store.js", "../application-store.js", "../create-application.js"], "message": "Services must depend on ports rather than HTTP, persistence implementations, or application composition." }
      ] }]
    },
  },
  {
    files: ["lib/services/database-administration.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["lib/http/routes/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { "patterns": [
        { "group": ["../../persistence/**", "../../history-store.js", "../../application-store.js", "../../create-application.js"], "message": "Routes must depend on service ports, not persistence or application composition." }
      ] }]
    },
  },
  {
    files: ["frontend/**/*.{ts,tsx}"],
    ignores: ["frontend/src/**/*.test.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks, i18next },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "i18next/no-literal-string": ["warn", {
        framework: "react",
        mode: "jsx-text-only",
        words: { exclude: ["^(?:[a-z][a-z0-9-]*|0|1|true|false)$"] },
        "jsx-attributes": { exclude: ["^(?:className|id|href|to|type|name|value|role|path|view|node|tone|color|aria-hidden|data-.*)$"] },
      }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    },
  },
]);
