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
  /** Which suite ran: the Catch2 binary, or ctest driving the labelled entries. */
  runner?: "catch2" | "ctest";
  labels?: string[];
}

/**
 * CTest labels the crosspad-pc suite defines. The GUI harness is a second
 * executable registered only as CTest entries, so `crosspad_tests` — the
 * binary this tool has always run — cannot reach it at all: without a label
 * the [gui] cases were simply unreachable from here.
 */
export type TestLabel = "gui" | "flaky";

const GUI_TEST_TARGET = "gui_tests";

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
  onLine?: OnLine,
  signal?: AbortSignal,
  labels: TestLabel[] = [],
): Promise<TestResult> {
  const useCtest = labels.length > 0;
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
    configResult = await runBuildStream(configCmd, CROSSPAD_PC_ROOT, onLine, 120_000, signal);
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

  const buildCmd = `cmake --build build --target ${useCtest ? GUI_TEST_TARGET : "crosspad_tests"}`;
  let buildResult;
  if (onLine) {
    buildResult = await runBuildStream(buildCmd, CROSSPAD_PC_ROOT, onLine, 300_000, signal);
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

  if (!useCtest && !fs.existsSync(TEST_EXE)) {
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
  let testCmd: string;
  if (useCtest) {
    testCmd = ctestCommand(labels, safeFilter, listOnly);
  } else {
    testCmd = `"${TEST_EXE}"`;
    if (listOnly) {
      testCmd += " --list-tests";
    } else {
      testCmd += " --reporter compact";
      if (safeFilter) {
        testCmd += ` "${safeFilter}"`;
      }
    }
  }

  onLine?.("stdout", "[crosspad] Running tests...");

  // Each labelled CTest entry launches the simulator and has its own 60 s
  // CMake timeout, so the whole run needs more room than one Catch2 binary.
  const runTimeout = useCtest ? 300_000 : 120_000;
  let testResult;
  if (onLine) {
    testResult = await runBuildStream(testCmd, CROSSPAD_PC_ROOT, onLine, runTimeout, signal);
  } else {
    testResult = runBuild(testCmd, CROSSPAD_PC_ROOT, runTimeout);
  }

  const testOutput = testResult.stdout + "\n" + testResult.stderr;

  const { passed, failed } = useCtest ? parseCtestOutput(testOutput) : parseCatch2Output(testOutput);

  const result: TestResult = {
    success: testResult.success,
    tests_found: true,
    build_output: buildResult.stdout.slice(-500),
    test_output: testOutput.slice(-5000),
    passed,
    failed,
    errors: testResult.success ? [] : parseErrors(testOutput),
    duration_seconds: (Date.now() - startTime) / 1000,
    runner: useCtest ? "ctest" : "catch2",
    labels,
  };

  onLine?.("stdout", `[crosspad] Tests ${result.success ? "PASSED" : "FAILED"}: ${passed} passed, ${failed} failed (${result.duration_seconds.toFixed(1)}s)`);

  return result;
}

/**
 * The ctest invocation for a label selection.
 *
 * `gui` without `flaky` excludes the flaky entries, which is the split the
 * suite's own CMakeLists documents (`ctest -L gui -LE flaky`): the CITest
 * audio self-test is intermittently red and must not redden the GUI harness.
 * Asking for `flaky` explicitly is how you get it anyway.
 *
 * @internal exported for testing
 */
export function ctestCommand(labels: TestLabel[], filter: string, listOnly: boolean): string {
  const parts = ["ctest --test-dir build --output-on-failure"];
  if (labels.includes("gui")) {
    parts.push("-L gui");
    if (!labels.includes("flaky")) parts.push("-LE flaky");
  } else if (labels.includes("flaky")) {
    parts.push("-L flaky");
  }
  // ctest selects by test name, not by Catch2 tag, so the filter is a regex
  // over the entry names (gui_integration, gui_audio_citest).
  if (filter) parts.push(`-R "${filter}"`);
  if (listOnly) parts.push("-N");
  return parts.join(" ");
}

/** @internal exported for testing */
export function parseCtestOutput(output: string): { passed: number; failed: number } {
  // "100% tests passed, 0 tests failed out of 2"
  const summary = /(\d+)\s+tests?\s+failed\s+out\s+of\s+(\d+)/i.exec(output);
  if (summary) {
    const failed = parseInt(summary[1], 10);
    const total = parseInt(summary[2], 10);
    return { passed: Math.max(total - failed, 0), failed };
  }
  // -N and interrupted runs print no summary; count the per-entry result lines.
  let passed = 0;
  let failed = 0;
  for (const line of output.split("\n")) {
    if (/Test\s+#\d+/.test(line) && /\bPassed\b/.test(line)) passed++;
    else if (/\*\*\*(Failed|Timeout|Exception)/.test(line)) failed++;
  }
  return { passed, failed };
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
