var assert = require('node:assert/strict');
var once = require('node:events').once;
var test = require('node:test');
var app = require('../server');
var store = require('../lib/store');

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('the printable invoice and GST audit agree with preview and Khata checkout', async function (t) {
  var db = {
    products: [
      { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 100, stock: 10 },
      { id: 2, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 100, stock: 10, gstRate: 0 },
      { id: 3, sku: 'TEA', name: 'Tea', hsn: '0902', price: 100, stock: 10 }
    ],
    customers: [{ id: 1, name: 'Sample Customer', creditLimit: 1000 }],
    orders: [],
    nextOrderId: 1001
  };
  t.mock.method(store, 'read', function () { return structuredClone(db); });
  var write = t.mock.method(store, 'write', function (updatedDb) { db = structuredClone(updatedDb); });

  var server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(function () {
    return new Promise(function (resolve, reject) {
      server.close(function (error) {
        if (error) reject(error);
        else resolve();
      });
    });
  });
  var baseUrl = 'http://127.0.0.1:' + server.address().port;
  var cart = {
    items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }, { id: 3, qty: 2 }],
    coupon: ' save10 '
  };

  var previewResponse = await postJson(baseUrl + '/api/pricing/preview', cart);
  assert.equal(previewResponse.status, 200);
  var preview = await previewResponse.json();
  assert.equal(preview.couponStatus.valid, true);
  assert.equal(preview.couponStatus.code, 'SAVE10');
  assert.deepEqual(preview.totals, {
    subtotal: 500,
    discount: 50,
    taxable: 450,
    tax: 52.2,
    cgst: 26.1,
    sgst: 26.1,
    total: 502.2,
    lines: [
      { id: 1, name: 'Rice', hsn: '1006', gstPercent: 5, gross: 200, discount: 20, taxable: 180, tax: 9, net: 189 },
      { id: 2, name: 'Ghee', hsn: '0405', gstPercent: 12, gross: 100, discount: 10, taxable: 90, tax: 10.8, net: 100.8 },
      { id: 3, name: 'Tea', hsn: '0902', gstPercent: 18, gross: 200, discount: 20, taxable: 180, tax: 32.4, net: 212.4 }
    ]
  });
  assert.equal(write.mock.callCount(), 0);

  var checkoutResponse = await postJson(baseUrl + '/api/orders', { ...cart, paymentMode: 'khata', customerId: 1 });
  assert.equal(checkoutResponse.status, 201);
  var order = await checkoutResponse.json();
  assert.equal(order.id, 1001);
  assert.equal(order.customer, 'Sample Customer');
  assert.equal(order.coupon, 'SAVE10');
  assert.deepEqual([order.subtotal, order.discount, order.tax, order.total], [500, 50, 52.2, 502.2]);
  // Checkout preserves the HSN and drops the product's explicit GST override.
  assert.deepEqual(order.items[1], { id: 2, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 100, qty: 1 });
  assert.deepEqual(db.orders, [order]);
  assert.equal(db.customers[0].totalBilled, 502.2);
  assert.equal(db.customers[0].balance, 502.2);
  assert.equal(write.mock.callCount(), 1);

  var invoiceResponse = await fetch(baseUrl + '/orders/1001/invoice');
  assert.equal(invoiceResponse.status, 200);
  var html = await invoiceResponse.text();
  assert.equal(html.match(/<td>Invoice Total<\/td><td class="r">₹([^<]+)<\/td>/)?.[1], '502.20');
  assert.equal(html.match(/<td>CGST \+ SGST \(Total GST\)<\/td><td class="r">₹([^<]+)<\/td>/)?.[1], '52.20');
  assert.match(html, /<td>1006<\/td><td class="r">2<\/td><td class="r">₹100\.00<\/td><td class="r">5%<\/td><td class="r">₹9\.00<\/td>/);
  assert.match(html, /<td>Coupon Discount \(SAVE10\)<\/td><td[^>]*>-₹50\.00<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);

  var reportResponse = await fetch(baseUrl + '/api/reports/gst-reconciliation');
  assert.equal(reportResponse.status, 200);
  assert.deepEqual(await reportResponse.json(), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1001, date: order.date, customer: 'Sample Customer', coupon: 'SAVE10',
      ledgerSubtotal: 500, ledgerDiscount: 50, ledgerTax: 52.2, ledgerTotal: 502.2,
      invoiceDiscount: 50, invoiceTax: 52.2, invoiceTotal: 502.2, delta: 0, matched: true
    }]
  });

  var cancelResponse = await postJson(baseUrl + '/api/orders/1001/cancel', {});
  assert.equal(cancelResponse.status, 200);
  var cancelledOrder = await cancelResponse.json();
  assert.equal(cancelledOrder.status, 'cancelled');
  assert.equal(cancelledOrder.total, 502.2);
  assert.equal(db.customers[0].balance, 0);

  var reportAfterCancellation = await fetch(baseUrl + '/api/reports/gst-reconciliation');
  assert.equal(reportAfterCancellation.status, 200);
  assert.deepEqual(await reportAfterCancellation.json(), {
    totalChecked: 0, mismatchCount: 0, totalDelta: 0, rows: []
  });
});
