"""Local synthetic browser acceptance. Start tests/browser-server.ts with with_server.py."""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

session = json.loads(Path('.artifacts/browser-session.json').read_text())
with sync_playwright() as p:
    executable = os.getenv('CHROMIUM_PATH')
    browser = p.chromium.launch(headless=True, **({'executable_path': executable} if executable else {}))
    context = browser.new_context(viewport={'width': 1280, 'height': 900})
    context.add_cookies([{'name': 'anymail_session', 'value': session['sid'], 'url': 'http://localhost:4379', 'httpOnly': True, 'sameSite': 'Lax'}])
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://localhost:4379')
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('heading', name='连接你的邮箱')).to_be_visible()
    expect(page.locator('#accounts')).to_have_value(session['account'])
    print('Rendered headings:', page.get_by_role('heading').all_text_contents())
    page.locator('#search input').fill('发票')
    page.locator('#search button').click()
    page.get_by_role('button', name='测试发票', exact=True).click()
    expect(page.locator('#message')).to_contain_text('Invoice 发票内容')
    page.locator('#draft input[name=to]').fill('synthetic-recipient@example.com')
    page.locator('#draft input[name=bcc]').fill('synthetic-bcc@example.com')
    page.locator('#draft input[name=subject]').fill('浏览器测试草稿')
    page.locator('#draft textarea').fill('这是测试夹具，不会连接真实邮箱。')
    page.locator('#draft button').click()
    expect(page.locator('#approval')).to_be_visible()
    page.screenshot(path='.artifacts/browser-desktop.png', full_page=True)
    page.locator('#approval').click()
    expect(page.get_by_role('heading', name='确认邮件发送')).to_be_visible()
    expect(page.locator('pre')).to_contain_text('synthetic-bcc@example.com')
    page.get_by_role('button', name='批准这份固定内容的发送').click()
    expect(page.get_by_role('heading', name='已批准')).to_be_visible()
    page.goto('http://localhost:4379')
    page.set_viewport_size({'width': 390, 'height': 844})
    page.wait_for_load_state('networkidle')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile horizontal overflow'
    page.screenshot(path='.artifacts/browser-mobile.png', full_page=True)
    assert not errors, errors
    print('PASS: synthetic mail search/read, draft/Bcc preview, trusted approval, desktop/mobile, no page errors')
    context.close()
    browser.close()
