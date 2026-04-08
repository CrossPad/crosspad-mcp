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
      test_output: `No tests/ directory found. Use crosspad_test_scaffold to create test infrastructure.`,
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
  let testCmd = `"${TEST_EXE}"`;
  if (listOnly) {
    testCmd += " --list-tests";
  } else {
    testCmd += " --reporter compact";
    if (filter) {
      testCmd += ` "${filter}"`;
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

/**
 * Scaffold the test infrastructure: CMakeLists.txt additions + sample test file.
 * Returns file contents — does NOT write to disk.
 */
export function crosspadTestScaffold(): { files: Record<string, string>; cmake_patch: string } {
  const files: Record<string, string> = {};

  // tests/CMakeLists.txt
  files["tests/CMakeLists.txt"] = `# CrossPad test suite — Catch2 v3
Include(FetchContent)

FetchContent_Declare(
  Catch2
  GIT_REPOSITORY https://github.com/catchorg/Catch2.git
  GIT_TAG        v3.5.2
)
FetchContent_MakeAvailable(Catch2)

# Collect test sources
file(GLOB_RECURSE TEST_SOURCES "\${CMAKE_CURRENT_SOURCE_DIR}/*.cpp")

add_executable(crosspad_tests \${TEST_SOURCES})

target_link_libraries(crosspad_tests PRIVATE
  Catch2::Catch2WithMain
)

# Include crosspad-core headers (for testing core logic)
target_include_directories(crosspad_tests PRIVATE
  \${CMAKE_SOURCE_DIR}/crosspad-core/include
  \${CMAKE_SOURCE_DIR}/crosspad-gui/include
  \${CMAKE_SOURCE_DIR}/src
)

# Same defines as main target
target_compile_definitions(crosspad_tests PRIVATE
  PLATFORM_PC=1
  CP_LCD_HOR_RES=320
  CP_LCD_VER_RES=240
)

# Add crosspad-core sources we want to test (non-platform-specific)
# Add individual source files as needed:
# target_sources(crosspad_tests PRIVATE
#   \${CMAKE_SOURCE_DIR}/crosspad-core/src/SomeFile.cpp
# )

include(CTest)
include(Catch)
catch_discover_tests(crosspad_tests)
`;

  // tests/test_pad_manager.cpp — sample test
  files["tests/test_pad_manager.cpp"] = `#include <catch2/catch_test_macros.hpp>

// Example: test crosspad-core types without full platform init
// #include <crosspad/pad/PadManager.hpp>
// #include <crosspad/platform/PlatformCapabilities.hpp>

TEST_CASE("Sanity check", "[core]") {
    REQUIRE(1 + 1 == 2);
}

// TEST_CASE("PlatformCapabilities bitflags", "[core][capabilities]") {
//     using crosspad::Capability;
//     using crosspad::setPlatformCapabilities;
//     using crosspad::hasCapability;
//     using crosspad::hasAnyCapability;
//
//     setPlatformCapabilities(Capability::Midi | Capability::Pads);
//
//     REQUIRE(hasCapability(Capability::Midi));
//     REQUIRE(hasCapability(Capability::Pads));
//     REQUIRE_FALSE(hasCapability(Capability::AudioOut));
//     REQUIRE(hasAnyCapability(Capability::Midi | Capability::AudioOut));
// }
`;

  // Patch for root CMakeLists.txt
  const cmakePatch = `
# Add this near the end of your CMakeLists.txt, before any final install/packaging:
# --- Test suite ---
if(EXISTS "\${CMAKE_SOURCE_DIR}/tests/CMakeLists.txt")
  add_subdirectory(tests)
endif()
`;

  return { files, cmake_patch: cmakePatch };
}

function parseCatch2Output(output: string): { passed: number; failed: number } {
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

function parseErrors(output: string): string[] {
  const errors: string[] = [];
  for (const line of output.split("\n")) {
    if (/\berror\b/i.test(line) && !line.includes("error(s)")) {
      errors.push(line.trim());
    }
  }
  return errors.slice(0, 20);
}
