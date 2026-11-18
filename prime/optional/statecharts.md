# Statecharts as a reading view

Use a statechart when requested or when states, event ordering, failure or recovery
are central to understanding a change. It is a view within the current task, not
another activity. A simple change may need only prose or the original diff.
The current agent creates the chart; columbo does not extract or verify it.

## When to generate (and when TLA+ is not needed)

You do **not** need TLA+, TLC, or Quint installed to generate a useful statechart.
Most code-reading and diff-review questions ask what transitions exist, what
changed, and where failure paths are missing — an **Implementation-traced** or
**Proposed** Mermaid chart answers those directly from source and diff evidence.

Generate a statechart when the code or diff touches one or more of:

- Explicit lifecycle states, enums, phases, or status transitions.
- Retries, backoff, timeouts, deadlines, cancellation, or abort handling.
- Concurrency, locks, atomic compare/publish steps, or ordering hazards.
- Multi-step persistence, error recovery, fallback, or partial-failure cleanup.

Skip a statechart when a change is purely cosmetic, static configuration, a
single-branch helper, or easier to read in the original diff or a small call tree.

## State the evidence

Label each chart with one of these meanings. Split mixed evidence into separate
charts or explicitly label the uncertain transitions.

| Label | Required evidence |
|---|---|
| Proposed | Intended behavior from the request and stated assumptions; unresolved design choices remain questions. |
| Implementation-traced | Transitions traced to current source or diff, with snapshot, path/line references and inspection gaps. This does not mean the behavior was executed or model-checked. |
| Model-checked | Named properties checked by an actual tool run (such as TLC or Quint) on an identified model, with result, tool/version, command, bounds and assumptions. State separately whether the model was reconciled with the implementation. |

A drawn chart is not model checking. A passing model does not establish that the
specification matches human intent or that the whole implementation is correct.
An unchecked or incomplete run stays unverified. Report violated and unchecked
properties explicitly; a model-checked label does not mean every property passed.

## Build the smallest useful view

1. State the question the reader needs to judge, scope and evidence label. For
   implemented behavior record HEAD and dirty/untracked scope. For a comparison,
   identify both versions; do not invent the old behavior from the new code.
2. Name **2–4 invariants** first — the rules that must never break (for example,
   *a cancelled job cannot emit a final write*, or *a stale snapshot cannot
   overwrite newer state*). Naming invariants before drawing keeps the chart
   focused on decisions that matter.
3. Identify user-visible states, events, guards and effects. Follow relevant
   callers and persistence boundaries. Include failure, retry, cancellation,
   timeout, recovery and concurrency when they affect the question. If their
   behavior is unknown, label those edges **unknown / unchecked** rather than
   drawing an assumed happy path.
4. Render a small Mermaid `stateDiagram-v2` with plain-language labels and event
   names. Aim for about 20 arrows or fewer; split complex concerns into focused
   charts. Use parallel regions only when supported by the behavior. A chart
   should expose important ordering rather than falsely serialize concurrency.
5. For a change (diff), include a compact **Transition delta** listing which
   transitions were **Added**, **Removed**, **Modified**, or left **Unknown**,
   and explain what decision they expose. Keep the original diff available.
6. Walk through at least one **Failure / counterexample trace** — a short 3–5
   step event sequence showing how failure, retry, or cancellation plays out
   (either a real counterexample from a checker if `Model-checked`, or a
   source-traced scenario if `Implementation-traced`).
7. Beside the chart, map consequential transitions to source references or design
   requirements and relevant tests. State which checks actually ran. Include
   omitted behavior, environment assumptions and abstraction choices. Do not
   merge states when that would hide a violation or a consequential distinction.

Return the chart in a Mermaid code block with its invariants, transition delta
(for diffs), failure walkthrough, evidence references, omissions and any open
intent question. If rendering is unavailable, leave readable Mermaid plus a
plain-language transition summary. Do not install a renderer just to draw a
chart. Save an artifact only when useful or requested; keep temporary artifacts
outside the reviewed diff. Refresh stale charts after relevant edits and include
artifact/evidence paths in requested handoffs.

## When model checking adds value

Use available specialist verification guidance (such as `pstack`'s `statechart`
or formal-verification skills) when requested or justified by consequential
state ordering, concurrency, or retry/persistence races. Choose properties from
the intended behavior, not from whatever the current implementation happens to
satisfy. Keep the model small and tie actions, atomicity and assumptions to code.
Types and lint rules, empirical tests and formal checks provide different
evidence; retain relevant checks instead of replacing them with the model result.

If a checker finds a counterexample, explain it as a short sequence of events
and attempt to reproduce it against the real implementation. Until that link is
established, report a model violation rather than a demonstrated product bug.
Do not weaken a property merely to obtain a passing result. For maintained
verification, demonstrate that an intentionally broken variant is detected in
an isolated scratch copy, and record covered code and the last reconciled
snapshot. Never modify the user's working changes for a mutation experiment.

Optional verification tools are not bundled or required. If requested checking
is unavailable, provide the proposed or implementation-traced chart, explain the
missing verification and do not claim a model-checked result. Loading this guide
does not authorize installation, remote uploads or additional agent processes.
