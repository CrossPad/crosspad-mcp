# Where does a new fact belong?

This project's Claude Code setup already keeps rich per-project local
memory (the `superpowers` plugin's `feedback_*.md` / `project_*.md` /
`reference_*.md` notes under `~/.claude/projects/<project path>/memory/`).
That's genuinely valuable — real hard-won debugging results accumulate
there automatically — but it's keyed to the literal directory a session was
launched from, so a note written while working in `CrossPad_STM32_r20`
is invisible to a session in `ESP32-S3`, is not in git, and won't exist on
another machine or for anyone else. Several `CLAUDE.md` files in this
ecosystem used to reference notes that only existed in that local memory —
dead references from the repo's point of view. If you're that deep in a
debugging session, keep letting local memory capture it; that's fine. The
question this file answers is: **once something turns out to matter beyond
the session that found it, where should it actually live?**

- **True for this machine/person regardless of project** (personal tooling,
  shell setup) → the global `~/.claude/CLAUDE.md`. Keep it short.
- **Stable and specific to one repo** — would help *any* future session in
  that repo, including a fresh clone or another machine → that repo's own
  `CLAUDE.md`, or a doc it points to (e.g. `docs/gotchas.md`,
  `docs/superpowers/specs/`). This is the promotion step that's easy to
  skip — a local note that's survived a few sessions without being
  contradicted is a good candidate to promote, not leave sitting in local
  memory indefinitely.
- **True across the whole CrossPad ecosystem** (crosspad-mcp's own
  behavior/config, the STM32↔ESP32 hardware contract, a tool gotcha that
  isn't specific to one repo) → **this skill** (`reference/faq.md`,
  `reference/repos.md`, `reference/role-*.md`, or this file), since it
  ships with `crosspad-mcp` and installs automatically for anyone who
  installs the plugin — the only tier in this list that reaches a new
  machine or collaborator without them separately discovering a repo's docs.
  Don't leave an ecosystem-wide fact sitting in one repo's `CLAUDE.md`
  "because that's where it was found" — that's the same locality mistake
  as local session memory, just one level up. Several genuine tool gotchas
  (the `npx` connection crash, `crosspad-core`'s triple checkout, the
  stale-`dist` false alarm) were diagnosed once, recorded only in one local
  session's memory, and then silently didn't apply anywhere else — that's
  the failure mode this tier exists to prevent.

If you're an agent working in this ecosystem and you just resolved
something non-obvious: before the session ends, ask whether the fix belongs
in the code, in a repo's `CLAUDE.md`, or here — not just in whatever
transient note-taking already caught it automatically.
