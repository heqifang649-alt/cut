import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next*/**",
    ".next-runtime/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Runtime state and local processing artifacts are not source inputs.
    "data/**",
    "storage/**",
    "logs/**",
    "outputs/**",
    "work/**",
    ".tmp/**",
    ".cache/**",
    "audit/**",
    "artifacts/**",
    "attachments/**",
    ".project-governance/evidence/**",
    "benchmarks/**/runs/**",
  ]),
]);

export default eslintConfig;
