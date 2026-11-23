#!/bin/sh
set -e

# Executed automatically by the official nginx image entrypoint through /docker-entrypoint.d/*.sh before nginx starts.
# Generate runtime config.js from environment variables. Each analytics provider has an independent variable;
# unset providers remain disabled, load no scripts, and send no external requests. Multiple providers may be enabled together.

# GA4 and Baidu IDs contain only letters, numbers, and hyphens. Remove other characters
# so quotes and similar values cannot break the JavaScript strings in config.js as a defense-in-depth measure.
sanitize_id() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9-'
}

GA4_ID=$(sanitize_id "${ANALYTICS_GA4_ID:-}")
BAIDU_ID=$(sanitize_id "${ANALYTICS_BAIDU_ID:-}")

cat > /usr/share/nginx/html/config.js <<EOF
window.__RUNTIME_CONFIG__ = {
  ANALYTICS_GA4_ID: "${GA4_ID}",
  ANALYTICS_BAIDU_ID: "${BAIDU_ID}"
};
EOF

# 可选：把 /comfyui/ 反向代理到局域网里的 ComfyUI，浏览器同源访问，ComfyUI 无需开启 CORS。
# 例如 COMFYUI_URL=http://10.10.20.10:8188，渠道接口地址填 /comfyui。
# 只接受 http(s)://主机[:端口][/路径]，拒绝空格、引号、分号、花括号等可能改写 nginx 配置的字符。
LOCATIONS_DIR="${NGINX_LOCATIONS_DIR:-/etc/nginx/locations.d}"
mkdir -p "$LOCATIONS_DIR"
rm -f "$LOCATIONS_DIR/comfyui.conf"
COMFYUI_URL_VALUE=$(printf '%s' "${COMFYUI_URL:-}" | sed 's:/*$::')
# grep 按行匹配，带换行的值可能只有某一行合法；先整体拒绝换行和回车，再校验格式。
case "$COMFYUI_URL_VALUE" in
    *"
"*|*"$(printf '\r')"*) COMFYUI_URL_INVALID=1 ;;
    *) COMFYUI_URL_INVALID= ;;
esac
if [ -n "$COMFYUI_URL_VALUE" ]; then
    if [ -z "$COMFYUI_URL_INVALID" ] && printf '%s' "$COMFYUI_URL_VALUE" | grep -Eq '^https?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'; then
        cat > "$LOCATIONS_DIR/comfyui.conf" <<NGINX
location /comfyui/ {
    proxy_pass ${COMFYUI_URL_VALUE}/;
    proxy_http_version 1.1;
    proxy_set_header Host \$proxy_host;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
    # ComfyUI 会拒绝 Origin 与自身地址不一致的请求；同源代理不转发 Origin。
    proxy_set_header Origin "";
    proxy_buffering off;
    # 上传参考图的大小上限和等待生成的读取超时。
    client_max_body_size 50m;
    proxy_read_timeout 300s;
}
NGINX
        echo "ComfyUI proxy: /comfyui/ -> ${COMFYUI_URL_VALUE}/"
    else
        echo "COMFYUI_URL is not a valid http(s) URL; /comfyui/ proxy disabled" >&2
    fi
fi
