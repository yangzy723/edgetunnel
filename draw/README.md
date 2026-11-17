# 兴享好礼 /draw

与 Eat 同一域名下的独立抽奖页面，入口为 `/draw` 或 `/draw/`。
沿用当前 Cloudflare Pages 构建命令 `python3 eat/build.py` 和输出目录 `dist/combined`，无需增加域名。云端配置复用 `EAT_DB` 数据库，管理密码通过运行时变量和密钥配置。
独立构建 `python3 eat/build.py --mode standalone` 同样包含该页面。

默认六类礼品：A5 计划本、维达抽纸、山茶花垃圾袋、金属手机支架、竹节随行杯、折叠环保袋。
抽纸默认每份 2 包，其余默认每份 1 件（单位可修改）。默认权重按本次礼品份数设置：计划本 30、抽纸 24（48 包，每份 2 包）、垃圾袋 16、支架 20、杯子 20、购物袋 30。全部开启时总权重 140；权重不扣减，不作为库存。

点击“活动设置”可开关礼品、修改名称/介绍/每份数量/单位/抽取权重、选择展示图片、添加或移除礼品（最多 12 款），也可隐藏每份数量。
已开启的礼品按权重随机中奖，每个匿名浏览器凭证仅可参与一次，不扣减库存。由 Worker 使用 Web Crypto 拒绝采样生成随机索引，每次抽奖读取 D1 主库中的最新配置快照。
礼品配置、数量展示开关和活动启停保存在 D1，全设备共享。未抽奖页面在前台每 60–75 秒查询一次共享配置（各浏览器随机错峰），常规轮询不再查询个人结果。首次进入、返回前台和手动重试时检查参与状态；失联后的轮询也会恢复个人结果。已抽奖页面停止自动查询，隐藏页面不轮询，刷新页面或打开管理设置仍可获取最新数据。返回前台事件合并处理，避免 focus 与 visibilitychange 重复请求。每次点击抽奖仍由服务端检查最新活动状态，降低轮询频率不会绕过暂停或礼品开关。编辑过程中保留草稿，保存使用版本号防止覆盖他人的更新。
首次打开时服务端签发 256 位随机匿名 Cookie（HttpOnly / Secure / SameSite=Strict，有效期 365 天），D1 只保存凭证的 SHA-256 哈希和中奖结果，不以姓名、手机号、IP 或浏览器指纹匹配参与者。管理员登录原有的 IP 哈希限流与抽奖资格无关。抽奖通过原子条件更新只允许一个请求成功写入，重复提交返回同一结果；刷新、重新打开或请求结果丢失后可恢复原结果。多个标签页通过 Web Locks 串行建立凭证（支持该 API 的浏览器），服务端仍负责同凭证的并发限制。
本机历史列表保留最近 12 条旧记录，但本次资格只由云端匿名凭证判断。清除 localStorage 不会重置资格；清除 Cookie、无痕窗口、换浏览器或 Cookie 到期后将被视为新访客。同一浏览器配置文件的使用者共用一次机会。个人结果仅通过对应 Cookie 读取，公共配置不包含个人记录。旧版本抽奖记录不追溯为已参与。

## Cloudflare 配置

1. Pages → 当前项目 → Settings → Bindings，确认 D1 绑定 `EAT_DB`（与 Eat 共用）。也支持独立的 `DRAW_DB`，存在时优先使用。
2. 选择生产环境，在 Settings → Variables and Secrets（变量和密钥）中新增 **`DRAW_ADMIN_PASSWORD`**，类型选择“密钥”（加密），值填写管理员指定的密码。保留现有 `ADMIN` 变量；它与抽奖管理密码无关。预览环境如需使用，应单独配置。
3. 保存后重新部署，确保新的运行时配置生效。不要把密码写入源代码或公开页面。抽奖功能不再读取 KV 中的密码；其他功能原有的 KV 绑定保留。
4. 首次访问会自动建立 `draw_config`、`draw_auth_attempts`、`draw_visitors` 三张表并初始化六款礼品，无需手动执行 SQL，不修改 Eat 表。

管理密码只在服务端从 `env.DRAW_ADMIN_PASSWORD` 读取，不会嵌入构建产物或返回给前端。验证成功签发 30 分钟的 HttpOnly / Secure / SameSite=Strict Cookie；会话不存放在 localStorage。每个来源 IP 在 15 分钟内最多尝试 10 次，成功后清零；失败计数保存为 IP 哈希。没有密码或数据库绑定时不会退回无密码管理或本地抽奖。
修改密钥并重新部署后，新部署会拒绝旧密码签发的会话。配置方式见 [Cloudflare Pages 变量和密钥文档](https://developers.cloudflare.com/pages/functions/bindings/#secrets)。奖池继续使用 D1 主库读取及原子版本更新。

接口：`GET /draw/api/config` 读取共享配置；`GET /draw/api/participation` 建立匿名凭证或读取本人的既有结果；`POST /draw/api/draw` 使用已建立的 Cookie 领取唯一结果，无 Cookie 则拒绝抽奖；`POST /draw/api/auth` 登录；`GET /draw/api/auth` 检查会话；`DELETE /draw/api/auth` 注销；`PUT /draw/api/config` 需要有效管理会话。接口均禁止缓存，配置 GET 支持 ETag，修改接口检查请求来源。返回中不包含密码或他人的抽奖记录。

当前不限库存，每个匿名凭证限一次，不维护全局正在播放的动画或领奖状态。修改礼品、暂停再开启活动或轮换管理员密码不会重置参与资格，旧结果保留中奖时的礼品名称、份数和时间。当前没有新活动重置入口。

视觉采用蓝金配色和本地礼品照片，无第三方图片热链/字体/运行时依赖。四款采用检索到的外观相符商品图，笔记本和购物袋采用用户原图局部展示，具体来源与匹配限制见 [照片来源](images/SOURCES.md)。
构建将照片复制到 `/draw/images/`，使用内容哈希文件名与长期静态缓存；不会将照片塞进 Worker 或 HTML。加载失败时回退到原 SVG 插画。
页头使用[兴业银行官网](https://www.cib.com.cn/)当前的原版 Logo（行徽及中英文组合），本地托管，保持原始比例与配色。
动效仅在抽奖时运行，支持减少动态效果偏好。结果区预留固定高度，长文本可滚动，避免揭晓时页面跳动。

验证：

```sh
python3 eat/build.py
node --test eat/tests/test_worker.mjs
# 安装 eat/tests/requirements.txt 中的 Playwright 后运行，CHROME_BIN 可指定已有 Chromium。
python3 draw/tests/test_draw.py
python3 draw/tests/test_shared.py
python3 draw/tests/test_polling.py
```

旧版 D1 配置缺少权重时，按原始礼品 ID 自动补入上述权重，保留名称、份数、开关等已有修改；自定义礼品默认权重 20。管理员保存后权重写入 D1。关闭礼品后，其余礼品按剩余总权重重新计算概率。已产生的中奖结果不变。
