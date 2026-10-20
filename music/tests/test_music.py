"""Real MP3 playback, lazy loading, retry and responsive layout on built pages."""
import os, re, subprocess, tempfile
from pathlib import Path
from urllib.parse import urlparse
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[2]
subprocess.run(['python3',str(root/'eat/build.py'),'--mode','standalone'],check=True)
class AssetHandler(SimpleHTTPRequestHandler):
    # Match Pages byte-range support; Python's basic server cannot test media seeking.
    def do_GET(self):
        if not urlparse(self.path).path.endswith('.mp3'):
            return super().do_GET()
        data=Path(self.translate_path(self.path)).read_bytes()
        match=re.fullmatch(r'bytes=(\d+)-(\d*)',self.headers.get('Range',''))
        start=int(match[1]) if match else 0
        end=min(int(match[2]) if match and match[2] else len(data)-1,len(data)-1)
        if start>end:
            self.send_response(416);self.send_header('Content-Range',f'bytes */{len(data)}');self.end_headers();return
        self.send_response(206 if match else 200)
        self.send_header('Content-Type','audio/mpeg');self.send_header('Accept-Ranges','bytes')
        self.send_header('Content-Length',str(end-start+1))
        if match:self.send_header('Content-Range',f'bytes {start}-{end}/{len(data)}')
        self.end_headers()
        try:self.wfile.write(data[start:end+1])
        except (BrokenPipeError,ConnectionResetError):pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(AssetHandler,directory=str(root/'dist/standalone')))
Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
with sync_playwright() as p:
    import sys as _sys
    engines=['chromium','webkit'] if (os.environ.get('MUSIC_TEST_WEBKIT')=='1' and _sys.platform=='darwin') else ['chromium']
    for engine in engines:
        browser=getattr(p,engine).launch(executable_path=os.environ.get('CHROME_BIN') if engine=='chromium' else None,headless=True)
        page=browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
        page.set_default_timeout(10000)
        errors=[];audio_requests=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.on('request',lambda request:audio_requests.append(request.url) if '.mp3' in request.url else None)
        for letter in 'ABCD':
            before=len(audio_requests)
            page.goto(f'{base}/music/Test-{letter}/')
            expect(page.locator('.question-number')).to_have_text('题目 '+letter)
            assert page.locator('audio').get_attribute('preload')=='none'
            assert len(audio_requests)==before
            assert page.locator('audio').evaluate('el=>el.paused')
            expect(page.locator('#seek')).to_be_disabled()
            page.locator('#play').tap()
            page.wait_for_function('document.querySelector("audio").currentTime > .15')
            assert page.locator('audio').evaluate('el=>Number.isFinite(el.duration) && el.duration>0')
            expect(page.locator('body')).to_have_class('playing')
            expect(page.locator('#play-label')).to_have_text('暂停播放')
            page.locator('#play').tap()
            expect(page.locator('body')).not_to_have_class('playing')
            assert page.locator('audio').evaluate('el=>el.paused')
            # Touch seeking is a real input event on the custom, full-width control.
            box=page.locator('#seek').bounding_box()
            page.touchscreen.tap(box['x']+box['width']*.6,box['y']+box['height']/2)
            page.wait_for_function('audio.currentTime > audio.duration*.4')
            page.locator('#replay').tap()
            assert page.locator('audio').evaluate('el=>el.currentTime<2')
            page.locator('#play').tap()
            for width,height in [(320,568),(375,667),(390,844),(430,932),(844,390),(768,1024)]:
                page.set_viewport_size({'width':width,'height':height})
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(engine,letter,width)
                assert page.locator('#play').bounding_box()['height']>=44
                assert page.locator('#seek').bounding_box()['height']>=44
            page.set_viewport_size({'width':390,'height':844})
        page.goto(f'{base}/music/Test-A/')
        page.route('**/*.mp3*',lambda route:route.abort())
        page.locator('audio').evaluate("el=>el.src+='?retry-check'")
        page.locator('#play').tap()
        expect(page.locator('#error')).to_be_visible()
        page.unroute('**/*.mp3*')
        page.locator('#retry').tap()
        page.wait_for_function('document.querySelector("audio").currentTime > .15')
        expect(page.locator('#error')).not_to_be_visible()
        # Pause, resume and seek with a keyboard as well as touch.
        page.locator('#play').focus();page.keyboard.press('Space')
        assert page.locator('audio').evaluate('el=>el.paused')
        page.locator('#seek').focus();page.keyboard.press('End')
        page.wait_for_function('audio.currentTime >= audio.duration-.1')
        page.locator('#play').tap()
        page.wait_for_function('audio.currentTime < 2 && !audio.paused')
        page.emulate_media(reduced_motion='reduce')
        assert page.locator('.record').evaluate('el=>getComputedStyle(el).animationName')=='none'
        page.locator('audio').evaluate('el=>{el.currentTime=el.duration-.05;el.play()}')
        expect(page.locator('#status')).to_contain_text('听完了')
        page.screenshot(path=str(Path(tempfile.gettempdir())/f'music-{engine}-mobile.png'),full_page=True)
        # Script failures leave usable native controls; no blank player.
        fallback=browser.new_page(java_script_enabled=False,viewport={'width':320,'height':568})
        fallback.goto(f'{base}/music/Test-A/')
        expect(fallback.locator('audio')).to_be_visible()
        expect(fallback.locator('#controls')).not_to_be_visible()
        fallback.close()
        desktop=browser.new_page(viewport={'width':1440,'height':1000})
        desktop.goto(f'{base}/music/Test-B/')
        desktop.locator('#play').click()
        desktop.wait_for_function('audio.currentTime>.15')
        assert desktop.evaluate('document.documentElement.scrollWidth<=innerWidth')
        desktop.screenshot(path=str(Path(tempfile.gettempdir())/f'music-{engine}-desktop.png'),full_page=True)
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: four MP3s; touch/keyboard play, pause, seek, replay; lazy load; retry; portrait/landscape/desktop; reduced motion; native fallback')
server.shutdown()
