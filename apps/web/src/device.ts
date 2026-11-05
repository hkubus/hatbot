export function deviceName(ua: string | null): string {
  if (!ua) return "A browser";
  const app = /HatbotApp\/\S+ \((\w+)\)/.exec(ua)?.[1];
  if (app) return `Hatbot's app on ${app}`;
  const browser = /Edg(e|iOS|A)?\//.test(ua)
    ? "Edge"
    : /(Firefox|FxiOS)\//.test(ua)
      ? "Firefox"
      : /(Chrome|CriOS)\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "A browser";
  // iOS says "like Mac OS X", and Android says "Linux", so they're asked first.
  const system = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "a Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  return system ? `${browser} on ${system}` : browser;
}
