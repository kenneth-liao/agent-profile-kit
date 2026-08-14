---
status: accepted
---

# Qualify invocation-scoped reuse, bounded concurrency, typed impacts, and scale-aware presentation

## Context

The fleet-wide synchronization work (spec #193) replaced per-Project repetition
with one invocation-scoped lifecycle: shared Workspace facts resolve once per
command, independent Project reads run with fixed bounded concurrency, apply
still proves post-commit state freshly, reconciliation emits typed lifecycle
impacts, and human reports become scale-aware and change-first. Each mechanism
was accepted and delivered on its own ticket; this ADR records the boundary
architecture the qualification now proves together (ticket #205): which facts
may be trusted within one invocation, which work may overlap, how change cause
is proven, and how concise reports disclose impact.

## Decision

### Invocation-scoped cache trust boundaries

One lifecycle command creates one invocation-scoped planning context, one Git
inspection context, and one ownership inspection context per pass. Within that
command only, each context is the single reader for its reusable facts, and
call sites must not add local memoization or fallback readers.

- **Reusable within one invocation:** Workspace ingestion, resolved Profiles,
  artifact fingerprints and workspace input hashes, portable Skill package
  source, composed Context, Host projections whose complete normalized inputs
  match, machine-level Host executable/version evidence, per-Project Git
  topology, batched tracked-path classifications, Repository Exclusion target
  snapshots, Installation Marker evidence, and owned-output inspections.
- **Never reused across passes where freshness is the contract:** apply creates
  fresh Git and ownership inspection contexts for preflight and post-commit
  verification, so pre-write filesystem evidence can neither prove post-write
  state nor authorize removal. A fresh-install pass has no owned outputs to
  prove; a steady-state pass inspects each owned output at most once.
- **Never persisted:** contexts are discarded when the command exits. There is
  no persistent cache, daemon, watcher, or cross-command memoization, so
  Workspace, Host, Git, and project facts cannot become stale second sources of
  truth.
- **Cache keys are complete trusted inputs:** Profile resolution and Host
  projection reuse require identical normalized inputs (including Project-
  relative Codex Context paths, Adapter capability contracts, and projection
  options). A path proven against a different expected hash, mode, or member
  tree always re-inspects.

### Bounded read concurrency, sequential mutation

Independent read-only Project planning and inspection run through one shared
invocation-scoped scheduler with a fixed product-policy concurrency bound
(currently four). The scheduler is a pure executor holding no Project, Git, or
filesystem evidence, so one instance spans desired-state planning,
reconciliation, and apply's preflight and post-commit verification without
leaking facts between passes. Concurrent results are folded and sorted by
canonical Project, so scheduling order is never observable in human or machine
output. Installation State publication, Project writes, Repository Exclusion
publication, commit sequencing, stale removals, rollback, and failure recovery
remain ordered and never pass through the scheduler; a read failure propagates
while global blockers still prevent any write.

### Typed lifecycle impact taxonomy and provenance

Reconciliation derives one typed lifecycle impact per Project and proven cause
by comparing current desired state against the prior Apply Receipt's
provenance (`installer/impacts.ts`). The taxonomy distinguishes Workspace
Skill/Context additions, updates, and removals (with the complete proven source
set), Project Binding/Host selection changes, Adapter/capability changes,
repairs and installation removals, receipt metadata-only changes, and
unclassified exact generated-path changes. Artifact identity and cause are
proven by normalized fingerprints and typed output origins recorded at the
Workspace/planning boundary and persisted on the Installation Manifest (schema
v3); cause is never inferred from generated path naming, and legacy receipts
without provenance fall back to exact generated paths. Preview, the apply
receipt, and the verified resulting state all derive impacts through this same
canonical comparison.

### Progressive-disclosure presentation policy

Default lifecycle presentation is scale-aware: a single-Project run keeps the
recognizable Project-first detail, while an unblocked run whose typed impacts
span more than one Project derives one impact-first view from the same impact
model. Shared Workspace changes render once per change kind, proven source
identity, Profile, and Host scope (a Host clause disambiguates only where
output differs by Host); distinct Project Binding and Adapter changes stay in a
Project section; and member-level attention that typed impacts do not carry
remains visible as Project exceptions. Group lines carry generated-file totals
and a progressive affected-Project scope: complete short lists when small, a
count when every Project of the scope is affected, or a capped representative
list with an explicit `--verbose` pointer to every Project. Successful
summaries omit zero-value clauses, identical next actions and readiness collapse
once per Host scope, blocked reports stay blocker-first, and `--verbose` plus
the versioned JSON retain the complete per-Project and per-path evidence.
Concise grouping is additive presentation, never evidence deletion.

### Structural qualification, not timing gates

Deterministic operation instrumentation (`installer/qualification-instrumentation.ts`)
counts real cache-miss work per invocation so the budgets above are enforced
structurally: unique Profiles resolve, fingerprint, compose, and read once;
Host projections and probes scale with unique Host/topology keys; Git topology
and batched index queries scale with Projects and Git roots; and each owned
output and Marker is inspected once per reconciliation pass. Warm-run
benchmarks (`installer/benchmark.ts`) record representative `status`, `preview`,
and `apply` samples against the isolated 12-Project qualification fixture as
release evidence, explicitly not as hardware-dependent CI thresholds.

## Consequences

- A new lifecycle consumer cannot add a second reader for a reusable fact:
  reuse is available only through the invocation-scoped contexts.
- Adding Projects, Hosts, or generated outputs cannot reintroduce per-Project
  repetition in planning, inspection, or default presentation; future artifact
  growth cannot silently restore the latency problem without violating the
  structural budgets the qualification enforces.
- Concurrency cannot weaken mutation safety: reads may overlap, writes and
  publication never do, and apply's post-commit verification remains a fresh
  proof of resulting state.
- Human presentation never invents a fact the engine did not prove: a Skill is
  named only when its change is proven by fingerprints and output origins, and
  full evidence remains available under `--verbose` and versioned JSON.
- ADR-0010 (global reconciliation through Project Bindings), ADR-0012
  (Host-native discovery, precedence, and resolution stay delegated to Hosts),
  ADR-0014 (user-facing language, `apkit`, `--json`, uniform exit codes), and
  ADR-0016 (one terminal-presentation boundary) remain in force; this ADR
  records the boundaries they rely on rather than rewriting them.
