export const gameSyncProviderOrder = Object.freeze([
  "playstation",
  "xbox",
  "nintendo",
  "steam",
  "rawg"
]);

export function createGameSyncTargets(syncByProvider) {
  return gameSyncProviderOrder.map((id) => {
    const sync = syncByProvider?.[id];
    if (typeof sync !== "function") throw new TypeError(`缺少 ${id} 同步函数`);
    return { id, sync };
  });
}
