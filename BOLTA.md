# Electronic tax invoices (Bolta)

Issues a 전자세금계산서 for an **issued** bill through [Bolta](https://bolta.io/api-integration)
(API docs: https://docs.bolta.io). Staff only; only **admin** and **finance_hr** can issue.

## Flow

1. Finance opens an issued bill → **Electronic tax invoice** panel → picks the VAT treatment → **Issue**.
2. The server sends `POST /v1/taxInvoices/issue` with a unique `Bolta-Client-Reference-Id` (`mcb-<billId>-<attempt>`).
   Bolta answers with an `issuanceKey`. That only means *accepted* — the row stays **Waiting for the NTS result**.
3. Bolta calls `POST /api/bolta/webhook/<token>` (or `/api/bolta/webhook?token=<token>`) with `TAX_INVOICE_ISSUANCE_SUCCESS` / `_FAILURE`
   (test key ≈ 10–30 s, live key ≈ 10 min). Only then is the row **Issued** (the NTS approval number is fetched right after).
4. If the webhook never arrives, **Refresh** looks the request up (by reference id, then by issuanceKey).

Safety rules built in: one active invoice per bill (a double click cannot issue twice); a reference id is never
reused (Bolta rejects reuse, even after a failure); if Bolta gives no clear answer the attempt is marked
*No answer* and **cannot be re-issued until Refresh** shows whether Bolta received it; a late failure event never
downgrades an issued invoice; every step is in the bill's change history.

## Setup checklist

1. bolta.io → sign up → create a workspace → **Developer Center → API keys** → create a `test_` key.
2. Fill `.env` (see `.env.example`): `BOLTA_API_KEY`, `BOLTA_WEBHOOK_TOKEN` (long random string), `BOLTA_SUPPLIER_*`
   (Mirae ESP's exact registered name, representative, 사업자등록번호), `BOLTA_VAT_MODE`.
3. Developer Center → **Webhooks**: register `https://YOUR-DOMAIN/api/bolta/webhook/<BOLTA_WEBHOOK_TOKEN>`
   (HTTPS only; test and live are registered separately). Optional: `BOLTA_WEBHOOK_IPS=43.201.136.252`.
4. On each client: a valid 10-digit business registration no., **Representative (대표자명)**, and a contact with an email.
5. Test with the `test_` key end to end (nothing reaches the NTS, no cost).
6. Go live: register Mirae ESP's **공동인증서** in Bolta, create a `live_` key, top up points in the Developer Center
   (정발행 ₩90 each), register the live webhook, then swap `BOLTA_API_KEY` to the `live_` key.

Setting names: the older names `SUPPLIER_BRN`, `SUPPLIER_NAME`, `SUPPLIER_REP`, `SUPPLIER_EMAIL` and `BOLTA_WEBHOOK_SECRET`
are accepted as well as the `BOLTA_*` ones, and `BOLTA_BASE_URL` or `BOLTA_API_BASE` both set the API address.

Requests made with the first (console-only) version are carried over automatically, so they show in the bill panel.

## Decisions to confirm (defaults in brackets)

- `BOLTA_VAT_MODE` [`add`]: whether `amount_billed` is before VAT. Only `amount_billed` is invoiced, not previous balance or late interest.
- Invoice date [today, KST]; supply date [bill period end].
- 영수/청구 [영수 once payment is confirmed, otherwise 청구].
- Amounts are treated as **whole Korean won**. Bolta only accepts KRW integers.

## Not built yet

Amended invoices (수정발행) for corrections and PDF download.

## It is the invoice

The Bolta tax invoice is the bill's invoice. The old Sales Invoice (printable page and scanned upload) was removed for bills.
Client logins see the issued tax invoice (amount, NTS approval no., **Open invoice** link) on their bill page once finance confirms the payment.
Quotations still use the scanned Sales Invoice upload.
