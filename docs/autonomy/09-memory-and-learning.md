# A09 — Project memory, decision provenance, and useful learning

Status: planned. Completion prerequisites: A01 and A05. Read [the overall plan](README.md) first.

## Outcome

Manager and workers retrieve relevant, current project knowledge and prior lessons without confusing it with authoritative execution state. Memory must improve measured outcomes, not merely grow.

Inspect `packages/storage/src/memory.ts`, `lessons.ts`, `lesson-scope.ts`, `packages/memory`, `packages/context`, and `apps/controller/src/lessons.ts`. Preserve accepted/proposed distinctions, repository scope, freshness checks, host-written lesson evidence, forgetting, and caps already implemented.

## Execution

1. Define project decision records: decision, rationale, alternatives, source/actor, requirement links, accepted status, relevant revisions, and supersession. Connect unresolved questions to explicit blockers.
2. Distinguish operational truth (workflow database), accepted knowledge, worker proposals, and inferred lessons. A summary or retrieved passage must never mark a task complete.
3. Build bounded manager/worker retrieval by project, requirement, task, and current revision. Preserve provenance and mark stale or unverified material clearly; exclude it where policy requires accepted fresh evidence.
4. Invalidate or reevaluate knowledge after relevant code, requirements, or architecture changes. Preserve historical decisions for audit without presenting them as current instructions.
5. Ensure external runtime search tools remain task-scoped and receipted. Restrict access using host-selected scope and execution capabilities.
6. Add retention, forgetting, export/import, and sensitive-data handling for the expanded records. Imported records become proposals unless separately accepted by an authorized actor.
7. Instrument lesson usage and outcomes with exposure, verification quality, and task/context identifiers. Treat prompted memory as an experimental input, not proof that learning helped.

## Success criteria

- **A09-C1:** Cross-project, rejected, forgotten, and ineligible stale knowledge cannot enter an authorized task packet.
- **A09-C2:** A manager restart reconstructs decisions from persisted records without relying on its old conversation.
- **A09-C3:** Worker-authored memory cannot change permissions, budgets, verification policy, or authoritative task state.
- **A09-C4:** Changed code/requirements invalidate affected knowledge according to tested rules.
- **A09-C5:** Import/export preserves provenance and does not silently grant accepted status.
- **A09-C6:** Retrieval is bounded by documented size/latency targets on a representative retained corpus.
- **A09-C7:** The qualification harness can compare memory/lessons enabled versus disabled with controlled task allocation and separate stores.

## Validation and latitude

Test a poisoned lesson, forged instruction, stale file anchor, origin/scope collision attempt, superseded decision, and forgotten record. Run a measured retrieval fixture and provide experiment-ready exposure data. A11 evaluates whether memory actually helps; do not claim efficacy from a few successful repairs.

Choose ranking, summarization, or indexing improvements using measured retrieval needs. Do not add a vector database simply to make memory appear sophisticated. Summarization must preserve required facts or explicitly report inability to fit them.

## Deliverables and handoff

Decision schema, retrieval/freshness changes, access/retention controls, instrumentation, and evidence. Document source-of-truth boundaries for A05 and experiment configuration for A11.
