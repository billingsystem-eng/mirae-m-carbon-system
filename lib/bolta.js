// Bolta (bolta.io) electronic tax invoice client. Server-side only: never expose BOLTA_API_KEY to the browser.
const BASE = process.env.BOLTA_BASE_URL || 'https://xapi.bolta.io';

function authHeader() {
  if (!process.env.BOLTA_API_KEY) throw new Error('BOLTA_API_KEY is not set.');
  return 'Basic ' + Buffer.from(process.env.BOLTA_API_KEY + ':').toString('base64');
}

// Korean business numbers are 10 digits; accept "123-45-67890" and strip the dashes.
const digits = (s) => String(s || '').replace(/\D/g, '');

function buildPayload(bill, client, contact) {
  const supply = Math.round(Number(bill.amount_billed) || 0);   // KRW, whole won
  const tax = Math.round(supply * 0.1);                          // Korean VAT 10%
  const date = (bill.bill_date || new Date().toISOString()).slice(0, 10);
  return {
    date,
    purpose: 'RECEIPT',
    taxType: 'TAXABLE',
    supplier: {
      identificationNumber: digits(process.env.SUPPLIER_BRN),
      organizationName: process.env.SUPPLIER_NAME || '미래이에스피 주식회사',
      representativeName: process.env.SUPPLIER_REP,
      manager: { email: process.env.SUPPLIER_EMAIL },
    },
    supplied: {
      identificationNumber: digits(client.tin),
      organizationName: client.name,
      representativeName: client.representative_name,
      managers: [{ email: contact.email }],
    },
    items: [{
      date,
      name: `M-Carbon 절감분 정산 (${bill.period_start} ~ ${bill.period_end})`,
      unitPrice: supply,
      quantity: 1,
      supplyCost: supply,
      tax,
    }],
  };
}

async function issueTaxInvoice(payload, refId) {
  const res = await fetch(`${BASE}/v1/taxInvoices/issue`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      'Bolta-Client-Reference-Id': refId,   // unique per request; reusing one gives a duplicate error
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) { const e = new Error('Bolta rejected the request (HTTP ' + res.status + ').'); e.detail = data; throw e; }
  return data; // { issuanceKey } - this only means "request accepted", not "issued"
}

module.exports = { buildPayload, issueTaxInvoice };
