p = 'tools/build-site.mjs'
with open(p, encoding='utf-8') as f:
    s = f.read()
old = (
    "  var metaBase = document.querySelector('meta[name=\"llm-api-base\"]');\n"
    "  var FALLBACK_ENDPOINTS = ['https://api.genetech.tools', 'https://api.swarmlabs.tools', 'https://genetech-api-guard.61960005.workers.dev'];\n"
    "  var ENDPOINTS = (metaBase && metaBase.content && metaBase.content.trim())\n"
    "    ? metaBase.content.trim().replace(/\\/+$/, '')\n"
    "    : 'https://api.genetech.tools';"
)
new = (
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
if old in s:
    s = s.replace(old, new, 1)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(s)
    print('ASK BLOCK REPLACED OK')
else:
    print('ASK OLD NOT FOUND')
