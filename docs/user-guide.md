# User guide

## Capture and observation

The plugin snapshots completed OpenCode messages into a redacted local source store. User messages are immediately complete; assistant messages are captured when completed or after the stale-incomplete timeout. Reasoning is omitted by default, memory-tool output is not recursively retained, and ordinary tool output is bounded.

Captured text is cut into fixed durable chunks at the buffer threshold. Automatic model observation waits until the session's total unobserved work reaches the activation threshold, while idle, max-age, startup recovery, and explicit flush safely process smaller sessions. The observer produces structured observations with source ranges. Validation checks source references, attribution, quotations, instruction-like text, scopes, and forgotten-content suppressions before committing anything.

The observer model can be wrong. Confidence is model metadata, not truth. Inspect sources and use review, edit, supersede, or forget.

## Memory tab

The optional desktop fork adds a **Memory** side-panel tab, enabled by default. It embeds `/embed` and follows the active session without reloading the iframe.

The tab provides:

- status (`idle`, `buffering`, `observing`, `reflecting`, `paused`, or `error`) and open-review count;
- unobserved and observation-token gauges, daily model usage, pause/resume;
- current task, suggested next action, and the exact memory block most recently injected;
- session-scoped review items;
- learning reviews due or research conflicts for the project's domain;
- a filterable observation timeline;
- search with retained-source recall;
- **Remember**, **Flush now**, and **Open full dashboard**.

Click **Source** on an observation to navigate to its originating OpenCode message. The bridge accepts only valid session/message IDs, resolves assistant messages to their parent user message, and loads a bounded amount of history. **Quiz me** and conflict actions insert text at the end of the composer; they never replace or submit the draft.

If the tab says the plugin is unavailable or the origin is forbidden, see [Troubleshooting](troubleshooting.md#dashboard-or-memory-tab-unavailable).

## Full dashboard

Open `http://127.0.0.1:4777/app`, or choose **Open full dashboard**.

- **Overview** — service state, connected instances, review count, due learning reviews, recent runs, cost gauges, pause/resume.
- **Timeline** — choose a session; filter by scope, kind, evidence, or status; inspect sources/events/supersession; remember, pin, edit, supersede, recall, or forget.
- **Search** — lexical/hybrid search including superseded history, with paged exact-source recall.
- **Knowledge** — reflected topic notes, generations, approval/rollback, and Markdown vault conflicts.
- **Learning** — workspace concept map, evidence-based level, independent/assisted/incorrect counts, FSRS calendar, and misconceptions.
- **Research** — workspace claims, status, evidence counts, source library, and contested-claim report.
- **Artifacts** — indexed SVG/Mermaid diagrams rendered after sanitization.
- **Review** — approve, edit, or reject proposals; resolve vault conflicts separately.
- **Runs** — operation usage/errors, background jobs, and quarantined-chunk retry.
- **Settings** — safe live configuration, redaction test, backup/restore/export, and active-session flags/forget.

The workspace selector affects workspace views. Learning and research are currently workspace-wide; selecting a project is not a separate learning/research boundary.

## Remember and review

### From chat

Use `/remember <text>` or ask the agent to use `memory_remember`. The tool accepts a kind and `session`, `project`, `workspace`, or `user` scope.

Agent writes:

- may become active only at session/project scope;
- become pending review when they target workspace/user scope;
- also go to review for user-sourced or high-impact kinds and mastery claims;
- refuse instruction-like text without an attributable user source;
- cannot replace workspace/user memories.

### From the dashboard

Choose **Remember…**, enter a memory, select kind and scope, then save. Dashboard writes are attributed to the user and can enter shared scopes directly. They are still redacted, validated, and refused if the target session was forgotten, excluded, or deleted.

Use **Edit** for an in-place user correction. Use **Supersede** when the old statement should remain in lifecycle history but the new statement should replace it. Pinning improves rank and prevents freshness decay.

### Review queue

Review items include:

- observation proposals;
- reflector promotion proposals;
- source-reverted decisions;
- Markdown vault conflicts.

Approve/edit/reject observation proposals deliberately. “Keep my file edit” on a vault conflict imports/sanitizes the external Markdown as an external edit; it is not human approval of the underlying observations. “Overwrite file from memory” replaces the file with the stored topic.

## Search, recall, and source navigation

`memory_search` and dashboard Search return scope-filtered observations. SQLite FTS5 provides BM25 when available; a JavaScript BM25 fallback exists. Optional vectors are blended with text rank when configured.

Recall is an exact view of the **retained, redacted snapshot**, not a fetch from OpenCode's current transcript. It may contain:

- `[REDACTED:…]` markers;
- omission/truncation markers;
- `[forgotten]` parts;
- reverted/removed status.

Recall pages are bounded to 40 messages and 80,000 characters. Use **Load more** or pass `nextCursor` back unchanged to `memory_recall_source`. A directly written memory may have no source. A user-scoped fact can be readable across workspaces while its source remains hidden; workspace source recall stays within the workspace, and project/session source recall stays within the project.

## Learning

Set the project's domain to `learning` for the focused Memory card, though the Learning page remains available for other non-research projects.

Typical flow:

1. Record prior knowledge or a misconception through observation/review or a user dashboard write.
2. Run `/review-due` or open the Learning view.
3. In the embedded tab, choose **Quiz me**. The prompt asks for one question at a time.
4. After the learner answers, the agent may call `learning_record_attempt`.
5. Review/promote agent-observed attempts before they contribute to workspace mastery.

The attempt tool accepts an answer only when at least three words appear in the latest user message. Hints force `independent: false`. Recalled evidence does not create a new attempt. FSRS schedules recall practice; mastery is a separate evidence model:

- `introduced`: concept exists with no qualifying attempts;
- `practicing`: attempts exist;
- `demonstrated`: at least one independent correct attempt;
- `retained`: at least two independent correct attempts on distinct days, spread by at least three days, with no open misconception;
- `needs-retention-check`: demonstrated/retained evidence is older than 45 days.

An explicit mastery assertion always requires human review. Forgetting an attempt rebuilds the card from remaining attempts.

## Research

Set the project domain to `research` for the focused conflict card.

- `research_claim` records an agent-observed claim proposal.
- `research_evidence` links supporting or contradicting evidence to a claim.
- `/claims`, `research_claims`, and `research_conflicts` summarize workspace state.

Claim status is derived from active workspace/user evidence:

- `open`: no linked evidence;
- `supported`: supporting evidence only;
- `refuted`: contradicting evidence only;
- `contested`: both;
- `superseded`: explicitly superseded conclusion.

URLs/DOIs identify sources. Quotations and locators are retained when supplied and validated where applicable. This is an evidence organizer, not a fact checker: an “agent-observed” source or claim is not human-verified.

## Artifacts

The plugin indexes:

- `.svg`, `.mmd`, and `.mermaid` files touched by supported write/edit/patch tools;
- fenced Mermaid/SVG/XML and raw SVG in completed assistant text;
- files explicitly passed to `artifact_register`.

Disk artifacts must resolve inside the current project after symlink/junction resolution, cannot use UNC/device paths, and must be at most 2 MB. Stored render content is capped at 200,000 characters; larger registered files remain listed as “content not retained.” The dashboard sanitizes SVG before displaying it.

## Forget

### Observation forget

Choose **Forget** on a dashboard observation. Similar candidates are shown but remain unchecked. By default the observation is removed while the retained conversation source stays. Select **Also delete the cited conversation parts** only when source erasure is intended; other observations may cite those parts.

A dashboard forget is a confirmed user-global action:

- selected observations and derived/similar suppressed copies are replaced with `[forgotten]`;
- predecessor/condensed relationships, domain records, vectors, snapshots, topics, journey entries, vault output, and FTS are scrubbed as applicable;
- hash/tombstone suppressions remain so observation, reflection, or restore cannot recreate the content;
- exact copies and close suppressed matches can be removed in other projects/workspaces;
- backups are scrubbed asynchronously and retried after failure.

The agent's `memory_forget` is different: it asks through OpenCode permission, is bounded to the current access context, keeps sources, and reports skipped IDs. Calling it with a text query only lists candidates.

### Session forget

Settings → **Forget session** removes observations sourced only from the session, retained source parts, copied fork descendants, artifacts, snapshots, and state. It records a permanent session suppression and marks the session excluded. The session cannot be included again and future writes from it are refused.

There is no supported “unforget.” Restore re-applies live and backup suppressions and therefore does not resurrect forgotten content.

### Erasure limitations

Forget commits a pending WAL-truncation marker and, when backups exist, a pending backup scrub marker. The request normally returns while backup cleanup is still running. Until the WAL checkpoint, vault rewrite, and backup scrub succeed, old bytes may remain in those locations. A running process, filesystem snapshots, external copies, model-provider logs, and previously exported JSON are outside this mechanism.

See [Security and privacy](architecture-security.md#security-and-privacy-invariants).

## Backup, restore, and export

Settings → **Create backup** creates a marked SQLite snapshot in `<dataDir>/backups` and applies retention. Daily backups are enabled by default.

**Restore** accepts only a file currently listed by the service, requires confirmation, and refuses missing/empty files, non-memory databases, unsupported/newer schemas, unmarked files, and snapshots with no sessions/observations/topics. Restore is logical and leaves the live database untouched on refusal. Live plus backup suppressions are merged and re-applied, running work is reset, FTS is rebuilt, vectors are pruned, and pending vault removals are preserved.

**Export JSON** downloads observations whose status is neither `forgotten` nor `rejected`—including superseded or pending rows—plus topics, journey, concepts, claims, sources, and artifact metadata. It is a data export, not a restorable backup, and it is not scrubbed after a later forget. Store exports accordingly.
