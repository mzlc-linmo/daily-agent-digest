#!/usr/bin/env python3
import argparse, datetime as dt, hashlib, json, os, sqlite3, subprocess, urllib.request
from pathlib import Path

TZ = dt.timezone(dt.timedelta(hours=8))
NON_WORK = ('暗黑4','暗黑 4','游戏','巅峰等级','死灵法师','电影','电视剧','动漫','星座','塔罗','彩票','旅游攻略','情感','恋爱','健身','菜谱','天气','生日','闲聊')
def work_only(events):
    kept=[]
    for e in events:
        text=e.get('text','').lower()
        # Keep coding, operations, research, and business work; drop obvious personal/entertainment turns.
        if any(term in text for term in NON_WORK) and not any(term in text for term in ('代码','部署','服务器','api','项目','脚本','配置','bug','开发')):
            continue
        kept.append(e)
    return kept

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
    payload={'schema_version':'1.0','date':day,'timezone':'Asia/Shanghai','coverage':{'events':len(events),'sessions':sum(map(len,by.values())),'providers':sorted(by),'limitations':[]},'summary':f'Collected {len(events)} work events across {sum(map(len,by.values()))} sessions.','work_items':[{'title':f"{p} session {s}",'status':'observed','details':next(e['text'] for e in events if e['provider']==p and e['session_id']==s)[:500],'source_task_ids':[s]} for p in by for s in by[p]],'blockers':[],'decisions':[],'artifacts':[],'sources':[{'provider':e['provider'],'task_id':e['session_id'],'turn_ids':[e['item_id']],'observed_at':e['timestamp']} for e in events]}
    base=os.getenv('LLM_BASE_URL'); key=os.getenv('LLM_API_KEY'); model=os.getenv('LLM_MODEL')
    if base and key and model:
        context='\n'.join(f"[{e['provider']}] {e['text']}" for e in events[:300])
        req=urllib.request.Request(base.rstrip('/')+'/chat/completions',data=json.dumps({'model':model,'messages':[{'role':'system','content':'Summarize agent work in Chinese. Return concise Markdown with completed work, decisions, blockers, and next steps.'},{'role':'user','content':context}]}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+key},method='POST')
        try:
            with urllib.request.urlopen(req,timeout=60) as r: payload['summary']=json.loads(r.read())['choices'][0]['message']['content']; payload['coverage']['limitations'].append('LLM context capped at 300 events')
        except Exception as exc: payload['coverage']['limitations'].append('LLM unavailable: '+type(exc).__name__)
    return payload

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--date',default=dt.datetime.now(TZ).date().isoformat()); ap.add_argument('--root',default=str(Path.home())); ap.add_argument('--out',default=None); args=ap.parse_args()
    start,end=day_window(args.date); root=Path(args.root); raw_events=codex(root,start,end)+pi(root,start,end)+dsh(root,start,end); events=work_only(raw_events); payload=summarize(events,args.date); payload['coverage']['raw_events']=len(raw_events); payload['coverage']['filtered_events']=len(events)
    out=Path(args.out) if args.out else Path(os.getenv('DIGEST_OUTPUT_DIR',str(Path.home()/'.local/share/daily-agent-digest')))/f'{args.date}.json'; out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8'); print(f'events={len(events)} raw={len(raw_events)} output={out}')

if __name__=='__main__': main()
