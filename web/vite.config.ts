import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

/** 开发时可选：设置 COMFYUI_URL（例如 http://10.10.20.10:8188）后，/comfyui 同源转发到 ComfyUI，和 Docker 镜像行为一致。 */
function comfyProxy() {
    const target = process.env.COMFYUI_URL?.trim().replace(/\/+$/, "");
    if (!target || !/^https?:\/\//i.test(target)) return undefined;
    return {
        "/comfyui": {
            target,
            changeOrigin: true,
            ws: true,
            rewrite: (path: string) => path.replace(/^\/comfyui/, "") || "/",
            // ComfyUI 会拒绝 Origin 与自身地址不一致的请求；普通请求和 WebSocket 升级请求（进度推送）都要去掉。
            configure: (proxy: { on: (event: "proxyReq" | "proxyReqWs", handler: (request: { removeHeader: (name: string) => void }) => void) => void }) => {
                proxy.on("proxyReq", (request) => request.removeHeader("origin"));
                proxy.on("proxyReqWs", (request) => request.removeHeader("origin"));
            },
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    server: { proxy: comfyProxy() },
    plugins: [react(), localPluginsManifest()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
