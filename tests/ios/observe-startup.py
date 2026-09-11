"""Observe an explicit Asura reload without injecting a page probe or startup guard.

Run with the Mac inspector-venv. No storage access. Native debugger/profiler
instrumentation adds overhead; script reinjection counts are not timing benchmarks.
"""
import argparse
import asyncio
import collections
import json
import logging
import time
from urllib.parse import urlparse

from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.webinspector import WebinspectorService


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=int, default=30, choices=range(5, 61))
    parser.add_argument('--reload', action='store_true')
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)
    lock = await asyncio.wait_for(create_using_usbmux(serial='00008101-000639912881401E'), 15)
    inspector = WebinspectorService(lockdown=lock)
    session = None
    counts = collections.Counter()
    scripts = collections.Counter()
    try:
        await asyncio.wait_for(inspector.connect(), 15)
        pages = await inspector.get_open_application_pages(timeout=5)
        matches = [p for p in pages if p.application.bundle == 'com.apple.mobilesafari'
                   and urlparse(p.page.web_url).hostname == 'asurascans.com']
        if len(matches) != 1:
            raise RuntimeError('Expected one Asura tab; found ' + str(len(matches)))
        pair = matches[0]
        session = await asyncio.wait_for(inspector.inspector_session(pair.application, pair.page), 15)

        async def command(method, **kwargs):
            result = await asyncio.wait_for(session.send_command(method, **kwargs), 10)
            if result.get('method') == 'Target.dispatchMessageFromTarget':
                result = json.loads(result['params']['message'])
            if result.get('error'):
                raise RuntimeError(str(result['error']))
            return result

        def parsed(event):
            p = event['params']
            url = p.get('url') or p.get('sourceURL') or '(anonymous)'
            scripts[url] += 1
            counts['scriptParsed'] += 1
            if scripts[url] <= 5:
                print('SCRIPT', json.dumps({'url': url, 'count': scripts[url], 'scriptId': p.get('scriptId'),
                                           'contentScript': p.get('isContentScript')}), flush=True)

        def console(event):
            p = event['params'].get('message', {})
            counts['console'] += 1
            if p.get('level') == 'error':
                counts['errors'] += 1
                if counts['errors'] <= 10:
                    print('ERROR', json.dumps({'text': p.get('text', '')[:1500],
                                              'stack': p.get('stackTrace')}), flush=True)

        session.response_methods['Debugger.scriptParsed'] = parsed
        session.response_methods['Console.messageAdded'] = console
        pending = set()
        committed = session.response_methods['Target.didCommitProvisionalTarget']

        async def reattach():
            try:
                await command('Debugger.enable')
                await command('Console.enable')
                await command('Runtime.enable')
                print('NAVIGATION_ATTACHED', flush=True)
            except Exception as error:
                print('NAVIGATION_ATTACH_ERROR', type(error).__name__, str(error), flush=True)

        def navigation(event):
            committed(event)
            print('NAVIGATION', json.dumps(event['params']), flush=True)
            task = asyncio.create_task(reattach())
            pending.add(task)
            task.add_done_callback(pending.discard)

        session.response_methods['Target.didCommitProvisionalTarget'] = navigation
        await command('Runtime.enable')
        await command('Debugger.enable')
        await command('Console.enable')
        await command('Page.enable')
        await asyncio.sleep(.2)
        print('ATTACHED_BASELINE', json.dumps(dict(scripts)), flush=True)
        scripts.clear()
        counts.clear()
        # No page-side listener, timer, wrapper, synthetic activation or guard.
        print('ARMED', json.dumps({'page': pair.page.id_, 'epoch': time.time(),
                                  'seconds': args.seconds, 'reload': args.reload}), flush=True)
        if args.reload:
            # Do not await the reload response: document_start may reenter while
            # close() is executing. The external capture remains time bounded.
            await session.send_message_to_target({'method': 'Page.reload', 'params': {}})
        await asyncio.sleep(args.seconds)
        print('COVERAGE', json.dumps({'events': dict(counts), 'scripts': dict(scripts)}), flush=True)
        try:
            result = await command('Runtime.evaluate', userGesture=False, returnByValue=True,
                                   expression="JSON.stringify({ready:document.readyState,guard:!!window.__mangaExtensionBoot,reader:!!document.querySelector('.hs-reader-body'),chapters:document.querySelectorAll('.hs-chapter').length,scripts:document.scripts.length,errors:[...document.querySelectorAll('.hs-error')].map(e=>e.textContent)})")
            print('FINAL_STATE', json.dumps(result), flush=True)
        except Exception as error:
            print('FINAL_STATE_UNAVAILABLE', type(error).__name__, str(error), flush=True)
    finally:
        if session:
            try:
                await asyncio.wait_for(session.send_command('Debugger.disable'), 5)
            except Exception:
                pass
        await inspector.close()
        await lock.close()


if __name__ == '__main__':
    asyncio.run(main())
