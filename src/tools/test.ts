import fs from "fs";
import path from "path";
import { CROSSPAD_PC_ROOT, VCPKG_TOOLCHAIN, IS_WINDOWS } from "../config.js";
import { runBuild, runBuildStream, OnLine } from "../utils/exec.js";

export interface TestResult {
  success: boolean;
  tests_found: boolean;
  build_output: string;
  test_output: string;
  passed: number;
  failed: number;
  errors: string[];
  duration_seconds: number;
}

const TESTS_DIR = path.join(CROSSPAD_PC_ROOT, "tests");
const BIN_DIR = path.join(CROSSPAD_PC_ROOT, "bin");
const EXE_EXT = IS_WINDOWS ? ".exe" : "";
const TEST_EXE = path.join(BIN_DIR, `crosspad_tests${EXE_EXT}`);

/**
 * Build and run the crosspad test suite (Catch2).
 * If tests/ dir doesn't exist, offers to scaffold it.
 */
export async function crosspadTest(
  filter: string = "",
  listOnly: boolean = false,
  onLine?: OnLine
): Promise<TestResult> {
  const startTime = Date.now();

  // Check if test infrastructure exists
  if (!fs.existsSync(TESTS_DIR)) {
    return {
      success: false,
      tests_found: false,
      build_output: "",
      test_output: `No tests/ directory found. See docs for the Catch2 setup snippet.`,
      passed: 0,
      failed: 0,
      errors: ["tests/ directory not found"],
      duration_seconds: 0,
    };
  }

  // Ensure cmake is configured with BUILD_TESTING=ON
  onLine?.("stdout", "[crosspad] Configuring cmake with BUILD_TESTING=ON...");

  const configCmd = `cmake -B build -G Ninja -DCMAKE_TOOLCHAIN_FILE=${VCPKG_TOOLCHAIN} -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=ON`;

  let configResult;
  if (onLine) {
    configResult = await runBuildStream(configCmd, CROSSPAD_PC_ROOT, onLine, 120_000);
  } else {
    configResult = runBuild(configCmd, CROSSPAD_PC_ROOT, 120_000);
  }

  if (!configResult.success) {
    return {
      success: false,
      tests_found: true,
      build_output: (configResult.stdout + "\n" + configResult.stderr).slice(-3000),
      test_output: "",
      passed: 0,
      failed: 0,
      errors: parseErrors(configResult.stdout + "\n" + configResult.stderr),
      duration_seconds: (Date.now() - startTime) / 1000,
    };
  }

  // Build tests target
  onLine?.("stdout", "[crosspad] Building test target...");

  const buildCmd = "cmake --build build --target crosspad_tests";
  let buildResult;
  if (onLine) {
    buildResult = await runBuildStream(buildCmd, CROSSPAD_PC_ROOT, onLine, 300_000);
  } else {
    buildResult = runBuild(buildCmd, CROSSPAD_PC_ROOT, 300_000);
  }

  if (!buildResult.success) {
    return {
      success: false,
      tests_found: true,
      build_output: (buildResult.stdout + "\n" + buildResult.stderr).slice(-3000),
      test_output: "",
      passed: 0,
      failed: 0,
      errors: parseErrors(buildResult.stdout + "\n" + buildResult.stderr),
      duration_seconds: (Date.now() - startTime) / 1000,
    };
  }

  if (!fs.existsSync(TEST_EXE)) {
    return {
      success: false,
      tests_found: true,
      build_output: buildResult.stdout.slice(-1000),
      test_output: "Test executable not found after build",
      passed: 0,
      failed: 0,
      errors: [`${TEST_EXE} not found`],
      duration_seconds: (Date.now() - startTime) / 1000,
    };
  }

  // Run tests
  // Escape double-quotes / backticks / dollars in the filter to prevent
  // shell injection. Catch2 filters are simple tag/glob strings so this
  // sanitization doesn't lose semantics.
  const safeFilter = filter.replace(/[`"$\\]/g, "\\$&");
  let testCmd = `"${TEST_EXE}"`;
  if (listOnly) {
    testCmd += " --list-tests";
  } else {
    testCmd += " --reporter compact";
    if (safeFilter) {
      testCmd += ` "${safeFilter}"`;
    }
  }

  onLine?.("stdout", "[crosspad] Running tests...");

  let testResult;
  if (onLine) {
    testResult = await runBuildStream(testCmd, CROSSPAD_PC_ROOT, onLine, 120_000);
  } else {
    testResult = runBuild(testCmd, CROSSPAD_PC_ROOT, 120_000);
  }

  const testOutput = testResult.stdout + "\n" + testResult.stderr;

  // Parse Catch2 compact output
  const { passed, failed } = parseCatch2Output(testOutput);

  const result: TestResult = {
    success: testResult.success,
    tests_found: true,
    build_output: buildResult.stdout.slice(-500),
    test_output: testOutput.slice(-5000),
    passed,
    failed,
    errors: testResult.success ? [] : parseErrors(testOutput),
    duration_seconds: (Date.now() - startTime) / 1000,
  };

  onLine?.("stdout", `[crosspad] Tests ${result.success ? "PASSED" : "FAILED"}: ${passed} passed, ${failed} failed (${result.duration_seconds.toFixed(1)}s)`);

  return result;
}

/** @internal exported for testing */
export function parseCatch2Output(output: string): { passed: number; failed: number } {
  // Catch2 compact reporter: "Passed X test(s)" / "Failed X test(s)"
  const passedMatch = output.match(/(\d+)\s+assertion[s]?\s+.*passed/i) ||
                      output.match(/All tests passed\s*\((\d+)/i);
  const failedMatch = output.match(/(\d+)\s+assertion[s]?\s+.*failed/i) ||
                      output.match(/test cases?:\s*\d+\s*\|\s*(\d+)\s+failed/i);

  return {
    passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
  };
}

/** @internal exported for testing */
export function parseErrors(output: string): string[] {
  const errors: string[] = [];
  for (const line of output.split("\n")) {
    if (/\berror\b/i.test(line) && !line.includes("error(s)")) {
      errors.push(line.trim());
    }
  }
  return errors.slice(0, 20);
}
