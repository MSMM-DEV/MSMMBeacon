# In-Between — paused billing review

## Purpose and user needs

This is a holding area for paused invoice projects, not completed work or deleted records. PMs and billing staff need to review existing billing details, decide when a project can resume, or close it out. Monthly amounts, firms, payments, files and notes remain editable through the existing ledger.

## Information and action priorities

1. Establish that the project is on hold and its billing information remains available.
2. Keep the existing search, period selection and ledger immediately accessible.
3. Explain the distinct row actions: review the breakdown, Resume to return to Invoices, or Close out to finish the project.
4. Preserve the existing empty and filtered-empty states, figures, exports, permissions, handlers and invoice editing surface.

## Page-specific composition

A compact frosted context strip sits above the solid billing ledger. Its short on-hold explanation remains visible. Secondary workflow guidance lives in a keyboard-operable native disclosure so experienced users do not scroll past another decorative dashboard. The disclosure opens in normal flow, never over the table or its controls. At phone sizes the strip stacks and the guidance becomes a one-column list. All copy wraps naturally.

Use the shared cool white/graphite, cobalt, spacing and motion tokens. No new metrics or calculations are introduced. The shared InvoiceTable continues to own all data and row operations. UI-UX-Pro-Max's visual hierarchy, primary-action and content-priority principles guide this composition; focused disclosure searches returned no relevant verified match, so the native HTML disclosure choice uses general web accessibility guidance.

## Verification

Check App JSX syntax, CSS syntax, scoped diff and unchanged InvoiceTable props locally. Parent handles integrated desktop/mobile and light/dark browser checks; do not exercise live mutation controls during visual QA.
