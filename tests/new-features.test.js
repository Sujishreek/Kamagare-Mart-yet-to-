const { loadBackend } = require('./gas-mock');
const vm = require('vm'), assert = require('assert');
const SRC = process.argv[2];
let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log('ok  -', name); } catch (e) { console.log('FAIL-', name, '\n     ', e.message); process.exitCode = 1; } };

function boot(props) {
  const store = { props: { SPREADSHEET_ID: 'X', ADMIN_EMAIL: 'admin@gmail.com', ADMIN_PASSWORD: 'Admin@12345', ...props } };
  const ctx = loadBackend(SRC, store);
  ctx.SpreadsheetApp.openById = id => store.books[id] || (store.books[id] = ctx.SpreadsheetApp.create());
  ctx.fetched = [];
  ctx.fetchResult = { code: 200, body: '{"messages":[{"id":"wamid.x"}]}' };
  ctx.UrlFetchApp.fetch = (url, opts) => { ctx.fetched.push({ url, opts, payload: JSON.parse(opts.payload) }); return { getResponseCode: () => ctx.fetchResult.code, getContentText: () => ctx.fetchResult.body }; };
  vm.runInContext('setup()', ctx);
  ctx.call = (method, path, body, token) => JSON.parse(vm.runInContext('apiCall', ctx)(JSON.stringify({ method, path, body, authorization: token ? 'Bearer ' + token : '' })));
  return ctx;
}
const WA = { WA_PHONE_NUMBER_ID: '1234567890', WA_ACCESS_TOKEN: 'EAAtoken', WA_TEMPLATE_NAME: 'order_invoice' };
const order = (extra) => Object.assign({ customerName: 'Meena', customerPhone: '9000000000', customerEmail: 'm@example.com', address: '12 MG Road', items: [{ id: 1, quantity: 2 }], payment: 'COD' }, extra);
function signup(c) {
  const registration = c.call('POST', '/api/register', { name: 'Meena', email: 'meena@example.com', phone: '9876543210', password: 'Str0ng@Pass', address: 'x' });
  assert.equal(registration.status, 200);
  assert.equal(registration.body.verificationRequired, true);
  const code = c.__store.sentEmails.at(-1).body.match(/\b(\d{6})\b/)[1];
  const verified = c.call('POST', '/api/register/verify', { email: 'meena@example.com', code });
  assert.equal(verified.status, 201);
  return c.call('POST', '/api/login', { email: 'meena@example.com', password: 'Str0ng@Pass' }).body.token;
}
const invoiceStatusOf = (c, id) => vm.runInContext(`readTable_('Orders').rows.filter(function(r){return r.id==='${id}'})[0].invoiceStatus`, c);

// ---------- payment config / UPI
let c = boot({});
t('admin credentials are rejected by customer login and accepted by admin login', () => {
  const credentials = { email: 'admin@gmail.com', password: 'Admin@12345' };
  const registration = c.call('POST', '/api/register', {
    name: 'Admin',
    email: credentials.email,
    phone: '9876543210',
    password: credentials.password
  });
  assert.equal(registration.status, 409);
  const customerLogin = c.call('POST', '/api/login', credentials);
  assert.notEqual(customerLogin.status, 200);
  const adminLogin = c.call('POST', '/api/admin/login', credentials);
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.body.admin.role, 'admin');
});
t('registration sends a six-digit email code and creates no account until verified', () => {
  const b = boot({});
  const started = b.call('POST', '/api/register', {
    name: 'Nila', email: 'nila@example.com', phone: '9876543211',
    password: 'Str0ng@Pass', address: 'Home'
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.verificationRequired, true);
  assert.match(b.__store.sentEmails[0].body, /\b\d{6}\b/);
  assert.equal(b.__store.sentEmails[0].from, 'kamageremart04@gmail.com');
  assert.equal(b.call('POST', '/api/login', { email: 'nila@example.com', password: 'Str0ng@Pass' }).status, 401);
  const pending = vm.runInContext("readTable_('PendingRegistrations').rows[0]", b);
  assert.notEqual(pending.password, 'Str0ng@Pass');
  assert.equal(pending.codeHash.includes(b.__store.sentEmails[0].body.match(/\b(\d{6})\b/)[1]), false);
});
t('email verification rejects incorrect codes and accepts the emailed code', () => {
  const b = boot({});
  b.call('POST', '/api/register', {
    name: 'Oviya', email: 'oviya@example.com', phone: '9876543212', password: 'Str0ng@Pass'
  });
  const code = b.__store.sentEmails[0].body.match(/\b(\d{6})\b/)[1];
  assert.equal(b.call('POST', '/api/register/verify', { email: 'oviya@example.com', code: '000000' }).status, 400);
  assert.equal(b.call('POST', '/api/register/verify', { email: 'oviya@example.com', code }).status, 201);
  assert.equal(b.call('POST', '/api/login', { email: 'oviya@example.com', password: 'Str0ng@Pass' }).status, 200);
});
t('verification code can be resent after the cooldown and old code is invalidated', () => {
  const b = boot({});
  b.call('POST', '/api/register', {
    name: 'Uma', email: 'uma@example.com', phone: '9876543213', password: 'Str0ng@Pass'
  });
  const oldCode = b.__store.sentEmails[0].body.match(/\b(\d{6})\b/)[1];
  assert.equal(b.call('POST', '/api/register/resend', { email: 'uma@example.com' }).status, 429);
  vm.runInContext("var p=findPendingRegistration_('uma@example.com');p.lastSentAt=Date.now()-60001;updateRow_('PendingRegistrations',p._row,p)", b);
  assert.equal(b.call('POST', '/api/register/resend', { email: 'uma@example.com' }).status, 200);
  const newCode = b.__store.sentEmails[1].body.match(/\b(\d{6})\b/)[1];
  assert.notEqual(newCode, oldCode);
  assert.equal(b.call('POST', '/api/register/verify', { email: 'uma@example.com', code: oldCode }).status, 400);
  assert.equal(b.call('POST', '/api/register/verify', { email: 'uma@example.com', code: newCode }).status, 201);
});
t('email delivery failures are returned explicitly and do not create pending accounts', () => {
  const b = boot({});
  b.__store.mailError = 'mail unavailable';
  const response = b.call('POST', '/api/register', {
    name: 'Ira', email: 'ira@example.com', phone: '9876543214', password: 'Str0ng@Pass'
  });
  assert.equal(response.status, 503);
  assert.equal(vm.runInContext("readTable_('PendingRegistrations').rows.length", b), 0);
});
t('email quota authorization failures return an actionable response instead of a server error', () => {
  const b = boot({});
  b.__store.mailQuotaError = 'authorization required';
  const response = b.call('POST', '/api/register', {
    name: 'Asha', email: 'asha@example.com', phone: '9876543218', password: 'Str0ng@Pass'
  });
  assert.equal(response.status, 503);
  assert.match(response.body.message, /authorize this sender/i);
  assert.equal(vm.runInContext("readTable_('PendingRegistrations').rows.length", b), 0);
});
t('registration requires the requested sender to be a verified Gmail alias', () => {
  const b = boot({});
  b.__store.gmailAliases = [];
  const response = b.call('POST', '/api/register', {
    name: 'Asha', email: 'asha@example.com', phone: '9876543218', password: 'Str0ng@Pass'
  });
  assert.equal(response.status, 503);
  assert.match(response.body.message, /kamageremart04@gmail\.com/i);
  assert.equal((b.__store.sentEmails || []).length, 0);
});
t('expired verification codes are rejected and pending registration is removed', () => {
  const b = boot({});
  b.call('POST', '/api/register', {
    name: 'Tara', email: 'tara@example.com', phone: '9876543215', password: 'Str0ng@Pass'
  });
  const code = b.__store.sentEmails[0].body.match(/\b(\d{6})\b/)[1];
  vm.runInContext("var p=findPendingRegistration_('tara@example.com');p.expiresAt=Date.now()-1;updateRow_('PendingRegistrations',p._row,p)", b);
  assert.equal(b.call('POST', '/api/register/verify', { email: 'tara@example.com', code }).status, 410);
  assert.equal(vm.runInContext("readTable_('PendingRegistrations').rows.length", b), 0);
});
t('resending replaces an expired code without losing the pending registration', () => {
  const b = boot({});
  b.call('POST', '/api/register', {
    name: 'Wina', email: 'wina@example.com', phone: '9876543217', password: 'Str0ng@Pass'
  });
  vm.runInContext("var p=findPendingRegistration_('wina@example.com');p.expiresAt=Date.now()-1;p.lastSentAt=Date.now()-60001;updateRow_('PendingRegistrations',p._row,p)", b);
  assert.equal(b.call('POST', '/api/register/resend', { email: 'wina@example.com' }).status, 200);
  const code = b.__store.sentEmails[1].body.match(/\b(\d{6})\b/)[1];
  assert.equal(b.call('POST', '/api/register/verify', { email: 'wina@example.com', code }).status, 201);
});
t('verification attempts are limited and pending registration is cleared', () => {
  const b = boot({});
  b.call('POST', '/api/register', {
    name: 'Vani', email: 'vani@example.com', phone: '9876543216', password: 'Str0ng@Pass'
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(b.call('POST', '/api/register/verify', { email: 'vani@example.com', code: '000000' }).status, 400);
  }
  assert.equal(b.call('POST', '/api/register/verify', { email: 'vani@example.com', code: '000000' }).status, 429);
  assert.equal(vm.runInContext("readTable_('PendingRegistrations').rows.length", b), 0);
});
t('payment-config: UPI off when UPI_ID missing', () => { const r = c.call('GET', '/api/payment-config'); assert.equal(r.status, 200); assert.equal(r.body.upiEnabled, false); assert.equal(r.body.cod, true); });
t('UPI order rejected when UPI is not configured', () => { const r = c.call('POST', '/api/orders', order({ payment: 'UPI' })); assert.equal(r.status, 400); assert.match(r.body.message, /UPI payment is not available/); });
t('unknown payment method rejected', () => { assert.equal(c.call('POST', '/api/orders', order({ payment: 'PAYPAL' })).status, 400); });
t('COD order works and records "Not configured" WhatsApp status', () => {
  const r = c.call('POST', '/api/orders', order()); assert.equal(r.status, 201); assert.equal(r.body.order.payment, 'COD');
  assert.equal(invoiceStatusOf(c, r.body.order.id), 'Not configured'); assert.equal(c.fetched.length, 0);
});
t('bad UPI_ID is ignored', () => { const b = boot({ UPI_ID: 'not a upi id' }); assert.equal(b.call('GET', '/api/payment-config').body.upiEnabled, false); });

c = boot({ UPI_ID: 'kamageremart@okhdfcbank', UPI_NAME: 'Kamagere Mart' });
t('payment-config: UPI on when UPI_ID set', () => { const r = c.call('GET', '/api/payment-config').body; assert.equal(r.upiEnabled, true); assert.equal(r.upiId, 'kamageremart@okhdfcbank'); });
t('UPI order returns a upi://pay link with server-side total', () => {
  const r = c.call('POST', '/api/orders', order({ payment: 'UPI', total: 1 })); assert.equal(r.status, 201);
  const o = r.body.order; assert.equal(o.payment, 'UPI'); assert.ok(o.upi.link.startsWith('upi://pay?pa=kamageremart%40okhdfcbank'), o.upi.link);
  assert.ok(o.upi.link.includes('am=' + o.total.toFixed(2)), o.upi.link); assert.ok(o.upi.link.includes('cu=INR')); assert.ok(o.upi.link.includes('Order%20' + o.id));
});
t('lower-case "upi" is accepted and normalised', () => { assert.equal(c.call('POST', '/api/orders', order({ payment: 'upi' })).body.order.payment, 'UPI'); });

// ---------- WhatsApp invoice
c = boot(WA);
let token = signup(c);
t('order list goes to the ADMIN WhatsApp number (not the customer)', () => {
  const r = c.call('POST', '/api/orders', order({ customerPhone: '9000000000' }), token); assert.equal(r.status, 201);
  assert.equal(c.fetched.length, 1);
  const f = c.fetched[0];
  assert.equal(f.payload.to, '917483990595');
  assert.match(f.url, /^https:\/\/graph\.facebook\.com\/v23\.0\/1234567890\/messages$/);
  assert.equal(f.opts.headers.Authorization, 'Bearer EAAtoken');
  assert.equal(f.payload.type, 'template'); assert.equal(f.payload.template.name, 'order_invoice'); assert.equal(f.payload.template.language.code, 'en');
  const p = f.payload.template.components[0].parameters.map(x => x.text);
  assert.equal(p.length, 7); assert.ok(/^Meena \| Ph: 9000000000 \| 12 MG Road$/.test(p[0]), p[0]); assert.equal(p[1], r.body.order.id); assert.ok(/x 2/.test(p[3]), p[3]);
  assert.equal(p[5], String(r.body.order.total)); assert.equal(p[6], 'Cash on Delivery');
  p.forEach(x => assert.ok(!/[\n\t]/.test(x) && !/ {4,}/.test(x) && x.length > 0));
  assert.deepEqual(r.body.order.invoice, { sent: true, phone: '+91 ******0595' });
  assert.equal(invoiceStatusOf(c, r.body.order.id), 'Sent');
});
t('guest checkout (no token) also sends the order list to the admin', () => {
  const n = c.fetched.length; const r = c.call('POST', '/api/orders', order()); assert.equal(r.status, 201);
  assert.equal(c.fetched.length, n + 1); assert.equal(c.fetched[n].payload.to, '917483990595'); assert.equal(invoiceStatusOf(c, r.body.order.id), 'Sent');
});
t('a typed-in userId cannot redirect the message away from the admin', () => {
  const n = c.fetched.length; const r = c.call('POST', '/api/orders', order({ userId: 1 })); assert.equal(r.status, 201); assert.equal(c.fetched[n].payload.to, '917483990595');
});
t('a valid token overrides a spoofed userId in the body', () => {
  const r = c.call('POST', '/api/orders', order({ userId: 999 }), token); assert.equal(r.status, 201); assert.equal(String(r.body.order.userId), '1');
});
t('WhatsApp failure never breaks the order; status is recorded', () => {
  c.fetchResult = { code: 400, body: '{"error":{"message":"Template name does not exist"}}' };
  const r = c.call('POST', '/api/orders', order(), token); assert.equal(r.status, 201); assert.equal(r.body.order.invoice.sent, false);
  assert.match(invoiceStatusOf(c, r.body.order.id), /^Failed: HTTP 400 Template name does not exist/);
});
t('network exception inside UrlFetchApp is swallowed', () => {
  c.UrlFetchApp.fetch = () => { throw new Error('boom'); };
  const r = c.call('POST', '/api/orders', order(), token); assert.equal(r.status, 201); assert.match(invoiceStatusOf(c, r.body.order.id), /Failed: boom/);
});
t('stock still decremented exactly once per order; lock free afterwards', () => {
  const r = c.call('POST', '/api/orders', order(), token); assert.equal(r.status, 201);
  assert.equal(c.__store.locked, false);
});
t('admin order list still works and hides token hashes', () => {
  const a = c.call('POST', '/api/admin/login', { email: 'admin@gmail.com', password: 'Admin@12345' }).body.token;
  const r = c.call('GET', '/api/orders', undefined, a); assert.equal(r.status, 200); assert.ok(r.body.length > 3); assert.ok(!('cancelTokenHash' in r.body[0]));
});
t('admin order status and cancellation changes are visible to customer tracking', () => {
  const adminToken = c.call('POST', '/api/admin/login', { email: 'admin@gmail.com', password: 'Admin@12345' }).body.token;
  const productBefore = c.call('GET', '/api/products').body.find(product => Number(product.id) === 1).stock;
  const placed = c.call('POST', '/api/orders', order({ items: [{ id: 1, quantity: 1 }] }));
  assert.equal(placed.status, 201);
  const created = placed.body.order;
  const outForDelivery = c.call('PATCH', '/api/orders/' + created.id + '/status', { status: 'Out for delivery' }, adminToken);
  assert.equal(outForDelivery.status, 200);
  assert.equal(c.call('GET', '/api/orders/' + created.id + '/track', undefined, created.trackingToken).body.status, 'Out for delivery');
  const cancelled = c.call('PATCH', '/api/admin/orders/' + created.id + '/cancel', {}, adminToken);
  assert.equal(cancelled.status, 200);
  assert.equal(c.call('GET', '/api/orders/' + created.id + '/track', undefined, created.trackingToken).body.status, 'Cancelled');
  assert.equal(c.call('GET', '/api/products').body.find(product => Number(product.id) === 1).stock, productBefore);
});
console.log(pass + ' checks passed');
