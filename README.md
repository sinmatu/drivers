# Lorry System

Firebase-backed driver work-hour, review and reconciliation system.

## Roles
- Driver — submit work entries and view own records.
- Staff — review/check entries and view reports.
- Manager — final reconciliation, rates and global settings.

## Core rules
The driver submits the original Start and End time. The original values are never rewritten.
If an entry crosses midnight, the calculation engine keeps the human-facing entry intact and splits internal calculation segments by date/rate boundary.

## Firebase setup
1. Create a Firebase project.
2. Enable Authentication > Google.
3. Create Firestore Database.
4. Create a Firebase Web App.
5. Paste its config into `firebase-config.js`.
6. Publish `firestore.rules`.
7. Create the first manager user document manually:
   `users/{firebase-auth-uid}`
   with fields:
   `name`, `email`, `role: "manager"`
8. Add at least one lorry and driver in Settings.

## Hosting
The frontend is static and can be hosted with GitHub Pages.

## Firestore collections
`users`, `drivers`, `lorries`, `shifts`, `settings`, `holidays`, `workEntries`, `reconciliationPeriods`.

## Pagination
Records use Firestore cursor pagination (`orderBy`, `limit`, `startAfter`) once Firebase is configured. Demo mode uses local in-memory data.
