/**
 * Toolchains: диагностика (doctor/preflight) и рецепты композиции целевого
 * репозитория — npm, pnpm, Turborepo, Go, Python/uv и их смешение в одном
 * Git root. Opt-in entrypoint: корень пакета и `./contracts` его не
 * импортируют.
 */
export {
  inspectPolicy,
  inspectRepository,
  assertToolchainReady,
  problemLines,
  toolchainProblemCodes,
  type InspectOptions,
  type PlanEntry,
  type ToolEntry,
  type ToolchainProblem,
  type ToolchainProblemCode,
  type ToolchainReport,
} from './inspect.ts';
export {
  defaultProbe,
  resolveExecutable,
  satisfies,
  versionOf as toolVersionOf,
  PROBE_TIMEOUT_MS,
  type ToolProbe,
} from './probe.ts';
export {
  composeRepository,
  installRecipes,
  type InstallRecipe,
  type ToolchainComponent,
} from './recipes.ts';
