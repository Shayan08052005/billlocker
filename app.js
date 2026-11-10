'use strict';
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));
const form = $('#invoice-form');
const login = $('#login-form');
const items = $('#items');
const money = new Intl.NumberFormat('en-IN', {style: 'currency', currency: 'INR'});
const modes = {gst: 'GST Tax Invoice', no_gst: 'Non-GST', supply: 'Bill of Supply'};
let requestId;
let authMode = 'login';
let calculationTimer;
let calculationRevision = 0;
let dashboardRevision = 0;
const lastFilled = {seller: {}, buyer: {}};
const lookupRevision = {seller: 0, buyer: 0};

async function api(path, data) {
  const options = data === undefined ? {} : {method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-BillLocker': '1',
  }, body: JSON.stringify(data)};
  const response = await fetch(path, options);
  if (response.status === 401 && !['/api/login', '/api/signup', '/api/recover'].includes(path)) showLogin();
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

function showLogin() {
  $('#login-page').hidden = false;
  $('#workspace').hidden = true;
  form.reset();
  items.replaceChildren();
  $('#history').replaceChildren();
  $('#totals').replaceChildren();
  $('#dashboard-rows').replaceChildren();
  $('#dashboard-summary').replaceChildren();
  dashboardRevision += 1;
  clearPartyLookup('seller');
  clearPartyLookup('buyer');
  $('#save-message').replaceChildren();
  login.reset();
  document.dispatchEvent(new Event('billlocker:close'));
  calculationRevision += 1;
}

function syncMode() {
  const mode = form.elements.mode.value;
  $('#seller-gstin-field').hidden = mode === 'no_gst';
  $('#seller-lookup-field').hidden = mode === 'no_gst';
  form.elements.seller_gstin.disabled = mode === 'no_gst';
  for (const key of ['seller_gstin', 'seller_state', 'pos']) form.elements[key].required = mode !== 'no_gst';
  $('#reverse-field').hidden = mode !== 'gst';
  $('#supply-field').hidden = mode !== 'supply';
  $$('.rate', form).forEach(cell => { cell.hidden = mode !== 'gst'; });
  $$('tr', items).forEach(row => {
    $('[name=hsn]', row).required = mode !== 'no_gst';
    $('[name=unit]', row).required = mode !== 'no_gst';
    $('[name=rate]', row).required = mode === 'gst';
  });
  const rows = $$('tr', items);
  rows.forEach(row => { $('.remove', row).disabled = rows.length === 1; });
  $('#add-item').disabled = rows.length >= 50;
}

function addItem() {
  items.append($('#item-template').content.cloneNode(true));
  syncMode();
  document.dispatchEvent(new Event('billlocker:line'));
}

function invoiceData() {
  const data = {};
  for (const element of form.elements) {
    if (element.name && !element.disabled && !items.contains(element)) data[element.name] = element.value;
  }
  data.items = $$('tr', items).map(row => Object.fromEntries($$('input, select', row).map(input => [input.name, input.value])));
  data.id = requestId;
  return data;
}

function renderTotals(invoice) {
  const labels = {taxable: 'Supply value', cgst: 'CGST', sgst: 'SGST', utgst: 'UTGST', igst: 'IGST', total: 'Amount payable'};
  const totals = $('#totals');
  totals.replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    if (!['taxable', 'total'].includes(key) && Number(invoice.totals[key]) === 0) continue;
    const row = document.createElement('div');
    const name = document.createElement('dt');
    const value = document.createElement('dd');
    name.textContent = label;
    value.textContent = money.format(invoice.totals[key]);
    row.append(name, value);
    totals.append(row);
  }
  $$('.line-total', items).forEach((cell, index) => { cell.textContent = money.format(invoice.items[index].total); });
}

function scheduleCalculation() {
  clearTimeout(calculationTimer);
  const revision = ++calculationRevision;
  $('#totals').replaceChildren();
  $$('.line-total', items).forEach(cell => { cell.textContent = '—'; });
  const message = $('#calculation-message');
  if (!form.checkValidity()) {
    message.textContent = 'Fill the required details to calculate totals.';
    return;
  }
  message.textContent = 'Calculating…';
  calculationTimer = setTimeout(async () => {
    try {
      const invoice = await api('/api/calculate', invoiceData());
      if (revision !== calculationRevision) return;
      renderTotals(invoice);
      message.textContent = invoice.reverse_charge ? 'Reverse charge applies. The amount payable to the supplier excludes GST.' : 'Totals calculated.';
    } catch (error) {
      if (revision === calculationRevision) message.textContent = error.message;
    }
  }, 250);
}

function pdfLink(invoice, text = 'Download PDF') {
  const link = document.createElement('a');
  link.href = `/api/invoices/${invoice.id}/pdf`;
  link.textContent = text;
  return link;
}

function renderHistory(invoices) {
  const history = $('#history');
  history.replaceChildren();
  if (!invoices.length) {
    const row = history.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 6;
    cell.textContent = 'No invoices yet.';
  }
  for (const invoice of invoices) {
    const row = history.insertRow();
    for (const value of [invoice.number, invoice.date, invoice.buyer, modes[invoice.mode], money.format(invoice.totals.total)]) {
      row.insertCell().textContent = value;
    }
    row.insertCell().append(pdfLink(invoice));
  }
}

function setExportLinks() {
  const month = $('#period').value;
  $$('[data-export]').forEach(link => {
    if (month) link.href = `/api/export/${link.dataset.export}?month=${encodeURIComponent(month)}`;
    else link.removeAttribute('href');
  });
}

function clearPartyLookup(role) {
  lookupRevision[role] += 1;
  for (const [key, value] of Object.entries(lastFilled[role])) {
    if (form.elements[key].value === value) form.elements[key].value = '';
  }
  lastFilled[role] = {};
  $(`#${role}-lookup-message`).replaceChildren();
}

async function lookupParty(role, online = false) {
  const input = form.elements[`${role}_gstin`];
  const gstin = input.value.trim().toUpperCase();
  const message = $(`#${role}-lookup-message`);
  const revision = ++lookupRevision[role];
  if (gstin.length !== 15) {
    if (online) message.textContent = 'Enter the 15-character GSTIN first.';
    return;
  }
  message.textContent = online ? 'Looking up registration…' : 'Checking saved details…';
  try {
    const result = await api('/api/gstin', {gstin, role, online});
    if (revision !== lookupRevision[role] || gstin !== input.value.trim().toUpperCase()) return;
    if (role === 'seller') form.elements.seller_state.value = result.state;
    if (['saved', 'live', 'test'].includes(result.source)) {
      for (const [key, value] of [[role, result.name], [`${role}_address`, result.address]]) {
        if (value && (!form.elements[key].value || lastFilled[role][key] === form.elements[key].value)) {
          form.elements[key].value = value;
          lastFilled[role][key] = value;
        }
      }
      if (result.source === 'saved') message.textContent = 'Found in your previous invoices. Review the details before issuing.';
      else {
        const origin = result.source === 'test' ? 'Sandbox test response' : 'Online registration';
        const status = result.status ? ` (${result.status})` : '';
        message.textContent = `${origin}${status}. ${result.name || ''} ${result.address || ''} Check the billing address.`;
      }
    } else {
      const state = form.elements.seller_state.querySelector(`option[value="${result.state}"]`)?.textContent || result.state;
      message.textContent = result.source === 'unconfigured' ? 'Online lookup needs an API connection. ' :
        result.source === 'not_found' ? 'No online registration found. ' : `GSTIN state ${state}. No saved details. `;
      const portal = document.createElement('a');
      portal.href = 'https://services.gst.gov.in/services/searchtp';
      portal.target = '_blank';
      portal.rel = 'noopener noreferrer';
      portal.textContent = 'Search on GST Portal';
      message.append(portal);
    }
    scheduleCalculation();
  } catch (error) {
    if (revision === lookupRevision[role]) message.textContent = error.message;
  }
}

async function refreshDashboard() {
  const month = $('#dashboard-month').value;
  if (!month) return;
  const revision = ++dashboardRevision;
  const message = $('#dashboard-message');
  message.textContent = '';
  try {
    const entries = await api(`/api/dashboard?month=${encodeURIComponent(month)}`);
    if (revision !== dashboardRevision) return;
    const rows = $('#dashboard-rows');
    const summary = $('#dashboard-summary');
    const selected = entries.at(-1);
    rows.replaceChildren();
    summary.replaceChildren();
    const cards = [['Invoices', selected.count], ['Sales before GST', money.format(selected.sales)],
      ['GST', money.format(selected.gst)], ['Payable', money.format(selected.payable)]];
    for (const [label, value] of cards) {
      const card = document.createElement('div');
      const title = document.createElement('dt');
      const figure = document.createElement('dd');
      title.textContent = label;
      figure.textContent = value;
      card.append(title, figure);
      summary.append(card);
    }
    const maximum = Math.max(1, ...entries.map(entry => Number(entry.sales)));
    for (const entry of [...entries].reverse()) {
      const row = rows.insertRow();
      for (const value of [entry.month, entry.count, money.format(entry.sales), money.format(entry.gst), money.format(entry.payable)]) {
        row.insertCell().textContent = value;
      }
      const bar = document.createElement('progress');
      bar.max = maximum;
      bar.value = Number(entry.sales);
      bar.setAttribute('aria-label', `Sales in ${entry.month}`);
      row.insertCell().append(bar);
    }
  } catch (error) {
    if (revision === dashboardRevision) message.textContent = error.message;
  }
}

async function openWorkspace() {
  const [config, records] = await Promise.all([api('/api/config'), api('/api/invoices')]);
  $$('.states').forEach(select => {
    select.length = 1;
    for (const [code, state] of Object.entries(config.states).sort(([a], [b]) => a.localeCompare(b))) {
      select.add(new Option(`${code} · ${state}`, code));
    }
  });
  form.elements.date.value = config.today;
  $('#period').value = config.today.slice(0, 7);
  $('#dashboard-month').value = $('#period').value;
  setExportLinks();
  for (const [key, value] of Object.entries(records.defaults)) form.elements[key].value = value;
  for (const key of ['seller', 'seller_address']) {
    if (records.defaults[key]) lastFilled.seller[key] = records.defaults[key];
  }
  items.replaceChildren();
  addItem();
  scheduleCalculation();
  requestId = crypto.randomUUID();
  renderHistory(records.invoices);
  $('#login-page').hidden = true;
  $('#workspace').hidden = false;
  document.dispatchEvent(new CustomEvent('billlocker:open', {detail: config.today}));
  refreshDashboard();
}

login.addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#auth-submit');
  const message = $('#login-message');
  message.textContent = '';
  button.disabled = true;
  try {
    const authResult = await api(`/api/${authMode}`, Object.fromEntries(new FormData(login)));
    if (authResult.recovery_key) {
      $('#recovery-key').value = authResult.recovery_key;
      $('#recovery-dialog').showModal();
    }
    await openWorkspace();
    login.reset();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', {});
    showLogin();
    $('#login-message').textContent = '';
  } catch (error) {
    const message = $('#workspace').hidden ? $('#login-message') : $('#save-message');
    message.textContent = error.message;
  }
});

form.addEventListener('input', event => {
  if (event.target === form.elements.mode) syncMode();
  scheduleCalculation();
});
$('#period').addEventListener('input', setExportLinks);
$('#dashboard-month').addEventListener('change', refreshDashboard);
for (const role of ['seller', 'buyer']) {
  const input = form.elements[`${role}_gstin`];
  input.addEventListener('input', () => {
    clearPartyLookup(role);
    if (role === 'seller') {
      for (const key of ['bank', 'holder', 'account', 'ifsc', 'upi']) form.elements[key].value = '';
      form.elements.seller_state.value = '';
    }
    if (input.value.trim().length === 15) lookupParty(role);
  });
  $(`[data-lookup=${role}]`).addEventListener('click', () => lookupParty(role, true));
}
$('#add-item').addEventListener('click', () => {
  addItem();
  scheduleCalculation();
  $('[name=description]', items.lastElementChild).focus();
});
items.addEventListener('click', event => {
  if (!event.target.matches('.remove')) return;
  event.target.closest('tr').remove();
  syncMode();
  scheduleCalculation();
  $('#add-item').focus();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('#save-message');
  const data = invoiceData();
  const enabled = Array.from(form.elements).filter(element => !element.disabled);
  enabled.forEach(element => { element.disabled = true; });
  message.classList.remove('ok');
  message.textContent = 'Issuing invoice…';
  let invoice;
  try {
    invoice = await api('/api/invoices', data);
    requestId = crypto.randomUUID();
    clearPartyLookup('buyer');
    for (const key of ['buyer', 'buyer_address', 'buyer_gstin', 'delivery_address', 'party_id', 'consignee', 'invoice_number', 'reference', 'payment_terms', 'notes', 'declaration']) form.elements[key].value = '';
    items.replaceChildren();
    addItem();
    message.classList.add('ok');
    message.replaceChildren(`Issued ${invoice.number}. `, pdfLink(invoice));
    document.dispatchEvent(new Event('billlocker:sale'));
    renderHistory((await api('/api/invoices')).invoices);
    refreshDashboard();
  } catch (error) {
    if (!invoice) message.textContent = error.message;
  } finally {
    enabled.forEach(element => { element.disabled = false; });
    syncMode();
    scheduleCalculation();
  }
});

openWorkspace().catch(error => {
  if (error.message !== 'Sign in to continue.') $('#login-message').textContent = error.message;
});

$$('[data-auth]').forEach(button => button.addEventListener('click', () => {
  authMode = button.dataset.auth;
  const titles = {login: 'Welcome back', signup: 'Create your account', recover: 'Recover your account'};
  const labels = {login: 'Login', signup: 'Create account', recover: 'Reset password'};
  $('#auth-heading').textContent = titles[authMode];
  $('#auth-description').textContent = authMode === 'recover' ? 'Enter your email, recovery key and a new password.' : 'Your business records belong to your account.';
  $('#auth-submit').textContent = labels[authMode];
  $('#recovery-field').hidden = authMode !== 'recover';
  login.elements.recovery_key.required = authMode === 'recover';
  login.elements.password.autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  $$('.auth-tabs button').forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.auth === authMode)));
  $('#login-message').textContent = '';
}));
$('#close-recovery').addEventListener('click', () => { $('#recovery-key').value = ''; $('#recovery-dialog').close(); });
$('#download-recovery').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob(['BillLocker recovery key\nKeep private\n\n' + $('#recovery-key').value], {type: 'text/plain'}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'BillLocker-Recovery-Key.txt';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
