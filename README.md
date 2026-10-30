# tq

**Ask a TypeScript project about a symbol, and get back only what answers it.**

tq is a CLI for coding agents. Instead of grepping for a name and then reading whole files, an agent asks about one symbol and gets back the signature, the body, the types it uses, every caller with the types of the arguments it passes, and where the tests are, in one answer of about a thousand tokens. It runs the TypeScript Language Service over your project's own `tsconfig.json`, so the answers come from the type checker, not from text matching.

> [!NOTE]
> tq is a prototype. It works well on the project it was built against, and the limits below are real.

## Why

**Agents read too much.** To change one function, an agent greps for its name, then reads the file it is defined in and every file that calls it. Most of those lines answer nothing. On [dek](https://github.com/hajimism/dek), finding out what a change to `asResolvedDeck` touches costs about 27,000 tokens the usual way, and 463 with `tq context`.

**Text search guesses.** grep cannot tell a call from a comment, a local function with the same name, or a name in a string, and it misses calls split across lines. tq asks the type checker, follows dynamic `import()`, and tells calls apart from other references, such as a function passed as a callback.

**A question deserves one answer.** "What do I need to change this?" is one question, so `tq context` answers it in one call, within a token budget, with production callers and test callers kept apart. When a name matches more than one symbol, tq lists them instead of guessing.

## Quick start

Requires [Bun](https://bun.sh) 1.4 or later.

```bash
git clone https://github.com/hajimism/tq
cd tq
bun install
bun link            # puts `tq` on your PATH
```

Then, from the root of any TypeScript project:

```bash
tq context renderSlideHtml
```

The first query starts a background process that loads the project, which takes 3 to 4 seconds on a project of 450 files. Every query after that takes 0.1 to 0.3 seconds.

## Commands

```
tq find <name>                   find symbols by part of their name
tq outline <file>                declarations in a file, without bodies
tq sig <symbol>                  signature, JSDoc, and where its types are
tq body <symbol>                 just the body, with line numbers
tq callers <symbol> [--all] [--tests] [--limit N]
                                 call sites, the function around each, and the types passed in
tq context <symbol> [--budget N] what you need to change it, within a budget (default 1500 tokens)
tq stats [--days N]              usage summary
tq daemon status|stop            show or stop the background process
```

A `<symbol>` is a name, `Class.method`, or `path#Name`. A function defined inside another function is `outer.inner`. Its bare name works too, unless a top-level declaration has the same name, which then wins. Give several symbols to answer them all at once: `tq callers a b c`.

| Option | |
|---|---|
| `--project <dir>` | the project to load (default: the current directory). tq reads its `tsconfig.json` as is |
| `--no-daemon` | skip the background process and load the project for this one query |
| `TQ_VERBOSE=1` | print timing lines to stderr. Otherwise only the answer goes to stdout |

## What an answer looks like

`tq context renderSlideHtml`, run in dek and shortened:

```
# src/core/still-page.ts#renderSlideHtml  src/core/still-page.ts:42-70
/**
 * One slide alone on a page, held at `beatIndex`, as shots and visual lint measure it. ...
 */
export function renderSlideHtml(sources: SlideSources, slug: string, beatIndex: number): string

## Body
...

## Types
// src/core/still-page.ts:16-23
export type SlideSources = { deck: ProjectDeck; styles: DeckStyles; ... };
// renderSlideHtml reads deck, slides, scripts, strict, styles

## Callers (3)
src/core/pptx.ts:52  in pptxDeck  │ renderSlideHtml(sources, section.slug, lastStop(section.beats))  ← sources: SlideSources, section.slug: string
src/core/shot/still.ts:138  in still  │ renderSlideHtml(sources, section.slug, beatIndex)  ← sources: SlideSources, ...
src/core/visual.ts:228  in visualPages  │ renderSlideHtml(sources, section.slug, beatIndex)  ← sources: SlideSources, ...

## May need changes too
renderPdfHtml  src/core/pdf.ts:45-71  — also calls stampSlide, slidePlace, stepValuesForBeat, ...

## From tests (17 calls in 3 files)
tests/core/html.test.ts: 648, 669, 682, 722, 766, 768, 796, 824, 845, 979
...

## Calls out to
requireSection  src/core/resolve.ts:82-95
stampSlide  src/core/html.ts:185-242
...
```

The signature and the JSDoc come first, then the body if it fits the budget, then the types it takes along with which of their fields it actually reads, the callers with the argument types at each call, functions that share its dependencies, test locations, and what it calls. Whatever does not fit is named, with the command that shows it.

## Working with an agent

Add something like this to the target project's `AGENTS.md` or `CLAUDE.md`:

```markdown
## Looking at code

Before Read or grep on TypeScript, use `tq` (`tq --help` lists the commands).

- Before you change a function: `tq context <symbol>`. It gives the signature, the body if it is short,
  the types it uses, its callers and the argument types they pass, functions you may need to change with it,
  and where its tests are.
- To find who calls something: `tq callers <symbol>`. Calls through a dynamic `import()` are included.
  Even when there are no calls, read "Other references": a function passed as a callback shows up there.
  tq cannot see calls from code written inside a string, such as a template string sent to the browser,
  so check those with grep.
- To see a file or a class as a whole: `tq outline <file>`, or `tq context <Class>` for how its methods call each other.
- To read one function: `tq body <symbol>`, with line numbers.
- For the signature and types only: `tq sig <symbol>`. When `tq context` leaves out a long type, it points here.
- "Not found" does not mean the name does not exist. tq does not index object properties,
  variables inside functions other than functions, or code inside strings. Check those with grep.

For a small file you need as a whole, and for files that are not TypeScript, use Read as before.
```

After a trial, `tq stats --days 14` shows how often each command ran, the average output size and time, how often tq had to ask which symbol was meant, and the symbols asked about most. The raw record is `~/.cache/tq/usage.jsonl`, one JSON line per query. It cannot tell you what the agent would have read without tq. For that, run the same task with and without it and compare.

## How it works

```
tq.ts (client) ──Unix socket──→ server.ts (daemon, one per project) ──→ engine.ts (TypeScript Language Service)
```

- **Daemon.** The first query starts it, and it keeps the project loaded. It exits after 30 minutes without a query.
- **Staying current.** On every query it checks each file's modification time and reloads only what changed, including added and deleted files.
- **Updating tq.** When tq's own code changes, a daemon running the old code exits, and the next query starts a new one.
- **Fallback.** If the daemon cannot be reached within 20 seconds, the client loads the project itself and answers.
- **Concurrency.** The daemon answers one query at a time. If two clients start daemons at once, a lock file lets only one stay.
- **Recovery.** A daemon whose socket disappears exits within 5 seconds, to make room for the next.

| What | Where |
|---|---|
| Socket | `$TMPDIR/tq-<hash of the project root>.sock` |
| Daemon log | `~/.cache/tq/daemon.log` |
| Usage record | `~/.cache/tq/usage.jsonl` (command, symbols, output tokens, time, exit code) |

## Measurements

Run at the root of [dek](https://github.com/hajimism/dek) (450 files) with `measure.sh`. Units are tokens, estimated as bytes / 4. The times were taken before the daemon existed, when every query loaded the project.

| Symbol | grep + definition file | + caller files | `tq context` | tq time | Files involved |
|---|---:|---:|---:|---:|---:|
| lintVisualDeck | 7,776 | 11,270 | 620 | 1.3 s | 3 |
| renderSlideHtml | 1,318 | 11,149 | 871 | 1.3 s | 4 |
| asResolvedDeck | 2,376 | 27,432 | 463 | 1.2 s | 13 |
| lintDeck | 5,688 | 9,296 | 1,134 | 1.4 s | 5 |
| SheetReader (class) | 4,830 | 4,830 | 732 | 1.3 s | 1 |

The baseline assumes an agent greps, then reads the definition file and every caller file whole. An experienced agent sometimes reads only the lines it needs, so the real gap can be smaller. On the other hand, the baseline leaves out type files, test files, and the line-number prefixes Read adds.

### Missed callers

For all 688 exported functions in dek, the number of calls `tq callers` reports was compared with a count from grep. 637 matched. Of the 8 where tq reported fewer:

- 5 were grep's false positives: a local function with the same name, a comment, a method declaration, a name in a string literal.
- **3 were real calls that tq cannot see**: calls inside code embedded as a template string and run in the browser or a child process (`withDeckPrefix` and `liveTokenQuery` in `src/runtime/live-reload.ts:11-12`, and `runPiped`, which a test passes to a child process).

Where tq reported more, grep had missed calls written in ways it cannot match, such as `...fn(` spreads and calls split across lines. Every one checked by hand was right.

## Known limits

- Calls through callbacks, dependency injection, or `any` are not classified as calls. They appear under "Other references".
- The index holds top-level declarations, class members, and functions defined inside functions. Methods in object literals and non-function variables inside functions are not indexed.
- Calls from code embedded in strings are invisible.
- Re-exports through barrel files and project references are untested.
- The order in which `context` fills its budget is fixed.
- Argument types go back one caller only. Following them through pass-through layers (`trace`) and writing changes (`replace`) are not implemented.
- The daemon holds the whole project and its type checker in memory: about 770 MB RSS on dek. Each project you use at the same time adds its own.

## Related tools

There are many tools in this space: CodeGraph, budget-aware-mcp, ts-language-mcp, Serena, and the LSP tool in Claude Code. tq differs in how it shapes the answer: one answer per question, production and test callers kept apart, calls followed through dynamic `import()`, and the argument types and the fields actually read shown at each call.

## Development

```bash
bun install
bun run typecheck
```

TypeScript is pinned to **5.x**. TypeScript 7 is native and does not offer the JavaScript Compiler API (`createLanguageService`) that tq is built on.

## License

MIT
