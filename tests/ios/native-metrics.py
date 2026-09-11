"""Bounded native graphics and Safari/WebKit process gauges over the Mac tunnel.

These are device-level sampling gauges, not per-frame native stacks. They do not
prove which process caused a GPU stall. Keep Safari foregrounded during capture.
"""
import argparse
import asyncio
import json
import logging
from pathlib import Path
import time

from pymobiledevice3.remote.native_tunnel import establish_native_rsd
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.device_info import DeviceInfo
from pymobiledevice3.services.dvt.instruments.graphics import Graphics
from pymobiledevice3.services.dvt.instruments.sysmontap import Sysmontap


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=int, default=60, choices=range(5, 301), metavar='5..300')
    parser.add_argument('--wait-for-start')
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)
    rsd = await asyncio.wait_for(establish_native_rsd(serial='00008101-000639912881401E'), 20)
    counts = {'graphics': 0, 'process': 0}
    try:
        async with DvtProvider(rsd) as dvt:
            async with DeviceInfo(dvt) as info:
                processes = await asyncio.wait_for(info.proclist(), 10)
            selected = {p['pid']: p.get('name', '') for p in processes
                        if any(s.lower() in p.get('name', '').lower()
                               for s in ['Safari', 'WebKit', 'Adguard', 'Userscripts', 'backboardd', 'SpringBoard'])}
            print('PROCESS_TARGETS', json.dumps(selected), flush=True)
            sysmon = await asyncio.wait_for(Sysmontap.create(dvt, interval=500), 10)
            print('PROCESS_FIELDS', json.dumps(list(sysmon.process_attributes_cls.__dataclass_fields__)), flush=True)
            if args.wait_for_start:
                gate = Path(args.wait_for_start)
                if gate.exists():
                    raise RuntimeError('Start marker already exists; choose a fresh path')
                print('READY_WAITING', args.wait_for_start, flush=True)
                deadline = time.monotonic() + 900
                while not gate.exists():
                    if time.monotonic() > deadline:
                        raise TimeoutError('No start marker within 15 minutes')
                    await asyncio.sleep(.25)
            async with Graphics(dvt) as graphics, sysmon:
                async def gpu_samples():
                    async for sample in graphics:
                        counts['graphics'] += 1
                        print('NATIVE_GRAPHICS', json.dumps({'receivedEpoch': time.time(), 'sample': sample}, default=str), flush=True)

                async def process_samples():
                    async for sample in sysmon.iter_processes():
                        fields = {'pid', 'name', 'cpuUsage', 'cpuTotalUser', 'cpuTotalSystem',
                                  'physFootprint', 'memResidentSize', 'memCompressed', 'threadCount',
                                  'faults', 'vmPageIns', 'ctxSwitch', 'numRunning', 'wqBlockedThreads', 'appSleep'}
                        rows = [{k: v for k, v in p.items() if k in fields}
                                for p in sample if p.get('pid') in selected]
                        counts['process'] += 1
                        print('NATIVE_PROCESSES', json.dumps({'receivedEpoch': time.time(), 'processes': rows}, default=str), flush=True)

                print('NATIVE_STARTED', json.dumps({'epoch': time.time(), 'seconds': args.seconds}), flush=True)
                tasks = [asyncio.create_task(gpu_samples()), asyncio.create_task(process_samples())]
                try:
                    done, _ = await asyncio.wait(tasks, timeout=args.seconds, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                        raise RuntimeError('Native sample stream ended early')
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        print('NATIVE_COVERAGE', json.dumps(counts), flush=True)
        await rsd.close()


if __name__ == '__main__':
    asyncio.run(main())
