import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const adminDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(adminDir, "tests");
const unitFiles = readdirSync(testsDir)
  .filter((name) => name.endsWith(".unit.ts"))
  .sort();

if (unitFiles.length === 0) {
  console.error(`No tests/*.unit.ts files found in ${testsDir}`);
  process.exitCode = 1;
} else {
  const outputDir = mkdtempSync(join(tmpdir(), "fireflint-admin-unit-"));
  let exitCode = 0;

  try {
    const compiler = join(adminDir, "node_modules", "typescript", "bin", "tsc");
    const compile = spawnSync(process.execPath, [
      compiler,
      "--target", "ES2022",
      "--module", "commonjs",
      "--moduleResolution", "node",
      "--lib", "ES2022,DOM,DOM.Iterable",
      "--types", "node",
      "--esModuleInterop",
      "--strict",
      "--skipLibCheck",
      "--forceConsistentCasingInFileNames",
      "--noEmitOnError",
      "--rootDir", adminDir,
      "--outDir", outputDir,
      ...unitFiles.map((name) => join(testsDir, name)),
    ], {
      cwd: adminDir,
      encoding: "utf8",
      shell: false,
      maxBuffer: 16 * 1024 * 1024,
    });

    exitCode = report(compile, "TypeScript unit-test compilation");
    if (exitCode === 0) {
      const compiledTests = unitFiles.map((name) =>
        join(outputDir, "tests", name.replace(/\.ts$/, ".js")),
      );
      const run = spawnSync(process.execPath, ["--test", ...compiledTests], {
        cwd: outputDir,
        encoding: "utf8",
        shell: false,
        maxBuffer: 16 * 1024 * 1024,
      });
      exitCode = report(run, "Node unit tests");
    }
  } catch (error) {
    console.error(`Unit-test runner failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }

  process.exitCode = exitCode;
}

function report(result, label) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(`${label} could not start: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`${label} was interrupted by ${result.signal}`);
    return 1;
  }
  if (result.status === null) {
    console.error(`${label} ended without an exit code`);
    return 1;
  }
  return result.status;
}
