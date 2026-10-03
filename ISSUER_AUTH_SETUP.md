# Issuer Authentication Setup

Letter issuance stays unavailable until mail delivery, encrypted storage, employer review, and persistent storage are configured.

## Required Configuration

Set these as protected environment variables in the deployment platform or local environment. Do not commit their values:

- `PUBLIC_BASE_URL`: canonical HTTPS origin, `https://usevs.railway.app`.
- `DATA_ENCRYPTION_KEY`: 32 random bytes encoded as Base64. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and keep a protected backup. Losing this key makes retained letters and pending business documents unreadable.
- `ISSUER_REVIEW_TOKEN`: at least 32 random characters, generated with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`, used only by the business reviewer API.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`: working SMTP settings for employer confirmation and HR one-time codes.
- `DATA_DIR`: a private, durable directory or mounted persistent volume for account records, encrypted letters, and audit logs.

The application must have durable storage before live use. The JSON ledgers are stored under `DATA_DIR`; an ephemeral deployment filesystem can lose employer accounts and audit records on restart. Keep this directory outside any separately served static directory.

Production uses `DATA_DIR=/var/data/usevs`. Attach a Railway volume to the service at `/var/data/usevs` before enabling issuance, then set the environment variables listed in `.env.example` in the Railway service settings. Railway supplies `PORT`; the server falls back to `8080` when it is not set. Keep the encryption key backed up securely; losing it makes retained letters and pending business documents unreadable.

## Railway Deployment

1. Create a Railway project from this repository and deploy the service using the included `railway.json` configuration. The start command is `npm start`.
2. Add a persistent volume to the service with mount path `/var/data/usevs`. The application stores account records, encrypted letters, payment history, and audit logs in this directory.
3. Set the environment variables below in the Railway service. Keep SMTP credentials, `DATA_ENCRYPTION_KEY`, `ISSUER_REVIEW_TOKEN`, and PayFast credentials private. Generate fresh encryption and review tokens if this is a new production environment; preserve existing values when migrating an existing deployment.
4. Configure `usevs.railway.app` as the public domain if it is available to your Railway account. Otherwise, use the Railway-generated service domain (typically `*.up.railway.app`) or a custom domain you control, and update `PUBLIC_BASE_URL` and the PayFast return, cancel, and notify URLs to match.
5. Confirm the deployment passes its `/landing` health check before directing users to `https://usevs.railway.app`.

Required runtime variables:

```text
NODE_ENV=production
DATA_DIR=/var/data/usevs
PUBLIC_BASE_URL=https://usevs.railway.app
SMTP_HOST=<SMTP host>
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<SMTP username>
SMTP_PASS=<SMTP password>
SMTP_FROM=<sender email>
DATA_ENCRYPTION_KEY=<existing or newly generated 32-byte Base64 key>
ISSUER_REVIEW_TOKEN=<existing or newly generated review token>
PAYFAST_MODE=sandbox
PAYFAST_SANDBOX=true
PAYFAST_MERCHANT_ID=<PayFast merchant ID>
PAYFAST_MERCHANT_KEY=<PayFast merchant key>
PAYFAST_PASSPHRASE=<PayFast passphrase>
PAYFAST_RETURN_URL=https://usevs.railway.app/payfast/return
PAYFAST_CANCEL_URL=https://usevs.railway.app/payfast/cancel
PAYFAST_NOTIFY_URL=https://usevs.railway.app/payfast/notify
PAYFAST_ONCE_OFF_AMOUNT=4.99
PAYFAST_SUBSCRIPTION_AMOUNT=24.99
PAYFAST_ANNUAL_AMOUNT=269.99
PAYFAST_SUBSCRIPTION_FREQUENCY=3
PAYFAST_SUBSCRIPTION_CYCLES=0
```

The annual plan uses PayFast's annual recurring frequency and grants 365 days of access from each confirmed annual payment. `PAYFAST_ANNUAL_AMOUNT` defaults to `269.99`. Railway manages `PORT`; do not hard-code it in production. Set `PAYFAST_SANDBOX=false` and configure live merchant credentials only after the integration has been verified.

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
