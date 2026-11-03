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
    return subprocess.run([str(tool), 'simctl', *args], check=check, capture_output=True, text=True, timeout=120 if args[0]=='install' else 40)
def hook(path):
    with urllib.request.urlopen('http://127.0.0.1:8765' + path, timeout=6) as response:
        return json.load(response)
def state(): return hook('/action?name=reader-check-state')
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
    sim('launch', a.device, bundle, '-reader-check')
    initial=wait_for(lambda s: s.get('ready') and s.get('reader',{}).get('strip',{}).get('pages',0)==32)
    report['initial']=initial
    expect(initial['homePrepared'], 'Home did not prepare the unread first/next pairs without marking them read')
    reader=initial['reader']
    expect(reader['chapters']==list(map(str,range(1,9))), reader)
    expect(all(abs(x-2/3)<1e-7 for x in reader['aspects']), 'Incorrect site dimensions escaped to the page strip')
    expected=reader['viewport']['height'] + len(reader['aspects'])*reader['viewport']['width']*1.5
    expect(abs(reader['height']-expected)<1, {'height':reader['height'],'expected':expected})
    hook('/layout'); hook('/timeline')
    time.sleep(.5)
    unchanged=state()['reader']
    expect(unchanged['height']==reader['height'] and unchanged['aspects']==reader['aspects'], 'Image arrival resized published boxes')
    sim('io', a.device, 'screenshot', str(out/'reader-fit.png'))
    hook('/zoom?scale=2.5')
    zoom=state()['reader']
    expect(zoom['aspects']==reader['aspects'], 'Zoom altered page geometry')
    sim('io', a.device, 'screenshot', str(out/'reader-zoom.png'))
    hook('/zoom?scale=1')
    restored=state()['reader']
    expect(abs(restored['height']-reader['height'])<1, 'Zoom changed the document height')
    for chapter in range(3,9):
        hook('/action?name=reader-check-bottom&end=0')
        moved=wait_for(lambda s: str(chapter) in s['reader']['chapters'])
        expect(moved['reader']['strip']['pages']>=chapter*4, moved)
        expect(moved['reader']['settledChapter']=='1', 'Continuous scroll depended on saving a settled page')
    final=hook('/action?name=reader-check-bottom&end=1')
    report['final']=state()
    expect(report['final']['chapterRequests']==0, 'Cached chapters made a provider request')
    expect(report['final']['reader']['settledChapter']=='8', report['final'])
    expect(report['final']['reader']['strip']['failures']==0, report['final'])
    report['pass']=True
    print('PASS: unread-entry preparation, exact decoder geometry, zoom stability and all eight cached chapters before scrolling and continuous free scrolling')
finally:
    (out/'report.json').write_text(json.dumps(report,indent=2))
    for action in ('terminate','uninstall'):
        try: sim(action, a.device, bundle, check=False)
        except (OSError, subprocess.TimeoutExpired) as error: print('Cleanup '+action+': '+str(error), flush=True)
