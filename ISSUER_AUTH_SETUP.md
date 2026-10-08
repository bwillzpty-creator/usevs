# Issuer Authentication Setup

Letter issuance stays unavailable until mail delivery, encrypted storage, employer review, and persistent storage are configured.

## Required Configuration

Set these as protected environment variables in the deployment platform or local environment. Do not commit their values:

- `PUBLIC_BASE_URL`: canonical HTTPS origin for your Linode-hosted domain, such as `https://your-domain.example`.
- `DATA_ENCRYPTION_KEY`: 32 random bytes encoded as Base64. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and keep a protected backup. Losing this key makes retained letters and pending business documents unreadable.
- `ISSUER_REVIEW_TOKEN`: at least 32 random characters, generated with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`, used only by the business reviewer API.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`: working SMTP settings for employer confirmation and HR one-time codes.
- `BUSINESS_POSTAL_ADDRESS`: the real physical mailing address to include in transactional email footers. Email delivery is blocked until this is configured.
- `PAYMENT_WEBHOOK_SECRET`: a high-entropy secret shared with the future payment provider for HMAC-SHA256 webhook verification. Payment initiation currently records intent only and does not charge a payment method.
- `DATA_DIR`: a private, durable directory or mounted persistent volume for account records, encrypted letters, and audit logs.

The application must have durable storage before live use. The JSON ledgers are stored under `DATA_DIR`; an ephemeral deployment filesystem can lose employer accounts and audit records on restart. Keep this directory outside any separately served static directory.

The I-9 evidence workspace additionally requires `DATA_ENCRYPTION_KEY`; candidate names, form data, document copies, and reverification worksheets are encrypted with the existing envelope-encryption scheme. Its audit ZIP contains decrypted employee data and must be handled as a sensitive compliance archive. The I-9 worksheet is not an official Form I-9, and E-Verify cases must still be created in the employer's E-Verify account.

On Linode, use a persistent directory such as `/var/lib/usevs` for `DATA_DIR`. The directory must be writable by the application service account. Keep the encryption key backed up securely; losing it makes retained letters and pending business documents unreadable.

## Linode Deployment

1. Create an Ubuntu Linode and point your domain's DNS record to its public IP address. Install Node.js 22.13 or newer, npm, and Nginx; check `node --version` before installing the application.
2. Check out this repository on the server (for example, in `/opt/usevs`) and install production dependencies with `npm ci --omit=dev`.
3. Create a dedicated `usevs` system account and the persistent data directory `/var/lib/usevs`; make the data directory writable by that account. The application stores its SQLite database, account records, encrypted letters, and audit logs there.
4. Create `/etc/usevs/usevs.env`, readable only by root, with the environment values below. Keep SMTP credentials, `DATA_ENCRYPTION_KEY`, and `ISSUER_REVIEW_TOKEN` private. Generate fresh encryption and review tokens for a new production environment; preserve existing values when migrating an existing deployment.
5. Configure a systemd service to run `npm start` from the application directory as the `usevs` account, loading `/etc/usevs/usevs.env` with `EnvironmentFile`. Enable and start the service, and confirm it listens on port `8080`.
6. Configure Nginx to proxy HTTPS requests for your domain to `http://127.0.0.1:8080`, and provision a TLS certificate. Set `PUBLIC_BASE_URL` to the exact HTTPS origin and verify that `https://your-domain.example/landing` responds successfully before enabling issuance.

Required runtime variables:

```text
NODE_ENV=production
DATA_DIR=/var/lib/usevs
PORT=8080
PUBLIC_BASE_URL=https://your-domain.example
SMTP_HOST=<SMTP host>
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<SMTP username>
SMTP_PASS=<SMTP password>
SMTP_FROM=<sender email>
BUSINESS_POSTAL_ADDRESS=<real physical mailing address>
PAYMENT_WEBHOOK_SECRET=<payment provider webhook secret>
DATA_ENCRYPTION_KEY=<existing or newly generated 32-byte Base64 key>
ISSUER_REVIEW_TOKEN=<existing or newly generated review token>
```

Replace `your-domain.example` with the Linode-hosted application's real domain. The Linode instance runs the Node.js process directly; Nginx provides the public HTTPS endpoint. Back up the persistent data directory and encryption key securely.

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

## Payment Integration Boundary

`POST /api/payments` requires a verified issuer session and an `Idempotency-Key` UUID. Its JSON body accepts `amountMinor`, `currency`, and an optional `reference`; it records an initiated event only and does not contact a processor or charge a payment method. The browser helper at `/payment-client.js` creates UUID keys and request headers. Reuse the same key for retries of the same payment intent.

`POST /api/payments/webhook` expects the exact raw JSON body signed as HMAC-SHA256 in the `X-Payment-Signature` header, either as a 64-character hex digest or `sha256=<hex>`. The normalized JSON fields are `eventId` (or `id`), `paymentId`, `eventType` (`authorized`, `captured`, `refunded`, or `disputed`), and optional `occurredAt`. The complete provider payload is retained with sensitive field names removed. Provider-specific event mapping and signature setup must be completed before enabling a live processor.
