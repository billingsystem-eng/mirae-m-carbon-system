// Thin client for the Bolta (볼타) Open API: electronic tax invoices (전자세금계산서).
// Docs: https://docs.bolta.io  ·  API base: https://xapi.bolta.io  ·  Auth: HTTP Basic, API key as the
// username and an empty password. Keys starting "test_" never reach the NTS (국세청) and cost nothing;
// "live_" keys issue real invoices and spend prepaid points.
//
// Configuration (.env): BOLTA_API_KEY, BOLTA_WEBHOOK_TOKEN, BOLTA_SUPPLIER_* — see .env.example.

const API_BASE = () => (process.env.BOLTA_API_BASE || 'https://xapi.bolta.io').replace(/\/$/, '');
const API_KEY = () => process.env.BOLTA_API_KEY || '';

const enabled = () => !!API_KEY();
const environment = () => (API_KEY().startsWith('live_') ? 'live' : 'test');

class BoltaError extends Error {
  constructor(message, { status, code, traceId, body } = {}) {
    super(message);
    this.name = 'BoltaError';
    this.status = status;   // HTTP status (undefined = never got a response, e.g. network error/timeout)
    this.code = code;       // Bolta's `code`, e.g. INVALID_REQUEST
    this.traceId = traceId;
    this.body = body;
  }
}

async function request(method, path, { body, headers = {}, timeoutMs = 20000 } = {}) {
  if (!enabled()) throw new BoltaError('Bolta is not set up (BOLTA_API_KEY is empty).');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(API_BASE() + path, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(API_KEY() + ':').toString('base64'),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    });
  } catch (e) {
    // No response at all: we cannot know whether Bolta received the request.
    throw new BoltaError(e.name === 'AbortError' ? 'Bolta did not respond in time.' : 'Could not reach Bolta.', {});
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body */ }
  if (!res.ok) {
    throw new BoltaError((json && json.message) || `Bolta returned HTTP ${res.status}.`, {
      status: res.status, code: json && json.code, traceId: json && json.traceId, body: json
    });
  }
  return json || {};
}

/** POST /v1/taxInvoices/issue — returns { issuanceKey }. This only means "request accepted";
 *  the final result arrives by webhook (test ≈10–30 s, live ≈10 min) or by lookup. */
const issue = (payload, clientReferenceId) =>
  request('POST', '/v1/taxInvoices/issue', {
    body: payload,
    headers: { 'Bolta-Client-Reference-Id': clientReferenceId }
  });

/** GET /v1/taxInvoices/issue/status?clientReferenceId=… — { issuanceKey, clientReferenceId, message }.
 *  Use this (not a second issue call) when an issue request got no answer. */
const statusByReference = (clientReferenceId) =>
  request('GET', '/v1/taxInvoices/issue/status?clientReferenceId=' + encodeURIComponent(clientReferenceId));

/** GET /v1/taxInvoices/{issuanceKey} — only returns for an invoice that is issued (발행 완료);
 *  includes ntsTransactionId (국세청승인번호) and issuedAt. */
const retrieve = (issuanceKey) => request('GET', '/v1/taxInvoices/' + encodeURIComponent(issuanceKey));

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Korean business registration number (사업자등록번호): 10 digits with a checksum. */
function validBrn(value) {
  const s = String(value || '').replace(/\D/g, '');
  if (s.length !== 10) return false;
  const d = s.split('').map(Number);
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += d[i] * w[i];
  sum += Math.floor((d[8] * 5) / 10);
  return (10 - (sum % 10)) % 10 === d[9];
}
const digits = (v) => String(v || '').replace(/\D/g, '');

/** Split an amount into supply value (공급가액) and VAT (세액), in whole won.
 *    add  — `amount` is the supply value; 10% VAT is added on top
 *    incl — `amount` already includes 10% VAT
 *    zero — zero-rated (영세율), no VAT      free — VAT-exempt (면세 계산서), no VAT */
function splitAmount(amount, mode) {
  const a = Math.round(Number(amount) || 0);
  if (mode === 'incl') { const supply = Math.round(a / 1.1); return { taxType: 'TAXABLE', supply, tax: a - supply }; }
  if (mode === 'zero') return { taxType: 'ZERO_RATE', supply: a, tax: 0 };
  if (mode === 'free') return { taxType: 'TAX_FREE', supply: a, tax: null };
  return { taxType: 'TAXABLE', supply: a, tax: Math.round(a * 0.1) };
}

const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

module.exports = { enabled, environment, BoltaError, issue, statusByReference, retrieve, validBrn, digits, splitAmount, kstToday };
