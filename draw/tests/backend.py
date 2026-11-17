"""Run the real Worker API against SQLite and a runtime secret test binding."""
import json
import sqlite3
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread

class Backend:
    def __init__(self, browser, root):
        self.connection = sqlite3.connect(':memory:')
        self.connection.row_factory = sqlite3.Row
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(root)))
        Thread(target=self.server.serve_forever, daemon=True).start()
        self.page = browser.new_page()
        self.page.expose_function('sql', self.sql)
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}/')
        self.page.evaluate('''async () => {
          // Browser Response filters Set-Cookie; Workers Response exposes it.
          const NativeResponse = Response;
          globalThis.Response = class extends NativeResponse {
            constructor(body, init) { super(body,init); Object.defineProperty(this,'headers',{value:new Headers(init?.headers)}); }
          };
          globalThis.originalRandom = crypto.getRandomValues.bind(crypto);
          globalThis.api = (await import('/draw/api.js')).drawAPI;
          globalThis.env = { DRAW_ADMIN_PASSWORD: 'test-only-secret', EAT_DB: {
            withSession(mode) {
              if(mode !== 'first-primary') throw Error('Not primary');
              return {prepare(query) {return {args:[], bind(...args){this.args=args;return this},
                first(){return sql(query,this.args)}, run(){return sql(query,this.args)}
              }}};
            }
          }};
        }''')
    def sql(self, query, args):
        row = self.connection.execute(query, args).fetchone()
        self.connection.commit()
        return dict(row) if row else None
    def request(self, path='config', method='GET', data=None, headers=None, missing=False):
        return self.page.evaluate('''async ({path,method,data,headers,missing}) => {
          const request = new Request('https://draw.test/draw/api/'+path, {
            method, headers:headers || {'Content-Type':'application/json'},
            body:data === null ? undefined : JSON.stringify(data)
          });
          if(headers) Object.defineProperty(request,'headers',{value:new Headers(headers)});
          const r = await api(request,missing?{}:env);
          return {status:r.status, data:r.status===304?null:await r.json(), headers:Object.fromEntries(r.headers)};
        }''', dict(path=path, method=method, data=data, headers=headers, missing=missing))
    def route(self, route):
        request = route.request
        result = self.request(request.url.split('/draw/api/')[1], request.method,
                              json.loads(request.post_data) if request.post_data else None, request.all_headers())
        route.fulfill(status=result['status'], headers=result['headers'],
                      body='' if result['data'] is None else json.dumps(result['data']))
    def close(self):
        self.page.close()
        self.server.shutdown()
        self.connection.close()
