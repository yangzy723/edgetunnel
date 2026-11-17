"""Shared primary state, authentication, conflicts and browser-private histories."""
import json, os, subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from backend import Backend
root = Path(__file__).resolve().parents[2]
subprocess.run(['python3', str(root/'eat/build.py'), '--mode','standalone'],check=True)
html = json.loads((root/'dist/standalone/_worker.js/draw-page.js').read_text().splitlines()[0].removeprefix('export const DRAW_HTML = ').removesuffix(';'))
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROME_BIN'),headless=True)
    backend=Backend(browser,root)
    api=backend.request
    assert api(missing=True)['status']==503
    assert api('auth',missing=True)['status']==503
    backend.page.evaluate("env.DRAW_ADMIN_PASSWORD=''")
    assert api('auth')['data']['code']=='AUTH_NOT_CONFIGURED'
    backend.page.evaluate("env.DRAW_ADMIN_PASSWORD='test-only-secret'")
    assert api(method='DELETE')['status']==405
    current=api()['data']
    assert len(current['config']['gifts'])==6
    assert api(headers={'If-None-Match':'"draw-config-weighted-v1-1"'})['status']==304
    assert api(method='PUT',data=current)['status']==401
    assert api('auth','POST',{'password':'test-only-secret'}, {'Content-Type':'application/json','Origin':'https://elsewhere.test'})['status']==403
    assert api('auth','POST',{'password':'wrong'})['status']==401
    assert api('auth','POST',{'password':'x'*25000})['status']==413
    login=api('auth','POST',{'password':'test-only-secret'})
    assert login['status']==200
    cookie=login['headers']['set-cookie']
    assert all(flag in cookie for flag in ['HttpOnly','Secure','SameSite=Strict'])
    auth={'Content-Type':'application/json','Cookie':cookie.split(';')[0]}
    assert api('auth',headers=auth)['data']['authenticated']
    assert not api('auth',headers={'Cookie':auth['Cookie']+'x'})['data']['authenticated']
    assert api(method='PUT',data={'revision':1,'config':{}},headers=auth)['status']==400
    assert api(method='PUT',data=current,headers=auth)['status']==200
    assert api(method='PUT',data=current,headers=auth)['status']==409
    # Rotation revokes existing sessions.
    backend.page.evaluate("env.DRAW_ADMIN_PASSWORD='rotated-test-secret'")
    assert api(method='PUT',data=current,headers=auth)['status']==401
    backend.page.evaluate("env.DRAW_ADMIN_PASSWORD='test-only-secret'")
    for _ in range(10):
        assert api('auth','POST',{'password':'wrong'})['status']==401
    assert api('auth','POST',{'password':'test-only-secret'})['status']==429
    backend.connection.execute('DELETE FROM draw_auth_attempts'); backend.connection.commit()
    # Anonymous credentials are required, and concurrent retries claim exactly one result.
    assert api('draw','POST')['data']['code']=='VISITOR_REQUIRED'
    visitor=api('participation')
    visitor_cookie=visitor['headers']['set-cookie'].split(';')[0]
    assert all(flag in visitor['headers']['set-cookie'] for flag in ['HttpOnly','Secure','SameSite=Strict'])
    results=backend.page.evaluate("""async cookie => Promise.all(Array.from({length:8},async()=>{
      const request=new Request('https://draw.test/draw/api/draw',{method:'POST'});
      Object.defineProperty(request,'headers',{value:new Headers({Cookie:cookie})});
      const response=await api(request,env); return response.json();
    }))""",visitor_cookie)
    assert sum(not result['alreadyDrawn'] for result in results)==1
    assert all(result['winner']==results[0]['winner'] and result['time']==results[0]['time'] for result in results)
    assert api('participation',headers={'Cookie':visitor_cookie})['data']['result']['winner']==results[0]['winner']
    assert api('participation')['data']['result'] is None
    contexts=[browser.new_context(reduced_motion='reduce') for _ in range(2)]
    errors=[]
    def serve(route):
        path=urlparse(route.request.url).path
        if path.startswith('/draw/api/'): backend.route(route)
        elif path.startswith('/draw/images/'): route.fulfill(path=str(root/'dist/standalone'/path.lstrip('/')))
        else: route.fulfill(content_type='text/html',body=html)
    pages=[]
    for context in contexts:
        context.route('https://draw.test/**',serve)
        page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto('https://draw.test/draw'); expect(page.locator('#draw-button')).to_be_enabled()
        pages.append(page)
    # If the response is lost after committing, reopening recovers the same award.
    recovery=browser.new_context(reduced_motion='reduce');recovery.route('https://draw.test/**',serve)
    lost=recovery.new_page();lost.goto('https://draw.test/draw');expect(lost.locator('#draw-button')).to_be_enabled()
    def lose_response(route):
        backend.request('draw','POST',headers=route.request.all_headers())
        route.fulfill(status=503,json={'error':'response lost'})
    lost.route('**/draw/api/draw',lose_response)
    lost.locator('#draw-button').click();expect(lost.locator('#retry-sync')).to_be_visible()
    lost.reload();expect(lost.locator('#draw-label')).to_have_text('已参与抽奖')
    expect(lost.locator('.history-item')).to_have_count(1)
    recovery.close()
    a,b=pages
    def settings(page):
        page.locator('#open-settings').click()
        page.locator('#admin-password').fill('test-only-secret')
        page.locator('#auth-form [type=submit]').click()
        expect(page.locator('#settings')).to_be_visible()
    settings(a); settings(b)
    a.locator('[name=name]').first.fill('全局新礼品')
    a.locator('#settings .save-button').click();expect(a.locator('#settings')).not_to_be_visible()
    b.locator('[name=name]').first.fill('另一设备草稿')
    b.locator('#settings .save-button').click()
    expect(b.locator('#settings-error')).to_contain_text('其他管理员')
    expect(b.locator('[name=name]').first).to_have_value('另一设备草稿')
    assert api()['data']['config']['gifts'][0]['name']=='全局新礼品'
    b.on('dialog',lambda dialog:dialog.accept())
    b.locator('#reload-settings').click()
    expect(b.locator('[name=name]').first).to_have_value('全局新礼品')
    # Expired session must keep the draft through reauthentication.
    b.locator('[name=name]').first.fill('重新验证后保存')
    contexts[1].clear_cookies()
    b.locator('#settings .save-button').click();expect(b.locator('#reauth')).to_be_visible()
    b.locator('#reauth').click();b.locator('#admin-password').fill('test-only-secret')
    b.locator('#auth-form [type=submit]').click();expect(b.locator('#auth-dialog')).not_to_be_visible()
    expect(b.locator('[name=name]').first).to_have_value('重新验证后保存')
    b.locator('#settings .save-button').click();expect(b.locator('#settings')).not_to_be_visible()
    a.evaluate('window.dispatchEvent(new Event("focus"))')
    expect(a.locator('.prize-card h3').first).to_have_text('重新验证后保存')
    a.locator('#draw-button').click();expect(a.locator('.history-item')).to_have_count(1)
    expect(b.locator('.history-item')).to_have_count(0)
    original=a.locator('#result-title').inner_text()
    a.evaluate('localStorage.removeItem(HISTORY_KEY)')
    a.reload();expect(a.locator('.history-item')).to_have_count(1)
    expect(a.locator('#result-title')).to_have_text(original)
    tab=contexts[0].new_page();tab.goto('https://draw.test/draw')
    expect(tab.locator('#result-title')).to_have_text(original)
    expect(tab.locator('#draw-button')).to_be_disabled()
    tab.close()
    expect(a.locator('#draw-button')).to_be_disabled()
    expect(a.locator('#draw-label')).to_have_text('已参与抽奖')
    # A still-open stale page is checked against the latest primary state when drawing.
    current=api()['data'];current['config']['activityEnabled']=False
    assert api(method='PUT',data=current,headers=auth)['status']==200
    b.locator('#draw-button').click();expect(b.locator('#toast')).to_contain_text('暂停')
    expect(a.locator('.history-item')).to_have_count(1)
    expect(a.locator('#draw-button')).to_be_disabled()
    b.evaluate('window.dispatchEvent(new Event("focus"))');expect(b.locator('#draw-button')).to_be_disabled()
    current=api()['data'];current['config']['activityEnabled']=True
    for gift in current['config']['gifts']:gift['enabled']=False
    assert api(method='PUT',data=current,headers=auth)['status']==200
    visitor_cookie=api('participation')['headers']['set-cookie'].split(';')[0]
    assert api('draw','POST',headers={'Cookie':visitor_cookie})['data']['code']=='EMPTY'
    b.reload();expect(b.locator('#cloud-message')).to_contain_text('好礼已就绪')
    expect(b.locator('.prize-card')).to_have_count(0)
    # A paused/removed prize cannot erase or change an existing award.
    saved=api('draw','POST',headers={'Cookie':visitor['headers']['set-cookie'].split(';')[0]})
    assert saved['data']['alreadyDrawn'] and saved['data']['winner']==results[0]['winner']
    assert len(api()['data']['config']['gifts'])==6
    assert set(api()['data'])=={'config','revision','updatedAt'}
    assert {r[0] for r in backend.connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}=={'draw_config','draw_auth_attempts','draw_visitors'}
    # Offline initialization cannot use a legacy local prize pool.
    b.route('**/draw/api/config',lambda route:route.fulfill(status=503,json={'error':'offline'}))
    b.reload();expect(b.locator('#retry-sync')).to_be_visible();expect(b.locator('#draw-button')).to_be_disabled()
    assert not errors,errors
    backend.close();browser.close()
print('PASS: real API/SQLite/runtime secret; primary reads; anonymous single draw; concurrent retries; lost-response recovery; authentication/cookie/rotation/throttling; CAS; two-device sync; reauth drafts; private histories; stale/paused/empty/offline draw protection')
