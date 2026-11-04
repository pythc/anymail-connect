"""Browser regressions for the two human authorization boundaries; synthetic data only."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

session = json.loads(Path('.artifacts/browser-session.json').read_text())
base = 'http://localhost:4379'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'))
    context = browser.new_context(viewport={'width': 1280, 'height': 900})
    context.add_cookies([{'name':'anymail_session','value':session['sid'],'url':base,'httpOnly':True,'sameSite':'Lax'}])
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error:errors.append(str(error)))
    page.goto(base+'/connect')
    expect(page.locator('html')).to_have_attribute('lang','en')
    expect(page.get_by_role('heading',name='Connect a mailbox')).to_be_visible()
    expect(page.locator('#authorization')).to_be_enabled()
    assert page.locator('#search, #draft, #messages').count() == 0
    expect(page.locator('[name=writable]')).not_to_be_checked()
    expect(page.locator('[name=sendEnabled]')).not_to_be_checked()
    requests = []
    def authorize(route):
        requests.append(route.request.post_data_json)
        route.fulfill(status=200,content_type='application/json',body=json.dumps({'url':base+'/connect?authorized=1'}))
    page.route('**/api/oauth/start',authorize)
    page.get_by_role('button',name='Continue to provider').click()
    page.wait_for_url(base+'/connect?authorized=1')
    assert requests == [{'provider':'gmail','writable':False,'sendEnabled':False}], requests
    expect(page.locator('#authorization')).to_be_enabled()
    page.locator('[name=sendEnabled]').check()
    page.get_by_role('button',name='Continue to provider').click()
    expect(page.locator('#status')).to_contain_text('Sending requires mail changes')
    assert len(requests) == 1
    page.locator('[name=sendEnabled]').uncheck()
    page.locator('[name=mailbox]').fill('shared@example.com')
    page.get_by_role('button',name='Continue to provider').click()
    expect(page.locator('#status')).to_contain_text('only for Microsoft')
    assert len(requests) == 1
    page.locator('[name=provider]').select_option('graph')
    page.locator('[name=writable]').check()
    page.get_by_role('button',name='Continue to provider').click()
    expect(page.locator('#authorization')).to_be_enabled()
    assert requests[-1] == {'provider':'graph','writable':True,'sendEnabled':False,'mailbox':'shared@example.com'}, requests
    page.unroute('**/api/oauth/start',authorize)
    page.goto(base+'/approve/'+session['operation'])
    expect(page.get_by_role('heading',name='Approve email submission')).to_be_visible()
    expect(page.locator('main')).to_contain_text('test@example.com')
    expect(page.locator('pre')).to_contain_text('synthetic-bcc@example.com')
    expect(page.locator('pre')).to_contain_text('<script>alert(1)</script>')
    assert page.locator('script').count() == 0
    expect(page.locator('main')).to_contain_text('SHA-256:')
    expect(page.get_by_role('link',name='invoice<1>.txt')).to_be_visible()
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Approval overflow'
    page.screenshot(path='.artifacts/approval-mobile.png',full_page=True)
    page.get_by_role('button',name='Approve this exact message').click()
    expect(page.get_by_role('heading',name='Submission approved')).to_be_visible()
    page.goto(base+'/message/'+session['account']+'/m1')
    expect(page.locator('pre')).to_contain_text('Invoice 发票内容')
    page.goto(base+'/connect')
    expect(page.get_by_role('button',name='Sign out')).to_be_enabled()
    page.get_by_role('button',name='Sign out').click()
    expect(page.locator('#status')).to_contain_text('Sign in to authorize')
    expect(page.locator('#authorization')).to_be_disabled()
    assert page.request.get(base+'/api/me').status == 401
    assert page.request.get(base+'/').json()['mcp'] == '/mcp'
    assert page.request.get(base+'/app.js').status == 404
    assert not errors, errors
    print('PASS: read-only OAuth defaults, explicit Microsoft delegation, consent payload, escaped sender/Bcc/attachment-bound approval, source links and logout')
    context.close()
    browser.close()
