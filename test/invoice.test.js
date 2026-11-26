var assert = require('node:assert/strict');
var test = require('node:test');
var invoice = require('../lib/invoice');
var pricing = require('../lib/pricing');
var reports = require('../lib/reports');

function bill(items, coupon) {
  var totals = pricing.computeTotals(items, coupon);
  return {
    id: 1001,
    date: '2021-11-15',
    items: items,
    coupon: coupon,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  };
}

test('an undiscounted order at the default GST rate matches its invoice', function () {
  var order = bill([{ name: 'Tea', price: 100, qty: 2 }], '');

  assert.equal(order.total, 236);
  assert.deepEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 200,
    discount: 0,
    tax: 36,
    cgst: 18,
    sgst: 18,
    total: 236,
    rows: [{
      name: 'Tea', sku: '-', hsn: '-', qty: 2, price: 100,
      gstPercent: 18, line: 200, lineTax: 36
    }]
  });

  var html = invoice.render(order);
  assert.match(html, /<td>CGST \+ SGST \(Total GST\)<\/td><td class="r">₹36\.00<\/td>/);
  assert.match(html, /<td>Invoice Total<\/td><td class="r">₹236\.00<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice|Coupon Discount/);
});

test('an explicit whole-percent GST rate is used by both calculations', function () {
  var items = [{ name: 'Ghee', price: 100, qty: 1, hsn: '0405', gstRate: 5 }];
  var order = bill(items, '');
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 5);
  assert.equal(order.total, 105);
  assert.equal(figures.rows[0].gstPercent, 5);
  assert.equal(figures.rows[0].lineTax, 5);
  assert.equal(figures.total, 105);
});

test('the invoice uses checkout GST slabs for HSN-only lines', function () {
  var items = [
    { name: 'Rice', price: 100, qty: 1, hsn: '1006' },
    { name: 'Ghee', price: 100, qty: 1, hsn: '0405' },
    { name: 'Tea', price: 100, qty: 1, hsn: '0902' }
  ];
  var totals = pricing.computeTotals(items, '');
  var figures = invoice.computeInvoiceFigures(bill(items, ''));

  assert.deepEqual(totals.lines.map(function (line) { return line.gstPercent; }), [5, 12, 18]);
  assert.deepEqual(totals.lines.map(function (line) { return line.tax; }), [5, 12, 18]);
  assert.equal(totals.tax, 35);
  assert.equal(totals.total, 335);
  assert.deepEqual(figures.rows.map(function (row) { return row.hsn; }), ['1006', '0405', '0902']);
  assert.deepEqual(figures.rows.map(function (row) { return row.gstPercent; }), [5, 12, 18]);
  assert.deepEqual(figures.rows.map(function (row) { return row.lineTax; }), [5, 12, 18]);
  assert.equal(figures.tax, 35);
  assert.equal(figures.total, 335);
});

test('the invoice uses fractional and zero GST overrides as billed', function () {
  var items = [
    { name: 'Fractional rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 }
  ];
  var totals = pricing.computeTotals(items, '');
  var figures = invoice.computeInvoiceFigures(bill(items, ''));

  assert.deepEqual(totals.lines.map(function (line) { return line.gstPercent; }), [5, 0]);
  assert.deepEqual(totals.lines.map(function (line) { return line.tax; }), [5, 0]);
  assert.equal(totals.total, 205);
  assert.deepEqual(figures.rows.map(function (row) { return row.gstPercent; }), [5, 0]);
  assert.deepEqual(figures.rows.map(function (row) { return row.lineTax; }), [5, 0]);
  assert.equal(figures.tax, 5);
  assert.equal(figures.total, 205);
});

test('a percentage coupon matches both the billed total and GST in reconciliation', function () {
  var order = bill([{ name: 'Tea', price: 1000, qty: 1 }], 'WELCOME');
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [50, 171, 1121]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 171, 1121]);
  assert.equal(figures.rows[0].lineTax, 171);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
  assert.deepEqual(reports.getGstReconciliation({ orders: [order] }), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1001, date: '2021-11-15', customer: 'Walk-in', coupon: 'WELCOME',
      ledgerSubtotal: 1000, ledgerDiscount: 50, ledgerTax: 171, ledgerTotal: 1121,
      invoiceDiscount: 50, invoiceTax: 171, invoiceTotal: 1121, delta: 0, matched: true
    }]
  });
});

test('the invoice honors the billed cap on a percentage coupon', function () {
  var order = bill([{ name: 'Tea', price: 1000, qty: 2 }], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [150, 333, 2183]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [150, 333, 2183]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('the invoice calculates GST after applying a flat coupon', function () {
  var order = bill([{ name: 'Tea', price: 500, qty: 1 }], 'FLAT50');
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [50, 81, 531]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 81, 531]);
});

test('the invoice respects zero discounts on orders with expired or below-minimum coupons', function () {
  // These legacy orders retain coupon codes alongside the amounts the ledger recorded.
  var expiredOrder = bill([{ name: 'Tea', price: 1000, qty: 1 }], 'DIWALI20');
  var belowMinimumOrder = bill([{ name: 'Tea', price: 400, qty: 1 }], 'SAVE10');
  var expiredFigures = invoice.computeInvoiceFigures(expiredOrder);
  var belowMinimumFigures = invoice.computeInvoiceFigures(belowMinimumOrder);

  assert.deepEqual([expiredOrder.discount, expiredOrder.tax, expiredOrder.total], [0, 180, 1180]);
  assert.deepEqual([expiredFigures.discount, expiredFigures.tax, expiredFigures.total], [0, 180, 1180]);
  assert.deepEqual([belowMinimumOrder.discount, belowMinimumOrder.tax, belowMinimumOrder.total], [0, 72, 472]);
  assert.deepEqual([belowMinimumFigures.discount, belowMinimumFigures.tax, belowMinimumFigures.total], [0, 72, 472]);
});

test('the invoice keeps a recorded discount after a coupon expires', function () {
  var order = bill([{ name: 'Tea', price: 1000, qty: 1 }], '');
  order.coupon = 'DIWALI20';
  order.discount = 200;
  order.tax = 144;
  order.total = 944;

  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([figures.discount, figures.tax, figures.total], [200, 144, 944]);
  assert.equal(figures.rows[0].lineTax, 144);
});

test('the invoice uses coupon rules when a legacy order lacks a recorded discount', function () {
  var order = bill([{ name: 'Tea', price: 1000, qty: 1 }], 'WELCOME');
  delete order.discount;

  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 171, 1121]);
});

test('the invoice sums rounded line GST and matches the checkout split', function () {
  var items = [
    { name: 'First item', price: 0.03, qty: 1 },
    { name: 'Second item', price: 0.03, qty: 1 }
  ];
  var totals = pricing.computeTotals(items, '');
  var figures = invoice.computeInvoiceFigures(bill(items, ''));

  assert.deepEqual(totals.lines.map(function (line) { return line.tax; }), [0.01, 0.01]);
  assert.deepEqual([totals.tax, totals.cgst, totals.sgst, totals.total], [0.02, 0.01, 0.01, 0.08]);
  assert.deepEqual(figures.rows.map(function (row) { return row.lineTax; }), [0.01, 0.01]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [0.02, 0.01, 0.01, 0.08]);
});

test('the invoice and reconciliation report still flag a genuine ledger discrepancy', function () {
  var order = bill([{ name: 'Tea', price: 100, qty: 1 }], '');
  order.tax += 1;
  order.total += 1;

  assert.match(invoice.render(order), /Invoice computed total \(₹118\.00\) differs from Order Ledger recorded total \(₹119\.00\) by -₹1\.00\./);

  var report = reports.getGstReconciliation({ orders: [order] });
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.totalDelta, 1);
  assert.equal(report.rows[0].matched, false);
});
