#!/usr/bin/env python3
"""Bounded offline Manga Reader simulator check; run inside mac-workload simulator."""
import argparse, json, os, pathlib, subprocess, time, urllib.request
p = argparse.ArgumentParser()
p.add_argument('--device', required=True)
p.add_argument('--app', required=True)
p.add_argument('--output', required=True)
a = p.parse_args()
if not os.environ.get('IOS_WORKLOAD_ACTIVE'):
    raise SystemExit('Run inside the shared simulator workload guard')
out = pathlib.Path(a.output); out.mkdir(parents=True, exist_ok=True)
tool = pathlib.Path.home() / 'Developer/ios-tools/native/scripts/apple-tool'
subprocess.run([str(tool.with_name('mac-workload')), 'assert-simulator', '--device', a.device], check=True)
bundle = 'com.visar.AsuraReader'
report = {}
def sim(*args, check=True):
    command=[str(tool), 'simctl', *args]
    if args[0]!='install':
        return subprocess.run(command, check=check, capture_output=True, text=True, timeout=40)
    proc=subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        try:
            stdout,stderr=proc.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            ps=subprocess.run(['ps','-axo','pid,ppid,stat,pcpu,command'],capture_output=True,text=True,timeout=10).stdout
            (out/'install-blocked-processes.txt').write_text(ps)
            candidates=[proc.pid]
            for line in ps.splitlines()[1:]:
                fields=line.split(None,4)
                if len(fields)<5: continue
                commandline=fields[4]
                if ('CoreSimulatorService' in commandline and 'grep' not in commandline) or ('/RuntimeRoot/' in commandline and any('/'+name in commandline for name in ['installd','lsd'])):
                    candidates.append(int(fields[0]))
            for pid in candidates[:4]:
                try:
                    sampled=subprocess.run(['/usr/bin/sample',str(pid),'3','-file',str(out/('sample-'+str(pid)+'.txt'))],capture_output=True,text=True,timeout=10)
                    (out/('sample-'+str(pid)+'-status.txt')).write_text(sampled.stdout+sampled.stderr)
                except subprocess.TimeoutExpired: pass
            stdout,stderr=proc.communicate(timeout=90)
        result=subprocess.CompletedProcess(command,proc.returncode,stdout,stderr)
        if check: result.check_returncode()
        return result
    finally:
        if proc.poll() is None:
            proc.kill(); proc.communicate(timeout=10)
def hook(path):
    with urllib.request.urlopen('http://127.0.0.1:8765' + path, timeout=6) as response:
        return json.load(response)
def state(): return hook('/action?name=cover-check-state')
def wait_for(predicate, seconds=25):
    deadline=time.monotonic()+seconds
    latest=None
    while time.monotonic()<deadline:
        try:
            latest=state()
            if latest.get('error'): raise AssertionError(latest)
            if predicate(latest): return latest
        except (OSError, ValueError): pass
        time.sleep(.15)
    raise AssertionError({'timeout': latest})
def expect(value, detail):
    if not value: raise AssertionError(detail)
try:
    sim('install', a.device, a.app)
    sim('launch', a.device, bundle, '-cover-check')
    initial=wait_for(lambda s: s.get('ready') and s.get('covers',{}).get('warm',0)>=100, seconds=40)
    time.sleep(.3)
    initial=state();report['initial']=initial
    expect(initial['order'][0]==25, 'Visible thumbnail was not prepared first')
    expect(initial['order']==sorted(set(initial['order'])), 'Ahead thumbnails did not prepare in catalog order')
    expect(initial['files']==160, 'All original covers must remain on disk')
    expect(initial['covers']['bytes']<=initial['covers']['budget'] and initial['covers']['cursor']<160, 'Ahead work must stop at its decoded-memory budget')
    before=initial['covers']['decoded']
    hook('/action?name=cover-check-repeat');time.sleep(.3)
    expect(state()['covers']['decoded']==before, 'Unchanged catalog/visibility restarted thumbnail decoding')
    hook('/action?name=cover-check-jump')
    jumped=wait_for(lambda s:s.get('cached145') and s['covers']['cursor']==160)
    report['jumped']=jumped
    expect(jumped['files']==160,'Moving the decoded window deleted a downloaded cover')
    hook('/action?name=cover-check-home');time.sleep(.5)
    layout=hook('/layout');hook('/timeline')
    shown=[x for x in layout.get('layout',[]) if x.get('kind')=='image' and x.get('shown')]
    expect(len(shown)>=3,{'homeImages':shown,'state':state()})
    sim('io',a.device,'screenshot',str(out/'covers-home.png'))
    report['final']=state();report['pass']=True
    print('PASS: visible-first/in-order cover preparation, bounded decode work, instant warm lookup, real Home images and permanent original retention',flush=True)
finally:
    (out/'report.json').write_text(json.dumps(report,indent=2))
    for action in ('terminate','uninstall'):
        try: sim(action,a.device,bundle,check=False)
        except (OSError,subprocess.TimeoutExpired) as error: print('Cleanup '+action+': '+str(error),flush=True)
