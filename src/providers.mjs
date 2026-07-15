// 平台能力注册表。未来获得正式开发者权限后，可在这里为平台加入
// connect() / sync() 实现，而不需要改动统一的 games 数据模型。
export const providers = [
  {
    id: "xbox",
    name: "Xbox",
    mode: "openxbl-api-key",
    status: "可连接",
    detail: "使用 OpenXBL 免费 API Key 同步 Xbox 游戏历史与 MinutesPlayed；数据会经过 OpenXBL，部分游戏不提供时长。"
  },
  {
    id: "playstation",
    name: "PlayStation",
    mode: "experimental-token",
    status: "可连接",
    detail: "用 Sony NPSSO 换取可刷新的访问令牌，再从 PlayStation 游戏历史同步官方累计时长。"
  },
  {
    id: "nintendo",
    name: "Nintendo",
    mode: "play-activity-or-parental-controls",
    status: "可连接",
    detail: "推荐使用 Nintendo 账号游戏记录读取累计时长和最近七天明细，无需家长监护；也保留家长监护日报/月报模式。"
  },
  {
    id: "steam",
    name: "Steam",
    mode: "official-web-api",
    status: "可连接",
    detail: "使用 Steam 官方 Web API Key 与 SteamID64/个人主页同步拥有的游戏、累计时长和最后游玩日期。"
  },
  {
    id: "rawg",
    name: "MC 评分",
    mode: "rawg-api-key",
    status: "可连接",
    detail: "优先使用 RAWG 免费 API，缺分时从 Metacritic 公开游戏页补全并缓存；无法精确匹配时显示为 —。"
  }
];

export function getProvider(id) {
  return providers.find((provider) => provider.id === id) ?? null;
}
