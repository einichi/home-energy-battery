import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
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
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    },
  },
]);
