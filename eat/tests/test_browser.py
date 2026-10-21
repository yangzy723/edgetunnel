from playwright.sync_api import sync_playwright
import json, subprocess
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from threading import Thread
import os

root = Path(__file__).resolve().parents[2]
server = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(root)))
Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_port}/eat/"
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROME_BIN') or ('/usr/bin/google-chrome' if Path('/usr/bin/google-chrome').exists() else None),headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1440,'height':1100},accept_downloads=True)
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 shared={'revision':1,'shops':[dict(id=str(i),name=name,emoji=emoji,category='随时',price=25,note='共享菜单',enabled=True) for i,(name,emoji) in enumerate([('巷口牛肉面','🍜'),('有家小饭馆','🍚'),('快乐汉堡站','🍔'),('一起涮火锅','🍲'),('小绿碗轻食','🥗'),('深夜烤串局','🍢')])]}
 def cloud(route):
  if route.request.method=='PUT':
   data=json.loads(route.request.post_data)
   if data['revision']!=shared['revision']:
    route.fulfill(status=409,json={**shared,'error':'奖池刚被其他人修改'});return
   shared.update(revision=shared['revision']+1,shops=data['shops'])
  elif route.request.headers.get('if-none-match')==f'"eat-pool-{shared["revision"]}"':
   route.fulfill(status=304,body='');return
  route.fulfill(json=shared)
 # Verify the actual self-contained deployment HTML, not just the source preview.
 subprocess.run(['python3', str(root/'eat/build.py'), '--mode', 'standalone'], check=True)
 module=(root/'dist/standalone/_worker.js/page.js').read_text()
 html=json.loads(module.splitlines()[0].removeprefix('export const EAT_HTML = ').removesuffix(';'))
 assert '/eat/styles.css' not in html and '<script src="/eat/app.js">' not in html
 page.route('**/eat/',lambda route:route.fulfill(content_type='text/html',body=html))
 page.route('**/eat/api/pool',cloud)
 page.goto(url)
 page.wait_for_function('cloudReady')
 with page.expect_download() as download:page.locator('#export').click()
 data=Path(download.value.path()).read_bytes();backup=json.loads(data);assert len(backup['shops'])==6
 page.locator('#add').click();page.locator('#shop-name').fill('临时店');page.locator('#shop-form button[type=submit]').click();page.wait_for_function('!saving')
 page.locator('#import-file').set_input_files({'name':'backup.json','mimeType':'application/json','buffer':data})
 page.locator('#confirm-ok').click();page.wait_for_function('!saving');assert page.locator('.shop').count()==6
 page.reload();page.wait_for_function('cloudReady');assert page.locator('.shop').count()==6
 page.locator('#import-file').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{bad'})
 assert page.locator('#toast').inner_text().startswith('无法导入')
 assert page.locator('.shop').count()==6
 # A real multi-entry spin, check actual wheel angle against selected sector.
 page.locator('#spin').click();page.wait_for_timeout(4900)
 assert page.evaluate("(()=>{const items=eligible(),winner=state.history[0];const i=items.findIndex(s=>s.name===winner.name);return Math.abs(((angle+(i+.5)*360/items.length)%360))<0.01})()")
 page.locator('#clear-history').click();page.locator('#confirm-ok').click()
 page.reload();page.wait_for_function('cloudReady');page.wait_for_timeout(300)
 page.screenshot(path='/tmp/eat-desktop.png',full_page=True)
 for width in [320,390,768,1440]:
  page.set_viewport_size({'width':width,'height':844})
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
  if width>760:
   assert page.evaluate("""() => {
    const a=document.querySelector('.lottery').getBoundingClientRect();
    const b=document.querySelector('#pool').getBoundingClientRect();
    return Math.abs(a.width-b.width)<1 && Math.abs(a.height-b.height)<1 && Math.abs(a.top-b.top)<1;
   }"""),width
  page.locator('#add').click();assert page.locator('#editor').is_visible()
  assert page.locator('#editor').bounding_box()['width']<=width
  page.locator('#cancel-editor').click()
 page.set_viewport_size({'width':390,'height':844})
 page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
 page.screenshot(path='/tmp/eat-mobile.png',full_page=True)
 # Local cache quota failure must not prevent an acknowledged cloud save.
 page.evaluate("() => { Storage.prototype.setItem=function(){throw new DOMException('quota','QuotaExceededError')}; }")
 page.locator('#add').click();page.locator('#shop-name').fill('保存异常测试');page.locator('#shop-form button[type=submit]').click();page.wait_for_function('!saving')
 assert '已保存' in page.locator('#save-status').inner_text()
 assert shared['shops'][-1]['name']=='保存异常测试'
 assert not errors,errors
 print('PASS: export/import round trip; invalid import; multi-shop wheel/result match; 320/390/768/1440 layouts; modal; quota failure; no browser JS errors')
 browser.close()

server.shutdown()
