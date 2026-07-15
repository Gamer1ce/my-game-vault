# My Game Vault

> 搭建属于自己的全平台游戏记录网站。

My Game Vault 是一个本地优先的 Xbox、PlayStation、Nintendo 与 Steam 游戏档案。它把不同平台的累计时长、成就、海报、最后游玩日期和 MC 评分归一到同一个赛博朋克风格页面，同时明确区分“官方确切数据”和“无法从接口还原的数据”。

## 界面预览

![My Game Vault 总览](docs/screenshots/overview.jpg)

![游戏活动日历](docs/screenshots/calendar.jpg)

![带平台图标、横版海报与 MC 评分的游戏库](docs/screenshots/library.jpg)

## 为什么值得一试

- **一站式游戏履历**：统一展示四个平台，自动过滤 0 分钟记录并汇总总时长、游戏数、成就和全成就游戏。
- **不是普通列表**：横版海报、官方平台图标，以及从《赛博朋克 2077》官网提炼的高对比黄色、切角面板、窄体技术字和间歇式信号故障；点击海报可进入对应官方商店。
- **可解释的游戏日历**：根据两次同步间的累计时长差生成每日分钟数；只有最后游玩日期、没有分钟数时会明确标为“当日时长未知”，不会伪造历史。
- **评分多级补全**：依次核对 RAWG、RAWG 游戏详情、Steam 商店官方 Metacritic 元数据与 Metacritic 公开游戏页；内置 Nintendo 日文/中文标题和 Switch 2 Edition 的规范名匹配，结果缓存 30 天。
- **本地隐私设计**：SQLite 数据和平台凭据只保存在本机；凭据采用 AES-256-GCM 加密，账号密码和验证码不会写入数据库。
- **数据源可替换**：每个平台连接器独立，最终统一为同一种游戏数据模型，便于后续适配平台接口变化。

## 快速开始

需要 Node.js 22.5 或更高版本。

```bash
git clone https://github.com/Gamer1ce/my-game-vault.git
cd my-game-vault
npm install
npm start
```

打开 <http://localhost:4173>。首次启动会自动创建 `data/games.db` 和本机凭据文件。

### macOS 一键启动

双击项目根目录中的 `启动游戏时光库.command` 即可。它会在首次运行时安装依赖、启动服务并自动打开浏览器；终端窗口保持打开时，网站会继续运行和自动同步。

如果 macOS 阻止首次打开，请右键该文件选择“打开”，确认一次后即可正常双击。也可以把它拖到桌面或 Dock 旁边方便使用。

运行测试：

```bash
npm test
```

## 连接游戏平台

连接成功后会立即同步一次。服务持续运行时每 6 小时自动同步，也可在“数据来源”中手动同步。

### PlayStation

1. 在浏览器登录 [PlayStation 官网](https://www.playstation.com/)。
2. 保持登录并打开 [Sony NPSSO 页面](https://ca.account.sony.com/api/v1/ssocookie)。
3. 复制 JSON 中的 `npsso` 值，粘贴到本程序。

程序使用 [`psn-api`](https://github.com/achievements-app/psn-api) 将 NPSSO 换成访问令牌，随后同步 PlayStation 游戏历史、逐游戏奖杯和账号奖杯汇总。首页的 PlayStation“全成就游戏”使用白金奖杯数量；这比只按当前游戏列表逐项匹配更完整。奖杯接口本身不包含游玩时长，时长只来自 Sony 游戏历史响应里的 `playDuration`。NPSSO 的权限接近登录凭据，请勿截图、分享或提交到 Git。

### Xbox

1. 打开 [OpenXBL](https://xbl.io/)，选择 **Login with Xbox Live** 并关联自己的 Xbox 账号。
2. 在 OpenXBL 账号页创建或复制 Personal API Key。
3. 将 Key 粘贴到本程序。

这个方案不需要 Azure 订阅。OpenXBL 是非微软官方的第三方网关，免费版有请求频率限制，且部分游戏不会发布 `MinutesPlayed`，因此可能出现有游戏记录但时长缺失的情况。

### Nintendo Switch

程序提供两种连接方式。推荐先尝试“游戏记录（无需家长监护）”：

1. 在本程序点击 Nintendo 连接，选择“游戏记录”。
2. 打开任天堂官方登录页并完成登录。
3. 在“选择此人”页面不要直接点击按钮；长按或右键复制按钮链接。
4. 把以 `npf5c38e31cd085304b://auth` 开头的完整链接粘贴回程序。

授权流程参考了[这篇接口分析](https://blog.siriyang.cn/posts/20230130130150id.html)。本项目适配 Nintendo Store 3.x 当前使用的游戏记录接口，可读取账号累计时长和最近逐日记录，不需要家长监护；当前接口结构也可在 [`nscard`](https://github.com/ChengChung/nscard) 与 [`vm0`](https://github.com/vm0-ai/vm0) 的开源实现中核对。

如果账号或地区无法使用游戏记录模式，可切换到“家长监护”模式：先在 Nintendo Switch Parental Controls 手机 App 中绑定主机，授权时复制以 `npf54789befb391a838://auth` 开头的回跳链接。该模式通过 [`nxapi`](https://github.com/samuelthomas2774/nxapi) 读取家长监护日报与月报。

两种方式都使用任天堂官方客户端背后的非公开接口，而不是面向个人开发者承诺稳定的公开 API；接口、客户端 ID 或登录流程变化时可能需要更新连接器。现有家长监护连接不会自动变成游戏记录连接，需要断开 Nintendo 后重新选择模式授权。

### Steam

1. 登录 [Steam Web API Key 页面](https://steamcommunity.com/dev/apikey)，域名可填 `localhost`。
2. 将 Steam 隐私设置中的“游戏详情”设为公开。
3. 填写 32 位 Web API Key，以及 SteamID64、自定义主页名称或完整个人主页链接。

SteamID64 可在个人资料链接中找到，格式通常以 `7656119…` 开头；自定义链接也可以由程序解析。程序会同步累计时长、最后游玩日期和公开成就。

### Metacritic 评分

1. 在 [RAWG API 页面](https://rawg.io/apidocs)注册免费账号并生成 Key。
2. 在“数据来源”中连接“MC 评分”。
3. 程序先按标题和平台查询 RAWG；缺分时继续检查 RAWG 详情、Steam 商店元数据以及 Metacritic 公开游戏页。

无法精确匹配、尚无媒体评分或 Metacritic 未收录的游戏显示 `MC —`，不会用用户评分或其他网站评分冒充 MC 分数。

## 游戏日历是怎样计算的

多数平台只提供“当前累计时长”，并不提供完整的逐日分钟数。因此程序在每次同步时保存一个基线：

```text
本次累计时长 - 上次累计时长 = 本次同步发现的新增分钟数
```

- 第一次连接只建立基线，不会把几千小时历史全部算到当天。
- 日历实心颜色表示程序实际检测到的新增分钟数。
- 粉色描边表示平台只告诉了“最后游玩日期”；点开后会按平台列出每款游戏与当前累计时长，并注明“当日时长未知”。
- Nintendo 游戏记录模式会保存接口提供的最近逐日分钟数；这部分会显示确切当日时长。
- 程序运行以前的每日分钟数无法从累计值反推。需要长期保留日历，请持续运行并定期同步。

## 我们遇到的平台问题，以及解决办法

这些不是前端或数据库 Bug，而是账号权限和平台数据边界。

| 问题 | 原因 | 处理方式 |
| --- | --- | --- |
| Xbox OAuth 提示 Bad Request、还要求 Azure | 微软开发者应用注册流程复杂，个人用途也容易卡在租户、回调地址和权限上 | 改用 OpenXBL Personal API Key；不需要 Azure 订阅，但要接受第三方网关和频率限制 |
| Xbox 同步成功却没有时长 | 不是每款游戏都向 Xbox 统计接口发布 `MinutesPlayed` | 保留有可靠时长的记录；0 分钟游戏不展示，不把成就进度猜成时长 |
| PlayStation 总时长比其他 App 少 | `psn-api` 调用的是 Sony 当前游戏列表接口；[项目维护者也注明 Sony 返回的时长可能不准确](https://github.com/achievements-app/psn-api/issues/120#issuecomment-1450070484)。奖杯列表没有时长，第三方 App 还可能保存了多年历史快照 | 确认隐藏游戏和隐私设置后重新同步；程序会保留每款游戏见过的最大累计值，但无法从奖杯数据反推出 Sony 当前响应缺失的几百小时 |
| 申请账号“数据副本”后无法实时更新 | 数据副本是一次性导出，不是可轮询 API | 只把导出文件用于核对或初始化；实时更新依赖平台连接器和定期同步 |
| Nintendo 已关联却没有游戏数据 | 旧连接使用家长监护模式但账号没有可用日报/月报，或新游戏记录接口不支持当前账号/地区 | 断开后重新选择“游戏记录”模式；仍失败时改用家长监护模式并确认手机 App 已绑定主机 |
| Steam 有账号却读取不到游戏 | “游戏详情”未公开、SteamID 填错，或 Web API Key 已失效 | 公开游戏详情，使用 SteamID64/完整主页重试；泄露过的 Key 应立即在 Steam 页面注销并重新生成 |

## 官方数据文件导入

程序支持 `.xlsx`、`.csv` 和 `.json`，用于导入平台官方数据副本或你自己的历史备份。请不要用它随意修改时长，否则总时长将失去“来自平台数据”的含义。

常见字段：

- 游戏名称：`title`、`game`、`游戏名称`、`软件`
- 时长：`minutes`、`hours`、`playtime`、`游玩时长`
- 可选：`platform`、`last played`、`external id`

重复导入同一游戏时保留较大的累计值，不会把相同数据反复相加。

## 数据与安全

- 游戏数据库：`data/games.db`
- 加密凭据：`data/credentials.enc`
- 本机加密密钥：`data/.credential-key`
- 以上内容、SQLite 临时文件、依赖目录和系统文件均已加入 `.gitignore`。
- 断开平台会删除本地保存的连接凭据，但保留已同步游戏；如需彻底撤销权限，还要到对应平台的授权/安全页面撤销远端会话。
- 不要把 `data` 目录、API Key、NPSSO、授权回跳链接或带有这些内容的截图分享给他人。

## 已知限制

- 各主机平台都没有为个人跨平台游戏时长网站提供稳定、完整的公开 API；平台改版可能导致连接器暂时失效。
- MC 兜底依赖 Metacritic 公开页面结构，页面变更或访问限制可能让部分评分暂时缺失。
- 体验版、配套资料、视频应用以及没有媒体评测的小品游戏会显示 `MC —`；程序不会把本体评分自动套给内容不同的附属条目。
- 只显示时长大于 0 的游戏；这能避免空记录污染统计，但也意味着“拥有但未启动”的游戏不会出现。
- Nintendo 没有系统级成就；Xbox 部分记录只返回已解锁成就数而没有可靠总数，这类游戏不参与全成就判断。
- PlayStation 的全成就数量按账号白金奖杯统计；首页总数还会加上 Steam/Xbox 能确认的全成就游戏，因此可能大于 PS 平台白金数。Sony 的游戏时长只覆盖接口当前返回的 PS4/PS5 记录，不能由奖杯数据补齐。

## 技术栈

Node.js、Express、原生 SQLite、原生 HTML/CSS/JavaScript，以及针对 PlayStation、Xbox、Nintendo、Steam 和 RAWG/Metacritic 的独立连接器。项目不需要云数据库，适合在自己的电脑或家庭服务器上运行。

## 免责声明

本项目与 Microsoft、Sony、Nintendo、Valve、RAWG 或 Metacritic 无隶属关系。请只连接你自己的账号，并遵守各平台条款。平台名称、商标、评分和游戏图片归各自权利人所有。

## License

[MIT](LICENSE)
