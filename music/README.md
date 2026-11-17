# 听歌识曲

四道题的正式入口：`/music/Test-A/`、`/music/Test-B/`、`/music/Test-C/`、`/music/Test-D/`。
`/Test-A` 至 `/Test-D`（包括尾斜杠）会跳转到对应题目，`/music/` 为题目入口列表。
每页只公开题号和音乐，不设置歌名、答案或自动跳转下一题。

## 音频管理

- 原始文件：本目录的 `Test-A.mp3` 至 `Test-D.mp3`，由 `.gitignore` 忽略。此前归档的本机原件保存在仓库旁的 `edgetunnel-activity-originals/music/`，如需重新处理可复制回本目录。
- 发布副本：`audio/track-a.mp3` 至 `audio/track-d.mp3`，**需要提交到 Git**，Cloudflare 的远程构建才能获取它们。
- 修改原件后运行 `python3 music/prepare.py`。脚本去掉 ID3/APE 元数据，不重新编码、不修改原件；随后提交生成的发布副本。
- 只提交原件的忽略规则，不把答案或原件一起发布。音频本身仍是访客可获取的公开资源。

沿用现有 `python3 eat/build.py` 构建命令和 `dist/combined` 输出目录；standalone 构建也包含音乐页面。
构建只读取发布副本，缺失文件时直接报错，不生成不能播放的占位页面。音频使用带内容哈希的文件名；替换音频后会自动生成新地址。
`/music` 和 `/music/*` 在 `_routes.json` 中排除 Worker，页面、脚本、音频直接由 Pages 静态托管。音频不进入 Worker 包，也不使用 D1/KV。单文件最多 25 MiB，见 [Pages 限制](https://developers.cloudflare.com/pages/platform/limits/)。

播放器使用统一的大按钮与原生 range 进度条，触控区域至少 44px，支持触摸和键盘操作；脚本未加载时保留浏览器原生播放器。点击后才加载音频（`preload="none"`），不强制自动播放。支持暂停、进度拖动、重听和失败重试，页面离开时暂停。手机竖屏为纵向布局，桌面和较宽横屏为左右布局，适配安全区域。唱片旋转、星光和音量柱只在播放且页面可见时运行，尊重系统减少动态效果偏好。

验证：`node --test eat/tests/test_worker.mjs`；安装已有 Playwright 依赖后运行 `python3 music/tests/test_music.py`（可通过 `CHROME_BIN` 指定 Chrome）。

选择题入口模板为 `selection.html`，播放器模板为 `index.html`，共用 `styles.css`；构建输出不展示曲名或答案。

兼容性回归（macOS）：安装 `python3 -m playwright install --with-deps chromium webkit` 后，运行 `MUSIC_TEST_WEBKIT=1 python3 music/tests/test_music.py`。测试使用桌面 Chrome / Playwright WebKit 和触屏视口模拟；不等同于实体 iPhone、Android 或微信内置浏览器实机验证。
