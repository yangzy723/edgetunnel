"""Actual JS API + SQLite CAS + two independent browser contexts (no Cloudflare account)."""
import json, os, sqlite3
from pathlib import Path
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[2]
server=ThreadingHTTPServer(('127.0.0.1',0),partial(SimpleHTTPRequestHandler,directory=str(root)))
Thread(target=server.serve_forever,daemon=True).start()
url=f'http://127.0.0.1:{server.server_port}/eat/'
connection=sqlite3.connect(':memory:');connection.row_factory=sqlite3.Row
connection.executescript((root/'eat/schema.sql').read_text())
def sql(query,args):
 row=connection.execute(query,args).fetchone();connection.commit()
 return dict(row) if row else None
def sql_all(query,args):
 rows=connection.execute(query,args).fetchall();connection.commit()
 return [dict(r) for r in rows]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROME_BIN') or ('/usr/bin/google-chrome' if Path('/usr/bin/google-chrome').exists() else None),headless=True,args=['--no-sandbox'])
 backend=browser.new_page();backend.expose_function('sql',sql);backend.expose_function('sqlAll',sql_all)
 backend.goto(f'http://127.0.0.1:{server.server_port}/')
 backend.evaluate("""async () => {
 const mod = await import('/eat/api.js');
 globalThis.api=mod.eatPoolAPI;
 globalThis.mealsApi=mod.eatMealsAPI;
 globalThis.env={EAT_DB:{
  withSession(mode){
   if(mode!=='first-primary')throw Error('Not primary');
   return {prepare(query){return {
    args:[], bind(...args){this.args=args;return this},
    first(){return sql(query,this.args)},
    async all(){return {results: await sqlAll(query,this.args)}},
    async run(){await sql(query,this.args);return {}}
   }}};
  }
 }};
 }""")
 def api(method='GET',data=None,headers=None,missing=False):
  return backend.evaluate('''async ({method,data,headers,missing})=>{const request=new Request('https://example.com/eat/api/pool',{method,headers:headers||{'Content-Type':'application/json'},body:data===null?undefined:JSON.stringify(data)});if(headers)Object.defineProperty(request,'headers',{value:new Headers(headers)});const r=await api(request,missing?{}:env);return{status:r.status,data:r.status===304?null:await r.json(),etag:r.headers.get('ETag')}}''',dict(method=method,data=data,headers=headers,missing=missing))
 def meals_api(method='GET',data=None,headers=None,missing=False,url_suffix=''):
  return backend.evaluate('''async ({method,data,headers,missing,url_suffix})=>{const request=new Request('https://example.com/eat/api/meals'+url_suffix,{method,headers:headers||{'Content-Type':'application/json'},body:data===null?undefined:JSON.stringify(data)});if(headers)Object.defineProperty(request,'headers',{value:new Headers(headers)});const r=await mealsApi(request,missing?{}:env);return{status:r.status,data:await r.json()}}''',dict(method=method,data=data,headers=headers,missing=missing,url_suffix=url_suffix))
 assert api(missing=True)['status']==503
 assert api('DELETE')['status']==405
 assert api()['data']['shops'] is None
 shop=dict(id='one',name='手机添加的店',emoji='🍜',category='随时',price=20,note='测试',enabled=True)
 assert api('PUT',dict(revision=0,shops=[shop]))['data']['revision']==1
 assert api('PUT',dict(revision=0,shops=[]))['status']==409
 assert api('PUT',dict(revision=1,shops=[shop,shop]))['status']==400
 assert api('PUT',dict(revision=1,shops=[]),{'Content-Type':'application/json','Origin':'https://elsewhere.com'})['status']==403
 assert api('PUT',dict(revision=1,shops=[dict(shop,note='x'*110000)]))['status']==413
 a=browser.new_context(viewport={'width':390,'height':844});b=browser.new_context(viewport={'width':1440,'height':1000})
 errors=[]
 def route(request_route):
  request=request_route.request
  headers={'Content-Type':'application/json'}
  if request.headers.get('if-none-match'):headers['If-None-Match']=request.headers['if-none-match']
  result=api(request.method,json.loads(request.post_data) if request.post_data else None,headers)
  if result['status']==304:request_route.fulfill(status=304,headers={'ETag':result['etag']},body='')
  else:request_route.fulfill(status=result['status'],json=result['data'])
 def meals_route(request_route):
  request=request_route.request
  from urllib.parse import urlparse
  parsed=urlparse(request.url)
  suffix=('?'+parsed.query) if parsed.query else ''
  result=meals_api(request.method,json.loads(request.post_data) if request.post_data else None,{'Content-Type':'application/json'},False,suffix)
  request_route.fulfill(status=result['status'],json=result['data'])
 for context in [a,b]:context.route('**/eat/api/pool',route);context.route('**/eat/api/meals*',meals_route)
 phone=a.new_page();desktop=b.new_page()
 for page in [phone,desktop]:page.on('pageerror',lambda error:errors.append(str(error)));page.goto(url);expect(page.locator('#save-status')).to_contain_text('已同步')
 phone.locator('#add').click();phone.locator('#shop-name').fill('新加烧烤');phone.locator('#shop-form button[type=submit]').click();expect(phone.locator('#editor')).not_to_be_visible()
 desktop.evaluate('window.dispatchEvent(new Event("focus"))');expect(desktop.locator('.shop')).to_have_count(2)
 # Eaten meals persistent logging across devices (dish, rating, note, edit, delete).
 assert meals_api(missing=True)['status']==503
 # Hold an old background response across a successful save.
 phone.evaluate("""async () => {
   while (mealsSyncing) await new Promise(resolve => setTimeout(resolve, 10));
   const originalFetch = window.fetch;
   window.fetch = (url, options) => {
     if (url === '/eat/api/meals' && options?.method === 'GET') {
       window.fetch = originalFetch;
       return new Promise(resolve => {
         window.releaseOldMeals = () => resolve(new Response(JSON.stringify({meals: []}), {
           headers: {'Content-Type': 'application/json'}
         }));
       });
     }
     return originalFetch(url, options);
   };
   void syncMeals();
 }""")
 phone.locator('#add-meal').click()
 phone.locator('#meal-shop-select').select_option('one')
 assert phone.locator('#meal-name').input_value()=='手机添加的店'
 phone.locator('#meal-dish').fill('招牌红烧牛腩面 + 卤蛋')
 phone.locator('#meal-rating').select_option('5')
 phone.locator('#meal-note').fill('汤浓肉烂，非常推荐')
 phone.locator('#save-meal-btn').click()
 expect(phone.locator('#meal-editor')).not_to_be_visible()
 expect(phone.locator('.meal-card')).to_have_count(1)
 expect(phone.locator('.meal-card .meal-dish')).to_contain_text('招牌红烧牛腩面')
 expect(phone.locator('.meal-card .meal-stars')).to_contain_text('★★★★★')
 phone.evaluate('window.releaseOldMeals()')
 phone.wait_for_function('!mealsSyncing')
 expect(phone.locator('.meal-card')).to_have_count(1)
 # Long user-entered dish names must wrap even without spaces on a small phone.
 saved_meals=phone.evaluate('meals')
 phone.evaluate("""() => {
   meals = meals.map(meal => ({...meal, dish: 'W'.repeat(48)}));
   renderMeals();
 }""")
 for width in [320,390]:
  phone.set_viewport_size({'width':width,'height':844})
  assert phone.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Meal content overflow'
  assert phone.locator('.meal-card').evaluate('(el) => el.scrollWidth <= el.clientWidth')
 phone.evaluate('(saved) => { applyMeals(saved); renderMeals(); }',saved_meals)
 desktop.evaluate('window.dispatchEvent(new Event("focus"))')
 expect(desktop.locator('.meal-card')).to_have_count(1)
 expect(desktop.locator('.meal-card .meal-name')).to_have_text('手机添加的店')
 desktop.locator('.meal-edit-btn').first.click()
 desktop.locator('#meal-dish').fill('清汤牛腩面')
 desktop.locator('#save-meal-btn').click()
 expect(desktop.locator('.meal-card .meal-dish')).to_contain_text('清汤牛腩面')
 desktop.locator('.meal-edit-btn').first.click()
 desktop.locator('#delete-meal').click()
 desktop.locator('#confirm-ok').click()
 expect(desktop.locator('.meal-card')).to_have_count(0)
 # Editing protects a draft from background refresh; stale revision must conflict.
 desktop.locator('.shop .icon-btn').first.click();desktop.locator('#shop-name').fill('电脑未保存草稿')
 phone.locator('.shop .icon-btn').first.click();phone.locator('#shop-name').fill('手机已经修改');phone.locator('#shop-form button[type=submit]').click();expect(phone.locator('#editor')).not_to_be_visible()
 desktop.locator('#shop-form button[type=submit]').click();expect(desktop.locator('#toast')).to_contain_text('其他人修改');expect(desktop.locator('#editor')).to_be_visible()
 assert api()['data']['shops'][0]['name']=='手机已经修改'
 assert desktop.locator('#shop-name').input_value()=='电脑未保存草稿'
 desktop.locator('#cancel-editor').click()
 # Timer synchronization, including an empty shared pool (must not recreate defaults).
 phone.locator('.shop .icon-btn').last.click();phone.locator('#delete-shop').click();phone.locator('#confirm-ok').click();expect(phone.locator('.shop')).to_have_count(1)
 expect(desktop.locator('.shop')).to_have_count(1,timeout=11000)
 current=api()['data'];assert api('PUT',dict(revision=current['revision'],shops=[]))['status']==200
 desktop.locator('#sync-now').click();expect(desktop.locator('.shop')).to_have_count(0)
 desktop.reload();expect(desktop.locator('#save-status')).to_contain_text('已同步');expect(desktop.locator('.shop')).to_have_count(0)
 # Save failure must not close editor or show the edit as shared.
 desktop.locator('#add').click();desktop.locator('#shop-name').fill('断网草稿')
 b.unroute('**/eat/api/pool');b.route('**/eat/api/pool',lambda route:route.fulfill(status=503,json={'error':'临时断网'}))
 desktop.locator('#shop-form button[type=submit]').click();expect(desktop.locator('#toast')).to_contain_text('临时断网');expect(desktop.locator('#editor')).to_be_visible();assert api()['data']['shops']==[]
 # Legacy data stays intact across refresh, then migrates only after explicit confirmation.
 legacy=browser.new_context();legacy.route('**/eat/api/pool',route);old=legacy.new_page();old.goto(url);expect(old.locator('#save-status')).to_contain_text('已同步')
 payload={'version':1,'shops':[dict(shop,name='旧版本机菜单')],'history':[]}
 old.evaluate('(data)=>localStorage.setItem("lunch-club:v1",JSON.stringify(data))',payload)
 old.reload();expect(old.locator('#migrate')).to_be_visible();expect(old.locator('.shop')).to_have_count(0)
 old.reload();expect(old.locator('#migrate')).to_be_visible();old.locator('#migrate').click();old.locator('#confirm-ok').click();expect(old.locator('.shop')).to_have_count(1)
 assert api()['data']['shops'][0]['name']=='旧版本机菜单'
 assert old.evaluate('localStorage.getItem("lunch-club:v1")') is None
 assert not errors,errors
 print('PASS: actual API/SQLite, primary reads, validation, CAS conflict, independent devices, focus sync, deletion, empty pool, failed-save draft retention')
 browser.close()
server.shutdown()
