# Licenses & certifications

## Purpose and user work
This is an operational renewal register for company and individual credentials. Users need to notice expiry risk, locate a license, update renewal details, keep supporting documents together, and maintain the recipients who receive reminders. Administrators can run the existing reminder delivery action.

## Information priority
1. Overdue credentials and renewals in the next 60 days.
2. Full entity name, credential type, license identifier, expiration date and days remaining.
3. State, reminder state and recipients, document availability and renewal notes.

## Organization
An action bar introduces the renewal workspace with Add license as the primary action. A compact upcoming renewal agenda uses normal-flow cards instead of absolutely positioned flags: multiple credentials expiring together cannot collide. An overdue control takes users directly to the expired filter. The register follows with six explicit status filters, search and attribute filters. Entity names lead each record; expiry and reminder state remain visible. At phone sizes records stack into labeled cards without removing fields.

The editor groups credential identity, validity dates, email reminders, and supporting notes/documents. Its live expiry preview remains at the top and its save/cancel actions remain pinned. Existing Radix dialog accessibility and destructive confirmation are retained. Long entity names, license numbers, recipient addresses and attachment filenames wrap.

## Design system application
Use the master cool-white/graphite surfaces and cobalt selection; meaningful rose/sage statuses retain icon and text. Restrained translucent section chrome surrounds opaque readable data. Keep 14px working copy, 12px metadata and 44px phone targets. Use 140ms color feedback and 260ms entrance opacity/translation, respecting reduced motion.

The ui-ux-pro-max search verified Minimalism / Swiss style as appropriate for enterprise tools. Its generic marketing hero suggestion is inapplicable to this register. Existing React controlled form patterns and shared Geist/Lucide components remain authoritative.

## Preservation contract
All fetches, mutations, file operations, reminder execution, permissions, expiry calculations, band definitions, search criteria and sorting remain unchanged. Changes are restricted to presentation and local UI controls.

## Approved renewal-register simplification (2026-09-12)
- Removed the duplicated upcoming-renewal card agenda. One urgency-ordered register now leads, with compact status/count filters, search, type and state controls.
- Original urgency bands, expiry ordering, filtering, reminders, attachments, edit dialog and all callbacks are preserved.
- Desktop filter controls measured 36px (formerly 82px); short records approximately 53px. Phone records use a labeled two-column grid with full-width holder and expiry-status context.
