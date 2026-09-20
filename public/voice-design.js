// Shared, finite design vocabulary. No model-generated CSS, HTML, URLs or scripts.
export const PROFILE_THEMES = ["yellow", "cyan", "violet", "orange", "silver", "rose", "green", "blue"];
export const PROFILE_DESIGN_OPTIONS = {
  layout: ["stack", "centered", "compact"],
  banner: ["solid", "grid", "scanlines", "diagonal", "orbit"],
  font: ["sans", "mono", "serif"],
  surface: ["carbon", "midnight", "paper"],
  edges: ["sharp", "soft"],
  avatarShape: ["circle", "square", "hex"],
  motion: ["none", "breathe"]
};
export const DEFAULT_PROFILE_DESIGN = Object.freeze(Object.fromEntries([
  ...Object.entries(PROFILE_DESIGN_OPTIONS).map(([key, values]) => [key, values[0]]), ["tagline", ""]
]));
export function profileText(value, length) {
  return typeof value === "string" ? value.normalize("NFC").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, length) : "";
}
export function normalizeProfileDesign(value, strict = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strict) throw new Error("面板设计格式不正确");
    return { ...DEFAULT_PROFILE_DESIGN };
  }
  if (strict && Object.keys(value).some(key => !Object.hasOwn(DEFAULT_PROFILE_DESIGN, key))) throw new Error("面板设计含不支持的字段");
  const result = {};
  for (const [key, values] of Object.entries(PROFILE_DESIGN_OPTIONS)) {
    if (strict && !values.includes(value[key])) throw new Error("面板设计含不支持的样式");
    result[key] = values.includes(value[key]) ? value[key] : DEFAULT_PROFILE_DESIGN[key];
  }
  if (strict && (typeof value.tagline !== "string" || value.tagline.length > 48)) throw new Error("面板短句不能超过 48 个字");
  result.tagline = profileText(value.tagline, 48);
  return result;
}
