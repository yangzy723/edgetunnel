#!/usr/bin/env python3
"""Build the management adapter, Eat, Draw and static music pages for Cloudflare Pages."""
import argparse
import hashlib
import json
import runpy
import shutil
from pathlib import Path

APP = Path(__file__).resolve().parent
ROOT = APP.parent


def inline_asset(html, tag, content, wrapper):
    if html.count(tag) != 1:
        raise ValueError('Expected one asset reference: ' + tag)
    return html.replace(tag, f'<{wrapper}>\n{content}</{wrapper}>')


def page_source(folder, script_tag, script=None):
    html = (folder / 'index.html').read_text(encoding='utf-8')
    html = inline_asset(html, f'<link rel="stylesheet" href="/{folder.name}/styles.css">',
                        (folder / 'styles.css').read_text(encoding='utf-8'), 'style')
    return inline_asset(html, script_tag, script if script is not None else
                        (folder / 'app.js').read_text(encoding='utf-8'), 'script')


def write_page(modules, name, html):
    symbol = name.upper()
    etag = f'"{name}-page-' + hashlib.sha256(html.encode('utf-8')).hexdigest()[:24] + '"'
    filename = 'page.js' if name == 'eat' else name + '-page.js'
    (modules / filename).write_text(
        f'export const {symbol}_HTML = ' + json.dumps(html, ensure_ascii=False) + ';\n' +
        f'export const {symbol}_ETAG = ' + json.dumps(etag) + ';\n', encoding='utf-8')


def build(mode='combined', output=None):
    target = Path(output).resolve() if output else ROOT / 'dist' / mode
    sources = (APP, ROOT / 'draw', ROOT / 'music')
    if target == ROOT or any(target == source or source in target.parents for source in sources):
        raise ValueError('Use an output directory outside the application source directories')
    modules = target / '_worker.js'
    draw = ROOT / 'draw'
    music = runpy.run_path(str(ROOT / 'music' / 'build.py'))['build_music']
    # Read and validate source files before replacing an existing Worker bundle.
    html = page_source(APP, '<script src="/eat/app.js"></script>')
    draw_script = (draw / 'model.js').read_text(encoding='utf-8').replace('export ', '') + '\n' + \
        (draw / 'app.js').read_text(encoding='utf-8').replace("import { validateDrawConfig } from './model.js';\n", '')
    draw_html = page_source(draw, '<script type="module" src="/draw/app.js"></script>', draw_script)
    photos = {}
    for source in sorted((draw / 'images').iterdir()):
        if source.suffix.lower() in ('.jpg', '.png', '.webp'):
            content = source.read_bytes()
            filename = f'{source.stem}.{hashlib.sha256(content).hexdigest()[:12]}{source.suffix}'
            photos[source.name] = (filename, content)
            draw_html = draw_html.replace("file:'" + source.name + "'", "file:'" + filename + "'")
            draw_html = draw_html.replace('/draw/images/' + source.name, '/draw/images/' + filename)
    worker_files = {'worker.js': APP / 'worker.js', 'api.js': APP / 'api.js',
                    'draw-api.js': draw / 'api.js', 'model.js': draw / 'model.js'}
    if mode == 'combined':
        worker_files.update({'upstream.js': ROOT / '_worker.js', 'index.js': APP / 'combined.js'})
    content = {name: source.read_bytes() for name, source in worker_files.items()}
    photo_output = target / 'draw' / 'images'
    if modules.is_symlink() or photo_output.is_symlink() or photo_output.parent.is_symlink():
        raise ValueError('Refusing to replace symlinked build output')
    if modules.exists():
        if not modules.is_dir():
            raise ValueError('Output contains an existing _worker.js file; use a fresh directory')
        shutil.rmtree(modules)
    modules.mkdir(parents=True)
    for name, value in content.items():
        (modules / name).write_bytes(value)
    if mode == 'standalone':
        (modules / 'index.js').write_text("export { default } from './worker.js';\n", encoding='utf-8')
    write_page(modules, 'eat', html)
    write_page(modules, 'draw', draw_html)
    if photo_output.exists():
        shutil.rmtree(photo_output)
    photo_output.mkdir(parents=True)
    for filename, value in photos.values():
        (photo_output / filename).write_bytes(value)
    music(target)
    static_paths = ['/draw/images/*', '/music', '/music/*']
    (target / '_routes.json').write_text(json.dumps({'version': 1, 'include': ['/*'], 'exclude': static_paths}) + '\n')
    (target / '_headers').write_text(''.join(path + '\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n'
                                           for path in ['/draw/images/*', '/music/assets/*']))
    (target / '404.html').write_text('<!doctype html><meta charset="utf-8"><title>Not found</title><h1>Not found</h1>\n')
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['combined', 'standalone'], default='combined')
    parser.add_argument('--out', type=Path, help='Output directory (default: dist/<mode>)')
    args = parser.parse_args()
    print(f'Built {args.mode}: {build(args.mode, args.out)}')
