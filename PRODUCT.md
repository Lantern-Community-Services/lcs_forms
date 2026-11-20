# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Lantern Forms is Lantern Community Services' internal staff website. Nobody outside the organization uses it, apart from partner staff who open a share link to one form.

- **Site staff, case workers and site managers** at supportive housing and shelter sites. They use it mostly on iPads and phones, added to the home screen and opened like an app, so there is no browser bar, back button or reload. They record forms during meal service, events, home visits and incidents. Sometimes they are offline, and sometimes a resident signs or answers on the device.
- **Main Office staff, HR/IT, finance, program leadership and admins.** They use it mostly on desktop computers to review entries, approve requests, run reports and manage forms, people and sites.

## Product Purpose

One place for Lantern's paperwork: record forms quickly and correctly, keep site rosters and attendance current, and move approvals and follow-ups along. It replaces the old WordPress/Gravity Forms and Power Automate flows. Success means staff finish a form in one sitting on whatever device is at hand, and nothing they record is lost, even offline.

## Operating Context

- Phones and iPads at sites, in both orientations, often one-handed and in a hurry, and sometimes handed to a resident to sign (signature pads, "Lock for resident" kiosk mode).
- Desktop at the Main Office for reviewing, approving, reporting and admin work.
- Offline mode: forms are recorded without a connection and upload later. An offline bar and upload queues show the state.
- Forms come in two kinds. Basic forms are made in the drag-and-drop builder and drawn by the site. Code forms are custom React apps running in a sandboxed frame, built on the same shared components (`@lcs/ui`) and design tokens as the site.

## Capabilities and Constraints

- Microsoft sign-in. Roles and per-site access decide what each person sees.
- Navigation is the desktop sidebar (accordion with search and Pinned) and, on phone and iPad, the floating dock plus the All forms launcher.
- Themes: Lantern (navy), Ocean, Plum, Forest and a custom colour, each with a dark version behind a separate dark-mode switch.
- Resident data is sensitive (incidents, wellness, case management): show only what a task needs.
- Case management features ship to prod but stay switched off there.

## Brand Commitments

- Lantern navy and the Lantern logo stay.
- Themes and the dark-mode switch keep working for every change.
- The dock (phone/iPad) and sidebar (desktop) stay as the navigation.

## Product Principles

1. Finish in one sitting: every form works on a phone, an iPad and a desktop without pinching, zooming or sideways scrolling.
2. Never lose work: offline, interrupted or signed out, an entry is kept and the person can see that it is.
3. Show only what the task needs: resident details appear where a decision needs them, nowhere else.
4. Familiar over novel: staff with any level of tech comfort should recognise every control.

## Accessibility & Inclusion

Staff range widely in tech comfort, and residents sometimes use the device directly. Touch targets need to suit fingers on phones and iPads, text needs to be readable at arm's length on an iPad, and contrast needs to hold in every theme and in dark mode.
