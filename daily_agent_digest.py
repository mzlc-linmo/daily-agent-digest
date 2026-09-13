#!/usr/bin/env python3
import argparse, datetime as dt, hashlib, json, os, re, sqlite3, subprocess, ssl, urllib.request
from pathlib import Path

TZ = dt.timezone(dt.timedelta(hours=8))
APP_DIR = Path(os.getenv('DIGEST_HOME', Path.home()/'.local/share/daily-agent-digest'))
RELEASE_VERSION = os.getenv('DIGEST_RELEASE_VERSION', 'dev')

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
# 高信号:人的意图与助手的叙述
HIGH_SIGNAL_KINDS = {'userMessage', 'agentMessage', 'assistant/message', 'reasoning',
                     'message', 'user', 'assistant', 'human'}
# 低信号:机器输出与流程事件,只在剩余预算里补充
LOW_SIGNAL_KINDS = {'functionCallOutput', 'commandExecution', 'mcpToolCall',
                    'tool/call', 'tool/result', 'tool', 'step/start', 'step/end', 'system'}

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

def strip_code_fence(text):
    text = str(text or '').strip()
    if text.startswith('```'):
        lines = text.splitlines()[1:]
        if lines and lines[-1].strip().startswith('```'): lines = lines[:-1]
        text = '\n'.join(lines)
    return text.strip()

def signal_rank(event):
    """0 = 人的意图/助手叙述,1 = 未知,2 = 机器输出与流程事件。"""
    kind = str(event.get('kind') or '')
    if kind in HIGH_SIGNAL_KINDS: return 0
    if kind in LOW_SIGNAL_KINDS: return 2
    return 1

def is_automation(event):
    """定时脚本/自动化任务的记录在本地直接排除,不占用模型的上下文预算。"""
    kind = str(event.get('kind') or '').lower()
    if kind == 'automation': return True
    text = str(event.get('text') or '')
    return 'automation_u' in text or '"name": "automation' in text or '"name":"automation' in text

def build_context(events, limit=CONTEXT_CHAR_LIMIT):
    """在预算内挑选送进 LLM 的摘录,返回 (上下文文本, 统计)。

    规则:先本地去重,再排除自动化记录,然后按「人的意图 → 其他 → 机器输出」分层,
    并在各来源之间轮转取样,任何一个来源的体量都不会把别的来源挤掉。
    """
    seen = set(); pool = []; automation = 0
    for e in events:
        if is_automation(e):
            automation += 1
            continue
        text = ' '.join(str(e.get('text') or '').split())
        fingerprint = hashlib.sha256(text[:800].encode()).hexdigest()
        if fingerprint in seen: continue
        seen.add(fingerprint)
        pool.append((e, f"[{e['provider']}] {text[:EXCERPT_CHAR_MAX]}"))

    providers = sorted({e['provider'] for e, _ in pool})
    tiers = {}
    for p in providers:
        rows = [x for x in pool if x[0]['provider'] == p]
        tiers[p] = (
            [x for x in rows if signal_rank(x[0]) == 0],
            [x for x in rows if signal_rank(x[0]) == 1],
            [x for x in rows if signal_rank(x[0]) == 2],
        )

    kept = []; used = 0
    taken = {p: 0 for p in providers}
    for tier in range(3):
        cursor = {p: 0 for p in providers}
        while True:
            progressed = False
            for p in providers:
                rows = tiers[p][tier]
                while cursor[p] < len(rows):
                    text = rows[cursor[p]][1]
                    if used + len(text) + 1 > limit:
                        break
                    cursor[p] += 1; taken[p] += 1
                    kept.append(text); used += len(text) + 1
                    progressed = True
            if not progressed: break

    omitted = {p: len([x for x in pool if x[0]['provider'] == p]) - taken[p] for p in providers}
    stats = {
        'events': len(events),
        'unique': len(pool),
        'automation_excluded': automation,
        'sent': len(kept),
        'chars': used,
        'char_limit': limit,
        'sent_by_provider': {p: taken[p] for p in providers},
        'omitted_by_provider': {p: n for p, n in omitted.items() if n},
    }
    return '\n'.join(kept), stats

def context_note(stats):
    """一行人类可读的选材说明,写入报告以便知道有什么没进模型。"""
    parts = [f"当天采集 {stats['events']} 条 → 去重 {stats['unique']} 条",
             f"排除自动化 {stats['automation_excluded']} 条",
             f"送模型 {stats['sent']} 条 / {stats['chars']} 字符(上限 {stats['char_limit']})"]
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
        APP_DIR.mkdir(parents=True, exist_ok=True); with_open = open(APP_DIR/'debug.log', 'a', encoding='utf-8'); with_open.write(f'{dt.datetime.now(TZ).isoformat()} {message}\n'); with_open.close()

def tls_context():
    cert_file=os.getenv('SSL_CERT_FILE')
    if not cert_file:
        for candidate in ('/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt'):
            if os.path.exists(candidate): cert_file=candidate; break
    try: return ssl.create_default_context(cafile=cert_file) if cert_file else ssl.create_default_context()
    except (OSError, ssl.SSLError): return ssl.create_default_context()
def app_state(day=None):
    load_env(); day=day or dt.datetime.now(TZ).date().isoformat(); state=read_state(day)
    if not state: state={'schema_version':'1.2','release_version':RELEASE_VERSION,'date':day,'work_items':[],'generated_at':None,'report_status':'not_generated','last_error':None,'reports':[],'report_chars':0,'included_count':0,'excluded_count':0,'submit_status':None,'submit_error':None}
    return state

def settings():
    load_env(); return {'base_url':os.getenv('LLM_BASE_URL','https://api.deepseek.com/v1'),'model':os.getenv('LLM_MODEL','deepseek-flash'),'api_key_set':bool(os.getenv('LLM_API_KEY'))}

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

def codex(root, start, end):
    db = root / '.codex/thread_history_1.sqlite'; rows = []
    if db.exists():
        con = sqlite3.connect(db)
        query = 'select thread_id, turn_id, created_at_ms, item_json, item_type from thread_items where created_at_ms >= ? and created_at_ms < ?'
        for tid, turn, created, raw, typ in con.execute(query, (int(start.timestamp()*1000), int(end.timestamp()*1000))):
            try: data = json.loads(raw)
            except json.JSONDecodeError: data = {'text': raw}
            text = json.dumps(data, ensure_ascii=False)[:4000]
            rows.append(event('codex', tid, turn, created, typ, text))
        con.close()
    for f in (root/'.codex/archived_sessions').glob('*.jsonl'):
        rows.extend(read_jsonl(f, 'codex', start, end))
    return dedupe(rows)

def read_jsonl(path, provider, start, end):
    out=[]
    try:
        lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    except OSError: return out
    sid = path.stem
    for i, line in enumerate(lines):
        try: obj=json.loads(line)
        except json.JSONDecodeError: continue
        stamp=obj.get('timestamp') or obj.get('createdAt') or obj.get('time')
        if in_window(stamp, start, end): out.append(event(provider, sid, str(obj.get('id', i)), stamp, obj.get('type'), json.dumps(obj, ensure_ascii=False)[:4000]))
    return out

def dsh(root, start, end):
    out=[]
    for f in (root/'.dsh/sessions').glob('**/*.zstd'):
        try: raw=subprocess.check_output(['zstd','-dc',str(f)], stderr=subprocess.DEVNULL, text=True)
        except (OSError, subprocess.CalledProcessError): continue
        for i,line in enumerate(raw.splitlines()):
            try: obj=json.loads(line)
            except json.JSONDecodeError: continue
            stamp=obj.get('time') or obj.get('createdAt')
            if in_window(stamp,start,end): out.append(event('deepseek-harness', f.parent.name, str(obj.get('seq',i)), stamp, obj.get('type'), json.dumps(obj,ensure_ascii=False)[:4000]))
    return dedupe(out)

def pi(root,start,end):
    out=[]
    for f in (root/'.pi/agent/sessions').glob('**/*.jsonl'): out.extend(read_jsonl(f,'pi',start,end))
    return dedupe(out)

def event(provider, session, item, stamp, kind, text):
    key=hashlib.sha256(f'{provider}|{session}|{item}|{text}'.encode()).hexdigest()
    return {'provider':provider,'session_id':session,'item_id':item,'timestamp':str(stamp),'kind':kind,'text':text,'dedupe_key':key}

def dedupe(rows):
    return list({r['dedupe_key']:r for r in rows}.values())

def summarize(events, day):
    by={}
    for e in events: by.setdefault(e['provider'],set()).add(e['session_id'])
    payload={'schema_version':'1.0','date':day,'timezone':'Asia/Shanghai','coverage':{'events':len(events),'sessions':sum(map(len,by.values())),'providers':sorted(by),'limitations':[]},'work_items':[{'id':hashlib.sha256(p.encode()).hexdigest()[:16],'title':f"{p} 工作记录（待 LLM 分类）",'desc':f'该来源当天有 {len(sessions)} 个会话，等待 LLM 按工作主题归并。','status':'observed','source_task_ids':sorted(sessions),'excluded':False} for p,sessions in by.items()],'blockers':[],'decisions':[],'artifacts':[],'sources':[{'provider':e['provider'],'task_id':e['session_id'],'turn_ids':[e['item_id']],'observed_at':e['timestamp']} for e in events]}
    base, key, model = llm_config()
    if base and key and model:
        # 在预算内选材:去重 -> 排除自动化 -> 按信号分层 + 来源轮转(FR-2)。
        context, stats = build_context(events)
        payload['coverage']['context'] = stats
        payload['coverage']['limitations'].append(context_note(stats))
        system='''你是日报整理器。把当天所有 agent 对话按“工作主题”聚类，每个主题写成一项独立内容。只保留真实工作内容：开发、工程、运维、研究、业务；排除个人问题、娱乐、闲聊和自动化噪音。一次性处理输入并返回严格 JSON，不要 Markdown：{"work_items":[{"title":"工作主题（不超过 30 字）","desc":"该项工作的完整说明","status":"completed|in_progress|blocked","source_task_ids":["provider/session"]}],"decisions":[],"blockers":[],"next_steps":[]}.
要求（必须遵守）：
1. 每一项的 desc 是这一项完整而独立的说明：写清做了什么、为什么做、怎么做的、结果或产出是什么，目标 100-300 字。
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
                    items.append({'id':hashlib.sha256((title+day).encode()).hexdigest()[:16],'title':title,'desc':str(item.get('desc','') or '').strip(),'status':item.get('status','observed'),'source_task_ids':item.get('source_task_ids',[]),'excluded':False})
                if items: payload['work_items']=items
                payload['decisions']=parsed.get('decisions',[]); payload['blockers']=parsed.get('blockers',[]); payload['next_steps']=parsed.get('next_steps',[])
        except Exception as exc: debug(f'LLM error: {type(exc).__name__}: {exc}'); payload['llm_error']=f'{type(exc).__name__}: {exc}'; payload['coverage']['limitations'].append('LLM unavailable: '+type(exc).__name__)
    # Enforce the budget locally too: model output is guidance, not a guarantee.
    payload['work_items'], payload['report_chars'] = fit_report(payload.get('work_items',[]))
    payload['coverage']['report_chars'] = payload['report_chars']
    payload['coverage']['report_char_limit'] = REPORT_CHAR_LIMIT
    return payload

def generate(day=None, source_root=None):
    day=day or dt.datetime.now(TZ).date().isoformat(); root=Path(source_root or os.getenv('DIGEST_SOURCE_ROOT', str(Path.home()))); start,end=day_window(day); events=codex(root,start,end)+pi(root,start,end)+dsh(root,start,end)
    payload=summarize(events,day); previous=app_state(day); excluded={x['id'] for x in previous.get('work_items',[]) if x.get('excluded')}
    for item in payload['work_items']: item['excluded']=item['id'] in excluded
    failed=payload.get('llm_error'); state={'schema_version':'1.2','release_version':RELEASE_VERSION,'date':day,'work_items':payload['work_items'],'generated_at':dt.datetime.now(TZ).isoformat(),'report_status':'error' if failed else 'ready','last_error':failed,'reports':sorted(set(previous.get('reports',[])+[day]))}
    # 排除项不会进入上报内容,因此字数按未排除项统计。
    state['coverage_note']=next((x for x in payload.get('coverage',{}).get('limitations',[]) if x.startswith('当天采集')), None)
    state=recount_report(state); write_state(state)
    return state

def app_command(command, data):
    load_env(); day=data.get('date') or dt.datetime.now(TZ).date().isoformat()
    if command == 'settings': return settings()
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
        state=recount_report(state); write_state(state); return state
    if command=='submit': return submit(day)
    raise ValueError('unknown app command')

def submit(day):
    """上报今天的日报。

    未配置上报通道或上报失败时**绝不**把状态置为 submitted:那会让界面与后续流程
    以为日报已经送达。改为持久化 submit_status / submit_error,report_status 保持
    不变,便于重试与排查。
    """
    state=app_state(day)
    if state.get('report_status')=='submitted': return state
    included=[x for x in state.get('work_items',[]) if not x.get('excluded')]
    target=os.getenv('DIGEST_SUBMIT_URL')
    if not target:
        state['submit_status']='not_configured'
        state['submit_error']='未配置上报通道(DIGEST_SUBMIT_URL),日报未上报'
        state['last_error']=state['submit_error']
        write_state(state); return state
    try:
        req=urllib.request.Request(target, data=json.dumps({'date':day,'work_items':included},ensure_ascii=False).encode(), headers={'Content-Type':'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=30, context=tls_context()): pass
    except Exception as exc:
        debug(f'submit error: {type(exc).__name__}: {exc}')
        state['submit_status']='failed'
        state['submit_error']=f'{type(exc).__name__}: {exc}'
        state['last_error']=state['submit_error']
        write_state(state); return state
    state['report_status']='submitted'; state['submitted_count']=len(included)
    state['submit_status']='submitted'; state['submit_error']=None; state['last_error']=None
    write_state(state); return state

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--date',default=dt.datetime.now(TZ).date().isoformat()); ap.add_argument('--root',default=str(Path.home())); ap.add_argument('--out',default=None); ap.add_argument('--app-command'); args=ap.parse_args()
    if args.app_command:
        try: print(json.dumps(app_command(args.app_command, json.load(__import__('sys').stdin)), ensure_ascii=False)); return
        except Exception as exc: print(json.dumps({'error':str(exc)},ensure_ascii=False)); raise SystemExit(1)
    start,end=day_window(args.date); root=Path(args.root); events=codex(root,start,end)+pi(root,start,end)+dsh(root,start,end); payload=summarize(events,args.date); payload['coverage']['raw_events']=len(events); payload['coverage']['filtered_events']='llm'
    out=Path(args.out) if args.out else Path(os.getenv('DIGEST_OUTPUT_DIR',str(Path.home()/'.local/share/daily-agent-digest')))/f'{args.date}.json'; out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8'); print(f'events={len(events)} raw={len(events)} output={out}')

if __name__=='__main__': main()
