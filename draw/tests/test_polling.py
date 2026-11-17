"""Advance browser time to check request budgets and recovery with the real API."""
import json, os, subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from backend import Backend

root=Path(__file__).resolve().parents[2]
subprocess.run(['python3',str(root/'eat/build.py'),'--mode','standalone'],check=True)
html=json.loads((root/'dist/standalone/_worker.js/draw-page.js').read_text().splitlines()[0].removeprefix('export const DRAW_HTML = ').removesuffix(';'))
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROME_BIN'),headless=True)
    backend=Backend(browser,root)
    page=browser.new_page(reduced_motion='reduce')
    page.clock.install(time=0)
    page.clock.pause_at(1000)
    calls=[]; errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    def serve(route):
        path=urlparse(route.request.url).path
        if path.startswith('/draw/api/'):
            calls.append(path)
            backend.route(route)
        elif path.startswith('/draw/images/'):
            route.fulfill(path=str(root/'dist/standalone'/path.lstrip('/')))
        else:route.fulfill(content_type='text/html',body=html)
    page.route('https://draw.test/**',serve)
    page.goto('https://draw.test/draw')
    expect(page.locator('#draw-button')).to_be_enabled()
    # Settle any initial focus event without waiting in wall-clock time.
    page.clock.fast_forward(500);page.evaluate('syncTask')
    baseline=len(calls)
    page.clock.fast_forward(50000);page.evaluate('syncTask')
    assert len(calls)==baseline, calls
    for _ in range(10):
        before=len(calls)
        page.clock.fast_forward(75000);page.evaluate('syncTask')
        assert calls[before:]==['/draw/api/config'],calls[before:]
    # Hidden tabs use no background requests.
    page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.testHidden});window.testHidden=true;document.dispatchEvent(new Event('visibilitychange'))")
    before=len(calls)
    page.clock.fast_forward(300000);page.evaluate('syncTask')
    assert len(calls)==before
    # A browser foreground transition often emits both events: make one sync.
    page.evaluate("window.testHidden=false;window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'))")
    page.clock.fast_forward(300);page.evaluate('syncTask')
    assert calls[before:]==['/draw/api/config','/draw/api/participation'],calls[before:]
    # Repeated explicit retries while offline keep the error UI without uncaught errors.
    page.route('**/draw/api/config',lambda route:route.fulfill(status=503,json={'error':'offline'}))
    page.evaluate('syncConfig()')
    expect(page.locator('#retry-sync')).to_be_visible()
    page.locator('#retry-sync').click();page.evaluate('syncTask?.catch(()=>{})')
    expect(page.locator('#draw-button')).to_be_disabled()
    page.unroute('**/draw/api/config')
    page.locator('#retry-sync').click()
    expect(page.locator('#draw-button')).to_be_enabled()
    # A server-completed draw with a lost response is recovered by the next poll.
    def lost_response(route):
        calls.append('/draw/api/draw')
        backend.request('draw','POST',headers=route.request.all_headers())
        route.fulfill(status=503,json={'error':'response lost'})
    page.route('**/draw/api/draw',lost_response)
    page.locator('#draw-button').click()
    expect(page.locator('#retry-sync')).to_be_visible()
    before=len(calls)
    page.clock.fast_forward(75000);page.evaluate('syncTask')
    expect(page.locator('#draw-label')).to_have_text('已参与抽奖')
    assert calls[before:]==['/draw/api/config','/draw/api/participation']
    # Once a result is known, neither timers nor foreground events cause reads.
    before=len(calls)
    for _ in range(10):
        page.clock.fast_forward(75000)
        page.evaluate("window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'))")
        page.clock.fast_forward(300)
    assert len(calls)==before,calls[before:]
    expect(page.locator('#draw-button')).to_be_disabled()
    # Administrators can still explicitly load fresh settings after participating.
    page.locator('#open-settings').click()
    page.locator('#admin-password').fill('test-only-secret')
    page.locator('#auth-form [type=submit]').click()
    expect(page.locator('#settings')).to_be_visible()
    assert '/draw/api/config' in calls[before:]
    assert not errors,errors
    backend.close();browser.close()
print('PASS: 60–75s config-only polling; hidden/completed visitors make no polls; foreground events coalesce; lost-response recovery; management after participation')
