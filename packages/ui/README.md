# Shared UI language

`src/tokens.ts` exports CareLoop colors and human-readable care-phase labels. The web application implements the responsive design system in `apps/web/src/app/globals.css` and reusable display primitives in `apps/web/src/components/shared.tsx`. Its Radix Slot / class-variance-authority button follows the shadcn component pattern; configuration is in `apps/web/components.json`.

Use text as well as color for statuses, synthetic-record labels wherever example clinical records appear, visible field labels, native dialogs with accessible names and focus return, and browser-safe domain helpers for prerequisite displays. Authorization belongs to the API, never to UI visibility or a selected role.
