/** 部署路径（来自 VITE_BASE），总以 / 结尾，例如 "/" 或 "/infinite-canvas/"。 */
export const APP_BASE_URL = import.meta.env.BASE_URL || "/";

/** 前端路由的 basename：根路径部署时为 "/"，子路径部署时去掉末尾的 /。 */
export const ROUTER_BASENAME = APP_BASE_URL === "/" ? "/" : APP_BASE_URL.replace(/\/+$/, "");

/**
 * 把 public 目录下以 / 开头的路径（如 "/icons/a.svg"、插件清单里的 "/plugins/a.js"）换成带部署路径的地址；完整 URL、data:、blob: 等原样返回。
 * 传入的总是 public 目录内的路径，不会是已经带部署路径的地址，所以一律补前缀；部署路径恰好叫 /plugins/ 或 /icons/ 时也不会误判。
 */
export function publicUrl(path: string, base = APP_BASE_URL) {
    if (!path.startsWith("/") || path.startsWith("//")) return path;
    const prefix = base.endsWith("/") ? base : `${base}/`;
    return `${prefix}${path.slice(1)}`;
}

/** 把浏览器地址栏里的完整路径换成路由内路径（去掉部署路径前缀）。 */
export function routerPath(pathname: string, basename = ROUTER_BASENAME) {
    if (basename === "/" || !pathname.startsWith(basename)) return pathname;
    const rest = pathname.slice(basename.length);
    return rest.startsWith("/") ? rest : `/${rest}`;
}
