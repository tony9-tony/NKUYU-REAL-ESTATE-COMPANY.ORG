# MKUYU Real Estate System

Internal MKUYU real estate workspace with projects, properties, clients, contracts, installments, payments, reports, organization management, RBAC, leads, follow-ups, approvals, and audit activity.

## Run locally

```powershell
npm install
npm run seed
npm start
```

The application runs at `http://localhost:3003`.

The first account is created from the private setup screen and receives the initial System Administrator role. There is no public signup after the workspace is configured.

## Organization API

Authenticated organization endpoints are under `/api/v1/org`:

- `/me`
- `/departments`
- `/roles`
- `/permissions`
- `/users`
- `/audit`
- `/leads`
- `/follow-ups`
- `/approvals`

All organization mutations are permission-checked server-side and important changes are recorded in `audit_logs`.
