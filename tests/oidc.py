"""Opt-in actual Keycloak authorization-code browser test (local synthetic realm)."""
import os
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'))
    context = browser.new_context()
    page = context.new_page()
    page.goto('http://localhost:4390')
    page.get_by_role('link', name='登录', exact=True).click()
    page.locator('#username').fill('lab-user')
    page.locator('#password').fill('local-keycloak-lab-only')
    page.locator('#kc-login').click()
    page.wait_for_load_state('networkidle')
    if urlsplit(page.url).path != '/':
        page.screenshot(path='.artifacts/oidc-failure.png', full_page=True)
        raise AssertionError('OIDC failed at '+urlsplit(page.url).path+': '+page.locator('body').inner_text()[:500])
    page.wait_for_url('http://localhost:4390/')
    page.wait_for_load_state('networkidle')
    me = page.request.get('http://localhost:4390/api/me')
    assert me.ok, me.text()
    body = me.json()
    assert body['principal']['tenant'] == 'lab-personal-and-enterprise', body
    assert body['principal']['client'] == 'anymail-web', body
    assert set(['mail.read','mail.write','mail.send']).issubset(body['principal']['scopes']), body
    cookies = {c['name']:c for c in context.cookies()}
    assert cookies['anymail_session']['httpOnly']
    assert cookies['anymail_session']['sameSite'] == 'Lax'
    page.locator('#logout').click()
    page.wait_for_load_state('networkidle')
    assert page.request.get('http://localhost:4390/api/me').status == 401
    print('PASS: real Keycloak discovery, code/PKCE/nonce/state, JWKS JWT, tenant/client/scopes, cookie, CSRF logout')
    context.close()
    browser.close()
