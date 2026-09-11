"""Bounded real Asura touch/restore observation. Run in the Mac inspector-venv.

No navigation unless --reload is requested; no userscript or storage access. Build with
MANGA_GESTURE_PROBE=1 to observe new documents. --profile adds
native sampled JavaScript stacks (use a separate pass to assess observer cost).
"""
import argparse
import asyncio
import json
import logging
from pathlib import Path
import time
from urllib.parse import urlparse

from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.webinspector import WebinspectorService


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native', action='store_true')
    parser.add_argument('--page-id', type=int)
    parser.add_argument('--seconds', type=int, default=180, choices=range(5, 301), metavar='5..300')
    parser.add_argument('--profile', action='store_true')
    parser.add_argument('--reload', action='store_true', help='Explicitly reload after arming to pick up the installed build')
    parser.add_argument('--wait-for-start', help='Wait for this Mac file before starting the timed recording (up to 15 minutes)')
    parser.add_argument('--stop-file', help='End recording cleanly when this new Mac file appears; do not send SIGINT')
    parser.add_argument('--inventory', action='store_true', help='Read event listener and script metadata before recording')
    args = parser.parse_args()
    if args.stop_file and Path(args.stop_file).exists():
        raise RuntimeError('Stop marker already exists; choose a fresh path')
    logging.disable(logging.CRITICAL)
    if args.native:
        from pymobiledevice3.remote.native_tunnel import establish_native_rsd
        lock = await asyncio.wait_for(establish_native_rsd(serial='00008101-000639912881401E'), 20)
    else:
        lock = await asyncio.wait_for(create_using_usbmux(serial='00008101-000639912881401E'), 20)
    inspector = WebinspectorService(lockdown=lock)
    session = None
    profiling = False
    timeline = False
    capture_epoch = float('inf')
    counts = {'batches': 0, 'timeline': 0, 'js': 0, 'sync': 0, 'replayed': 0, 'dropped': 0}
    try:
        await asyncio.wait_for(inspector.connect(), 15)
        pages = await inspector.get_open_application_pages(timeout=5)
        matches = [p for p in pages if p.application.bundle == 'com.apple.mobilesafari'
                   and urlparse(p.page.web_url).hostname == 'asurascans.com'
                   and (args.page_id is None or p.page.id_ == args.page_id)]
        if len(matches) != 1:
            raise RuntimeError('Select one Asura tab with --page-id. Candidates: ' +
                               str([p.page.id_ for p in matches]))
        pair = matches[0]
        session = await asyncio.wait_for(inspector.inspector_session(pair.application, pair.page), 15)

        async def command(method, **kwargs):
            try:
                result = await asyncio.wait_for(session.send_command(method, **kwargs), 10)
            except asyncio.TimeoutError:
                receiver = session._receive_task
                print('COMMAND_TIMEOUT', json.dumps({'method': method,
                      'receiverDone': receiver.done(),
                      'receiverError': str(receiver.exception()) if receiver.done() and not receiver.cancelled() else None,
                      'outerErrors': [v.get('error') for v in inspector.wir_message_results.values() if v.get('error')]}), flush=True)
                raise
            if result.get('method') == 'Target.dispatchMessageFromTarget':
                result = json.loads(result['params']['message'])
            if result.get('error'):
                raise RuntimeError(f'{method}: {result["error"]}')
            return result

        async def evaluate(source):
            # pymobiledevice3's convenience runtime_evaluate grants userGesture.
            # Observation must not manufacture activation for the page.
            result = await command('Runtime.evaluate', expression=source,
                                   returnByValue=True, userGesture=False,
                                   uniqueContextId='0.1', awaitPromise=False, replMode=True,
                                   doNotPauseOnExceptionsAndMuteConsole=True)
            if result.get('result', {}).get('wasThrown'):
                raise RuntimeError(str(result))
            return result.get('result')

        def console(event):
            message = event['params'].get('message', {})
            text = message.get('text', '')
            if text.startswith('MANGA_SETUP '):
                print(text, flush=True)
            if text.startswith('MANGA_GESTURE '):
                batch = json.loads(text[len('MANGA_GESTURE '):])
                if batch.get('version') != 2:
                    counts['replayed'] += 1
                    return
                batch['events'] = [e for e in batch['events']
                                   if batch['timeOrigin'] + e['at'] >= capture_epoch]
                if batch['events']:
                    counts['batches'] += 1
                    counts['dropped'] += batch.get('dropped', 0)
                    print('MANGA_GESTURE ' + json.dumps(batch), flush=True)

        session.response_methods['Console.messageAdded'] = console
        session.response_methods['Debugger.paused'] = lambda event: print('DEBUGGER_PAUSED', json.dumps(event['params']), flush=True)
        pending = set()
        previous_commit = session.response_methods['Target.didCommitProvisionalTarget']

        async def enable_after_navigation():
            try:
                await asyncio.wait_for(session.console_enable(), 10)
                await asyncio.wait_for(session.runtime_enable(), 10)
                print('NAVIGATION_ATTACHED', flush=True)
            except Exception as error:
                print('NAVIGATION_ATTACH_ERROR', str(error), flush=True)

        def committed(event):
            previous_commit(event)
            task = asyncio.create_task(enable_after_navigation())
            pending.add(task)
            task.add_done_callback(pending.discard)

        session.response_methods['Target.didCommitProvisionalTarget'] = committed
        def profile_event(event):
            if event['method'] == 'ScriptProfiler.trackingUpdate':
                counts['js'] += 1
            print('PROFILE ' + json.dumps(event), flush=True)

        for event_name in ['trackingStart', 'trackingUpdate', 'trackingComplete']:
            session.response_methods['ScriptProfiler.' + event_name] = profile_event
        def timeline_event(event):
            record = event['params']['record']
            def count_sync(record):
                if record['type'] == 'EventDispatch' and record.get('data', {}).get('type') == 'manga-inspector-sync':
                    counts['sync'] += 1
                for child in record.get('children', []):
                    count_sync(child)
            count_sync(record)
            counts['timeline'] += 1
            print('TIMELINE ' + json.dumps(record), flush=True)
        session.response_methods['Timeline.eventRecorded'] = timeline_event
        await asyncio.wait_for(session.runtime_enable(), 10)
        await evaluate('window.__mangaGestureProbe?.stop()')
        state = await evaluate('JSON.stringify({visible:document.visibilityState,href:location.href,epoch:Date.now(),at:performance.now()})')
        state = json.loads(state['result']['value'])
        print('PAGE_STATE', json.dumps(state), flush=True)
        if state['visible'] != 'visible':
            raise RuntimeError('Keep the Asura reader foregrounded and the phone unlocked; page is hidden')
        if args.inventory:
            scripts = {}
            session.response_methods['Debugger.scriptParsed'] = lambda event: scripts.update({
                event['params']['scriptId']: {k: event['params'].get(k) for k in ['url', 'sourceURL', 'isContentScript']}})
            await command('Debugger.enable')
            await asyncio.sleep(.2)
            for script_id, metadata in list(scripts.items()):
                result = await command('Debugger.getScriptSource', scriptId=script_id)
                source_text = result.get('result', {}).get('scriptSource', '')
                metadata['classifications'] = [name for name, marker in [
                    ('manga', '__mangaExtensionBoot'), ('adguard', 'adguard'),
                    ('userscripts-loader', 'userscripts'), ('gesture-probe', '__mangaGestureProbe')]
                    if marker.lower() in source_text.lower()]
                metadata['bytes'] = len(source_text)
                print('SCRIPT_METADATA', json.dumps(metadata), flush=True)
            inventory = r"""JSON.stringify({href:location.href,ready:document.readyState,boot:window.__mangaExtensionBoot,viewport:{width:innerWidth,height:innerHeight},listeners:[['window',window],['document',document],['body',document.body]].map(([name,target])=>({name,events:!target?{}:Object.fromEntries(Object.entries(getEventListeners(target)).map(([type,list])=>[type,list.map(item=>({keys:Object.keys(item),passive:item.passive,useCapture:item.useCapture,once:item.once,name:item.listener?.name,preventsDefault:String(item.listener).includes('preventDefault')}))]))}))})"""
            result = await command('Runtime.evaluate', expression=inventory,
                                   returnByValue=True, userGesture=False, includeCommandLineAPI=True)
            print('LISTENER_INVENTORY', json.dumps(result), flush=True)
            await command('Debugger.disable')
        await asyncio.wait_for(session.console_enable(), 10)
        await command('Page.enable')
        if args.wait_for_start:
            gate = Path(args.wait_for_start)
            if gate.exists():
                raise RuntimeError('Start marker already exists; choose a fresh path')
            print('READY_WAITING', args.wait_for_start, flush=True)
            limit = time.monotonic() + 900
            while not gate.exists():
                if time.monotonic() > limit:
                    raise TimeoutError('No start marker within 15 minutes')
                await asyncio.sleep(.25)
            visible = await evaluate('document.visibilityState')
            if visible['result']['value'] != 'visible':
                raise RuntimeError('Page became hidden while waiting; return to Safari before recording')
        phone_clock = await evaluate('Date.now()')
        capture_epoch = phone_clock['result']['value']
        deadline = capture_epoch + (args.seconds + 10) * 1000
        source = Path(__file__).with_name('gesture-probe.js').read_text().replace('__CAPTURE_DEADLINE__', str(deadline))
        # Attach listeners before enabling the Timeline debugger instrument.
        # Probe installation performs viewport reads; keep setup out of the
        # measured interval and do not confuse setup work with user gestures.
        await evaluate('setTimeout(() => {\n' + source + '\n}, 0); "install scheduled"')
        await asyncio.sleep(1)
        result = await evaluate('JSON.stringify({id:window.__mangaGestureProbe?.id,version:window.__mangaGestureProbe?.version})')
        probe_state = json.loads(result['result']['value'])
        if probe_state.get('version') != 2:
            raise RuntimeError('Gesture listeners did not finish installing: ' + str(probe_state))
        if args.profile:
            await command('ScriptProfiler.startTracking', includeSamples=True)
            profiling = True
            await command('Timeline.enable')
            await command('Timeline.start', maxCallStackDepth=8)
            timeline = True
            await evaluate("setTimeout(() => window.dispatchEvent(new Event('manga-inspector-sync')), 100)")
        print('ARMED', json.dumps({'page': pair.page.id_, 'seconds': args.seconds, 'result': result}), flush=True)
        if args.reload:
            await command('Page.reload')
        finish_at = time.monotonic() + args.seconds
        while time.monotonic() < finish_at:
            if args.stop_file and Path(args.stop_file).exists():
                break
            await asyncio.sleep(min(.25, max(0, finish_at - time.monotonic())))
        print('FINISHED', flush=True)
    finally:
        if session:
            if timeline:
                try:
                    await command('Timeline.stop')
                except Exception as error:
                    print('TIMELINE_STOP_ERROR', str(error), flush=True)
            if profiling:
                try:
                    await command('ScriptProfiler.stopTracking')
                    await asyncio.sleep(1)
                except Exception as error:
                    print('PROFILE_STOP_ERROR', str(error), flush=True)
            try:
                await evaluate('window.__mangaGestureProbe?.stop()')
            except Exception:
                pass  # Navigated-away documents also expire at the fixed deadline.
            print('COVERAGE', json.dumps(counts), flush=True)
        await inspector.close()
        await lock.close()


if __name__ == '__main__':
    asyncio.run(main())
