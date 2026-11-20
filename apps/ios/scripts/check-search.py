#!/usr/bin/env python3
"""Home search on the virtual iPhone: run inside mac-workload simulator, on an unsuffixed SIMULATOR=1 build.

  check-search.py --device UUID --app .../ScytheReader.app --output DIR [--query TEXT --expect ID]

Uses the real site and the real PC search (a few searches cost a fraction of a cent); takes the
screenshots the owner checks the visuals with, and asserts what can be measured:
  1. Home restored mid-list: the box arrives (the PC's model said hi) without moving the cards.
  3. Enter: the spinner, then the matches at the top with the box above them.
  4. A relaunch shows the same result.
  5. Emptying the box: the usual order and the place before searching return.
  6. Scrolled to the top: the empty box, "Search for…", above the first card.
  7. Enter there: the spinner in the box (only while the PC has not cached that query), then results.
The app is uninstalled afterwards (its data with it).
"""
import argparse, json, os, pathlib, subprocess, time, urllib.parse, urllib.request

p = argparse.ArgumentParser()
p.add_argument('--device', required=True)
p.add_argument('--app', required=True)
p.add_argument('--output', required=True)
p.add_argument('--bundle', default='com.visar.ScytheReader')
p.add_argument('--query', default='the dragon who wants no more kids')
p.add_argument('--expect', default='shut-up-malevolent-dragon-i-dont-want-to-have-any-more-children-with-you')
# Searched from the top for the spinner's picture; a query the PC has cached answers too fast to see it.
p.add_argument('--spinner-query', default='the archmage who opens a restaurant')
a = p.parse_args()
if not os.environ.get('IOS_WORKLOAD_ACTIVE'):
    raise SystemExit('Run inside the shared simulator workload guard')
out = pathlib.Path(a.output); out.mkdir(parents=True, exist_ok=True)
tool = pathlib.Path.home() / 'Developer/ios-tools/native/scripts/apple-tool'
subprocess.run([str(tool.with_name('mac-workload')), 'assert-simulator', '--device', a.device], check=True)
report = {'steps': []}


def sim(*args, check=True):
    return subprocess.run([str(tool), 'simctl', *args], check=check, capture_output=True, text=True, timeout=240 if args[0] == 'install' else 40)


def hook(path):
    with urllib.request.urlopen('http://127.0.0.1:8765' + path, timeout=8) as response:
        return json.load(response)


def state():
    return hook('/action?name=search-state')


def wait_for(predicate, seconds, every=0.1, record=None):
    deadline, latest = time.monotonic() + seconds, None
    while time.monotonic() < deadline:
        try:
            latest = state()
            if record is not None: record.append(latest)
            if predicate(latest): return latest
        except (OSError, ValueError):
            pass
        time.sleep(every)
    raise AssertionError({'timeout': latest})


def shot(name):
    sim('io', a.device, 'screenshot', str(out / (name + '.png')))
    report['steps'].append(name)


def expect(value, detail):
    if not value: raise AssertionError(detail)


def launch():
    sim('launch', a.device, a.bundle)


def relaunch():
    time.sleep(2.5)  # the navigation save follows a change shortly
    sim('terminate', a.device, a.bundle, check=False)
    time.sleep(1)
    launch()


def screen_y(s):
    return {card['key']: card['screenY'] for card in s['cards']}


launched = False
try:
    sim('install', a.device, a.app)
    launch(); launched = True
    first = wait_for(lambda s: s.get('catalog', 0) > 20 and s.get('box'), 120, every=0.5)
    report['firstLaunch'] = {k: first[k] for k in ('phase', 'catalog', 'box')}
    hook('/scroll?y=1000')
    mid = state()
    expect(mid['cards'], mid)

    # 1. Relaunched mid-list: cards from the phone's copy first, then the box, with nothing moving.
    relaunch()
    seen = []
    ready = wait_for(lambda s: s.get('box') and s.get('cards'), 60, every=0.05, record=seen)
    before = next((s for s in seen if s.get('cards') and not s.get('box')), None)
    report['boxArrived'] = {'hiddenFirst': before is not None, 'states': len(seen)}
    if before:
        moved = {key: (y, screen_y(ready).get(key)) for key, y in screen_y(before).items()
                 if key in screen_y(ready) and abs(y - screen_y(ready)[key]) > 0.5}
        report['boxArrived']['moved'] = moved
        expect(not moved, {'cards moved when the box appeared': moved})
    shot('1-box-arrived-mid-list')

    # 3. Enter (from mid-list): spinner, then the matches at the top.
    hook('/scroll?y=1200')
    place = state()
    searching = hook('/action?name=search&text=' + urllib.parse.quote(a.query))
    report['searching'] = {k: searching[k] for k in ('phase', 'busy')}
    expect(searching['busy'], searching)
    shot('3a-spinner')
    shown = wait_for(lambda s: s['phase'] == 'showing', 150, every=0.25)
    report['shown'] = {k: shown[k] for k in ('query', 'matches', 'order', 'offset')}
    expect(shown['order'][0] == a.expect, {'best match not first': shown['order'][:3]})
    expect(shown['cards'] and shown['cards'][0]['key'] == a.expect, {'best match not at the top of the screen': shown['cards'][:2]})
    shot('3b-results')

    # 4. A relaunch shows the same result.
    relaunch()
    restored = wait_for(lambda s: s.get('cards') and s['phase'] in ('showing', 'hidden', 'ready'), 60, every=0.1)
    report['relaunch'] = {k: restored[k] for k in ('phase', 'query', 'order')}
    expect(restored['phase'] == 'showing' and restored['order'][0] == a.expect, restored)
    shot('4-result-after-relaunch')

    # 5. Emptied: the usual order and the place before searching.
    cleared = hook('/action?name=search&text=')
    report['cleared'] = {k: cleared[k] for k in ('phase', 'order', 'offset')}
    expect(cleared['phase'] == 'ready' and cleared['order'] == place['order'], {'usual order not back': (cleared['order'], place['order'])})
    back = {c['key'] for c in cleared['cards']} & {c['key'] for c in place['cards']}
    expect(back, {'not back at the place before searching': (place['cards'][:2], cleared['cards'][:2])})
    shot('5-cleared-back-in-place')

    # 6. The empty box at the top ("Search for…"), above the first card: the top is where a result scrolled to.
    report['top'] = hook('/scroll?y=%s' % shown['offset'])
    shot('6-empty-box-at-top')

    # 7. Enter from the top, as typed: the spinner in the box while the PC is asked.
    spinning = hook('/action?name=search&text=' + urllib.parse.quote(a.spinner_query))
    shot('7-spinner-in-box')
    report['spinner'] = {'busyAtScreenshot': state()['busy'] or spinning['busy']}
    wait_for(lambda s: s['phase'] == 'showing', 150, every=0.25)
    shot('8-spinner-query-results')
    report['pass'] = True
    print('PASS: box arrives without moving cards, spinner, matches at the top, kept across relaunch, cleared back in place')
finally:
    (out / 'report.json').write_text(json.dumps(report, indent=2))
    for action in (('terminate', 'uninstall') if launched else ('uninstall',)):
        try: sim(action, a.device, a.bundle, check=False)
        except (OSError, subprocess.TimeoutExpired) as error: print('Cleanup ' + action + ': ' + str(error), flush=True)
