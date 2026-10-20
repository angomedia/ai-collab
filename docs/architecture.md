# How AI Collab works

`src/main/cli.mjs` locates the CLIs, checks their login status, starts isolated child processes, parses their JSON streams, and terminates process groups on cancellation. Public assistant text is displayed; private reasoning events are excluded.

`src/main/orchestrator.mjs` owns the conversation and its question history. Each question begins with a moderator planning call that produces a refined question and two distinct role assignments. The moderator is a separate logical participant using the Codex transport and an explicit model, defaulting to `gpt-6-sol`; it does not require a third login.

Moderator planning and judgment use Codex's [schema-constrained output](https://learn.chatgpt.com/docs/non-interactive-mode#create-structured-outputs-with-a-schema). The adapter writes a private temporary schema, reads the final response separately from any progress messages, and removes the schema after the call. App validation still checks distinct perspectives, candidate versions, and review validity. A repair attempt receives the specific validation problem; invalid responses never become plans or approvals.

Codex proposes an answer, Claude responds, and Codex prepares the first candidate. Both debaters independently review that exact candidate version, then the moderator adjudicates it. Successive revisions alternate between the debaters and require fresh reviews and judgment. Valid moderator finalization ends the question; consensus is recorded only when both reviews also approve the exact finalized draft. Invalid or mismatched structured responses cannot establish approval or a decision. Interrupted drafts retain explicit review and approval status.

Follow-ups reuse the same conversation ID and append a new question and moderator plan. Every provider call receives the accumulated public conversation and source text. The app keeps earlier plans, roles, and answers intact and records the models and outcome for each question.

`src/main/models.mjs` discovers model choices through the installed CLIs and caches the catalog. `src/main/attachments.mjs` validates and stores imported documents. macOS PDF extraction and OCR use a bundled native helper. Windows PDF text, DOCX, and RTF extraction run in a bounded worker. Excel is also parsed in a worker with resource limits. Extracted documents are supplied as quoted source material to both assistants throughout the debate.

`src/main/main.mjs` owns the native window, local history, exports, and a narrow IPC bridge. The renderer is sandboxed with Node integration off and a restrictive content security policy. Model responses are rendered as text with a small Markdown formatter; raw HTML is never executed.

The renderer lives in `src/renderer/`. There is no frontend build step and no remote CDN dependency.
