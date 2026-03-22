import path from "path";
import os from "os";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";

// Base directory for all CrossPad repos (override with CROSSPAD_GIT_DIR)
const defaultGitDir = IS_WINDOWS
  ? "C:/Users/Mateusz/GIT"
  : path.join(os.homedir(), "GIT");
const GIT_DIR = process.env.CROSSPAD_GIT_DIR || defaultGitDir;

export const CROSSPAD_PC_ROOT =
  process.env.CROSSPAD_PC_ROOT || path.join(GIT_DIR, "crosspad-pc");

export const REPOS: Record<string, string> = {
  "crosspad-core": path.join(GIT_DIR, "crosspad-core"),
  "crosspad-gui": path.join(GIT_DIR, "crosspad-gui"),
  "crosspad-pc": CROSSPAD_PC_ROOT,
  "ESP32-S3": path.join(GIT_DIR, "ESP32-S3"),
  "2playerCrosspad": path.join(GIT_DIR, "P4_TEST", "2playerCrosspad"),
  "crosspad-idf": path.join(GIT_DIR, "crosspad-idf"),
};

// MSVC — only used on Windows
export const VCVARSALL =
  process.env.VCVARSALL ||
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvarsall.bat";

// vcpkg — platform-aware defaults
const defaultVcpkgRoot = IS_WINDOWS ? "C:/vcpkg" : path.join(os.homedir(), "vcpkg");
const vcpkgRoot = process.env.VCPKG_ROOT || defaultVcpkgRoot;
export const VCPKG_TOOLCHAIN = path.join(vcpkgRoot, "scripts", "buildsystems", "vcpkg.cmake");

export const BUILD_DIR = path.join(CROSSPAD_PC_ROOT, "build");

const EXE_EXT = IS_WINDOWS ? ".exe" : "";
export const BIN_EXE = path.join(CROSSPAD_PC_ROOT, "bin", `main${EXE_EXT}`);

// ESP-IDF
export const CROSSPAD_IDF_ROOT =
  process.env.CROSSPAD_IDF_ROOT || path.join(GIT_DIR, "crosspad-idf");

const defaultIdfPath = path.join(os.homedir(), "esp", "v5.5", "esp-idf");
export const IDF_PATH = process.env.IDF_PATH || defaultIdfPath;
