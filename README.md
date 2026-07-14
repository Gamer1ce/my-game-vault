# My Game Vault

> 搭建属于自己的全平台游戏记录网站。

My Game Vault 是一个本地优先的 Xbox、PlayStation、Nintendo 与 Steam 游戏档案。它把不同平台的累计时长、成就、海报、最后游玩日期和 MC 评分归一到同一个赛博朋克风格页面，同时明确区分“官方确切数据”和“无法从接口还原的数据”。

## 为什么值得一试

- **一站式游戏履历**：统一展示四个平台，自动过滤 0 分钟记录并汇总总时长、游戏数、成就和全成就游戏。
- **不是普通列表**：横版海报、官方平台图标、Cyberpunk 风格故障动画；点击海报可进入对应官方商店。
- **可解释的游戏日历**：根据两次同步间的累计时长差生成每日分钟数；只有最后游玩日期、没有分钟数时会明确标为“当日时长未知”，不会伪造历史。
- **评分双重补全**：优先读取 RAWG 的 Metacritic 字段，缺失时再从 Metacritic 公开游戏页精确匹配；结果缓存 30 天。
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

程序用 NPSSO 换取可刷新的访问令牌，随后同步 PlayStation 游戏历史和奖杯。NPSSO 的权限接近登录凭据，请勿截图、分享或提交到 Git。

### Xbox

1. 打开 [OpenXBL](https://xbl.io/)，选择 **Login with Xbox Live** 并关联自己的 Xbox 账号。
2. 在 OpenXBL 账号页创建或复制 Personal API Key。
3. 将 Key 粘贴到本程序。

这个方案不需要 Azure 订阅。OpenXBL 是非微软官方的第三方网关，免费版有请求频率限制，且部分游戏不会发布 `MinutesPlayed`，因此可能出现有游戏记录但时长缺失的情况。

### Nintendo Switch

1. 先在官方 Nintendo Switch Parental Controls 手机 App 中绑定 Switch。
2. 在本程序点击 Nintendo 连接，打开任天堂官方登录页。
3. 在“关联外部账号”页面长按或右键“选择此人”，复制以 `npf54789befb391a838://auth` 开头的完整链接。
4. 把链接粘贴回程序完成授权。

程序读取家长监护保存的日报与月报，它不等于任天堂账号的终身累计时长。任天堂目前没有面向个人开发者的公开 Play Activity API；不使用家长监护时，只能在 Nintendo Store App 中查看，暂时无法稳定自动导入。

### Steam

1. 登录 [Steam Web API Key 页面](https://steamcommunity.com/dev/apikey)，域名可填 `localhost`。
2. 将 Steam 隐私设置中的“游戏详情”设为公开。
3. 填写 32 位 Web API Key，以及 SteamID64、自定义主页名称或完整个人主页链接。

SteamID64 可在个人资料链接中找到，格式通常以 `7656119…` 开头；自定义链接也可以由程序解析。程序会同步累计时长、最后游玩日期和公开成就。

### Metacritic 评分

1. 在 [RAWG API 页面](https://rawg.io/apidocs)注册免费账号并生成 Key。
2. 在“数据来源”中连接“MC 评分”。
3. 程序先按标题和平台查询 RAWG；RAWG 评分为空时，再核对 Metacritic 公开游戏页。

无法精确匹配、尚无媒体评分或 Metacritic 未收录的游戏显示 `MC —`，不会用用户评分或其他网站评分冒充 MC 分数。

## 游戏日历是怎样计算的

多数平台只提供“当前累计时长”，并不提供完整的逐日分钟数。因此程序在每次同步时保存一个基线：

```text
本次累计时长 - 上次累计时长 = 本次同步发现的新增分钟数
```

- 第一次连接只建立基线，不会把几千小时历史全部算到当天。
- 日历实心颜色表示程序实际检测到的新增分钟数。
- 粉色描边表示平台只告诉了“最后游玩日期”；点开后会显示游戏与当前累计时长，但注明“当日时长未知”。
- 程序运行以前的每日分钟数无法从累计值反推。需要长期保留日历，请持续运行并定期同步。

## 我们遇到的平台问题，以及解决办法

这些不是前端或数据库 Bug，而是账号权限和平台数据边界。

| 问题 | 原因 | 处理方式 |
| --- | --- | --- |
| Xbox OAuth 提示 Bad Request、还要求 Azure | 微软开发者应用注册流程复杂，个人用途也容易卡在租户、回调地址和权限上 | 改用 OpenXBL Personal API Key；不需要 Azure 订阅，但要接受第三方网关和频率限制 |
| Xbox 同步成功却没有时长 | 不是每款游戏都向 Xbox 统计接口发布 `MinutesPlayed` | 保留有可靠时长的记录；0 分钟游戏不展示，不把成就进度猜成时长 |
| PlayStation 总时长比其他 App 少 | PSN 游戏历史接口可能遗漏旧游戏、特定世代/地区版本或不可见记录；第三方 App 也可能使用不同接口或历史缓存 | 确认账号和隐私设置，重复同步并按游戏核对；无法由当前官方响应证明的时长不手工补写 |
| 申请账号“数据副本”后无法实时更新 | 数据副本是一次性导出，不是可轮询 API | 只把导出文件用于核对或初始化；实时更新依赖平台连接器和定期同步 |
| Nintendo 已关联却没有终身游戏数据 | 家长监护接口只覆盖其保存期内的日报/月报，账号本身没有公开 Play Activity API | 提前绑定家长监护并持续同步；没有家长监护时只能在官方 App 查看 |
| Steam 有账号却读取不到游戏 | “游戏详情”未公开、SteamID 填错，或 Web API Key 已失效 | 公开游戏详情，使用 SteamID64/完整主页重试；泄露过的 Key 应立即在 Steam 页面注销并重新生成 |
| 明明有 MC 分却显示 `MC —` | RAWG 的 Metacritic 字段并不完整，或不同版本标题不一致 | 程序会做标题规范化、平台匹配、RAWG 详情查询，并用 Metacritic 公开页作第二级兜底；仍失败时等待缓存到期后重试 |

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
- 只显示时长大于 0 的游戏；这能避免空记录污染统计，但也意味着“拥有但未启动”的游戏不会出现。
- Nintendo 没有系统级成就；Xbox 部分记录只返回已解锁成就数而没有可靠总数，这类游戏不参与全成就判断。

## 技术栈

Node.js、Express、原生 SQLite、原生 HTML/CSS/JavaScript，以及针对 PlayStation、Xbox、Nintendo、Steam 和 RAWG/Metacritic 的独立连接器。项目不需要云数据库，适合在自己的电脑或家庭服务器上运行。

## 免责声明

本项目与 Microsoft、Sony、Nintendo、Valve、RAWG 或 Metacritic 无隶属关系。请只连接你自己的账号，并遵守各平台条款。平台名称、商标、评分和游戏图片归各自权利人所有。

## License

[MIT](LICENSE)
