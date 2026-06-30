/** Pure builders for the daemon write/call subcommands and live-trace stdin cmds. */

export function buildWriteArgv(elf: string, writes: string[]): string[] {
  return ["write", "--elf", elf, "--writes", writes.join(";")];
}

export function buildCallArgv(
  elf: string, func: string, args: number[], confirm: boolean,
  retType: string, timeout: number,
): string[] {
  const argv = ["call", "--elf", elf, "--func", func,
                "--args", args.map((n) => String(n)).join(",")];
  if (confirm) argv.push("--confirm");
  argv.push("--ret-type", retType, "--timeout", String(timeout));
  return argv;
}

export function writeStdinCmd(id: number, writes: string[]): string {
  return JSON.stringify({ cmd: "write", id, writes });
}

export function callStdinCmd(
  id: number, func: string, args: number[], confirm: boolean,
  retType: string, timeout: number,
): string {
  return JSON.stringify({ cmd: "call", id, func, args, confirm, ret_type: retType, timeout });
}

export function parseResultFrame(line: string, id: number): { match: boolean; frame?: any } {
  const t = line.trim();
  if (!t.startsWith("{")) return { match: false };
  try {
    const o = JSON.parse(t);
    if ((o.type === "write_result" || o.type === "call_result") && o.id === id) {
      return { match: true, frame: o };
    }
  } catch { /* not a json frame */ }
  return { match: false };
}
