# crosspad-mcp — TODO (Review MCP)

Review krytyczny z perspektywy zgodności z MCP spec, security i idiomatyki protokołu.
Skala: 🔴 krytyczne · 🟠 anti-pattern · 🟡 średnie · 🟢 nice-to-have

**Status:** runda 1 (commit `7ac0f17`) + runda 2 + runda 3 (uncommitted, **v7.0.0**).

---

## ⭐ Meta-bug (user-reported, runda 3)

**Problem:** Mimo CLAUDE.md i memory, Claude w sesji często NIE używa `crosspad_*` tools — robi raw `git status`, `grep`, `cmake` ręcznie. Trzeba mu jawnie przypominać.

**Fix runda 3:**
- ✅ MCP server `instructions` (1667 chars) — eksponowane przez protokół do klienta na initialize. Klient sklei z system-promptem. Wymienia explicite kiedy używać crosspad_* zamiast raw shell.
- ✅ Wzmocnione description kluczowych toolów ("PREFER THIS over raw `cmake --build`/`git status`/`grep`/etc.") — drugi sygnał na poziomie tool selection.
- ✅ Resource `crosspad://workspace` — agregat (repos, branch, dirty, sim status) loadowalny bez tool call. Klient może pinować jako session context.

To obchodzi zależność od CLAUDE.md i memory — sygnał idzie kanałem MCP-protokołu który klient *zawsze* uwzględnia.

---

## Co dało v7.0.0 (runda 3)

- **Surface 42 → 30 tools + 1 resource:**
  - Wywalone: `crosspad_scaffold_app`, `crosspad_test_scaffold` (do docs)
  - Zlane: 7× input → 1 (`crosspad_input` z `action`); 4× midi → 1 (`crosspad_midi` z `type`); 2× log → 1 (`crosspad_log` z `target`)
  - Dodane: `crosspad_kill_pc`
- **Server `instructions`** dla discoverability/affinity
- **Resource `crosspad://workspace`** dla session context bez tool call
- **Migration notes** w README v6→v7

---

## 🔴 Krytyczne — niezgodność z MCP spec

### [x] 1. Dodać `isError: true` na błędach narzędzi ✅ commit `7ac0f17`
- **Plik:** [src/index.ts:72-74](src/index.ts#L72-L74)
- **Problem:** `err()` zwraca `{success:false, error:...}` w treści, ale brakuje protokolarnej flagi `isError: true` na CallToolResult. LLM widzi to jako "tool call ok z tekstem" zamiast "tool call zwrócił błąd".
- **Fix:**
  ```ts
  function err(message: string, extra: Record<string, unknown> = {}) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message, ...extra }, null, 2) }],
    };
  }
  ```
- Dodatkowo: w każdym `jsonResponse(envelope(...))` jeśli `success===false` ustawić `isError: true`.

### [ ] 2. `outputSchema` + `structuredContent`
- **Problem:** Wszystkie tool results to `text` content z JSON-em. MCP od 2025-03 wspiera typowane outputy.
- **Fix:** Dla każdego toola zdefiniować `outputSchema` (zod) i zwracać `structuredContent: {...}` zamiast (lub obok) `text`.
- **Priorytet:** Tooly z bogatymi danymi: `crosspad_repo_status`, `crosspad_stats`, `crosspad_apps_list`, `crosspad_search_symbols`, `crosspad_devices`, `crosspad_build_*`.

### [x] 3. Tool annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) ✅ commit `7ac0f17`
- **Problem:** Zero hintów. Klienci MCP używają ich do confirmation gating.
- **Destructive (`destructiveHint: true`):**
  - `crosspad_commit`
  - `crosspad_submodule_update` (`git checkout origin/X` kasuje local commits)
  - `crosspad_apps_install` / `crosspad_apps_remove` / `crosspad_apps_update` / `crosspad_apps_sync`
  - `crosspad_flash_uart` / `crosspad_flash_ota`
  - `crosspad_build_idf` (gdy `mode=fullclean|clean`)
  - `crosspad_build_pc` (gdy `mode=clean`)
  - `crosspad_settings_set`
- **Read-only (`readOnlyHint: true`):**
  - `crosspad_devices`, `crosspad_repo_status`, `crosspad_repo_diff`
  - `crosspad_search_symbols`, `crosspad_list_interfaces`, `crosspad_interface_implementations`, `crosspad_capabilities`, `crosspad_list_apps_source`
  - `crosspad_apps_list`, `crosspad_check_pc`, `crosspad_stats`, `crosspad_settings_get`, `crosspad_screenshot`
- **Open world (`openWorldHint: true`):** wszystkie tooly app-manager (sięgają do gh/GitHub).

### [ ] 4. Streaming via `notifications/progress` zamiast `logging/message`
- **Plik:** [src/index.ts:46-52](src/index.ts#L46-L52)
- **Problem:** Build/test/flash wysyłają każdą linię jako `sendLoggingMessage`. To diagnostic channel, nie progress reporting. Klient nie ma progress baru.
- **Fix:** Pobrać `progressToken` z `_meta` requestu, wysyłać `notifications/progress` z `{progress, total?}`. Logging zostawić tylko dla błędów/diagnostyki.
- **Tooły wymagające progress:** `crosspad_build_pc`, `crosspad_build_idf`, `crosspad_test_run`, `crosspad_flash_uart`, `crosspad_flash_ota`, `crosspad_log_pc`, `crosspad_log_idf`, `crosspad_apps_install/update`.

### [ ] 5. Obsługa cancellation
- **Problem:** Build IDF ma timeout 600s. User anuluje (`notifications/cancelled`) — spawn dalej miele.
- **Fix:** Pobrać `AbortSignal` z requestu, propagować do `spawn`, na `cancelled` wywołać `child.kill('SIGTERM')` → po 2s `SIGKILL`.

### [~] 6. Eksponować `resources` i `prompts` (runda 3 — wybrany podzbiór)
- Resources: `crosspad://workspace` agregat — w trakcie
- Prompts: odłożone, na razie polegamy na server `instructions`
- **Problem:** Tylko `tools` capability. Idiomatyczny MCP eksponuje:
- **Resources do dodania:**
  - `app-registry.json` z każdej platformy
  - `apps.json` (manifest installed) per-platform
  - `.gitmodules` z każdego repo
  - capability listy
  - lista interfejsów (cache statyczny)
  - logi build (z `build/` dir)
- **Prompts do dodania:**
  - "scaffold + integrate app" (scaffold → patch CMakeLists → register)
  - "flash + monitor" (build → flash → log_idf)
  - "PR ready" (test_run → repo_status → diff_core → commit)
- **Capability declaration:** `{ capabilities: { logging: {}, resources: {}, prompts: {} } }`.

---

## 🟠 Bloat surfacy (anti-pattern dla LLM)

### [~] 7. Konsolidacja 41 → ~32 tools (runda 3 — w trakcie)
- Wywal: scaffold (2× — przeniesione do docs)
- Zlej: midi 4→1, input 5→1, log 2→1
- Bump major version 6→7
- **Problem:** Commit `aa866ec` "split mega-tools into 41" → ruch w złą stronę. Każdy tool kosztuje LLM context (name+desc+schema).
- **Konsolidacja:**
  - 4× MIDI (`note_on/off`, `cc`, `program_change`) → 1 `crosspad_midi` z `z.discriminatedUnion("type", ...)`. Backend już to ma w [src/tools/midi.ts:33](src/tools/midi.ts#L33).
  - 5× input (`pad_press/release`, `encoder_*`, `click`, `key`) → 1 `crosspad_input` z `z.discriminatedUnion("action", ...)`. Backend już to ma.
  - 3× architecture (`list_interfaces`, `interface_implementations`, `capabilities`) → 1 `crosspad_architecture` z `query` enum.
  - Rozważ: `crosspad_log_pc` + `crosspad_log_idf` → `crosspad_log` z `target`.

### [ ] 8. Spójność osi platformowej w nazwach
- **Problem:** `crosspad_build_pc`, `crosspad_build_idf` — platforma w nazwie. Ale `crosspad_apps_install` bierze `platform` jako arg.
- **Fix:** Wybrać jedną konwencję. Sugestia: zostać przy nazwie z platformą dla build/flash (różne implementacje), `platform` jako arg dla apps (delegacja do tego samego skryptu).

---

## 🔴 Security — shell injection

### [~] 9. `runCommand` puszcza shell domyślnie — częściowo (allow-listy w poz. 10 mitygują)
- **Plik:** [src/utils/exec.ts:106](src/utils/exec.ts#L106), [src/utils/exec.ts:99-128](src/utils/exec.ts#L99-L128)
- **Problem:** `execSync` bez `shell:false` uruchamia przez `/bin/sh -c`. Każdy interpolowany user-string to potencjalny RCE.
- **Hot-spoty:**
  - [src/tools/idf-flash.ts:77](src/tools/idf-flash.ts#L77): `idf.py -p ${targetPort} flash` — port użytkownika do shella.
  - [src/tools/idf-flash.ts:153](src/tools/idf-flash.ts#L153): `python3 "${otaScript}" "${fwPath}" ${portArg}` — `firmware_path` user input.
  - [src/tools/repo-actions.ts:165](src/tools/repo-actions.ts#L165): `git checkout origin/${branch}` — `branch` dowolny string.
  - [src/tools/repo-actions.ts:188-203](src/tools/repo-actions.ts#L188-L203): `oldSha`, `newSha` z `getHead()` reused w `git rev-list --count ${oldSha}..${newSha}`.
  - [src/tools/app-manager.ts:204](src/tools/app-manager.ts#L204): `python3 -c "${script}"` w double-quoted shell → `$VAR`/backtick/`\` ekspandują mimo `pyEscape`.
- **Fix:**
  - Refaktor `runCommand` / `runCommandStream` na `spawn(cmd, args[], { shell: false })` z tablicą argumentów (analogicznie `execFile`).
  - Zostaw shell-mode tylko dla statycznych komend (`cmake --build build`).
  - Dodać wariant `runShell(cmdString, ...)` jawnie tylko dla zaufanych statycznych ciągów.

### [x] 10. Allow-list walidacja `port` i `branch` ✅ commit `7ac0f17`
- **Port (Zod):**
  ```ts
  const Port = z.string()
    .regex(/^(\/dev\/(tty(ACM|USB)\d+|cu\.usb[A-Za-z0-9_-]+)|COM\d+)$/,
           "Port must be /dev/ttyACM*, /dev/ttyUSB*, /dev/cu.usb*, or COM*");
  ```
- **Branch (Zod):**
  ```ts
  const BranchName = z.string()
    .regex(/^[A-Za-z0-9._/-]+$/, "Invalid branch name")
    .refine(s => !s.startsWith("-"), "Branch cannot start with dash");
  ```
- **App name (Zod):** już ma regex w `crosspad_scaffold_app`, dodać do `crosspad_apps_install/remove/update`.

### [x] 11. Tempfile permissions (`os.tmpdir()`) ✅ commit `7ac0f17`
- **Plik:** [src/tools/repo-actions.ts:268-278](src/tools/repo-actions.ts#L268-L278), [src/tools/repo-actions.ts:311-316](src/tools/repo-actions.ts#L311-L316)
- **Problem:** Pliki w `os.tmpdir()` z PID+Date.now() są world-readable na multi-user boxie pod default umask. Commit message + paths leak.
- **Fix:**
  ```ts
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-"));
  const pathspecFile = path.join(dir, "pathspec");
  fs.writeFileSync(pathspecFile, content, { encoding: "utf-8", mode: 0o600 });
  // ...użyj...
  fs.rmSync(dir, { recursive: true, force: true });
  ```

---

## 🟡 Średnie

### [ ] 12. Cache env-ów na całe życie procesu
- **Plik:** [src/utils/exec.ts:11](src/utils/exec.ts#L11), [src/utils/exec.ts:246](src/utils/exec.ts#L246)
- **Problem:** MSVC (`cachedMsvcEnv`) i IDF (`cachedIdfEnv`) cache forever. Upgrade IDF → server pokazuje stare paths.
- **Fix:** Trzymać mtime `export.sh`/`export.bat` w cache, invalidate przy zmianie. Albo prosty TTL 10min.

### [ ] 13. `isPythonAvailable` cache bez TTL
- **Plik:** [src/tools/app-manager.ts:321-332](src/tools/app-manager.ts#L321-L332)
- **Fix:** TTL 60s lub invalidate przy mutating action.

### [ ] 14. `_registryCache` singleton, nie per-source
- **Plik:** [src/tools/app-manager.ts:124-130](src/tools/app-manager.ts#L124-L130)
- **Problem:** Wczytasz registry z PC, potem z IDF — drugi nadpisuje pierwszy.
- **Fix:** `Map<sourcePath, {data, timestamp, mtimeMs}>`.

### [x] 15. Brak `crosspad_kill_pc` / proper status ✅ runda 2 (uncommitted)
- **Plik:** [src/tools/build.ts:147](src/tools/build.ts#L147), [src/utils/exec.ts:417-430](src/utils/exec.ts#L417-L430)
- **Problem:** `spawnDetached` → fire-and-forget. `isSimulatorRunning` przez TCP, ale zombie binary po crashu (TCP server padł, proces żyje) niewykryte.
- **Fix:**
  - Dodać `crosspad_kill_pc` (PID tracked przez server lub `pgrep CrossPad`).
  - W `crosspad_run_pc` zwracać też wynik post-spawn ping (z timeoutem 3s) — wtedy LLM wie czy sim faktycznie wstał.

### [x] 16. Hardcoded port 19840 ✅ runda 2 (uncommitted) — `CROSSPAD_REMOTE_PORT` + `CROSSPAD_REMOTE_HOST`
- **Plik:** [src/utils/remote-client.ts:8](src/utils/remote-client.ts#L8)
- **Fix:** `const REMOTE_PORT = parseInt(process.env.CROSSPAD_REMOTE_PORT ?? "19840", 10);` Dodać do README config table.

### [ ] 17. Brak lockingu na port serial
- **Plik:** [src/tools/idf-monitor.ts:36-49](src/tools/idf-monitor.ts#L36-L49)
- **Problem:** Równoległy `idf.py monitor` w terminalu się gryzie z `crosspad_log_idf`.
- **Fix:** Sprawdzić `lsof -t <port>` przed otwarciem, zwrócić błąd "port busy". Albo dodać do README warning.

### [x] 18. Naiwny `parseErrors` w PC build ✅ runda 2 (uncommitted)
- **Plik:** [src/tools/build.ts:16-24](src/tools/build.ts#L16-L24)
- **Problem:** `\berror\b` case-insensitive na każdej linii. `// error handling done` w outputcie cmake → false positive.
- **Fix:** Zaaplikować pattern z [src/tools/idf-build.ts:76-92](src/tools/idf-build.ts#L76-L92) (compiler `:line:col: error:` style + `CMake Error` + `FAILED:` + `undefined reference`).

### [~] 19. Walidacja response z TCP simulator — runda 2 (uncommitted): screenshot+settings_set zod-walidowane; midi/stats/settings_get nadal pass-through
- **Pliki:** [src/tools/screenshot.ts:69-73](src/tools/screenshot.ts#L69-L73), [src/tools/midi.ts](src/tools/midi.ts), [src/tools/settings.ts](src/tools/settings.ts), [src/tools/stats.ts](src/tools/stats.ts)
- **Problem:** `resp.width as number` bez walidacji. Sim zwróci śmieć → NaN/undefined w odpowiedzi tool.
- **Fix:** Zod schema dla każdej response (np. `ScreenshotResponseSchema`, `StatsResponseSchema`), `.parse()` przed castem.

### [x] 20. Asymetria scaffold (`return content` vs `crosspad_commit` write) ✅ runda 3 — wywalone z MCP, treść w docs (decyzja usera)
- **Pliki:** [src/tools/scaffold.ts](src/tools/scaffold.ts), `crosspad_test_scaffold` w [src/tools/test.ts](src/tools/test.ts)
- **Problem:** Scaffold zwraca content → caller LLM `Write`-uje. `crosspad_commit` modyfikuje git. Niespójna semantyka.
- **Fix opcja A:** Dodać `dry_run: boolean` (default true). Gdy false, tool zapisuje pliki do `dir`, sprawdza czy istnieją (refuse override unless `force`).
- **Fix opcja B:** Wywalić scaffold z MCP — to czysty generator, lepiej do CLI/codegen.

### [ ] 21. Redundantny helper `envelope()`
- **Plik:** [src/index.ts:62-66](src/index.ts#L62-L66)
- **Problem:** Większość tool-functions już zwraca `success`. Helper czasem dodaje, czasem nie. Konwencja niepewna.
- **Fix:** Wymusić w typie zwrotnym tool-functions `{ success: boolean, ...}` jako required, wywalić envelope.

---

## 🟢 Nice-to-have

### [ ] 22. `package.json` `engines.node`
- **Fix:** Dodać `"engines": { "node": ">=18.0.0" }` (spawn options, ESM, fetch).

### [ ] 23. Logger naming convention
- **Pliki:** [src/index.ts](src/index.ts) (`build_pc`, `flash_uart`, `idf-monitor`)
- **Problem:** Mix underscore i dash.
- **Fix:** Wybrać jedno (sugestia: dash).

### [ ] 24. `crosspad_build_pc` — wsparcie release mode
- **Plik:** [src/tools/build.ts:54](src/tools/build.ts#L54)
- **Problem:** Hardcoded `-DCMAKE_BUILD_TYPE=Debug`.
- **Fix:** Param `build_type: z.enum(["Debug","Release","RelWithDebInfo"])` default `Debug`.

### [ ] 25. Bardziej "MCP-native" code search
- **Idea:** Zamiast `crosspad_search_symbols` zwracać JSON, eksponować jako `resources` z URI `crosspad://symbols/<repo>/<symbol>` — LLM nawiguje, nie filtruje.

### [ ] 26. HTTP/SSE transport opcjonalnie
- **Plik:** [src/index.ts:626](src/index.ts#L626)
- **Problem:** Tylko stdio. Dla embedded dev OK, ale ogranicza remote dev box.
- **Fix:** CLI flag `--http :PORT` z `HttpServerTransport`. Optional.

---

## TL;DR — Top 5 do naprawy najpierw

1. **`isError: true` flag** na błędach (1-linijka, real spec compliance) → poz. 1.
2. **Tool annotations** (`destructiveHint`/`readOnlyHint`) — natychmiastowy UX win → poz. 3.
3. **Shell injection** — refaktor `runCommand` na spawn z args[] + allow-list dla port/branch → poz. 9, 10.
4. **Konsolidacja** 41 → ~25 tools (input + midi do discriminatedUnion) → poz. 7.
5. **Progress notifications** zamiast logging dla build/test/flash + cancellation → poz. 4, 5.

Reszta to nice-to-have (resources, outputSchema, hardcoded port, env cache TTL).
