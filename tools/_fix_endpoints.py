p = 'tools/build-site.mjs'
with open(p, encoding='utf-8') as f:
    s = f.read()
s = s.replace('\r\n', '\n')  # normalize CRLF -> LF

old_ask = (
    "  var metaBase = document.querySelector('meta[name=\"llm-api-base\"]');\n"
    "  var FALLBACK_ENDPOINTS = ['https://api.genetech.tools', 'https://api.swarmlabs.tools', 'https://genetech-api-guard.61960005.workers.dev'];\n"
    "  var ENDPOINTS = (metaBase && metaBase.content && metaBase.content.trim())\n"
    "    ? metaBase.content.trim().replace(/\\\\/+$/, '')\n"
    "    : 'https://api.genetech.tools';"
)
new_ask = (
    "  var metaBase = document.querySelector('meta[name=\"llm-api-base\"]');\n"
    "  var FALLBACK_ENDPOINTS = ['https://api.genetech.tools', 'https://api.swarmlabs.tools', 'https://genetech-api-guard.61960005.workers.dev'];\n"
    "  var ENDPOINTS = (metaBase && metaBase.content && metaBase.content.trim())\n"
    "    ? [metaBase.content.trim().replace(/\\/+$/, '')].concat(FALLBACK_ENDPOINTS)\n"
    "    : FALLBACK_ENDPOINTS;\n"
    "  async function fetchAny(path, opts) {\n"
    "    var lastErr;\n"
    "    for (var i = 0; i < ENDPOINTS.length; i++) {\n"
    "      try {\n"
    "        var r = await fetch(ENDPOINTS[i] + path, opts);\n"
    "        if (r.ok || (r.status >= 200 && r.status < 500)) return r;\n"
    "        lastErr = new Error('HTTP ' + r.status);\n"
    "      } catch (e) { lastErr = e; }\n"
    "    }\n"
    "    throw lastErr || new Error('所有推理端点均不可达');\n"
    "  }"
)

old_lic = "var WORKER = 'https://license.genetech.tools';"
new_lic = (
    "var WORKERS = ['https://license.genetech.tools', 'https://license.swarmlabs.tools', 'https://genetech-license.61960005.workers.dev'];\n"
    "async function fetchWorker(path, opts) {\n"
    "  var lastErr;\n"
    "  for (var i = 0; i < WORKERS.length; i++) {\n"
    "    try {\n"
    "      var r = await fetch(WORKERS[i] + path, opts);\n"
    "      if (r.ok || (r.status >= 200 && r.status < 500)) return r;\n"
    "      lastErr = new Error('HTTP ' + r.status);\n"
    "    } catch (e) { lastErr = e; }\n"
    "  }\n"
    "  throw lastErr || new Error('所有许可证端点均不可达');\n"
    "}"
)

repls = [
    (old_ask, new_ask, 'ASK'),
    (old_lic, new_lic, 'LIC'),
    ("fetch(ENDPOINT + '/api/llm/chat/completions'", "fetchAny('/api/llm/chat/completions'", 'FETCH_LLM'),
    ("fetch(WORKER + '/api/hupijiao/create-order'", "fetchWorker('/api/hupijiao/create-order'", 'FETCH_ORDER'),
    ("fetch(WORKER + '/api/hupijiao/order?trade_order_id='", "fetchWorker('/api/hupijiao/order?trade_order_id='", 'FETCH_POLL'),
]

for old, new, name in repls:
    if old in s:
        s = s.replace(old, new, 1)
        print('OK   ', name)
    else:
        print('MISS ', name)

with open(p, 'w', encoding='utf-8') as f:
    f.write(s)
print('DONE')
