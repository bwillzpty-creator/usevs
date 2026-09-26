# Issuer Authentication Setup

Letter issuance stays unavailable until mail delivery, encrypted storage, employer review, and persistent storage are configured.

## Required Configuration

Set these as protected environment variables in the deployment platform or local environment. Do not commit their values:

- `PUBLIC_BASE_URL`: canonical HTTPS origin, currently `https://usevs.onrender.com`.
- `DATA_ENCRYPTION_KEY`: 32 random bytes encoded as Base64. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and keep a protected backup. Losing this key makes retained letters and pending business documents unreadable.
- `ISSUER_REVIEW_TOKEN`: at least 32 random characters, generated with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`, used only by the business reviewer API.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`: working SMTP settings for employer confirmation and HR one-time codes.
- `DATA_DIR`: a private, durable directory or mounted persistent volume for account records, encrypted letters, and audit logs.

The application must have durable storage before live use. The JSON ledgers are stored under `DATA_DIR`; an ephemeral deployment filesystem can lose employer accounts and audit records on restart. Keep this directory outside any separately served static directory.

Production startup deliberately fails when `DATA_DIR` is missing. On Render, mount a persistent disk to the service and set `DATA_DIR` to that mount path before deploying. The current free Render plan may not support persistent disks; upgrade or choose a host that provides durable private storage before enabling issuance.

## Employer Review

Employer registration requires the legal business name, address, business phone, and business and HR emails on the same non-consumer domain. The employer must confirm the corporate email. Accounts remain `pending_review` until a reviewer independently verifies the business and the named HR signatory's authority; a supplied document is supporting evidence, not automatic approval.

Use the configured reviewer token from a protected operator shell:

```powershell
$headers = @{ Authorization = "Bearer $env:ISSUER_REVIEW_TOKEN" }
Invoke-RestMethod -Uri "$env:PUBLIC_BASE_URL/api/review/employers" -Headers $headers
```

If an account has uploaded evidence, retrieve it with `GET /api/review/employers/{employer-id}/document` using the same header. After independent review, approve it with:

```powershell
Invoke-RestMethod -Uri "$env:PUBLIC_BASE_URL/api/review/employers/{employer-id}/approve" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
```

Do not approve an employer based only on a user-entered business name or email domain. Review official business records, confirm control of the corporate domain, and independently verify the named officer's authority to issue employment letters. The reviewer API is unavailable unless `ISSUER_REVIEW_TOKEN` is configured.

## HR Sign-In And Retention

The initial HR signatory is created with the employer registration and must sign in with their password plus a one-time code sent to their corporate email. An authenticated signatory can add other signatories on the verified corporate domain.

Issued employee details and letter contents are encrypted with a per-letter key. The application removes the encrypted payload and its wrapped key after 30 days, retaining a non-sensitive audit record with employer/signatory IDs, reference, timestamp, IP address, and status. Public reference lookup never returns employee details or letter contents. Legacy public letter records are migrated to encrypted storage when possible and removed from the old plaintext ledger at startup.
