import path from "path";

// Resolve crosspad-pc root from env or relative to this file
export const CROSSPAD_PC_ROOT =
  process.env.CROSSPAD_PC_ROOT ||
  "C:/Users/Mateusz/GIT/crosspad-pc";

export const REPOS: Record<string, string> = {
  "crosspad-core": "C:/Users/Mateusz/GIT/crosspad-core",
  "crosspad-gui": "C:/Users/Mateusz/GIT/crosspad-gui",
  "crosspad-pc": CROSSPAD_PC_ROOT,
  "ESP32-S3": "C:/Users/Mateusz/GIT/ESP32-S3",
  "2playerCrosspad": "C:/Users/Mateusz/GIT/P4_TEST/2playerCrosspad",
};

export const VCVARSALL =
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvarsall.bat";

export const VCPKG_TOOLCHAIN = "C:/vcpkg/scripts/buildsystems/vcpkg.cmake";

export const BUILD_DIR = path.join(CROSSPAD_PC_ROOT, "build");
export const BIN_EXE = path.join(CROSSPAD_PC_ROOT, "bin", "main.exe");
