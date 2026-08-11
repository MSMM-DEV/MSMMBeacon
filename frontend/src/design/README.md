# Beacon Design System (ui-v2.0)

Read this before changing any UI in `frontend/src`. It is the contract that
keeps twelve independently-redesigned pages looking like one product.

---

## 1. Hard rules

1. **UI and UX only.** Do not change behaviour, data, business logic, API
   calls, Supabase queries, permissions, workflows, calculations, state
   shape, prop contracts, or feature behaviour. Same props in, same effects
   out. If a redesign seems to require a logic change, redesign differently.
2. **Do not touch the Invoice page.** Off limits: `InvoiceTable` and the
   modals between it and `EventsTable` in `tables.jsx`, plus
   `invoice-charts.jsx`, `invoice-links.jsx`, `invoice-notes-thread.jsx`,
   `invoice-perspectives.js`, `quadsheet-receivables.jsx`,
   `description-generator.jsx`.
3. **No emojis. No AI or sparkle motifs used as decoration. No em dashes
   (—) in any user-facing string.** Use a comma, a colon, parentheses, or a
   restructured sentence. The empty-cell placeholder is an en dash `–`.
   Em dashes in *code comments* are fine and should be left alone.
4. **Nothing overflows.** Text truncates or wraps inside its container,
   components never overlap, and the page body never scrolls horizontally.
   Wide tables and charts scroll inside their own `.bx-scroll-x` wrapper.
5. **Both themes, every time.** Light and dark are equally finished. Never
   hard-code a hex value; always reference a token.

## 2. Tokens

Everything lives in `tokens.css` and is available as a CSS custom property
and as a Tailwind utility.

| Purpose | Token | Tailwind |
|---|---|---|
| Page canvas | `--bg` | `bg-background` |
| Raised panel | `--surface`, `--surface-2`, `--surface-3` | `bg-surface`, `bg-surface-2` |
| Body text | `--text` | `text-foreground` |
| Secondary text | `--text-muted` | `text-muted-foreground` |
| Tertiary / placeholder | `--text-soft` | |
| Hairline | `--border`, `--border-strong` | `border-border` |
| Brand | `--accent`, `--accent-solid`, `--accent-soft`, `--accent-ink` | `text-brand`, `bg-primary` |
| Positive | `--sage*` | `text-sage` |
| Negative | `--rose*`, `--destructive` | `text-clay` |
| Informational | `--blue*` | `text-steel` |

Semantic colour meanings are fixed product-wide: **sage** = awarded /
approved / paid / on track. **clay** = closed out / rejected / overdue /
destructive. **ochre (brand)** = in progress / awaiting / attention.
**steel** = paused, in-between, informational. Never reassign these.

Type scale `--fs-2xs … --fs-4xl`; spacing `--sp-1 … --sp-16`; radii
`--radius-xs … --radius-xl`; elevation `--shadow-xs … --shadow-xl`; motion
`--dur-*` with `--ease-out` (enter, hover) and `--ease-spring` (size and
position). Numeric content gets `.num` for tabular figures.

## 3. Components

Import from `@/ui`. Never import a `src/ui/*` file directly, and never
re-implement something the kit already has.

`Button` `Input` `InputGroup` `Textarea` `Label` `Field` `Badge` `Card`
`Separator` `Skeleton` `SkeletonTable` `Checkbox` `Switch` `RadioGroup`
`Avatar` `Progress` `ScrollArea` `Alert` `EmptyState` `Kbd` `Tabs`
`Dialog` `Sheet` `DropdownMenu` `Popover` `Tooltip` `Select` `AlertDialog`

Icons come from `@/icons` as `<Icon name="…" size={16} />`, backed by a
Lucide registry. If a glyph is missing, add it to the registry in
`icons.jsx` rather than importing `lucide-react` in a page.

### Restraint

- **Cards are for genuinely self-contained, grouped content.** A page is
  not a deck of boxes. A table, a list, or a form section on the page
  canvas usually needs a heading and a hairline, not a card.
- **Tables are for comparing many records across the same fields.** Two or
  three fields about one record is a definition list, not a table.
- One primary button per view. Everything else is `default`, `subtle`, or
  `ghost`.
- Badges carry status, not decoration.

## 4. Layout

- The shell (`.bx-shell`) provides the collapsible rail, the sticky glass
  topbar, and the scrolling page. Page code renders inside `.bx-page` and
  must not create a second full-height scroll container.
- Page structure: `.bx-pagehead` (title, one-line description, actions),
  then content sections separated by `--sp-5`.
- Breakpoints: `xs 400`, `sm 640`, `md 768`, `lg 1024`, `xl 1280`,
  `2xl 1536`, `3xl 1920`. The rail becomes an overlay drawer below `lg`.
- Design mobile-first inside each component. Toolbars wrap, filter strips
  scroll horizontally, dense tables become stacked rows or scroll inside
  `.bx-scroll-x` below `md`.
- Touch targets are at least 36px, and 44px for anything primary on mobile.

## 5. Accessibility

- Semantic elements: `<button>` for actions, `<a>` for navigation, real
  `<table>` markup for tabular data, `<h1>` once per page then in order.
- Every icon-only control needs an accessible name (`aria-label` or an
  `.sr-only` span) and, where useful, a `Tooltip`.
- Focus is never removed. The global `:focus-visible` ring is defined once
  in `beacon.css`; do not override it with `outline: none`.
- Dialogs, menus, and popovers come from Radix so focus trapping, escape,
  and `aria-*` wiring are handled. Do not hand-roll an overlay.
- Body text stays at or above 4.5:1, large or secondary text at or above
  3:1, in both themes. State is never signalled by colour alone; pair it
  with an icon, a label, or a shape.
- Decorative animation respects `prefers-reduced-motion` automatically via
  the duration tokens. Do not add unconditional `animation` shorthand.

## 6. Visual voice

Beacon is an engineering firm's system of record, not a consumer app. The
canvas is warm paper rather than the blue-grey every other dashboard ships
with; the accent is a burnt ochre from the MSMM mark. Restraint is the
house style:

- Surfaces are separated by hairlines and a single step of elevation, not
  by heavy shadows or thick borders.
- Glass (`--glass-bg` + `--glass-blur`) is used only on the sticky topbar,
  the rail, and overlay scrims. Never behind content the user has to read
  numbers off.
- Motion is short (150–220ms), only on state the user caused, and never on
  page load beyond a single subtle `.bx-enter`.
- Every interactive element defines hover, focus-visible, active,
  disabled, and (where relevant) selected. A control with only a hover
  state is unfinished.
