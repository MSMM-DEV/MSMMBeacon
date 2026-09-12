# Admin workspace

## Purpose and priorities
Admins maintain teammate access, inspect notification delivery, and configure shared invoice settings. Appearance is personal rather than workspace-wide. The most important roster data is the complete person identity, email, role and access state; alert operators need schedule, subject, recipient list and delivery history together.

## Page-specific organization
- Keep a steady-width settings workspace so changing sections does not move the close control or resize the whole sheet.
- Four clearly named sections retain their current behavior. A contextual introduction explains what changes are shared versus personal.
- People: searchable register, one primary Add user action, visible Manage menu per person. Full names and addresses wrap; phone layouts become labeled records.
- Alerts: delivery health first, filters/refresh/manual dispatch next, then readable subject-led cards. Pause/resume and recipient editing are labeled. Expand the subject to see all recipients and delivery history; deletion stays visually subordinate.
- Billing: configure actuals cutover and benchmark before the manual reminder action. Existing values, draft previews, validation and saves stay unchanged.
- Forms: grouped identity/access sections, clear cancel/submit action rows, readable destructive confirmations. Glass is restricted to supporting chrome; working data is opaque.

## Boundaries and verification
UI only. Preserve all admin actions, permissions, lifecycle rules, data reads/writes, calculations and polling. Use shared semantic colors in both themes. Follow UI-UX-Pro-Max long-token wrapping guidance with shrinkable content and overflow-wrap:anywhere; respect reduced motion and touch targets. Parent performs integrated browser checks; this owner checks JSX/CSS syntax and scope.
