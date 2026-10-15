#!/usr/bin/env bash
# verify-online.sh — 线上实测台账复现脚本
# 用法: bash scripts/verify-online.sh
# 输出: 端点 HTTP + 字节；DNS 解析

set -u
API_BASE="https://api.swarmlabs.tools"
LIC_BASE="https://license.swarmlabs.tools"
DATA_BASE="https://data.swarmlabs.tools"

echo "=== [1] 端点契约（api-guard） ==="
for u in \
  "$API_BASE/health" \
  "$API_BASE/v1/oss/registry" \
  "$API_BASE/v1/domains" \
  "$API_BASE/v1/citation/edges" \
  "$API_BASE/v1/citation/gaps" ; do
  printf "%-64s " "$u"
  curl -s --ssl-no-revoke --tlsv1.3 --max-time 10 -o /dev/null -w "http=%{http_code} bytes=%{size_download}\n" "$u"
done

# POST semantic search（按设计应返 401）
printf "%-64s " "$API_BASE/v1/search/semantic (POST)"
curl -s --ssl-no-revoke --tlsv1.3 --max-time 10 -X POST -H "Content-Type: application/json" \
  -d '{"q":"test","topK":3}' -o /dev/null -w "http=%{http_code} bytes=%{size_download}\n" \
  "$API_BASE/v1/search/semantic"

echo ""
echo "=== [2] 支付 / 许可层 ==="
printf "%-64s " "$LIC_BASE/health"
curl -s --ssl-no-revoke --tlsv1.3 --max-time 10 -o /tmp/lic_health.json -w "http=%{http_code} bytes=%{size_download} body=" "$LIC_BASE/health"
cat /tmp/lic_health.json; echo ""

printf "%-64s " "$LIC_BASE/api/hupijiao/order?trade_order_id=probe-1015"
curl -s --ssl-no-revoke --tlsv1.3 --max-time 10 -o /tmp/lic_order.json -w "http=%{http_code} bytes=%{size_download} body=" "$LIC_BASE/api/hupijiao/order?trade_order_id=probe-1015"
cat /tmp/lic_order.json; echo ""

echo ""
echo "=== [3] 数据分发（GitHub Pages 直出） ==="
for u in \
  "$DATA_BASE/openapi.yaml" \
  "$DATA_BASE/data/citation-gaps.json" ; do
  printf "%-64s " "$u"
  curl -s --ssl-no-revoke --tlsv1.3 --max-time 10 -o /dev/null -w "http=%{http_code} bytes=%{size_download}\n" "$u"
done

echo ""
echo "=== [4] DNS 解析 ==="
for h in \
  api.swarmlabs.tools \
  data.swarmlabs.tools \
  license.swarmlabs.tools \
  quantum-computing.swarmlabs.tools \
  tcm.swarmlabs.tools ; do
  printf "%-40s %s\n" "$h" "$(getent hosts "$h" 2>/dev/null | awk '{print $1}' | head -1 | sed 's/^$/<no record>/')"
done

echo ""
echo "=== [5] 时间戳 ==="
date -u +"%Y-%m-%dT%H:%M:%SZ"
