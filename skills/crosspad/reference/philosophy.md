# CrossPad philosophy — why the ecosystem is shaped this way

These principles are load-bearing: most architectural review comments and
"where does this code go?" decisions trace back to one of them.

## Write once, run everywhere

The same core logic runs on ESP32-S3 hardware, Arduino builds, and the desktop
simulator. Platform differences hide behind **thin abstraction layers**
(`IEventBus`, `IPadLogicHandler`, `IClock`, `ILedStrip`, …), not thick
frameworks. Business logic must never know what chip it's running on.

**In practice:** apps depend on crosspad-core interfaces only — never on
ESP-IDF, Arduino, or SDL APIs directly. If an app needs something
platform-specific, the platform gets a new interface implementation; the app
stays portable.

## Platform repos are thin, shared repos are thick

Platform repositories (platform-idf, ESP32-S3, crosspad-pc) contain only what
cannot be shared: hardware drivers, HAL bindings, build glue. All business
logic belongs in **crosspad-core**; all UI components in **crosspad-gui**.

**Litmus test:** if the code you're writing could work on another platform,
it does not belong in a platform repo. "Code that exists in two places will
eventually exist in one."

## Hardware is software you can touch

Hardware and software are designed as one system. The pad grid, encoder, and
LED strip are first-class citizens with well-defined interfaces. If you can
simulate it on the PC, you can ship it on the board — which is why the PC
simulator is the primary dev loop and HIL tests close the gap
(`reference/hil-testing.md`).

## Small team, big surface area

A feature, not a limitation. Every architectural decision reduces maintenance
burden: shared init sequences, one event bus, portable abstractions,
auto-registration (`REGISTER_APP`) over manual wiring. Long-term solutions
beat quick hacks even when they cost more upfront.

## Open by default

Schematics, firmware, PC tools, docs — all open source. A music controller you
can't modify isn't yours. People are expected to fork, adapt, and build things
the team never imagined — the app registry and template exist for exactly that.

## Community-driven, not committee-driven

Contributions welcome, but the project ships fast. Clear architecture and good
docs lower the entry barrier: nobody should need to read the whole codebase to
add an app or write a platform driver.

## Documentation is not an afterthought

If it's not documented, it doesn't exist. API references, architecture guides,
and build instructions ship *with* the code. (This skill is part of that
contract — when you learn something non-obvious, `reference/memory.md` says
where to record it.)
