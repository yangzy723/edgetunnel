"""Build static music pages and fingerprinted media for Cloudflare Pages."""
import hashlib
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def render(template, **values):
    for key, value in values.items():
        template = template.replace('{{' + key + '}}', value)
    if '{{' in template or '}}' in template:
        raise ValueError('Unresolved music template placeholder')
    return template


def build_music(target):
    output = Path(target) / 'music'
    if output.is_symlink():
        raise ValueError('Refusing to replace symlinked music output')
    # Validate all inputs before replacing the previous build.
    assets = {name: (ROOT / name).read_bytes() for name in ['styles.css', 'app.js']}
    for letter in 'ABCD':
        name = f'audio/track-{letter.lower()}.mp3'
        assets[name] = (ROOT / name).read_bytes()
        if not assets[name] or len(assets[name]) > 25 * 1024 * 1024:
            raise ValueError('Music assets must be nonempty and at most 25 MiB')
    template = (ROOT / 'index.html').read_text(encoding='utf-8')
    selection = (ROOT / 'selection.html').read_text(encoding='utf-8')
    urls = {}
    files = {}
    for name, content in assets.items():
        source = Path(name)
        filename = f'{source.stem}.{hashlib.sha256(content).hexdigest()[:12]}{source.suffix}'
        files[filename] = content
        urls[name] = '/music/assets/' + filename
    questions = {
        letter: render(template, LETTER=letter, CSS=urls['styles.css'], JS=urls['app.js'],
                       AUDIO=urls[f'audio/track-{letter.lower()}.mp3'])
        for letter in 'ABCD'
    }
    links = ''.join(
        f'<a href="/music/Test-{letter}/" aria-label="打开题目 {letter}">'
        f'<b>{letter}</b><span class="question-copy"><strong>题目 {letter}</strong>'
        '<small>点击聆听</small></span><span class="question-arrow" aria-hidden="true">↗</span></a>'
        for letter in 'ABCD')
    index = render(selection, CSS=urls['styles.css'], QUESTIONS=links)
    if output.exists():
        shutil.rmtree(output)
    (output / 'assets').mkdir(parents=True)
    for filename, content in files.items():
        (output / 'assets' / filename).write_bytes(content)
    for letter, html in questions.items():
        folder = output / f'Test-{letter}'
        folder.mkdir()
        (folder / 'index.html').write_text(html, encoding='utf-8')
    (output / 'index.html').write_text(index, encoding='utf-8')
