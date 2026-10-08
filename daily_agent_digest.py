#!/usr/bin/env python3
import argparse, datetime as dt, hashlib, json, os, re, sqlite3, subprocess, ssl, urllib.error, urllib.request
from pathlib import Path

TZ = dt.timezone(dt.timedelta(hours=8))
APP_DIR = Path(os.getenv('DIGEST_HOME', Path.home()/'Library/Application Support/Daily Agent Digest'))
RELEASE_VERSION = os.getenv('DIGEST_RELEASE_VERSION', 'dev')
# 服务端/CDN 可能拦截 Python-urllib 的默认 UA(例如 Cloudflare 的 1010),所以带自己的标识。
USER_AGENT = f'DailyAgentDigest/{RELEASE_VERSION}'

# 工作日志管理模块(企业管理 → 工作日志管理)的日报上报接口,契约见 docs/backend-api.md。
# 设置里填的是**基地址**(如 http://192.168.110.164/api),这个路径由客户端拼上去 ——
# 密钥的「授权URL」按整条地址登记,所以拼接结果必须与服务端登记的完全一致。
REPORT_PATH = '/admin/enterprise/worklog/api/report'

# API 密钥验证接口(安全与凭证 → 密钥管理 → 内部密钥 → 验证密钥)。
# 只校验不写入;密钥放请求体而不是 URL,避免明文进访问日志。
VERIFY_PATH = '/admin/api-key/verify'

# Report contract (docs/requirements.md FR-3.11). The whole report is
# 工作总结 + every work-item title, counted in characters with whitespace
# removed, capped at REPORT_CHAR_LIMIT. The report is a list of independent
# work items, each with its own heading and body, so removing one is a plain
# array filter - never an LLM regeneration.
REPORT_CHAR_LIMIT = 1000     # 工作总结 = 所有 {title + desc} 之和
TITLE_CHAR_MAX = 30          # 工作项标题上限
ITEM_CHAR_MAX = 300          # 单项正文的上限(项少时可以写满)
ITEM_CHAR_MIN = 100          # 单项正文的目标下限(仅提示词引导)
ITEM_READABLE_FLOOR = 20     # 预算不足时正文不会被压到这个长度以下

# 送进 LLM 的上下文预算与选材规则(FR-2)。
# 曾经直接按采集顺序取前 N 条,冗长的工具/命令输出会吃光预算:实测 281 条事件
# 只有 34 条进得去,而且全部来自 codex —— deepseek-harness 的 214 条一条没进,
# 模型只能看见自动化噪音,于是日报里只有自动化工作项。
CONTEXT_CHAR_LIMIT = 90000   # 单次请求上下文字符上限(D-5 的目标值)
EXCERPT_CHAR_MAX = 900       # 单条摘录上限

def char_count(text):
    return len(''.join(str(text or '').split()))

def normalize_text(text, keep_paragraphs=False):
    text = str(text or '')
    if not keep_paragraphs:
        return ' '.join(text.split())
    # Keep paragraph structure (at most one blank line) so the summary stays
    # readable in the report window.
    lines = [' '.join(line.split()) for line in text.splitlines()]
    out = []
    for line in lines:
        if line or (out and out[-1] != ''):
            out.append(line)
    return '\n'.join(out)

def clamp_text(text, limit, keep_paragraphs=False):
    """Trim to at most `limit` characters, preferring a sentence boundary."""
    text = normalize_text(text, keep_paragraphs)
    if limit <= 0: return ''
    if char_count(text) <= limit: return text
    out, used = [], 0
    for ch in text:
        if not ch.isspace(): used += 1
        if used > limit: break
        out.append(ch)
    cut = ''.join(out)
    for stop in ('。', '！', '？', '；', '\n', '.', '!', '?', ';'):
        idx = cut.rfind(stop)
        if idx >= len(cut) * 0.6:
            return cut[:idx].rstrip() if stop == '\n' else cut[:idx+1]
    return clamp_text_hard(cut, limit)

def clamp_text_hard(text, limit):
    out, used = [], 0
    for ch in text:
        used += 0 if ch.isspace() else 1
        if used > max(0, limit - 1): break
        out.append(ch)
    return ''.join(out).rstrip(' ，,、；;') + '…'

def llm_config():
    return os.getenv('LLM_BASE_URL'), os.getenv('LLM_API_KEY'), os.getenv('LLM_MODEL')

# 抽取层已经只留下提示词/最终文本/交付物,所以这里不再需要任何关键词匹配。
ROLE_TIERS = ('prompt', 'result', 'deliverable', 'process')

def build_context(events, limit=CONTEXT_CHAR_LIMIT):
    """在预算内挑选送进 LLM 的摘录,返回 (上下文文本, 统计)。

    分层:人的提示词 → AI 的最终文本 → 交付物(→ 过程,仅当显式开启)。
    各来源之间轮转取样,任一来源的体量都不会把别的来源挤掉。
    """
    seen = set(); pool = []
    for e in events:
        text = ' '.join(str(e.get('text') or '').split())
        if not text: continue
        fingerprint = hashlib.sha256(text[:800].encode()).hexdigest()
        if fingerprint in seen: continue
        seen.add(fingerprint)
        pool.append((e, f"[{e['provider']}/{e.get('role','?')}] {text[:EXCERPT_CHAR_MAX]}"))

    providers = sorted({e['provider'] for e, _ in pool})
    tiers = {p: {role: [] for role in ROLE_TIERS} for p in providers}
    for e, text in pool:
        tiers[e['provider']][str(e.get('role') or 'process')].append((e, text))

    kept = []; used = 0; taken = {p: 0 for p in providers}; sent_roles = {role: 0 for role in ROLE_TIERS}
    for role in ROLE_TIERS:
        cursor = {p: 0 for p in providers}
        while True:
            progressed = False
            for p in providers:
                rows = tiers[p][role]
                while cursor[p] < len(rows):
                    text = rows[cursor[p]][1]
                    if used + len(text) + 1 > limit: break
                    cursor[p] += 1; taken[p] += 1
                    kept.append(text); used += len(text) + 1
                    sent_roles[role] += 1
                    progressed = True
            if not progressed: break

    omitted = {p: len([x for x in pool if x[0]['provider'] == p]) - taken[p] for p in providers}
    stats = {
        'events': len(events),
        'unique': len(pool),
        'sent': len(kept),
        'chars': used,
        'char_limit': limit,
        'sent_by_provider': {p: taken[p] for p in providers},
        'collected_by_role': {role: sum(1 for e in events if str(e.get('role') or 'process') == role)
                              for role in ROLE_TIERS},
        'sent_by_role': sent_roles,
        'omitted_by_provider': {p: n for p, n in omitted.items() if n},
    }
    return '\n'.join(kept), stats

def context_note(stats):
    """一行人类可读的选材说明,写入报告以便知道有什么没进模型。"""
    if not stats: return ''
    collected = stats.get('collected_by_role') or {}
    sent = stats.get('sent_by_role') or {}
    detail = f"提示词 {collected.get('prompt',0)} / 最终文本 {collected.get('result',0)}"
    if collected.get('deliverable'): detail += f" / 交付物 {collected['deliverable']}"
    parts = [f"当天入库 {stats.get('unique',0)} 条({detail})",
             f"送模型 {stats.get('sent',0)} 条(提示词 {sent.get('prompt',0)} / 最终文本 {sent.get('result',0)}"
             f"{' / 交付物 ' + str(sent.get('deliverable')) if sent.get('deliverable') else ''})"
             f" / {stats.get('chars',0)} 字符(上限 {stats.get('char_limit')})"]
    if stats['omitted_by_provider']:
        detail = '、'.join(f"{p} {n} 条" for p, n in sorted(stats['omitted_by_provider'].items()))
        parts.append(f"因预算省略:{detail}")
    return ';'.join(parts)

def recount_report(state):
    """Report size = the items that will actually be reported.

    Excluding an item is a pure array filter, so the number moves immediately
    and no regeneration is needed.
    """
    included = [i for i in state.get('work_items', []) if not i.get('excluded')]
    state['report_chars'] = sum(char_count(i.get('title','')) + char_count(i.get('desc','')) for i in included)
    state['included_count'] = len(included)
    state['excluded_count'] = len(state.get('work_items', [])) - len(included)
    return state

def fit_report(items, limit=REPORT_CHAR_LIMIT):
    """Clamp every work item to the budget and return (items, total).

    预算在各项之间平均分配:项少时每项可以写到 ITEM_CHAR_MAX,项多时相应压缩,
    但任何情况下都不删除工作项。排除某项是后续的数组过滤,不在这里发生。
    """
    fitted = [dict(item, title=clamp_text(item.get('title', ''), TITLE_CHAR_MAX)) for item in items]
    n = len(fitted)
    if not n:
        return fitted, 0
    title_chars = sum(char_count(i['title']) for i in fitted)
    per_item = max(0, min(ITEM_CHAR_MAX, (limit - title_chars) // n))
    for item in fitted:
        item['desc'] = clamp_text(item.get('desc', ''), per_item)

    def total():
        return sum(char_count(i['title']) + char_count(i['desc']) for i in fitted)

    for _ in range(limit):
        if total() <= limit: break
        longest = max(fitted, key=lambda i: char_count(i['desc']))
        current = char_count(longest['desc'])
        if current <= ITEM_READABLE_FLOOR: break
        longest['desc'] = clamp_text(longest['desc'], current - 1)

    for item in fitted:
        item['chars'] = char_count(item['title']) + char_count(item['desc'])
    return fitted, total()

def load_env():
    path = APP_DIR/'.env'
    if not path.exists(): return
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        if not line or line.lstrip().startswith('#') or '=' not in line: continue
        key, value = line.split('=', 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] == '"':
            try: value = json.loads(value)
            except json.JSONDecodeError: value = value[1:-1]
        for quote in ('"', "'"):
            if len(value) >= 2 and value[0] == value[-1] == quote: value = value[1:-1]
        value = value.replace('\\\"', '"').replace("\\'", "'")
        os.environ[key.strip()] = value

def state_path(): return APP_DIR/'state.json'
def read_state(day=None):
    try: state=json.loads(state_path().read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError): state={}
    if day and state.get('date') != day: state={}
    return state
def write_state(state):
    APP_DIR.mkdir(parents=True, exist_ok=True); tmp=state_path().with_suffix('.json.tmp'); tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8'); os.chmod(tmp, 0o600); os.replace(tmp, state_path())

def debug(message):
    if os.getenv('DIGEST_DEBUG') == '1':
        APP_DIR.mkdir(parents=True, exist_ok=True)
        # 日志含工作内容与上游错误文本,权限必须和 state.json 一致(0600),不能跟随 umask
        log = APP_DIR/'debug.log'
        fd = os.open(log, os.O_WRONLY|os.O_CREAT|os.O_APPEND, 0o600)
        with os.fdopen(fd, 'a', encoding='utf-8') as fh:
            fh.write(f'{dt.datetime.now(TZ).isoformat()} {message}\n')

def tls_context():
    cert_file=os.getenv('SSL_CERT_FILE')
    if not cert_file:
        for candidate in ('/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt'):
            if os.path.exists(candidate): cert_file=candidate; break
    try: return ssl.create_default_context(cafile=cert_file) if cert_file else ssl.create_default_context()
    except (OSError, ssl.SSLError): return ssl.create_default_context()
def app_state(day=None):
    load_env(); day=day or dt.datetime.now(TZ).date().isoformat(); state=read_state(day)
    if not state: state={'schema_version':'1.2','release_version':RELEASE_VERSION,'date':day,'work_items':[],'generated_at':None,'report_status':'not_generated','last_error':None,'reports':[],'report_chars':0,'included_count':0,'excluded_count':0,'submit_status':None,'submit_error':None,'submitted_at':None,'submit_mode':None}
    return state

def settings():
    # 同时回传**值**而不只是"是否已配置":设置窗口要把已保存的 Key 明文显示出来,
    # 否则用户无法确认自己粘贴是否成功(掩码输入框已经被明确否掉)。
    # 这些值只经本机管道传给 App,不出网;.env 本身也只有 0600。
    load_env(); return {'base_url':os.getenv('LLM_BASE_URL','https://api.deepseek.com/v1'),'model':os.getenv('LLM_MODEL','deepseek-flash'),'api_key':os.getenv('LLM_API_KEY',''),'api_key_set':bool(os.getenv('LLM_API_KEY')),'release_version':RELEASE_VERSION,
                        'submit_url':os.getenv('DIGEST_SUBMIT_URL',''),'submit_api_key':os.getenv('DIGEST_API_KEY',''),'submit_api_key_set':bool(os.getenv('DIGEST_API_KEY'))}

def save_settings(data):
    APP_DIR.mkdir(parents=True, exist_ok=True); path=APP_DIR/'.env'; old={}
    if path.exists():
        for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
            if '=' in line:
                k,v=line.split('=',1); old[k]=v.strip()
                if len(old[k]) >= 2 and old[k][0] == old[k][-1] == '"':
                    try: old[k]=json.loads(old[k])
                    except json.JSONDecodeError: old[k]=old[k][1:-1]
                for quote in ('"', "'"):
                    if len(old[k]) >= 2 and old[k][0] == old[k][-1] == quote: old[k]=old[k][1:-1]
                old[k]=old[k].replace('\\\"','"').replace("\\'", "'")
    old['LLM_BASE_URL']=data.get('base_url', old.get('LLM_BASE_URL','https://api.deepseek.com/v1')); old['LLM_MODEL']=data.get('model', old.get('LLM_MODEL','deepseek-flash'))
    if data.get('api_key'): old['LLM_API_KEY']=data['api_key']
    # 提交服务:地址与 API Key 各填一次即长期复用(与 LLM 配置同一个 0600 的 .env)。
    if 'submit_url' in data: old['DIGEST_SUBMIT_URL']=str(data['submit_url']).strip()
    if data.get('submit_api_key'): old['DIGEST_API_KEY']=str(data['submit_api_key']).strip()
    path.write_text(''.join(f'{k}={json.dumps(v)}\n' for k,v in old.items()), encoding='utf-8'); os.chmod(path, 0o600); return settings()

def day_window(day):
    start = dt.datetime.fromisoformat(day).replace(tzinfo=TZ)
    return start, start + dt.timedelta(days=1)

def in_window(value, start, end):
    if value is None: return False
    if isinstance(value, (int, float)):
        value = value / (1000 if value > 10_000_000_000 else 1)
        stamp = dt.datetime.fromtimestamp(value, TZ)
    else:
        try: stamp = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(TZ)
        except ValueError: return False
    return start <= stamp < end

MESSAGE_CHAR_MAX = 4000      # 单条提示词/最终文本的上限(抽取之后再截断)

def parts_text(content):
    """从 content 分片里取正文,忽略 reasoning/thinking/toolCall/tool-result。"""
    if isinstance(content, str): return ' '.join(content.split())
    if not isinstance(content, list): return ''
    out = []
    for part in content:
        if isinstance(part, dict) and part.get('type') == 'text':
            out.append(str(part.get('text') or ''))
    return ' '.join(' '.join(out).split())

def extract_codex(item_type, data):
    kind = str(item_type or '')
    if kind == 'userMessage':
        return 'prompt', parts_text(data.get('content')) or str(data.get('text') or '')
    if kind == 'agentMessage':
        return 'result', str(data.get('text') or '') or parts_text(data.get('content'))
    return None, None

def extract_dsh(obj):
    """只认 user/message、assistant/message 的正文与 deliverables/presented。"""
    kind = str(obj.get('type') or '')
    data = obj.get('data') or {}
    if kind == 'user/message':
        return 'prompt', parts_text(data.get('content'))
    if kind == 'assistant/message':
        return 'result', parts_text((data.get('message') or {}).get('content'))
    if kind == 'deliverables/presented':
        files = data.get('files') or []
        text = '; '.join(f"{f.get('path','')} {f.get('description','')}".strip()
                         for f in files if isinstance(f, dict))
        return 'deliverable', text
    return None, None

def extract_pi(obj):
    if str(obj.get('type') or '') != 'message': return None, None
    message = obj.get('message') if isinstance(obj.get('message'), dict) else obj
    role = str(message.get('role') or '')
    if role == 'user': return 'prompt', parts_text(message.get('content'))
    if role == 'assistant': return 'result', parts_text(message.get('content'))
    return None, None

def extract_generic(obj):
    """归档 jsonl 等未知结构:依次尝试三种已知形状。"""
    for extract in (extract_codex, extract_dsh, extract_pi):
        if extract is extract_codex:
            role, text = extract(obj.get('type'), obj)
        else:
            role, text = extract(obj)
        if role: return role, text
    return None, None

# ------------------------------------------------------------ VS Code 及其分支 --
# VS Code 与它的各个 fork 把 AI 对话存在
#   <Application Support>/<产品>/User/workspaceStorage/<workspace-hash>/chatSessions/<uuid>.jsonl
# 实测 VS Code 的格式（response[] 的 kind 分布来自真实会话，不是推测）：
#
#   {"kind":0,"v":{...}}                  ← 初态行，自带**完整** session
#   {"kind":1,"k":...,"v":...}            ← 增量更新
#   {"kind":2,"v":...,"completedAt":...}  ← 结束标记
#
# 初态行 v.requests[] 里每条 request 是一次问答：
#   request.message.text   → 用户提示词
#   request.response[]     → 回复片段；**只有 kind 为空且 value 是字符串的才是正文**
#   request.requestId      → 稳定 id        request.timestamp → 毫秒
#
# 变更 op 的 kind（VS Code 源码 objectMutationLog.ts 的 EntryKind，非推测）：
#   0 = Initial 首行，完整对象   1 = Set 属性更新
#   2 = **Push** 数组更新        3 = Delete 删除属性
# ⚠️ kind=2 **不是结束标记**。它的语义是"截断到 i 再追加 v"，按结束标记处理会
# 丢数据。本机实测就有反例：
#   {"kind":2,"k":["requests"],"v":[…]}}                    新增整整一轮问答
#   {"kind":2,"k":["requests",0,"response"],"v":[…],"i":6}   把后 10 段回复整段换掉
# 后者长度与初态相同、**内容却是旧的** —— 只读首行会拿到过期回复且毫无征兆。
# 所以必须按 op 顺序重放。
VSCODE_OP_INITIAL, VSCODE_OP_SET, VSCODE_OP_PUSH, VSCODE_OP_DELETE = 0, 1, 2, 3
VSCODE_CHAT_GLOB = 'User/workspaceStorage/*/chatSessions/*.jsonl'
# 「没有打开文件夹」的窗口会话落在 globalStorage 下（作用域不同、格式相同）。
# 漏掉它会让"平时就靠空窗口问 Copilot"的人一条都采不到。
VSCODE_EMPTY_WINDOW_GLOB = 'User/globalStorage/emptyWindowChatSessions/*.jsonl'

# 除正文外，这些 kind 都是过程，必须排除。列全是为了让"什么被丢掉了"可审。
#   thinking                  内部推理        toolInvocationSerialized 工具调用
#   mcpServersStarting        MCP 启动        autoModeResolution       模式选择
VSCODE_PROCESS_KINDS = ('thinking', 'toolInvocationSerialized', 'mcpServersStarting',
                        'autoModeResolution', 'progressMessage', 'command', 'errorDetails')

# VS Code 及其分支。分支按同一约定处理 —— 它们都是 VS Code 的 fork，沿用同一套
# chatSessions 机制。若某个分支实际不同，它的 stats 会是 dir_missing / no_sessions，
# 而不是一个看起来正常的 0（后者会被误读成"当天没聊"）。处理器名与层的归属见 README。
VSCODE_PRODUCTS = (
    ('vscode',          'Code'),
    ('vscode-insiders', 'Code - Insiders'),
    ('cursor',          'Cursor'),
    ('windsurf',        'Windsurf'),
    ('qoder',           'Qoder'),
    ('kimi-code',       'Kimi Code'),
    ('codebuddy',       'CodeBuddy'),
)

def _log_path_get(state, path):
    """按 ObjectPath 取值，任一层缺失返回 None。"""
    cur = state
    for key in path or []:
        if isinstance(cur, list):
            if not isinstance(key, int) or not 0 <= key < len(cur): return None
            cur = cur[key]
        elif isinstance(cur, dict):
            if key not in cur: return None
            cur = cur[key]
        else:
            return None
    return cur

def _log_path_set(state, path, value):
    """按 ObjectPath 写值。中间层是 dict 且缺失时，按下一段类型补 list / dict。

    **越界的数组写入一律忽略**（不给数组补空洞）：补空洞等于凭空造出一条消息，
    会让"重放"这个动作本身产生原始数据里不存在的内容。dict 的中间层可以补，
    因为 dict 没有"位置"语义，补出来的是空容器而不是伪造的条目。
    """
    path = list(path or [])
    if not path: return
    cur = state
    for idx, key in enumerate(path[:-1]):
        nxt = path[idx + 1]
        if isinstance(cur, list):
            if not isinstance(key, int) or not 0 <= key < len(cur): return
            cur = cur[key]
        elif isinstance(cur, dict):
            if not isinstance(cur.get(key), (dict, list)):
                cur[key] = [] if isinstance(nxt, int) else {}
            cur = cur[key]
        else:
            return
    last = path[-1]
    if isinstance(cur, list):
        if isinstance(last, int) and 0 <= last < len(cur):
            cur[last] = value
    elif isinstance(cur, dict):
        cur[last] = value

def replay_vscode_log(lines):
    """把 chatSessions 的变更日志重放成最终会话对象（即末态的 ``v``）。

    没有初态行（kind=0）就直接返回 None —— 缺失基准的增量没有意义，不能瞎猜。
    """
    state = None
    for obj in lines:
        if not isinstance(obj, dict): continue
        kind = obj.get('kind')
        if kind == VSCODE_OP_INITIAL:
            v = obj.get('v')
            state = v if isinstance(v, dict) else None
            continue
        if state is None: continue
        k = obj.get('k')
        if kind == VSCODE_OP_SET:
            _log_path_set(state, k, obj.get('v'))
        elif kind == VSCODE_OP_PUSH:
            arr = _log_path_get(state, k)
            if isinstance(arr, list):
                i = obj.get('i')
                # Push 语义：i 存在时先删掉 i 之后的所有元素，再追加
                if isinstance(i, int) and 0 <= i <= len(arr): del arr[i:]
                extra = obj.get('v')
                if isinstance(extra, list): arr.extend(extra)
        elif kind == VSCODE_OP_DELETE:
            _log_path_set(state, k, None)
    return state


def vscode_reply_text(response):
    """从 request.response[] 里取 AI 正文，排除思考与工具调用。"""
    if not isinstance(response, list):
        return ''
    out = []
    for part in response:
        if isinstance(part, str):
            out.append(part)          # 少数版本把正文直接写成字符串
            continue
        if not isinstance(part, dict):
            continue
        if part.get('kind') is not None:
            continue                  # 带 kind 的一律是过程
        value = part.get('value')
        if isinstance(value, str):
            out.append(value)
        elif isinstance(value, dict):
            out.append(str(value.get('value') or ''))
    return ' '.join(' '.join(out).split())

def extract_vscode_session(v):
    """把**重放后**的会话对象展平成 ``[(item_id, stamp, role, text), ...]``。

    入参是 :func:`replay_vscode_log` 的结果（也就是末态的 ``v``），不是文件里的原始行。
    返回列表而不是单个 ``(role, text)``：一个会话里有多轮问答，这是它与其它
    ``extract_*`` 的唯一区别。
    """
    if not isinstance(v, dict):
        return []
    session = str(v.get('sessionId') or '')
    rows = []
    for i, req in enumerate(v.get('requests') or []):
        if not isinstance(req, dict):
            continue
        rid = str(req.get('requestId') or f'{session}#{i}')
        stamp = req.get('timestamp') or v.get('creationDate')
        message = req.get('message')
        if isinstance(message, dict):
            prompt = str(message.get('text') or '')
        elif isinstance(message, str):
            prompt = message
        else:
            prompt = ''
        prompt = ' '.join(prompt.split())
        if prompt:
            rows.append((rid, stamp, 'prompt', prompt))
        reply = vscode_reply_text(req.get('response'))
        if reply:
            rows.append((f'{rid}#reply', stamp, 'result', reply))
    return rows

# 对话正文里会夹带**真实凭据**：实测本机 WorkBuddy/Hermes 采集结果里就有完整的
# 飞书机器人 webhook（含 token），DSH 会话日志里也有 `Bearer <token>`。
# 这些文本要送进第三方 LLM、还可能被上报，所以必须在**进入事件之前**就地脱敏。
#
# 放在 collect_one 这一个入口，而不是每个采集器里各写一遍：老采集器漏掉的，
# 新加的十几个不可能凭空补上。只认**形状明确**的凭据，避免误删正常正文
# （例如把一句含 "token=" 的技术讨论整段抹掉，比漏脱敏更糟）。
SECRET_PATTERNS = (
    # 飞书/钉钉机器人 webhook：URL 末尾那段就是凭证
    (re.compile(r'(https://open\.feishu\.cn/open-apis/bot/v2/hook/)[\w-]+'), r'\1<redacted>'),
    (re.compile(r'(https://oapi\.dingtalk\.com/robot/send\?access_token=)[\w-]+'), r'\1<redacted>'),
    (re.compile(r'(https://hooks\.slack\.com/services/)[\w/-]+'), r'\1<redacted>'),
    # 带前缀的 API key / token
    (re.compile(r'\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}'), '<redacted-key>'),
    (re.compile(r'\bgh[pousr]_[A-Za-z0-9]{20,}'), '<redacted-token>'),
    (re.compile(r'\bAKIA[0-9A-Z]{16}\b'), '<redacted-aws-key>'),
    (re.compile(r'\bxox[baprs]-[A-Za-z0-9-]{10,}'), '<redacted-slack-token>'),
    # HTTP 头与赋值式：只认字段名紧跟长值的情况
    (re.compile(r'(?i)\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}'), r'\1 <redacted>'),
    (re.compile(r'(?i)\b(authorization|api[-_]?key|access[-_]?token|secret[-_]?key|password)\b\s*[:=]\s*["\']?([A-Za-z0-9._~+/=-]{16,})'),
     r'\1: <redacted>'),
)

def redact_secrets(text):
    """把高置信度的凭据形态替换掉。返回替换后的文本（原样返回非字符串入参）。"""
    if not isinstance(text, str) or not text:
        return text
    for pattern, repl in SECRET_PATTERNS:
        text = pattern.sub(repl, text)
    return text


def make_event(provider, session, item, stamp, kind, role, text, truncated=False):
    """role: prompt | result | deliverable | process"""
    text = ' '.join(str(text or '').split())
    if len(text) > MESSAGE_CHAR_MAX:
        text = text[:MESSAGE_CHAR_MAX]; truncated = True
    key = hashlib.sha256(f'{provider}|{session}|{item}|{text}'.encode()).hexdigest()
    return {'provider': provider, 'session_id': session, 'item_id': item, 'timestamp': str(stamp),
            'kind': kind, 'role': role, 'text': text, 'truncated': truncated, 'dedupe_key': key}

def keep_process():
    """默认只保留提示词/最终文本/交付物;置 1 可回退到"过程也送、但排在最后"。"""
    return os.getenv('DIGEST_CONTEXT_INCLUDE_PROCESS') == '1'

def new_stats():
    return {'prompt': 0, 'result': 0, 'deliverable': 0, 'process': 0, 'truncated': 0, 'chars': 0}

def collect_one(stats, out, provider, session, item, stamp, kind, raw_text, role, text, include_process):
    # 唯一入口：所有采集器的正文都在这里落地，脱敏放这里才不会有漏网的来源
    text = redact_secrets(text)
    if role:
        stats[role] += 1
        if len(' '.join(str(text or '').split())) > MESSAGE_CHAR_MAX: stats['truncated'] += 1
        event = make_event(provider, session, item, stamp, kind, role, text or '')
        stats['chars'] += len(event['text']); out.append(event)
    else:
        stats['process'] += 1
        if include_process:
            out.append(make_event(provider, session, item, stamp, kind, 'process', raw_text or ''))

def codex(root, start, end):
    """只抽取 userMessage(提示词)与 agentMessage(最终结果),过程记录不进入汇总。"""
    stats = new_stats(); out = []; include = keep_process()
    # 不写死文件名:codex 换过库名/版本时,回退到目录里最新的 thread_history*.sqlite
    candidates = sorted((root/'.codex').glob('thread_history*.sqlite'), key=lambda p: p.stat().st_mtime, reverse=True) if (root/'.codex').is_dir() else []
    db = candidates[0] if candidates else root/'.codex/thread_history_1.sqlite'
    if not db.exists():
        # 明确记录"库里没有",而不是让 0 条看起来像"当天没工作"
        stats['db_missing'] = str(db)
    if db.exists():
        con = open_sqlite_readonly(db)
        try:
            query = 'select thread_id, turn_id, created_at_ms, item_json, item_type from thread_items where created_at_ms >= ? and created_at_ms < ?'
            for tid, turn, created, raw, typ in con.execute(query, (int(start.timestamp()*1000), int(end.timestamp()*1000))):
                try: data = json.loads(raw)
                except json.JSONDecodeError: data = {'text': raw}
                role, text = extract_codex(typ, data)
                collect_one(stats, out, 'codex', tid, turn, created, typ, json.dumps(data, ensure_ascii=False)[:MESSAGE_CHAR_MAX], role, text, include)
        finally:
            con.close()  # 之前没有 try/finally:中途抛错会泄漏连接
    for f in (root/'.codex/archived_sessions').glob('*.jsonl'):
        read_jsonl(f, 'codex', start, end, stats, out, include)
    return dedupe(out), stats

def read_jsonl(path, provider, start, end, stats, out, include_process):
    try:
        lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    except OSError: return
    sid = path.stem
    for i, line in enumerate(lines):
        try: obj = json.loads(line)
        except json.JSONDecodeError: continue
        stamp = obj.get('timestamp') or obj.get('createdAt') or obj.get('time')
        if not in_window(stamp, start, end): continue
        role, text = extract_pi(obj)
        if not role: role, text = extract_generic(obj)
        collect_one(stats, out, provider, sid, str(obj.get('id', i)), stamp, obj.get('type'),
                    json.dumps(obj, ensure_ascii=False)[:MESSAGE_CHAR_MAX], role, text, include_process)

def dsh(root, start, end):
    stats = new_stats(); out = []; include = keep_process()
    zstd = zstd_binary()
    if not zstd:
        stats['zstd_missing'] = '未找到 zstd,无法解压 .dsh 会话(brew install zstd,或用 DIGEST_ZSTD 指定路径)'
        return dedupe(out), stats
    for f in (root/'.dsh/sessions').glob('**/*.zstd'):
        try: raw = subprocess.check_output([zstd,'-dc',str(f)], stderr=subprocess.DEVNULL, text=True)
        except (OSError, subprocess.CalledProcessError): continue
        for i, line in enumerate(raw.splitlines()):
            try: obj = json.loads(line)
            except json.JSONDecodeError: continue
            stamp = obj.get('time') or obj.get('createdAt')
            if not in_window(stamp, start, end): continue
            role, text = extract_dsh(obj)
            collect_one(stats, out, 'deepseek-harness', f.parent.name, str(obj.get('seq', i)), stamp,
                        obj.get('type'), json.dumps(obj, ensure_ascii=False)[:MESSAGE_CHAR_MAX], role, text, include)
    return dedupe(out), stats

def pi(root, start, end):
    stats = new_stats(); out = []; include = keep_process()
    for f in (root/'.pi/agent/sessions').glob('**/*.jsonl'):
        read_jsonl(f, 'pi', start, end, stats, out, include)
    return dedupe(out), stats

def vscode(root, start, end, app_dir, provider):
    """采集一个 VS Code 系产品的 chatSessions。

    ``app_dir`` 是 Application Support 下的产品目录名；``provider`` 是上报用的来源名。
    两者分开是为了让「同一份解析逻辑」服务多个 fork，而上报仍能按产品区分。
    """
    stats = new_stats(); out = []; include = keep_process()
    product = root / 'Library/Application Support' / app_dir
    if not product.is_dir():
        # 明确记录"这个产品没装"，而不是让 0 条看起来像"当天没工作"
        stats['dir_missing'] = str(product)
        return dedupe(out), stats
    files = sorted(product.glob(VSCODE_CHAT_GLOB)) + sorted(product.glob(VSCODE_EMPTY_WINDOW_GLOB))
    stats['files'] = len(files)
    if not files:
        # 装了却一个会话文件都没有：这**不是**"当天没聊"，而是格式不同或对话不落在本地。
        # 区分这两者很重要 —— 前者无需处理，后者说明这个源的采集路径选错了。
        stats['no_sessions'] = str(product)
    for f in files:
        try:
            raw = f.read_text(encoding='utf-8', errors='replace').splitlines()
        except OSError:
            continue
        objs = []
        for line in raw:
            try: objs.append(json.loads(line))
            except json.JSONDecodeError: continue
        # 先重放再抽取：只读首行会拿到被后续 Push 覆盖掉的旧回复（见上方注释里的实测反例）
        session = replay_vscode_log(objs)
        if session is None:
            stats['no_initial'] = stats.get('no_initial', 0) + 1
            continue
        sid = str(session.get('sessionId') or f.stem)
        for item, stamp, role, text in extract_vscode_session(session):
            if not in_window(stamp, start, end): continue
            collect_one(stats, out, provider, sid, item, stamp, 'chat', '', role, text, include)
    return dedupe(out), stats

# ---------------------------------------------------------------- Hermes Agent --
# Hermes 把会话存进 **SQLite**（不是散落的 JSONL），实测结构：
#   sessions(id, source, display_name, model, started_at REAL 秒, message_count, …)
#   messages(id, session_id, role, content TEXT, tool_calls, tool_name,
#            reasoning, reasoning_content, timestamp REAL 秒, active, compacted, …)
# 实测 role 只有 user / assistant / tool 三种（3 会话 154 条里 21/75/58）。
# `content` 是纯文本（assistant 是 Markdown 正文，tool 是 JSON），
# 所以**只需要按 role 过滤**，不必再解析 content 内部结构。
HERMES_DB = '.hermes/state.db'
HERMES_ROLE_TO_KIND = {'user': 'prompt', 'assistant': 'result'}

def hermes(root, start, end):
    """从 ~/.hermes/state.db 取用户提示词与 AI 最终回复。

    `tool` 角色的 content 是工具返回的 JSON、`reasoning*` 是内部推理 —— 都是过程，
    不进汇总。`active=0` / `compacted=1` 的行已被压缩或作废，同样跳过。
    """
    stats = new_stats(); out = []; include = keep_process()
    db = root / HERMES_DB
    if not db.exists():
        # 只是打不开不足以判断"没用过"，先记下路径让 collect_warnings 决定要不要提示
        stats['db_missing'] = str(db)
        return dedupe(out), stats
    try:
        con = open_sqlite_readonly(db)
    except sqlite3.Error:
        stats['db_missing'] = str(db)
        return dedupe(out), stats
    try:
        # 用 REAL 秒直接与窗口比较：in_window 对 >1e10 的值才按毫秒解释，
        # 秒级时间戳(约 1.7e9)不会被误判。
        lo, hi = start.timestamp(), end.timestamp()
        rows = con.execute(
            'select id, session_id, role, content, timestamp from messages '
            'where timestamp >= ? and timestamp < ? and active = 1 and compacted = 0 '
            'order by timestamp', (lo, hi))
        for mid, sid, role, content, stamp in rows:
            kind = HERMES_ROLE_TO_KIND.get(str(role or '').lower())
            if not kind:
                if include and role:
                    collect_one(stats, out, 'hermes', str(sid), str(mid), stamp, str(role),
                                str(content or ''), 'process', str(content or ''), include)
                continue
            text = ' '.join(str(content or '').split())
            if not text:
                continue          # 只发起工具调用、没有正文的 assistant 行
            collect_one(stats, out, 'hermes', str(sid), str(mid), stamp, str(role), '', kind, text, include)
    finally:
        con.close()
    return dedupe(out), stats


# ------------------------------------------------------------------- WorkBuddy --
# `~/.workbuddy-ai/projects/<编码后的 cwd>/<sessionId>.jsonl`，Claude Code 同构的 JSONL：
# 一行一个事件，`type` 取 message / reasoning / function_call / function_call_result /
# file-history-snapshot / ai-title。只有 `type=message` 的才进汇总。
# 实测一条 message 的 `content` 是分片数组，role=user 用 `input_text`、assistant 用 `output_text`。
WORKBUDDY_ROOT = '.workbuddy-ai'
WORKBUDDY_CHAT_GLOB = 'projects/*/*.jsonl'
WORKBUDDY_ROLE_TO_KIND = {'user': 'prompt', 'assistant': 'result'}
WORKBUDDY_PART_TYPES = ('input_text', 'output_text')
WORKBUDDY_USER_QUERY = re.compile(r'<user_query>(.*?)</user_query>', re.S)
WORKBUDDY_INJECTED = re.compile(r'<system-reminder.*?</system-reminder>', re.S)

def workbuddy_prompt_text(text):
    """从用户分片里取出**真正的问题**。

    实测 19 条用户分片里 17 条以 ``<system-reminder>`` 开头 —— 那是 OS/Shell/工作区/
    身份文件的注入上下文，单条可到 4000 字；真正的问题在末尾的 ``<user_query>`` 里。
    整段照收会让日报被系统样板淹没（"重新部署Pig-ui"这种有效信息被埋掉）。
    另外 2 条是裸文本，去掉注入块后原样使用。
    """
    t = str(text or '')
    m = WORKBUDDY_USER_QUERY.search(t)
    if m:
        return ' '.join(m.group(1).split())
    return ' '.join(WORKBUDDY_INJECTED.sub(' ', t).split())

def workbuddy(root, start, end):
    """采集 WorkBuddy 的会话（JSONL，逐行事件）。"""
    stats = new_stats(); out = []; include = keep_process()
    base = root / WORKBUDDY_ROOT
    if not base.is_dir():
        stats['dir_missing'] = str(base)
        return dedupe(out), stats
    files = sorted(base.glob(WORKBUDDY_CHAT_GLOB))
    stats['files'] = len(files)
    if not files:
        stats['no_sessions'] = str(base)
    for f in files:
        sid = f.stem
        try:
            raw = f.read_text(encoding='utf-8', errors='replace').splitlines()
        except OSError:
            continue
        for i, line in enumerate(raw):
            if not line.strip(): continue
            try: obj = json.loads(line)
            except json.JSONDecodeError: continue
            if not isinstance(obj, dict) or obj.get('type') != 'message': continue
            role = str(obj.get('role') or '')
            kind = WORKBUDDY_ROLE_TO_KIND.get(role)
            if not kind:
                continue
            parts = []
            for part in (obj.get('content') or []):
                if not isinstance(part, dict): continue
                # 只认 input_text/output_text；其它分片类型属于过程
                if part.get('type') not in WORKBUDDY_PART_TYPES: continue
                if kind == 'prompt':
                    text = workbuddy_prompt_text(part.get('text'))
                else:
                    text = ' '.join(str(part.get('text') or '').split())
                if text: parts.append(text)
            text = ' '.join(parts).strip()
            if not text: continue
            stamp = obj.get('timestamp')
            if not in_window(stamp, start, end): continue
            collect_one(stats, out, 'workbuddy', str(obj.get('sessionId') or sid),
                        str(obj.get('id') or i), stamp, 'message', '', kind, text, include)
    return dedupe(out), stats


def _vscode_collector(app_dir, provider):
    """把 (app_dir, provider) 绑定成一个 collect() 能直接调的采集器。"""
    return lambda root, start, end: vscode(root, start, end, app_dir, provider)


# zstd 不是 macOS 自带命令。**只查 PATH 是不够的**:从 Finder / 登录项启动的 App
# 拿不到 shell 的 PATH(launchctl getenv PATH 为空),于是 brew(/opt/homebrew/bin)与
# anaconda(/opt/anaconda3/bin)里的 zstd 全都看不见 —— 表现为"今天没干活"。
# 所以除 PATH 外,再按常见绝对路径找一遍。
ZSTD_CANDIDATES = (
    '/opt/homebrew/bin/zstd',
    '/usr/local/bin/zstd',
    '/opt/anaconda3/bin/zstd',
    '/opt/local/bin/zstd',
    '/usr/bin/zstd',
    str(Path.home()/'.local/bin/zstd'),
)

def zstd_binary():
    """返回可用的 zstd 路径,找不到返回 None。顺序:显式配置 → PATH → 常见绝对路径。"""
    override=(os.getenv('DIGEST_ZSTD') or '').strip()
    if override:
        return override if Path(override).exists() else None
    from shutil import which
    found=which('zstd')
    if found: return found
    for candidate in ZSTD_CANDIDATES:
        if Path(candidate).exists(): return candidate
    return None

def zstd_available():
    """zstd 缺失时 dsh 会话无法解压 —— 必须让这件事**可见**,否则用户只会看到"今天没干活"。"""
    return zstd_binary() is not None


def open_sqlite_readonly(path):
    """以只读方式打开 SQLite 库,且在**目录不可写**时也能打开。

    背景:codex 的库是 WAL 模式,即使只读打开,SQLite 也要在同目录建 -shm 文件;
    目录不可写(只读挂载/容器/沙箱)时会报 "unable to open database file",而引擎本来只需要读。
    因此先按正常只读打开(保留锁语义),失败再退化为 immutable(不建任何文件、不加锁)。
    """
    last = None
    for uri in (f'file:{path}?mode=ro', f'file:{path}?mode=ro&immutable=1'):
        con = None
        try:
            con = sqlite3.connect(uri, uri=True, timeout=5)
            # connect() 是惰性的,真正的打开发生在第一次读取 —— 必须在这里触发,
            # 否则失败会漏到调用方,回退逻辑形同虚设。
            con.execute('select 1 from sqlite_master limit 1').fetchone()
            return con
        except sqlite3.Error as exc:
            last = exc
            if con is not None: con.close()
    raise sqlite3.OperationalError(f'unable to open database file: {path} ({last})')


# 采集器注册表。新增一个数据源 = 在这里加一项 + 写一个 extract_* + 一条回归测试。
COLLECTORS = (
    ('codex', codex),
    ('pi', pi),
    ('dsh', dsh),
    ('hermes', hermes),
    ('workbuddy', workbuddy),
) + tuple((name, _vscode_collector(app_dir, name)) for name, app_dir in VSCODE_PRODUCTS)


def collect(root, start, end):
    """返回 (events, stats):events 默认只含提示词 / 最终文本 / 交付物。"""
    events = []; stats = {}
    for name, fn in COLLECTORS:
        # 逐个隔离:某个采集器损坏(库打不开、schema 不符、时间戳溢出)时,
        # 只降级这一个来源并把原因写进 coverage,而不是让当天日报整体生成失败。
        try:
            got, st = fn(root, start, end)
            events.extend(got); stats[name] = st
        except Exception as exc:
            debug(f'collector {name} failed: {type(exc).__name__}: {exc}')
            stats[name] = {'error': f'{type(exc).__name__}: {exc}', 'events': 0, 'kept': 0, 'dropped': 0}
    return dedupe(events), stats

def dedupe(rows):
    return list({r['dedupe_key']:r for r in rows}.values())

def summarize(events, day):
    by={}
    for e in events: by.setdefault(e['provider'],set()).add(e['session_id'])
    payload={'schema_version':'1.0','date':day,'timezone':'Asia/Shanghai','coverage':{'events':len(events),'sessions':sum(map(len,by.values())),'providers':sorted(by),'limitations':[]},'work_items':[{'id':hashlib.sha256(p.encode()).hexdigest()[:16],'title':f"{p} 工作记录（待 LLM 分类）",'desc':f'该来源当天有 {len(sessions)} 个会话，等待 LLM 按工作主题归并。','status':'observed','source_task_ids':sorted(sessions),'excluded':False} for p,sessions in by.items()],'blockers':[],'decisions':[],'artifacts':[],'sources':[{'provider':e['provider'],'task_id':e['session_id'],'turn_ids':[e['item_id']],'observed_at':e['timestamp']} for e in events]}
    # 选材统计与 LLM 是否可用无关:降级报告也应该能说明"本来会送什么"。
    context, stats = build_context(events)
    payload['coverage']['context'] = stats
    payload['coverage']['limitations'].append(context_note(stats))
    debug(f"context: {context_note(stats)}")
    base, key, model = llm_config()
    if base and key and model:
        system='''你是日报整理器。把当天所有 agent 对话按“工作主题”聚类，每个主题写成一项独立内容。只保留真实工作内容：开发、工程、运维、研究、业务；排除个人问题、娱乐、闲聊和自动化噪音。一次性处理输入并返回严格 JSON，不要 Markdown：{"work_items":[{"title":"工作主题（不超过 30 字）","desc":"该项工作的完整说明","status":"completed|in_progress|blocked","source_task_ids":["provider/session"]}],"decisions":[],"blockers":[],"next_steps":[]}.
要求（必须遵守）：
1. 每一项的 desc 是这一项完整而独立的说明：写清做了什么、为什么做、怎么做的、结果或产出是什么，目标 {ITEM_CHAR_MIN}-{ITEM_CHAR_MAX} 字。
2. 所有项的 title 与 desc 合计不超过 1000 字，不设下限；项多时每项相应缩短，但不要为了字数删除真实工作项。
3. 各项 desc 之间不要重复同一件事，不要把别的项的内容写进来。
4. title 是简短主题，不超过 30 字，不要出现 session ID，不要只是复述 desc 的第一句。
5. 工作项数量控制在 3-20 个，合并同一主题。'''
        req=urllib.request.Request(base.rstrip('/')+'/chat/completions',data=json.dumps({'model':model,'temperature':0.1,'messages':[{'role':'system','content':system},{'role':'user','content':context}]}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+key},method='POST')
        try:
            with urllib.request.urlopen(req,timeout=120,context=tls_context()) as r:
                content=json.loads(r.read())['choices'][0]['message']['content']; parsed=json.loads(content[content.find('{'):content.rfind('}')+1])
                items=[]
                for item in parsed.get('work_items',[])[:20]:
                    title=clamp_text(item.get('title',''), TITLE_CHAR_MAX)
                    if not title: continue
                    items.append({'id':hashlib.sha256(f'{day}|{len(items)}|{title}'.encode()).hexdigest()[:16],'title':title,'desc':str(item.get('desc','') or '').strip(),'status':item.get('status','observed'),'source_task_ids':item.get('source_task_ids',[]),'excluded':False})
                if items: payload['work_items']=items
                else:
                    # 模型回了但一个可用标题都没有:占位项会留在报告里,必须记下原因,
                    # 否则这份"没归并"的报告会被当成正常日报。
                    payload['llm_error']='LLM 没有返回可用的工作项'
                    payload['coverage']['limitations'].append('LLM returned no usable items')
                    debug('LLM returned no usable items')
                payload['decisions']=parsed.get('decisions',[]); payload['blockers']=parsed.get('blockers',[]); payload['next_steps']=parsed.get('next_steps',[])
        except Exception as exc: debug(f'LLM error: {type(exc).__name__}: {exc}'); payload['llm_error']=f'{type(exc).__name__}: {exc}'; payload['coverage']['limitations'].append('LLM unavailable: '+type(exc).__name__)
    else:
        # 没配置 LLM 也一样:报告里只有"按来源分组的占位内容",必须说明。
        payload['llm_error']='未配置 LLM(LLM_BASE_URL / LLM_API_KEY / LLM_MODEL)'
        payload['coverage']['limitations'].append('LLM not configured')
        debug('LLM not configured: report stays unclassified')
    # Enforce the budget locally too: model output is guidance, not a guarantee.
    payload['work_items'], payload['report_chars'] = fit_report(payload.get('work_items',[]))
    payload['coverage']['report_chars'] = payload['report_chars']
    payload['coverage']['report_char_limit'] = REPORT_CHAR_LIMIT
    return payload

def collect_warnings(payload, collect_stats):
    """把"这份日报为什么可能不完整"整理成给人看的一行行提示。

    以前这些原因只躺在 collect_stats / coverage 里,界面完全不显示:
    LLM 没配置、模型没返回工作项、zstd 缺失导致 DSH 会话没被采集、某个采集器报错,
    全都会表现为一份"看起来正常"的日报(用户实际遇到的就是这种)。
    """
    out=[]
    if payload.get('llm_error'):
        out.append(f"未做主题归并:{payload['llm_error']};以下为按来源分组的原始记录")
    for name, st in (collect_stats or {}).items():
        if not isinstance(st, dict): continue
        if st.get('zstd_missing'): out.append(st['zstd_missing'])
        if st.get('db_missing'):
            # 目录都不存在 = 这台机器根本没用过这个 agent,不是问题;
            # 目录在、库却不在,才值得提醒(否则每台机器都会天天看到误报)。
            db=Path(str(st['db_missing']))
            if db.parent.is_dir(): out.append(f"未找到 {name} 的数据库:{db}")
        if st.get('error'): out.append(f"采集 {name} 失败:{st['error']}")
    # 「装了却一条没采到」值得单独提示:否则界面看起来正常,而实际这个源根本没进来。
    # 与 db_missing 同一套判断——**没装的产品不提示**(否则每台机器天天看到 7 条误报)。
    barren=[n for n,st in (collect_stats or {}).items() if isinstance(st,dict) and st.get('no_sessions')]
    if barren:
        out.append(f"以下工具已安装但未采到对话(存储格式可能不同、或对话不在本地):{'、'.join(sorted(barren))}")
    # 去重但保序(同一个 zstd 提示可能来自多个采集器)
    seen=set(); uniq=[]
    for w in out:
        if w not in seen: seen.add(w); uniq.append(w)
    return uniq

def generate(day=None, source_root=None):
    day=day or dt.datetime.now(TZ).date().isoformat(); root=Path(source_root or os.getenv('DIGEST_SOURCE_ROOT', str(Path.home()))); start,end=day_window(day); events,collect_stats=collect(root,start,end)
    payload=summarize(events,day); previous=app_state(day); excluded={x['id'] for x in previous.get('work_items',[]) if x.get('excluded')}
    for item in payload['work_items']: item['excluded']=item['id'] in excluded
    failed=payload.get('llm_error'); state={'schema_version':'1.2','release_version':RELEASE_VERSION,'date':day,'work_items':payload['work_items'],'generated_at':dt.datetime.now(TZ).isoformat(),'report_status':'error' if failed else 'ready','last_error':failed,'reports':sorted(set(previous.get('reports',[])+[day]))}
    # 排除项不会进入上报内容,因此字数按未排除项统计。
    state['coverage_note']=context_note(payload.get('coverage',{}).get('context') or {}) if payload.get('coverage',{}).get('context') else None
    state['collect_stats']=collect_stats
    state['warnings']=collect_warnings(payload, collect_stats)
    state=recount_report(state); write_state(state)
    return state

def app_command(command, data):
    load_env(); day=data.get('date') or dt.datetime.now(TZ).date().isoformat()
    if command == 'settings': return settings()
    if command == 'check-submit': return check_submit(data)
    if command == 'save-settings': return save_settings(data)
    if command == 'clear':
        state=app_state(day); state.update({'schema_version':'1.2','release_version':RELEASE_VERSION,'work_items': [], 'report_chars': 0, 'included_count': 0, 'excluded_count': 0, 'submit_status': None, 'submit_error': None, 'generated_at': None, 'report_status': 'generating', 'last_error': None}); write_state(state); return state
    if command in ('generate','state','tick'):
        state=app_state(day)
        now=dt.datetime.now(TZ)
        # Manual generate always refreshes. Tick generates once after 17:30 and finalizes once after 18:00.
        after_preview = now.hour > 17 or (now.hour == 17 and now.minute >= 30)
        if command == 'generate' or (command == 'tick' and now.date().isoformat()==day and after_preview and not state.get('generated_at')):
            state=generate(day, data.get('source_root'))
        if command == 'tick' and now.date().isoformat()==day and now.hour >= 18 and state.get('report_status')=='ready' and os.getenv('DIGEST_SUBMIT_URL'): state=submit(day)
        return state
    state=app_state(day); ids={x.get('id') for x in state.get('work_items',[])}
    if command in ('exclude','restore'):
        ident=data.get('id');
        if ident not in ids: raise ValueError('unknown work item id')
        for item in state['work_items']:
            if item['id']==ident: item['excluded']=(command=='exclude')
        # 排除就是数组过滤：不重新生成、不调用 LLM,立即可逆。
        state=recount_report(state)
        # 内容变了,上一次的上报结果就失效 —— 否则 submit() 会因 report_status=='submitted'
        # 直接早退,服务端永远拿不到更新,界面却仍显示"已上报"。
        if state.get('report_status')=='submitted':
            state['report_status']='ready'; state['submit_status']='stale'
        write_state(state); return state
    if command=='submit': return submit(day)
    raise ValueError('unknown app command')

def report_payload(state, day, included):
    """组装上报报文:字段与工作日志管理模块的 WorkLogReportDTO 一一对应。

    date 只作留痕 —— 服务端按自己的当天决定这份日报归属哪一天,所以补传历史也不会散成多天。
    """
    items=[{'title':x.get('title',''),'desc':x.get('desc',''),'status':x.get('status','completed'),
            'source_task_ids':x.get('source_task_ids',[])} for x in included]
    return {'date':day,'generated_at':state.get('generated_at'),'release_version':RELEASE_VERSION,
            'report_chars':state.get('report_chars',0) if included else 0,
            'coverage_note':state.get('coverage_note') or '','work_items':items}

def server_message(raw):
    """把服务端的失败响应压成一句可读原因:Pig 的 R 包装把原因放在 msg 里。"""
    text=raw.decode('utf-8','replace') if isinstance(raw,bytes) else str(raw)
    try:
        body=json.loads(text)
        if isinstance(body,dict) and body.get('msg'): return str(body['msg'])
    except ValueError: pass
    return text[:300]

def submit_base(target):
    """把设置里的提交地址归一成**基地址**(去掉可能已经带上的上报路径)。

    设置里两种写法都会有人填 —— 密钥的「授权URL」通常就是按完整接口地址登记的,从
    「API密钥管理」页面复制过来自然带路径。后面要在这个基地址上拼不同的接口
    (上报 / 校验密钥),所以先归一,避免各拼各的。
    """
    url=(target or '').strip().rstrip('/')
    return url[:-len(REPORT_PATH)].rstrip('/') if url.endswith(REPORT_PATH) else url

def report_url(target):
    """上报接口地址:基地址 + REPORT_PATH。"""
    return submit_base(target)+REPORT_PATH

def verify_url(target):
    """API 密钥验证接口地址:基地址 + VERIFY_PATH。"""
    return submit_base(target)+VERIFY_PATH

def post_report(target, key, payload):
    """上报一次日报,返回服务端 R 包装里的 data。

    成功判定与服务端一致:HTTP 2xx + code==0 + data.result ∈ created/updated/unchanged。
    任何一条不满足都抛 ValueError —— 调用方据此把状态留在"未提交",绝不显示成已上报。
    「上传」与设置里的「测试连接」共用这里,避免各写一份请求与错误处理。
    """
    url=report_url(target)
    req=urllib.request.Request(url, data=json.dumps(payload,ensure_ascii=False).encode(),
        headers={'Content-Type':'application/json','X-API-Key':key,'User-Agent':USER_AGENT}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=60, context=tls_context()) as r:
            body=json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as exc:
        # 4xx/5xx 的正文才是"为什么被拒"(缺少密钥/应用编码不对/授权URL不匹配/报文不合法),
        # 只报状态码用户无法自救。
        # 还要带上**实际请求的地址**:服务端的授权URL 文案只说"这个密钥没授权本接口",
        # 分不清是密钥配错还是地址拼错(例如把完整接口地址又当基地址拼了一遍)。
        raise ValueError(f'HTTP {exc.code}: {server_message(exc.read())}（客户端实际请求:{url}）')
    except Exception as exc:
        debug(f'report error: {type(exc).__name__}: {exc}')
        raise ValueError(f'{type(exc).__name__}: {exc}（客户端实际请求:{url}）')
    # 合法 JSON 但不是对象(数组/字符串)时,后面的 .get 会抛 AttributeError,
    # 那样调用方区分不出"未提交"和"提交失败"。
    if not isinstance(body,dict): raise ValueError(f'提交服务返回的不是 JSON 对象:{str(body)[:200]}')
    if body.get('code'): raise ValueError(f'提交服务返回失败:{server_message(json.dumps(body,ensure_ascii=False))}')
    data=body.get('data')
    if not isinstance(data,dict) or data.get('result') not in ('created','updated','unchanged'):
        raise ValueError(f'提交服务返回了无法识别的结果:{str(body)[:200]}')
    return data

def submit(day):
    """把当天的日报上报到工作日志管理模块(地址与 Key 由设置界面配置)。

    服务端按「使用人 + 服务器当天」覆盖:同一天重复上报只留最新一条(不会多出一行),
    报文完全一致时回 unchanged 且不写库。使用人取自密钥,客户端**不发**任何身份字段。

    未配置提交地址/Key,或服务端返回非 2xx / 无法识别的结果时**绝不**把状态置为 submitted:
    那会让界面以为日报已经送达。改为持久化 submit_status / submit_error,便于重试与排查。
    """
    state=app_state(day)
    if state.get('report_status')=='submitted': return state
    # 只有成功归并过的日报才允许上报。否则手动点「上传」会把"按来源分组的占位内容"
    # 当成日报送出去 —— 那比不报更糟。
    if state.get('report_status')!='ready':
        reason=state.get('last_error') or '日报未成功生成(可能未配置 LLM)'
        state['submit_status']='failed'
        state['submit_error']=f'日报未完成主题归并,拒绝上报:{reason}'
        state['last_error']=state['submit_error']
        write_state(state); return state
    included=[x for x in state.get('work_items',[]) if not x.get('excluded')]
    target=(os.getenv('DIGEST_SUBMIT_URL') or '').strip(); key=(os.getenv('DIGEST_API_KEY') or '').strip()
    if not target or not key:
        state['submit_status']='not_configured'
        state['submit_error']='未配置提交地址或 API Key(DIGEST_SUBMIT_URL / DIGEST_API_KEY),日报未提交'
        state['last_error']=state['submit_error']
        write_state(state); return state

    try:
        result=post_report(target, key, report_payload(state, day, included))
    except ValueError as exc:
        return fail_submit(state, day, str(exc))
    state['report_status']='submitted'; state['submitted_count']=len(included)
    state['submit_status']='submitted'; state['submit_error']=None; state['last_error']=None
    # 服务端不返回 submitted_at(时间以服务端的 last_report_time 为准),缺省用本机时间填充。
    state['submitted_at']=result.get('submitted_at') or dt.datetime.now(TZ).isoformat()
    state['submit_mode']=result.get('result')
    write_state(state); return state

def fail_submit(state, day, message):
    debug(f'submit failed: {message}')
    state['submit_status']='failed'; state['submit_error']=message; state['last_error']=message
    write_state(state); return state

def post_verify(target, key):
    """调 API 密钥验证接口,返回服务端 R 包装里的 data。

    **只校验不写入** —— 不像上报接口那样有副作用,所以「测试连接」随时可以点。

    鉴权用**密钥自身**作 Bearer:该接口要 sys_apikey_view 权限,而密钥持有人的身份
    正是由这把密钥 introspect 出来的(userId/username 就来自密钥记录)。
    """
    url=verify_url(target)
    req=urllib.request.Request(url, data=json.dumps({'apiKey':key},ensure_ascii=False).encode(),
        headers={'Content-Type':'application/json','Authorization':'Bearer '+key,'User-Agent':USER_AGENT},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=20, context=tls_context()) as r:
            body=json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as exc:
        raise ValueError(f'HTTP {exc.code}: {server_message(exc.read())}（客户端实际请求:{url}）')
    except Exception as exc:
        debug(f'verify error: {type(exc).__name__}: {exc}')
        raise ValueError(f'{type(exc).__name__}: {exc}（客户端实际请求:{url}）')
    if not isinstance(body,dict): raise ValueError(f'提交服务返回的不是 JSON 对象:{str(body)[:200]}')
    if body.get('code'): raise ValueError(f'提交服务返回失败:{server_message(json.dumps(body,ensure_ascii=False))}')
    data=body.get('data')
    if not isinstance(data,dict):
        raise ValueError(f'提交服务返回了无法识别的结果:{str(body)[:200]}')
    return data

def check_submit(data=None):
    """设置里的「测试连接」:调 API 密钥验证接口,确认地址对不对、密钥能不能用。

    接口是 POST {基地址}/admin/api-key/verify,请求体 {"apiKey": <密钥>}。
    **校验不通过也返回 200**,结论由 data.valid + data.reason 表达("密钥不正确" /
    "密钥已禁用" / "密钥已过期" …),所以这里把 valid=false 当成一条可展示的结论,
    而不是"请求失败"。

    传 submit_url / submit_api_key 可测试"尚未保存"的输入;留空则用已保存的值。
    """
    load_env(); data=data or {}
    target=(data.get('submit_url') or os.getenv('DIGEST_SUBMIT_URL') or '').strip()
    key=(data.get('submit_api_key') or os.getenv('DIGEST_API_KEY') or '').strip()
    if not target or not key: raise ValueError('未配置提交地址或 API Key')
    try:
        result=post_verify(target, key)
    except ValueError as exc:
        message=str(exc)
        # 该接口需要鉴权,而客户端正是拿**待验证的这把密钥**去鉴权 —— 于是"密钥本身
        # 不可用"会先在鉴权层被拒(401/424),根本走不到接口里 valid=false 那条结论。
        # 框架在这里的原话是 "token expired",对着一个 API 密钥看这句只会更糊涂。
        if message.startswith(('HTTP 424','HTTP 401')):
            raise ValueError('密钥未通过服务端鉴权:密钥无效、已禁用、已过期,或不是 '
                             'sk-<主键ID>-<随机串> 的新格式。\n服务端原话:' + message)
        # 密钥的授权URL 必须放行验证接口本身,否则拦截器先以 403 拦下,服务端原话只说
        # "未授权访问本接口",不补一句用户很难想到要去改授权URL。
        if '授权URL' in message:
            raise ValueError(f'{message}\n\n提示:该密钥的「授权URL」需要包含 {VERIFY_PATH}'
                             '(或留空表示不限制),否则验证接口本身会被拦下。')
        raise
    if not result.get('valid'):
        raise ValueError('密钥校验未通过:' + str(result.get('reason') or '服务端未给出原因'))
    # 验证通过时回显密钥元数据:让用户确认"服务端认到的是谁、这把钥匙是干嘛的"。
    return {'member':result.get('username') or result.get('name') or '',
            'name':result.get('name') or '','app_code':result.get('appCode') or '',
            'reason':result.get('reason') or '','expires_at':result.get('expiresAt') or ''}

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--date',default=dt.datetime.now(TZ).date().isoformat()); ap.add_argument('--root',default=str(Path.home())); ap.add_argument('--out',default=None); ap.add_argument('--app-command'); args=ap.parse_args()
    if args.app_command:
        try:
            # App 会写 {} 到 stdin,但手工执行 `--app-command settings` 时 stdin 往往是空的。
            # 此前空输入会被当成坏 JSON,而这个失败还会被写进 state(把当天标成 failed),
            # 等于一次手动查看就污染了托盘状态。空输入按"无参数"处理。
            raw=__import__('sys').stdin.read()
            data=json.loads(raw) if raw.strip() else {}
            print(json.dumps(app_command(args.app_command, data), ensure_ascii=False)); return
        except Exception as exc:
            # 失败也要落盘:否则 state 停在 generating、last_error 为空,
            # 界面只能弹一次错误框,托盘却永远显示"生成中"。
            try:
                st = app_state(); st['last_error'] = str(exc)
                if st.get('report_status') == 'generating': st['report_status'] = 'failed'
                write_state(st)
            except Exception: pass
            print(json.dumps({'error':str(exc)},ensure_ascii=False)); raise SystemExit(1)
    load_env()  # 直接 CLI 路径也要读 .env:此前靠 run.sh source 配置文件,那会让配置里的 $(...) 被执行
    start,end=day_window(args.date); root=Path(args.root); events,collect_stats=collect(root,start,end); payload=summarize(events,args.date); payload['coverage']['collect']=collect_stats; payload['coverage']['raw_events']=len(events); payload['coverage']['filtered_events']='llm'
    out=Path(args.out) if args.out else Path(os.getenv('DIGEST_OUTPUT_DIR',str(APP_DIR)))/f'{args.date}.json'; out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8'); print(f'events={len(events)} raw={len(events)} output={out}')
    os.chmod(out, 0o600)

if __name__=='__main__': main()
