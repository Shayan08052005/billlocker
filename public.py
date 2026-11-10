"""Public, isolated-account entry point for BillLocker."""
import json
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path
from contextlib import contextmanager

import app

DATA = Path(os.environ.get('BILLLOCKER_DATA_DIR', str(app.ROOT / 'data' / 'public')))


@contextmanager
def accounts():
    DATA.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DATA / 'accounts.sqlite3', timeout=20)
    try:
        with db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
                salt TEXT NOT NULL, password TEXT NOT NULL, recovery TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);
            ''')
            yield db
    finally:
        db.close()


def respond(start, value, status='200 OK', headers=()):
    content = json.dumps(value).encode()
    start(status, [('Content-Type', 'application/json'), ('Content-Length', str(len(content))),
                   ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                   ('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'"), *headers])
    return [content]


def throttle(db, key):
    now = int(time.time())
    db.execute('DELETE FROM attempts WHERE start < ?', (now - 600,))
    prior = db.execute('SELECT start, count FROM attempts WHERE key = ?', (key,)).fetchone()
    start, count = prior if prior else (now, 0)
    if count >= 10:
        return False
    db.execute('INSERT OR REPLACE INTO attempts VALUES (?, ?, ?)', (key, start, count + 1))
    return True


def credentials(data):
    email, password = data.get('email'), data.get('password')
    if not isinstance(email, str) or len(email) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
        raise ValueError('Enter a valid email address.')
    if not isinstance(password, str) or not 12 <= len(password) <= 128:
        raise ValueError('Use a password with 12 to 128 characters.')
    return email.strip().lower(), password


def authenticate(env, start, signup=False, recovery=False):
    data = app.body(env)
    email, password = credentials(data)
    with accounts() as db:
        db.execute('BEGIN IMMEDIATE')
        if not throttle(db, app.digest(email)):
            return respond(start, {'error': 'Too many attempts. Try again in ten minutes.'}, '429 Too Many Requests')
    with accounts() as db:
        user = db.execute('SELECT id, salt, password, recovery FROM users WHERE email = ?', (email,)).fetchone()
    salt = user[1] if user else '00' * 16
    actual = app.password_hash(password, salt)
    recovery_key = None
    if signup:
        if user:
            raise ValueError('Account already exists. Sign in or recover your account.')
        user_id = secrets.token_hex(16)
        salt = secrets.token_hex(16)
        password_digest = app.password_hash(password, salt)
        recovery_key = secrets.token_urlsafe(32)
        # Initialize private data before making the account available.
        token = app.ACTIVE_DB.set(DATA / 'users' / user_id / 'billing.sqlite3')
        try:
            app.initialize()
        finally:
            app.ACTIVE_DB.reset(token)
        try:
            with accounts() as db:
                db.execute('INSERT INTO users VALUES (?, ?, ?, ?, ?)',
                           (user_id, email, salt, password_digest, app.digest(recovery_key)))
        except sqlite3.IntegrityError as error:
            raise ValueError('Account already exists. Sign in instead.') from error
    elif recovery:
        key = data.get('recovery_key', '')
        if not isinstance(key, str) or len(key) > 128 or not user or not secrets.compare_digest(user[3], app.digest(key)):
            return respond(start, {'error': 'Email or recovery key is incorrect.'}, '401 Unauthorized')
        user_id = user[0]
        salt = secrets.token_hex(16)
        new_digest = app.password_hash(password, salt)
        recovery_key = secrets.token_urlsafe(32)
        with accounts() as db:
            db.execute('BEGIN IMMEDIATE')
            changed = db.execute('UPDATE users SET salt = ?, password = ?, recovery = ? WHERE id = ? AND recovery = ?',
                                 (salt, new_digest, app.digest(recovery_key), user_id, user[3])).rowcount
            if changed != 1:
                raise ValueError('Recovery key already used. Use your latest recovery key.')
            db.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
    else:
        if not user or not secrets.compare_digest(actual, user[2]):
            return respond(start, {'error': 'Email or password is incorrect.'}, '401 Unauthorized')
        user_id = user[0]
    session = secrets.token_urlsafe(32)
    with accounts() as db:
        db.execute('DELETE FROM sessions WHERE expires <= ?', (int(time.time()),))
        db.execute('INSERT INTO sessions VALUES (?, ?, ?)', (app.digest(session), user_id, int(time.time()) + app.SESSION_AGE))
    value = {'ok': True}
    if recovery_key:
        value['recovery_key'] = recovery_key
    return respond(start, value, headers=[app.cookie_header(session, app.SESSION_AGE)])


def application(env, start):
    path, method = env['PATH_INFO'], env['REQUEST_METHOD']
    if path == '/health' and method == 'GET':
        return respond(start, {'status': 'ok'})
    if not path.startswith('/api/'):
        if method == 'GET' and path in ('/', '/style.css', '/app.js', '/operations.js', '/logo.svg'):
            return app.application(env, start)
        return respond(start, {'error': 'Page not found.'}, '404 Not Found')
    try:
        if method == 'POST' and path in ('/api/login', '/api/signup', '/api/recover'):
            return authenticate(env, start, signup=path == '/api/signup', recovery=path == '/api/recover')
        session = app.token_from(env)
        with accounts() as db:
            user = db.execute('SELECT user_id FROM sessions WHERE token = ? AND expires > ?',
                              (session, int(time.time()))).fetchone()
        if not user:
            return respond(start, {'error': 'Sign in to continue.'}, '401 Unauthorized')
        if path == '/api/logout' and method == 'POST':
            app.body(env)
            with accounts() as db:
                db.execute('DELETE FROM sessions WHERE token = ?', (session,))
            return respond(start, {'ok': True}, headers=[app.cookie_header('', 0)])
        db_token = app.ACTIVE_DB.set(DATA / 'users' / user[0] / 'billing.sqlite3')
        auth_token = app.PUBLIC_AUTH.set(True)
        try:
            app.initialize()
            return app.application(env, start)
        finally:
            app.PUBLIC_AUTH.reset(auth_token)
            app.ACTIVE_DB.reset(db_token)
    except (ValueError, UnicodeError) as error:
        return respond(start, {'error': str(error)}, '400 Bad Request')


if __name__ == '__main__':
    from wsgiref.simple_server import make_server
    os.environ['BILLLOCKER_LOCAL_HTTP'] = '1'
    print('BillLocker running at http://127.0.0.1:8000', flush=True)
    with make_server('127.0.0.1', 8000, application) as server:
        server.serve_forever()
