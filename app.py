import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import time
from collections import defaultdict
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs
from wsgiref.simple_server import make_server

import operations
from billing import GSTIN, STATES, calculate, export, pdf
from gst_lookup import LookupUnavailable, live_lookup

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get('BILLLOCKER_DB', ROOT / 'data' / 'billlocker.sqlite3'))
ACTIVE_DB = ContextVar('billlocker_database', default=None)
PUBLIC_AUTH = ContextVar('billlocker_public_auth', default=False)
IST = timezone(timedelta(hours=5, minutes=30))
SESSION_AGE = 8 * 60 * 60
SCHEMA = '''
CREATE TABLE IF NOT EXISTS owner (email TEXT PRIMARY KEY, salt TEXT NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_gate (id INTEGER PRIMARY KEY CHECK (id = 1), start INTEGER, attempts INTEGER);
CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY, issuer TEXT NOT NULL, fy INTEGER NOT NULL, serial INTEGER NOT NULL,
    issue_date TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE (issuer, fy, serial)
);
'''


@contextmanager
def database():
    database_path = ACTIVE_DB.get() or DB
    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database_path, timeout=10)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize():
    with database() as db:
        db.executescript(SCHEMA + operations.SCHEMA)


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**15, r=8, p=1,
                          maxmem=64 * 1024 * 1024).hex()


def create_owner():
    initialize()
    email = input('Owner email: ').strip().lower()
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email) or len(email) > 254:
        raise SystemExit('Enter a valid email address.')
    password = getpass.getpass('Password (12 characters minimum): ')
    if not 12 <= len(password) <= 128 or password != getpass.getpass('Confirm password: '):
        raise SystemExit('Password length or confirmation is invalid.')
    salt = secrets.token_hex(16)
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT 1 FROM owner').fetchone():
            raise SystemExit('An owner account already exists.')
        db.execute('INSERT INTO owner VALUES (?, ?, ?)', (email, salt, password_hash(password, salt)))
    print('Owner account created.')


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def cookie_header(token, age):
    secure = '' if os.environ.get('BILLLOCKER_LOCAL_HTTP') == '1' else '; Secure'
    return 'Set-Cookie', f'billlocker_session={token}; Max-Age={age}; Path=/; HttpOnly; SameSite=Strict{secure}'


def body(env):
    if env.get('CONTENT_TYPE', '').split(';')[0] != 'application/json' or env.get('HTTP_X_BILLLOCKER') != '1':
        raise ValueError('Invalid request.')
    length = int(env.get('CONTENT_LENGTH') or '0')
    if not 1 <= length <= 65536:
        raise ValueError('Request size is invalid.')
    data = json.loads(env['wsgi.input'].read(length))
    if not isinstance(data, dict):
        raise ValueError('Invalid request data.')
    return data


def login(env, response):
    data = body(env)
    email, password = data.get('email'), data.get('password')
    if not isinstance(email, str) or not isinstance(password, str) or len(email) > 254 or len(password) > 128:
        raise ValueError('Invalid sign-in details.')
    now = int(time.time())
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        owner = db.execute('SELECT email, salt, password FROM owner').fetchone()
        if not owner:
            return response({'error': 'Run python app.py create-owner to set up the owner account.'}, '503 Service Unavailable')
        gate = db.execute('SELECT start, attempts FROM login_gate WHERE id = 1').fetchone()
        start, attempts = gate if gate and now - gate[0] < 60 else (now, 0)
        if attempts >= 8:
            return response({'error': 'Too many attempts. Try again in one minute.'}, '429 Too Many Requests')
        db.execute('INSERT OR REPLACE INTO login_gate VALUES (1, ?, ?)', (start, attempts + 1))
    actual = password_hash(password, owner[1])
    if not (hmac.compare_digest(actual, owner[2]) and owner[0] == email.strip().lower()):
        return response({'error': 'Email or password is incorrect.'}, '401 Unauthorized')
    token = secrets.token_urlsafe(32)
    with database() as db:
        db.execute('DELETE FROM sessions WHERE expires <= ?', (now,))
        db.execute('DELETE FROM login_gate')
        db.execute('INSERT INTO sessions VALUES (?, ?)', (digest(token), now + SESSION_AGE))
    return response({'ok': True}, extra=[cookie_header(token, SESSION_AGE)])


def token_from(env):
    cookie = SimpleCookie()
    try:
        cookie.load(env.get('HTTP_COOKIE', ''))
    except CookieError:
        return ''
    token = cookie.get('billlocker_session')
    return digest(token.value) if token else ''


def save(data):
    invoice = calculate(data)
    identifier = data.get('id')
    if not isinstance(identifier, str) or not re.fullmatch(r'[0-9a-f-]{36}', identifier):
        raise ValueError('Invalid invoice request ID. Refresh the page and try again.')
    issuer = invoice['seller_gstin'] or 'commercial'
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute('SELECT payload FROM invoices WHERE id = ?', (identifier,)).fetchone()
        if existing:
            prior = json.loads(existing[0])
            if any(prior[key] != value for key, value in invoice.items()):
                raise ValueError('This request already saved a different invoice. Refresh before creating another.')
            return prior
        serial = db.execute('SELECT COALESCE(MAX(serial), 0) + 1 FROM invoices WHERE issuer = ? AND fy = ?',
                            (issuer, invoice['fy'])).fetchone()[0]
        if serial > 999999:
            raise ValueError('This invoice series is full.')
        prefix = 'CI' if invoice['mode'] == 'no_gst' else 'BL'
        def number_exists(candidate):
            return db.execute("SELECT 1 FROM invoices WHERE issuer = ? AND fy = ? AND json_extract(payload, '$.number') = ?",
                              (issuer, invoice['fy'], candidate)).fetchone()

        candidate = invoice.get('invoice_number')
        if candidate and number_exists(candidate):
            raise ValueError('That invoice number is already used in this financial year.')
        if not candidate:
            candidate = f'{prefix}/{invoice["fy"]}/{serial:06d}'
            while number_exists(candidate):
                serial += 1
                if serial > 999999:
                    raise ValueError('This invoice series is full.')
                candidate = f'{prefix}/{invoice["fy"]}/{serial:06d}'
        invoice.update(id=identifier, number=candidate)
        operations.link_sale(db, invoice)
        db.execute('INSERT INTO invoices VALUES (?, ?, ?, ?, ?, ?)',
                   (identifier, issuer, invoice['fy'], serial, invoice['date'], json.dumps(invoice)))
    return invoice



def month_param(env):
    month = parse_qs(env.get('QUERY_STRING', '')).get('month', [''])[0]
    if not re.fullmatch(r'(?:19|20)[0-9]{2}-(0[1-9]|1[0-2])', month):
        raise ValueError('Choose a valid month.')
    return month


def sales_dashboard(month):
    year, number = map(int, month.split('-'))
    end = year * 12 + number - 1
    months = [f'{index // 12:04d}-{index % 12 + 1:02d}' for index in range(end - 11, end + 1)]
    totals = defaultdict(lambda: dict(count=0, sales=Decimal(0), gst=Decimal(0), payable=Decimal(0)))
    with database() as db:
        for issue_date, payload in db.execute('SELECT issue_date, payload FROM invoices WHERE issue_date BETWEEN ? AND ?',
                                              (months[0] + '-01', month + '-31')):
            invoice = json.loads(payload)
            summary = totals[issue_date[:7]]
            summary['count'] += 1
            for key, source in [('sales', 'taxable'), ('gst', 'tax'), ('payable', 'total')]:
                summary[key] += Decimal(invoice['totals'][source])
    return [{'month': period, **{key: str(value) if isinstance(value, Decimal) else value
                                for key, value in totals[period].items()}} for period in months]


def gst_details(data):
    raw, role = data.get('gstin'), data.get('role')
    gstin = raw.strip().upper() if isinstance(raw, str) else ''
    if role not in ('seller', 'buyer') or not re.fullmatch(GSTIN, gstin) or gstin[:2] not in STATES:
        raise ValueError('Enter a valid 15-character GSTIN.')
    with database() as db:
        row = db.execute('SELECT payload FROM invoices WHERE json_extract(payload, ?) = ? ORDER BY rowid DESC LIMIT 1',
                         (f'$.{role}_gstin', gstin)).fetchone()
    if row:
        prior = json.loads(row[0])
        return {'source': 'saved', 'name': prior[role], 'address': prior[f'{role}_address'], 'state': gstin[:2]}
    if data.get('online') is True:
        return {'state': gstin[:2], **live_lookup(gstin)}
    return {'source': 'state', 'state': gstin[:2]}

def application(env, start_response):
    def response(value, status='200 OK', mime='application/json; charset=utf-8', extra=()):
        payload = value if isinstance(value, bytes) else json.dumps(value).encode()
        start_response(status, [('Content-Type', mime), ('Content-Length', str(len(payload))),
                                ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                                ('X-Frame-Options', 'DENY'), ('Referrer-Policy', 'no-referrer'),
                                ('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"), *extra])
        return [payload]

    path, method = env['PATH_INFO'], env['REQUEST_METHOD']
    assets = {'/': ('index.html', 'text/html'), '/style.css': ('style.css', 'text/css'),
              '/logo.svg': ('logo.svg', 'image/svg+xml'), '/app.js': ('app.js', 'text/javascript'), '/operations.js': ('operations.js', 'text/javascript')}
    if method == 'GET' and path in assets:
        file, mime = assets[path]
        return response((ROOT / 'static' / file).read_bytes(), mime=f'{mime}; charset=utf-8')
    try:
        if method == 'POST' and path == '/api/login':
            return login(env, response)
        token = token_from(env)
        with database() as db:
            session = db.execute('SELECT 1 FROM sessions WHERE token_hash = ? AND expires > ?',
                                 (token, int(time.time()))).fetchone()
        if not session and not PUBLIC_AUTH.get():
            return response({'error': 'Sign in to continue.'}, '401 Unauthorized')
        if method == 'POST' and path == '/api/logout':
            body(env)
            with database() as db:
                db.execute('DELETE FROM sessions WHERE token_hash = ?', (token,))
            return response({'ok': True}, extra=[cookie_header('', 0)])
        if method == 'GET' and path == '/api/config':
            return response({'states': STATES, 'today': datetime.now(IST).date().isoformat()})
        if method == 'GET' and path == '/api/operations':
            with database() as db:
                return response(operations.overview(db))
        match = re.fullmatch(r'/api/operations/(party|item|purchase|expense|payment)', path)
        if method == 'POST' and match:
            data = body(env)
            with database() as db:
                saved = operations.add_payment(db, data) if match[1] == 'payment' else operations.add_record(db, match[1], data)
            return response(saved, '201 Created')
        if method == 'GET' and path == '/api/dashboard':
            return response(sales_dashboard(month_param(env)))
        if method == 'POST' and path == '/api/gstin':
            try:
                return response(gst_details(body(env)))
            except LookupUnavailable:
                return response({'error': 'Online GST lookup is unavailable. Verify the GSTIN on the GST portal.'},
                                '502 Bad Gateway')
        if method == 'POST' and path == '/api/calculate':
            return response(calculate(body(env)))
        if method == 'POST' and path == '/api/invoices':
            return response(save(body(env)), '201 Created')
        if method == 'GET' and path == '/api/invoices':
            with database() as db:
                rows = db.execute('SELECT payload FROM invoices ORDER BY rowid DESC LIMIT 100').fetchall()
            invoices = [json.loads(row[0]) for row in rows]
            defaults = {key: invoices[0][key] for key in ('seller', 'seller_address', 'seller_gstin', 'seller_state',
                        'bank', 'holder', 'account', 'ifsc', 'upi')} if invoices else {}
            summaries = [{key: invoice[key] for key in ('id', 'number', 'date', 'mode', 'buyer', 'totals')}
                         for invoice in invoices]
            return response({'invoices': summaries, 'defaults': defaults})
        match = re.fullmatch(r'/api/invoices/([0-9a-f-]{36})/pdf', path)
        if method == 'GET' and match:
            with database() as db:
                row = db.execute('SELECT payload FROM invoices WHERE id = ?', (match[1],)).fetchone()
            if row:
                invoice = json.loads(row[0])
                filename = invoice['number'].replace('/', '-') + '.pdf'
                return response(pdf(invoice), mime='application/pdf',
                                extra=[('Content-Disposition', f'attachment; filename="{filename}"')])
        match = re.fullmatch(r'/api/export/(sales|hsn|documents)', path)
        if method == 'GET' and match:
            period = month_param(env)
            with database() as db:
                rows = db.execute('SELECT payload FROM invoices WHERE substr(issue_date, 1, 7) = ? '
                                  'ORDER BY issue_date, issuer, serial', (period,)).fetchall()
            payload = export((json.loads(row[0]) for row in rows), match[1])
            return response(payload, mime='text/csv; charset=utf-8', extra=[
                ('Content-Disposition', f'attachment; filename="BillLocker-{match[1]}-{period}.csv"')])
    except (ValueError, UnicodeError) as error:
        return response({'error': str(error)}, '400 Bad Request')
    return response({'error': 'Page not found.'}, '404 Not Found')


if __name__ == '__main__':
    if sys.argv[1:] == ['create-owner']:
        create_owner()
    elif not sys.argv[1:]:
        initialize()
        os.environ['BILLLOCKER_LOCAL_HTTP'] = '1'
        print('BillLocker running at http://127.0.0.1:8000', flush=True)
        with make_server('127.0.0.1', 8000, application) as server:
            server.serve_forever()
    else:
        raise SystemExit('Usage: python app.py [create-owner]')
