"""End-to-end public demo: generated config, real OIDC, exact consent, fake submission."""
import os
import queue
import re
import subprocess
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

process = subprocess.Popen(['node', 'scripts/demo.mjs', 'walk'], stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True)
lines = queue.Queue()
def read_lines():
    for line in process.stdout:
        lines.put(line.strip())
threading.Thread(target=read_lines, daemon=True).start()
def wait_line(prefix):
    for _ in range(20):
        line = lines.get(timeout=30)
        if line.startswith(prefix):
            return line[len(prefix):]
    raise AssertionError('Expected workflow stage: '+prefix)

try:
    password = re.search(r'^Password: (.+)$', Path('.artifacts/demo/login.txt').read_text(), re.M)[1]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'))
        context = browser.new_context()
        page = context.new_page()
        page.goto(wait_line('Sign in as demo: '))
        page.locator('#username').fill('demo')
        page.locator('#password').fill(password)
        page.locator('#kc-login').click()
        page.wait_for_url('http://127.0.0.1:4482/callback?**')
        assert wait_line('Search/read: ') == 'Invoice demo-001 (synthetic)'
        approval = wait_line('Review and approve: ')
        # CLI authentication does not mint an approval cookie or approve anything.
        unauthenticated = page.request.get(approval, max_redirects=0)
        assert unauthenticated.status == 302
        assert unauthenticated.headers['location'] == '/auth/login'
        assert not any(c['name'] == 'anymail_session' for c in context.cookies())
        assert page.request.post('http://localhost:4480/api/accounts/connect', data={}).status == 403
        assert page.request.post('http://localhost:4480/api/oauth/start', data={}).status == 403
        page.goto('http://localhost:4480/auth/login')
        page.wait_for_url('http://localhost:4480/connect')
        me = page.request.get('http://localhost:4480/api/me').json()
        assert me['principal']['subject'] == 'a5a8c029-96a0-4ea7-9449-50178ef90ed1'
        page.goto(approval)
        expect(page.get_by_role('heading', name='Approve email submission')).to_be_visible()
        expect(page.locator('main')).to_contain_text('recipient@example.test')
        expect(page.locator('main')).to_contain_text('Synthetic demo reply')
        page.get_by_role('button', name='Approve this exact message').click()
        expect(page.get_by_role('heading', name='Submission approved')).to_be_visible()
        assert wait_line('Completed: ') == 'synthetic provider_accepted; no real mail delivered.'
        assert process.wait(timeout=10) == 0
        context.close()
        browser.close()
    print('PASS: public demo search/read/draft, real OIDC/PKCE, separate browser consent and persisted simulated submission')
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
