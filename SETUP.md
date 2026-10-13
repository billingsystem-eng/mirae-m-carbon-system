# Bolta tax invoice patch - mirae-esp-billing

Copy these files over the same paths in your project (merge if you changed them since you sent the zip):
  lib/bolta.js          (new)
  routes/bolta.js       (new)
  routes/clients.js     (adds representative_name)
  public/client.html    (adds "Representative name (대표자)" field)
  server.js             (mounts /api/bolta and the webhook)
  db/index.js           (adds columns + bolta_events table on boot)

Railway > Variables (add all):
  BOLTA_API_KEY=test_...            # your test key for now
  BOLTA_BASE_URL=https://xapi.bolta.io
  BOLTA_WEBHOOK_SECRET=<same random value used in the webhook URL path>
  SUPPLIER_BRN=<Mirae ESP business registration number>
  SUPPLIER_REP=<representative name>
  SUPPLIER_EMAIL=<company contact email>
  SUPPLIER_NAME=미래이에스피 주식회사   # optional

Each Korean client needs: Business registration no. (tin), Representative name, and a contact with an email.

Test (logged in, in the browser console on your site), bill must be final or issued:
  fetch('/api/bolta/bills/BILL_ID/tax-invoice',{method:'POST'}).then(r=>r.json()).then(console.log)
Then check Bolta: 연동 현황 > API 로그 and 웹훅 로그.
