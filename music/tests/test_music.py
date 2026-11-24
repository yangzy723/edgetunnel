"""Real MP3 playback, lazy loading, retry and responsive layout on built pages."""
import os, re, subprocess, tempfile
from pathlib import Path
from urllib.parse import urlparse
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
from playwright.sync_api import sync_playwright, expect

# Media seeks and play promises complete independently, especially on WebKit.
# Capture a bounded trace before the first interaction on each page.
MEDIA_TRACE = """(() => {
    window.mediaEvents=[];
    window.mediaSequence=0;
    for (const type of ['loadedmetadata','durationchange','play','playing','pause',
                        'seeking','seeked','waiting','stalled','ended','error']) {
        document.addEventListener(type,event=>{
            const a=event.target;
            if (!(a instanceof HTMLMediaElement)) return;
            mediaEvents.push({sequence:++window.mediaSequence,type,at:performance.now(),
                currentTime:a.currentTime,duration:a.duration,paused:a.paused,
                ended:a.ended,seeking:a.seeking,readyState:a.readyState});
            if(mediaEvents.length>80) mediaEvents.shift();
        },true);
    }
})()"""


def media_snapshot(page):
    return page.locator('audio').evaluate("""a=>({
        currentTime:a.currentTime,duration:a.duration,paused:a.paused,
        ended:a.ended,seeking:a.seeking,readyState:a.readyState,
        networkState:a.networkState,error:a.error?.code,
        status:document.getElementById('status').textContent,
        events:window.mediaEvents
    })""")


def wait_for_media(page, condition, step, checkpoint=0, timeout=10000):
    try:
        page.wait_for_function("""checkpoint=>{
            const a=document.getElementById('audio');
            const events=window.mediaEvents.filter(event=>event.sequence>checkpoint);
            return a && ("""+condition+""");
        }""",arg=checkpoint,timeout=timeout)
    except Exception as failure:
        raise AssertionError(f'{step} failed: {media_snapshot(page)}') from failure


def wait_for_playback(page, step):
    wait_for_media(page, '!a.paused && !a.ended && !a.seeking && a.readyState>=2 && a.currentTime>.15', step)


def wait_for_replay(page, step, checkpoint):
    # The real seeked event records the reset even if CI pauses Python long
    # enough for playback to advance before its next assertion reaches the page.
    wait_for_media(page, """!a.paused && !a.ended && !a.seeking && a.readyState>=2 &&
        a.currentTime>.15 && (a.currentTime<2 ||
        events.filter(event=>event.type==='seeked').slice(-1)
            .some(event=>event.currentTime<2))""",step,checkpoint)


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
        page.add_init_script(MEDIA_TRACE)
        errors=[];audio_requests=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.on('request',lambda request:audio_requests.append(request.url) if '.mp3' in request.url else None)
        page.goto(f'{base}/music/')
        expect(page.locator('.question-links a')).to_have_count(4)
        for width in [320,390,768,1440]:
            page.set_viewport_size({'width':width,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(engine,'selection',width)
        assert not audio_requests, 'Question selection must not preload audio'
        page.screenshot(path=str(Path(tempfile.gettempdir())/f'music-{engine}-selection.png'),full_page=True, animations="disabled")
        page.set_viewport_size({'width':390,'height':844})
        page.get_by_role('link',name='打开题目 C').click()
        expect(page.locator('.question-number')).to_have_text('题目 C')
        for letter in 'ABCD':
            before=len(audio_requests)
            page.goto(f'{base}/music/Test-{letter}/')
            expect(page.locator('.question-number')).to_have_text('题目 '+letter)
            assert page.locator('audio').get_attribute('preload')=='none'
            assert len(audio_requests)==before
            assert page.locator('audio').evaluate('el=>el.paused')
            expect(page.locator('#seek')).to_be_disabled()
            page.locator('#play').tap()
            wait_for_playback(page,f'{engine} question {letter}: play')
            assert page.locator('audio').evaluate('el=>Number.isFinite(el.duration) && el.duration>0')
            expect(page.locator('body')).to_have_class('playing')
            expect(page.locator('#play-label')).to_have_text('暂停播放')
            page.locator('#play').tap()
            expect(page.locator('body')).not_to_have_class('playing')
            wait_for_media(page,'a.paused',f'{engine} question {letter}: pause')
            # Touch seeking is a real input event on the custom, full-width control.
            box=page.locator('#seek').bounding_box()
            page.touchscreen.tap(box['x']+box['width']*.6,box['y']+box['height']/2)
            wait_for_media(page,'a.paused && !a.seeking && a.readyState>=2 && a.currentTime>a.duration*.4',
                           f'{engine} question {letter}: touch seek')
            checkpoint=page.evaluate('window.mediaSequence')
            page.locator('#replay').tap()
            wait_for_replay(page,f'{engine} question {letter}: replay',checkpoint)
            expect(page.locator('#play-label')).to_have_text('暂停播放')
            page.locator('#play').tap()
            wait_for_media(page,'a.paused',f'{engine} question {letter}: pause replay')
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
        wait_for_playback(page,f'{engine}: retry playback')
        expect(page.locator('#error')).not_to_be_visible()
        # Also exercise replay while a new seek is still settling.
        page.locator('audio').evaluate('a=>{a.currentTime=a.duration*.75}')
        checkpoint=page.evaluate('window.mediaSequence')
        page.locator('#replay').tap()
        wait_for_replay(page,f'{engine}: rapid seek then replay',checkpoint)
        # Pause, resume and seek with a keyboard as well as touch.
        page.locator('#play').focus();page.keyboard.press('Space')
        wait_for_media(page,'a.paused',f'{engine}: keyboard pause')
        page.locator('#seek').focus();page.keyboard.press('End')
        # At the exact end there may be no current sample, so readyState>=2 is
        # required for playback, not for this completed end-position seek.
        wait_for_media(page,'!a.seeking && (a.ended || a.currentTime>=a.duration-.1)',
                       f'{engine}: keyboard seek to end')
        checkpoint=page.evaluate('window.mediaSequence')
        page.locator('#play').tap()
        wait_for_replay(page,f'{engine}: replay from end',checkpoint)
        page.emulate_media(reduced_motion='reduce')
        assert page.locator('.record').evaluate('el=>getComputedStyle(el).animationName')=='none'
        # Test natural completion independently of the seek/retry sequence. Play
        # the whole short clip: an MP3 tail seek is not uninterrupted playback.
        page.goto(f'{base}/music/Test-A/?natural-completion')
        page.locator('#play').tap()
        wait_for_playback(page,f'{engine}: uninterrupted playback')
        completion_timeout=page.locator('audio').evaluate('a=>Math.ceil(a.duration*1000)+10000')
        wait_for_media(page,'a.ended',f'{engine}: natural completion',timeout=completion_timeout)
        expect(page.locator('#status')).to_contain_text('听完了')
        expect(page.locator('#play-label')).to_have_text('再听一次')
        expect(page.locator('body')).not_to_have_class('playing')
        page.screenshot(path=str(Path(tempfile.gettempdir())/f'music-{engine}-mobile.png'),full_page=True, animations="disabled")
        # Script failures leave usable native controls; no blank player.
        fallback=browser.new_page(java_script_enabled=False,viewport={'width':320,'height':568})
        fallback.goto(f'{base}/music/Test-A/')
        expect(fallback.locator('audio')).to_be_visible()
        expect(fallback.locator('#controls')).not_to_be_visible()
        fallback.close()
        desktop=browser.new_page(viewport={'width':1440,'height':1000})
        desktop.add_init_script(MEDIA_TRACE)
        desktop.goto(f'{base}/music/Test-B/')
        desktop.locator('#play').click()
        wait_for_playback(desktop,f'{engine}: desktop playback')
        assert desktop.evaluate('document.documentElement.scrollWidth<=innerWidth')
        desktop.screenshot(path=str(Path(tempfile.gettempdir())/f'music-{engine}-desktop.png'),full_page=True, animations="disabled")
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: four MP3s; touch/keyboard play, pause, seek, replay; lazy load; retry; portrait/landscape/desktop; reduced motion; native fallback')
server.shutdown()
