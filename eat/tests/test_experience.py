"""Search/budget decisions, result actions and safe editor feedback in deployment HTML."""
import json
import os
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
subprocess.run(['python3', str(root / 'eat/build.py'), '--mode', 'standalone'], check=True)
html = json.loads((root / 'dist/standalone/_worker.js/page.js').read_text()
                  .splitlines()[0].removeprefix('export const EAT_HTML = ').removesuffix(';'))
shared = {'revision': 1, 'shops': [
    dict(id=str(i), name=name, emoji=emoji, price=price, category=category, note=note, enabled=enabled)
    for i, (name, emoji, price, category, note, enabled) in enumerate([
        ('巷口牛肉面', '🍜', 25, '随时', '步行 5 分钟', True),
        ('暖胃稀饭', '🥣', 12, '早餐', '', True),
        ('西餐牛排', '🥩', 88, '晚餐', '', True),
        ('Noodle Lab', '🍝', 45, '随时', '奶油蘑菇意面', True),
        ('小绿碗轻食', '🥗', None, '午餐', '', True),
        ('街角披萨', '🍕', 20, '随时', '', False),
    ])
]}
pending = []
hold_save = False
fail_get = False


def cloud(route):
    if route.request.method == 'PUT':
        if hold_save:
            pending.append(route)
            page.evaluate('window.saveReached = true')
            return
        data = route.request.post_data_json
        assert data['revision'] == shared['revision']
        shared.update(shops=data['shops'], revision=shared['revision'] + 1)
    elif fail_get:
        route.fulfill(status=503, json={'error': '临时断网'})
        return
    route.fulfill(json=shared)


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROME_BIN'), headless=True)
    page = browser.new_page(viewport={'width': 390, 'height': 844}, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/eat/', lambda route: route.fulfill(content_type='text/html', body=html))
    page.route('**/eat/api/pool', cloud)
    page.goto('https://eat.test/eat/')
    page.wait_for_function('cloudReady && !syncing')
    assert page.locator('.skip-link').bounding_box()['y'] < 0
    page.keyboard.press('Tab')
    assert page.locator('.skip-link').bounding_box()['y'] >= 0

    # Search includes names, notes and cuisines; budget excludes unknown prices.
    page.locator('#shop-search').fill('  NOODLE  ')
    expect(page.locator('.shop')).to_have_count(1)
    assert page.evaluate('eligible()[0].name') == 'Noodle Lab'
    page.locator('#shop-search').fill('步行')
    expect(page.locator('.shop-name')).to_have_text('巷口牛肉面')
    page.locator('#shop-search').fill('')
    page.locator('#budget-filter').select_option('25')
    expect(page.locator('.shop')).to_have_count(3)
    assert page.evaluate('eligible().length') == 2
    expect(page.locator('#filter-summary')).to_contain_text('按已填预算')
    page.locator('#flavor-filter').select_option('西餐')
    expect(page.locator('.shop')).to_have_count(1)
    expect(page.locator('#spin')).to_be_disabled()  # The matching pizza is disabled.
    page.locator('#reset-filters').click()
    expect(page.locator('.shop')).to_have_count(6)
    expect(page.locator('#reset-filters')).to_be_hidden()

    # Composed filters leave a single enabled candidate; actions use that exact winner.
    page.locator('#shop-search').fill('西餐')
    page.locator('#budget-filter').select_option('50')
    page.locator('#filters button').filter(has_text='午餐').click()
    assert page.evaluate('eligible().map(s => s.name)') == ['Noodle Lab']
    page.emulate_media(reduced_motion='no-preference')
    page.locator('#spin').click()
    page.wait_for_function('!spinning && state.history.length === 1', timeout=2000)
    page.emulate_media(reduced_motion='reduce')
    expect(page.locator('#result-title')).to_contain_text('Noodle Lab')
    page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => window.copiedMeal=text}})")
    page.locator('#copy-result').click()
    assert page.evaluate('window.copiedMeal') == '今天吃：🍝 Noodle Lab\n人均 ¥45\n奶油蘑菇意面'
    page.locator('#locate-result').click()
    assert page.locator('.shop.winner').is_visible()
    assert page.locator('.shop.winner').bounding_box()['y'] < 844
    page.evaluate("() => { navigator.clipboard.writeText=async()=>{throw Error('denied')}; }")
    page.locator('#copy-result').click()
    expect(page.locator('#toast')).to_contain_text('未能复制')

    # A new shop outside the current search/budget resets filters so it remains visible.
    page.locator('#add').click()
    page.locator('#shop-name').fill('新开的海鲜店')
    page.locator('#shop-price').fill('120')
    page.locator('#shop-emoji').select_option('🦞')
    expect(page.locator('#editor-mark')).to_have_text('🦞')
    page.locator('#shop-form button[type=submit]').click()
    expect(page.locator('#editor')).not_to_be_visible()
    assert page.locator('#shop-search').input_value() == ''
    assert page.locator('#budget-filter').input_value() == ''
    expect(page.locator('.shop')).to_have_count(7)
    expect(page.locator('#result-actions')).to_be_hidden()

    # During a save, the draft cannot be changed or dismissed; failures stay in the dialog.
    hold_save = True
    page.locator('#add').click()
    page.locator('#shop-name').fill('保留未保存草稿')
    page.locator('#shop-form button[type=submit]').click()
    page.wait_for_function('window.saveReached')
    expect(page.locator('#shop-name')).to_be_disabled()
    expect(page.locator('#cancel-editor')).to_be_disabled()
    page.keyboard.press('Escape')
    expect(page.locator('#editor')).to_be_visible()
    pending.pop().fulfill(status=503, json={'error': '临时断网，请重试'})
    page.wait_for_function('!saving')
    expect(page.locator('#editor-message')).to_contain_text('临时断网')
    assert page.locator('#shop-name').input_value() == '保留未保存草稿'
    expect(page.locator('#shop-name')).to_be_enabled()
    page.locator('#cancel-editor').click()
    hold_save = False

    # A connection error is visible, cached meals stay usable, and a retry recovers.
    fail_get = True
    page.evaluate('syncPool()')
    expect(page.locator('#connection-note')).to_be_visible()
    expect(page.locator('#spin')).to_be_enabled()
    fail_get = False
    page.locator('#save-status').click()
    page.wait_for_function('!syncing')
    expect(page.locator('#connection-note')).to_be_hidden()

    # Both empty search results and an empty shared pool offer the appropriate action.
    page.locator('#shop-search').fill('不存在的店铺')
    expect(page.locator('#cards .empty')).to_be_visible()
    page.locator('#cards .empty button').click()
    expect(page.locator('.shop')).to_have_count(7)
    shared.update(shops=[], revision=shared['revision'] + 1)
    page.evaluate('syncPool()')
    page.locator('#cards .empty button').click()
    expect(page.locator('#editor')).to_be_visible()
    assert page.locator('#shop-name').input_value() == ''
    expect(page.locator('#editor-message')).to_be_hidden()
    assert not errors, errors
    print('PASS: search/cuisine/time/budget composition; exact winner actions; clipboard fallback; '
          'new-shop visibility; pending-save locks; inline errors; reconnect; actionable empty states')
    # Result copy and newly available actions must never move the draw button or pool.
    for width in (320, 390, 768, 1440):
        layout_page = browser.new_page(viewport={'width': width, 'height': 900})
        meal = dict(id='layout', name='巷口现熬暖胃早餐稀饭与手工点心专门店', emoji='🥣',
                    price=12, category='随时', note='步行五分钟，记得加个蛋。' * 6, enabled=True)
        layout_page.route('**/eat/', lambda route: route.fulfill(content_type='text/html', body=html))
        layout_page.route('**/eat/api/pool', lambda route: route.fulfill(json={'revision': 1, 'shops': [meal]}))
        layout_page.goto('https://eat.test/eat/')
        layout_page.wait_for_function('cloudReady && !syncing')
        if width > 760:
            assert layout_page.evaluate('''() => {
              const left = document.querySelector('.lottery').getBoundingClientRect();
              const right = document.querySelector('#pool').getBoundingClientRect();
              return Math.abs(left.width - right.width) < 1 &&
                Math.abs(left.height - right.height) < 1 && Math.abs(left.top - right.top) < 1;
            }'''), f'Unequal desktop panels at {width}px'
        layout_page.evaluate('''() => {
          window.geometry = () => {
            const root = document.querySelector('.layout').getBoundingClientRect();
            return ['.result', '.result-actions', '#spin', '.lottery', '#pool'].flatMap(selector => {
              const box = document.querySelector(selector).getBoundingClientRect();
              return [box.width, box.height, box.top - root.top];
            });
          };
          window.baseline = geometry(); window.samples = []; window.watchLayout = true;
          const sample = () => { samples.push(geometry()); if (watchLayout) requestAnimationFrame(sample); };
          requestAnimationFrame(sample);
        }''')
        for draw in range(2):
            layout_page.evaluate("$('spin').click()")
            layout_page.wait_for_function(f'!spinning && state.history.length === {draw + 1}')
        layout_page.evaluate('resetResult()')
        layout_page.evaluate('''() => new Promise(resolve => requestAnimationFrame(() => {
          samples.push(geometry()); watchLayout = false; resolve();
        }))''')
        assert layout_page.evaluate('''samples.length > 3 && samples.every(sample =>
          sample.every((value, index) => Math.abs(value - baseline[index]) < 1))'''), width
        expect(layout_page.locator('#copy-result')).to_be_hidden()
        layout_page.close()
    print('PASS: stable result, actions, draw button and pool across idle/spinning/reveal/repeat/reset at 320/390/768/1440')
    browser.close()
