'use strict';
let business = null;
let businessRevision = 0;
let businessToday = '';
const paymentsForm = $('[data-record=payment]');
const purchaseLines = $('#purchase-lines');
const sectionButtons = $$('[data-open]');

function switchPage(page) {
  $$('[data-page]').forEach(section => { section.hidden = section.dataset.page !== page; });
  sectionButtons.forEach(button => {
    if (button.dataset.open === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

sectionButtons.forEach(button => button.addEventListener('click', () => switchPage(button.dataset.open)));

function populate(select, entries, placeholder, label) {
  const previous = select.value;
  select.replaceChildren(new Option(placeholder, ''));
  entries.forEach(entry => select.add(new Option(label(entry), entry.id)));
  select.value = entries.some(entry => entry.id === previous) ? previous : '';
}

function refreshSelects() {
  const parties = business?.party ?? [];
  const catalogue = business?.item ?? [];
  $$('[data-parties], #statement-party').forEach(select => populate(select, parties, 'Choose a party',
    entry => `${entry.name}${entry.gstin ? ` · ${entry.gstin}` : ''}`));
  $$('[data-items]').forEach(select => populate(select, catalogue, select.required ? 'Choose an item' : 'Manual item',
    entry => entry.name));
}

function addPurchaseLine() {
  if (purchaseLines.children.length >= 50) return;
  purchaseLines.append($('#purchase-line-template').content.cloneNode(true));
  const line = purchaseLines.lastElementChild;
  $('.remove-purchase', line).addEventListener('click', () => {
    if (purchaseLines.children.length > 1) line.remove();
  });
  refreshSelects();
}

function renderTable(selector, values) {
  const target = $(selector);
  target.replaceChildren();
  if (!values.length) {
    const cell = target.insertRow().insertCell();
    cell.colSpan = target.closest('table').tHead.rows[0].cells.length;
    cell.textContent = 'No records to show.';
    return;
  }
  values.forEach(valuesForRow => {
    const row = target.insertRow();
    valuesForRow.forEach(value => { row.insertCell().textContent = value; });
  });
}

function paymentTargets() {
  if (!business) return;
  const incoming = paymentsForm.elements.direction.value === 'in';
  const records = incoming ? business.sales : business.purchase;
  populate(paymentsForm.elements.target, records.filter(entry => Number(entry.due) > 0), 'Choose an outstanding document',
    entry => `${incoming ? entry.number : entry.bill} · ${incoming ? entry.buyer : entry.party} · ${money.format(entry.due)} due`);
}

function sumAmounts(entries, key) {
  const paise = entries.reduce((total, entry) => {
    const [whole, fraction = ''] = String(entry[key]).split('.');
    return total + BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  }, 0n);
  return money.formatToParts(paise / 100n).map(part =>
    part.type === 'fraction' ? String(paise % 100n).padStart(2, '0') : part.value).join('');
}

function renderStatement() {
  if (!business) return;
  const party = $('#statement-party').value;
  const sales = new Map(business.sales.filter(entry => party && entry.party_id === party).map(entry => [entry.id, entry]));
  const buys = new Map(business.purchase.filter(entry => party && entry.party_id === party).map(entry => [entry.id, entry]));
  const rows = [...sales.values()].map(entry => [entry.date, 'Sale', entry.number, money.format(entry.amount)]);
  rows.push(...[...buys.values()].map(entry => [entry.date, 'Purchase', entry.bill, money.format(entry.amount)]));
  for (const entry of business.payments) {
    const document = entry.direction === 'in' ? sales.get(entry.target) : buys.get(entry.target);
    if (document) rows.push([entry.date, entry.direction === 'in' ? 'Payment in' : 'Payment out',
      `${document.number ?? document.bill} · ${entry.mode}`, money.format(entry.amount)]);
  }
  renderTable('#statement-rows', rows.sort((a, b) => a[0].localeCompare(b[0])));
}

function renderBusinessReport() {
  if (!business) return;
  const month = $('#report-month').value;
  const during = list => list.filter(entry => entry.date.slice(0, 7) === month);
  const summary = $('#business-summary');
  summary.replaceChildren();
  const stats = [['Invoiced sales', during(business.sales), 'amount'], ['Purchase bills', during(business.purchase), 'amount'],
    ['Payments received', during(business.payments).filter(entry => entry.direction === 'in'), 'amount'],
    ['Payments made', during(business.payments).filter(entry => entry.direction === 'out'), 'amount'],
    ['Expenses logged', during(business.expense), 'amount'], ['Receivable now', business.sales, 'due'],
    ['Payable now', business.purchase, 'due']];
  for (const [label, entries, key] of stats) {
    const tile = document.createElement('div');
    const term = document.createElement('dt');
    const definition = document.createElement('dd');
    term.textContent = label;
    definition.textContent = sumAmounts(entries, key);
    tile.append(term, definition);
    summary.append(tile);
  }
  const rows = [];
  for (const [direction, entries] of [['Receivable', business.sales], ['Payable', business.purchase]]) {
    for (const entry of entries.filter(record => Number(record.due) > 0)) {
      rows.push([entry.date, direction, entry.number ?? entry.bill, entry.buyer ?? entry.party,
        ...[entry.amount, entry.paid, entry.due].map(value => money.format(value))]);
    }
  }
  renderTable('#outstanding-rows', rows.sort((a, b) => a[0].localeCompare(b[0])));
}

async function refreshBusiness() {
  const revision = ++businessRevision;
  try {
    const data = await api('/api/operations');
    if (revision !== businessRevision) return;
    business = data;
    refreshSelects();
    paymentTargets();
    renderStatement();
    renderBusinessReport();
    const saleNames = new Map(business.sales.map(entry => [entry.id, entry.number]));
    const purchaseNames = new Map(business.purchase.map(entry => [entry.id, entry.bill]));
    renderTable('#party-rows', business.party.map(entry => [entry.name, entry.gstin || '—', entry.address,
      sumAmounts(business.sales.filter(sale => sale.party_id === entry.id), 'due'),
      sumAmounts(business.purchase.filter(buy => buy.party_id === entry.id), 'due')]));
    renderTable('#stock-rows', business.item.map(entry => [entry.name, entry.type, entry.hsn || '—', money.format(entry.price),
      entry.type === 'goods' ? `${entry.stock} ${entry.unit}` : '—']));
    renderTable('#purchase-rows', business.purchase.map(entry => [entry.bill, entry.date, entry.party,
      entry.items.map(line => `${line.quantity} ${line.unit} ${line.item}`).join(', '), money.format(entry.amount), money.format(entry.due)]));
    renderTable('#payment-rows', business.payments.map(entry => [entry.date, entry.direction === 'in' ? 'In' : 'Out',
      (entry.direction === 'in' ? saleNames : purchaseNames).get(entry.target), entry.mode, money.format(entry.amount), entry.note]));
    renderTable('#expense-rows', business.expense.map(entry => [entry.date, entry.category, entry.note, money.format(entry.amount)]));
  } catch (error) {
    if (revision === businessRevision) {
      $$('[data-record] [role=status]').forEach(status => { status.textContent = error.message; });
    }
  }
}

form.elements.party_id.addEventListener('change', event => {
  const selected = business?.party.find(entry => entry.id === event.target.value);
  if (!selected) return;
  clearPartyLookup('buyer');
  form.elements.buyer.value = selected.name;
  form.elements.buyer_gstin.value = selected.gstin;
  form.elements.buyer_address.value = selected.address;
  scheduleCalculation();
});
items.addEventListener('change', event => {
  if (event.target.name !== 'item_id') return;
  const selected = business?.item.find(entry => entry.id === event.target.value);
  if (!selected) return;
  const row = event.target.closest('tr');
  for (const [key, value] of Object.entries({description: selected.name, hsn: selected.hsn, unit: selected.unit,
    price: selected.price, rate: selected.rate})) {
    $(`[name=${key}]`, row).value = value;
  }
  scheduleCalculation();
});

$('#add-purchase-line').addEventListener('click', addPurchaseLine);
$('#statement-party').addEventListener('change', renderStatement);
$('#report-month').addEventListener('change', renderBusinessReport);
paymentsForm.elements.direction.addEventListener('change', paymentTargets);
for (const editor of $$('[data-record]')) {
  editor.addEventListener('submit', async event => {
    event.preventDefault();
    const type = editor.dataset.record;
    const fields = new FormData(editor);
    const data = Object.fromEntries(fields);
    if (type === 'purchase') data.items = Array.from(purchaseLines.children, line =>
      Object.fromEntries($$('input, select', line).map(input => [input.name, input.value])));
    const fingerprint = JSON.stringify(data);
    if (editor.dataset.lastInput !== fingerprint) editor.dataset.request = crypto.randomUUID();
    editor.dataset.lastInput = fingerprint;
    data.id = editor.dataset.request;
    const message = $('[role=status]', editor);
    const controls = Array.from(editor.elements).filter(element => !element.disabled);
    controls.forEach(element => { element.disabled = true; });
    message.textContent = 'Saving…';
    try {
      await api(`/api/operations/${type}`, data);
      editor.reset();
      delete editor.dataset.lastInput;
      delete editor.dataset.request;
      if (editor.elements.date) editor.elements.date.value = businessToday;
      if (type === 'purchase') {
        purchaseLines.replaceChildren();
        addPurchaseLine();
      }
      message.textContent = 'Saved.';
      await refreshBusiness();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      controls.forEach(element => { element.disabled = false; });
    }
  });
}

document.addEventListener('billlocker:open', event => {
  businessToday = event.detail;
  switchPage('dashboard');
  $$('[data-record] input[type=date]').forEach(input => { input.value = businessToday; });
  $('#report-month').value = businessToday.slice(0, 7);
  if (!purchaseLines.children.length) addPurchaseLine();
  refreshBusiness();
});
document.addEventListener('billlocker:close', () => {
  businessRevision += 1;
  business = null;
  for (const editor of $$('[data-record]')) {
    editor.reset();
    delete editor.dataset.lastInput;
    delete editor.dataset.request;
    $('[role=status]', editor).replaceChildren();
  }
  purchaseLines.replaceChildren();
  for (const id of ['party-rows', 'stock-rows', 'purchase-rows', 'payment-rows', 'expense-rows', 'statement-rows', 'outstanding-rows', 'business-summary']) {
    $(`#${id}`).replaceChildren();
  }
  paymentsForm.elements.target.replaceChildren();
  refreshSelects();
});
document.addEventListener('billlocker:line', refreshSelects);
document.addEventListener('billlocker:sale', refreshBusiness);

$('#quick-invoice').addEventListener('click', () => switchPage('sales'));
