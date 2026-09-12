# Login

## Purpose and user priorities
Returning MSMM employees use this gate to open their existing workspace. Their immediate task is to enter an email/password, identify and correct a sign-in error, or find password-reset guidance. They are not evaluating a product or signing up.

## Organization
- Compact persistent Beacon / MSMM identity establishes the destination.
- Desktop has a quiet workspace introduction and one elevated credentials card; the form is the strongest actionable element.
- Phone places the identity immediately above the form and removes supporting overview content to reduce travel to the fields.
- Email, password and the single primary Sign in action follow a predictable vertical order. Reset guidance sits directly below them; optional PWA installation remains secondary.

## Design choices
Inherit the MASTER cool-white / graphite / cobalt system and Geist/Lucide. A translucent, nearly opaque form surface provides restrained glass depth with readable text in both themes. The supporting composition names actual project, billing and team capabilities without invented counts or fake product controls. Content wraps; no brand or help text is truncated. Inputs and password visibility control use 44px minimum heights.

## Interaction and preserved contracts
Keep the original submit handler, auth calls, pending/error state, callbacks, automatic email focus, controlled inputs, autocomplete and paste support. The existing password toggle remains labeled and exposes its pressed state. Error text remains connected to both inputs. A brief form entrance respects reduced motion. No backend or data changes.

## Skill evidence
`accessible authentication password --domain ux` returned Accessible Authentication, Password Visibility and ARIA Labels. `form inputs accessibility --stack react` returned labeled controlled form guidance; these stable practices apply to the installed React 18 stack. Parent owns browser checks for mobile, desktop and both themes.
