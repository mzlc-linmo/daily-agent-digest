#!/usr/bin/env python3
import argparse, datetime as dt, hashlib, json, os, sqlite3, subprocess, urllib.request
from pathlib import Path

TZ = dt.timezone(dt.timedelta(hours=8))
APP_DIR = Path(os.getenv('DIGEST_HOME', Path.home()/'.local/share/daily-agent-digest'))

def load_env():
    path = APP_DIR/'.env'
    if not path.exists(): return
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        if not line or line.lstrip().startswith('#') or '=' not in line: continue
        key, value = line.split('=', 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"": value = value[1:-1]
        os.environ[key.strip()] = value

def state_path(): return APP_DIR/'state.json'
def read_state(day=None):
    try: state=json.loads(state_path().read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError): state={}
    if day and state.get('date') != day: state={}
    return state
def write_state(state):
    APP_DIR.mkdir(parents=True, exist_ok=True); state_path().write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8'); os.chmod(state_path(), 0o600)
def app_state(day=None):
    load_env(); day=day or dt.datetime.now(TZ).date().isoformat(); state=read_state(day)
    if not state: state={'date':day,'work_items':[],'generated_at':None,'report_status':'not_generated','last_error':None,'reports':[]}
    return state

def settings():
    load_env(); return {'base_url':os.getenv('LLM_BASE_URL','https://api.deepseek.com/v1'),'model':os.getenv('LLM_MODEL','deepseek-flash'),'api_key_set':bool(os.getenv('LLM_API_KEY'))}

def save_settings(data):
    APP_DIR.mkdir(parents=True, exist_ok=True); path=APP_DIR/'.env'; old={}
    if path.exists():
        for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
            if '=' in line: k,v=line.split('=',1); old[k]=v
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
    payload={'schema_version':'1.0','date':day,'timezone':'Asia/Shanghai','coverage':{'events':len(events),'sessions':sum(map(len,by.values())),'providers':sorted(by),'limitations':[]},'summary':f'Collected {len(events)} events across {sum(map(len,by.values()))} sessions; the LLM classifies work content.','work_items':[{'id':hashlib.sha256(f'{p}|{s}'.encode()).hexdigest()[:16],'title':f"{p} session {s}",'status':'observed','details':next(e['text'] for e in events if e['provider']==p and e['session_id']==s)[:500],'source_task_ids':[s],'excluded':False} for p in by for s in by[p]],'blockers':[],'decisions':[],'artifacts':[],'sources':[{'provider':e['provider'],'task_id':e['session_id'],'turn_ids':[e['item_id']],'observed_at':e['timestamp']} for e in events]}
    base=os.getenv('LLM_BASE_URL'); key=os.getenv('LLM_API_KEY'); model=os.getenv('LLM_MODEL')
    if base and key and model:
        context='\n'.join(f"[{e['provider']}] {e['text']}" for e in events[:300])
        req=urllib.request.Request(base.rstrip('/')+'/chat/completions',data=json.dumps({'model':model,'messages':[{'role':'system','content':'Summarize only genuine work activity in Chinese. Decide from the conversation content what is work: include coding, engineering, operations, research, and business tasks. Exclude personal questions, entertainment, games, lifestyle requests, casual chat, and unrelated automation noise. Return concise Markdown with completed work, decisions, blockers, and next steps.'},{'role':'user','content':context}]}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+key},method='POST')
        try:
            with urllib.request.urlopen(req,timeout=60) as r: payload['summary']=json.loads(r.read())['choices'][0]['message']['content']; payload['coverage']['limitations'].append('LLM context capped at 300 events')
        except Exception as exc: payload['coverage']['limitations'].append('LLM unavailable: '+type(exc).__name__)
    return payload

def generate(day=None):
    day=day or dt.datetime.now(TZ).date().isoformat(); start,end=day_window(day); events=codex(Path.home(),start,end)+pi(Path.home(),start,end)+dsh(Path.home(),start,end)
    payload=summarize(events,day); previous=app_state(day); excluded={x['id'] for x in previous.get('work_items',[]) if x.get('excluded')}
    for item in payload['work_items']: item['excluded']=item['id'] in excluded
    state={'date':day,'work_items':payload['work_items'],'generated_at':dt.datetime.now(TZ).isoformat(),'report_status':'ready','last_error':None,'reports':sorted(set(previous.get('reports',[])+[day]))}
    state['summary']=payload.get('summary',''); write_state(state)
    return state

def app_command(command, data):
    load_env(); day=data.get('date') or dt.datetime.now(TZ).date().isoformat()
    if command == 'settings': return settings()
    if command == 'save-settings': return save_settings(data)
    if command in ('generate','state','tick'):
        state=app_state(day)
        now=dt.datetime.now(TZ)
        # Manual generate always refreshes. Tick generates once after 17:30 and finalizes once after 18:00.
        after_preview = now.hour > 17 or (now.hour == 17 and now.minute >= 30)
        if command == 'generate' or (command == 'tick' and now.date().isoformat()==day and after_preview and not state.get('generated_at')):
            state=generate(day)
        if command == 'tick' and now.date().isoformat()==day and now.hour >= 18 and state.get('report_status')=='ready': state=submit(day)
        return state
    state=app_state(day); ids={x.get('id') for x in state.get('work_items',[])}
    if command in ('exclude','restore'):
        ident=data.get('id');
        if ident not in ids: raise ValueError('unknown work item id')
        for item in state['work_items']:
            if item['id']==ident: item['excluded']=(command=='exclude')
        write_state(state); return state
    if command=='submit': return submit(day)
    raise ValueError('unknown app command')

def submit(day):
    state=app_state(day)
    if state.get('report_status')=='submitted': return state
    included=[x for x in state.get('work_items',[]) if not x.get('excluded')]
    # Reserved submission hook: configure DIGEST_SUBMIT_URL to enable an API POST.
    target=os.getenv('DIGEST_SUBMIT_URL')
    if target:
        req=urllib.request.Request(target, data=json.dumps({'date':day,'work_items':included},ensure_ascii=False).encode(), headers={'Content-Type':'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=30): pass
    state['report_status']='submitted'; state['submitted_count']=len(included); state['last_error']=None; write_state(state); return state

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--date',default=dt.datetime.now(TZ).date().isoformat()); ap.add_argument('--root',default=str(Path.home())); ap.add_argument('--out',default=None); ap.add_argument('--app-command'); args=ap.parse_args()
    if args.app_command:
        try: print(json.dumps(app_command(args.app_command, json.load(__import__('sys').stdin)), ensure_ascii=False)); return
        except Exception as exc: print(json.dumps({'error':str(exc)},ensure_ascii=False)); raise SystemExit(1)
    start,end=day_window(args.date); root=Path(args.root); events=codex(root,start,end)+pi(root,start,end)+dsh(root,start,end); payload=summarize(events,args.date); payload['coverage']['raw_events']=len(events); payload['coverage']['filtered_events']='llm'
    out=Path(args.out) if args.out else Path(os.getenv('DIGEST_OUTPUT_DIR',str(Path.home()/'.local/share/daily-agent-digest')))/f'{args.date}.json'; out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8'); print(f'events={len(events)} raw={len(events)} output={out}')

if __name__=='__main__': main()
