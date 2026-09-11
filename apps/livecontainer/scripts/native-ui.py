#!/usr/bin/env python3
"""Bounded physical-device accessibility inspection; press an observed exact caption."""
import argparse
import asyncio
import logging
from pathlib import Path
from pymobiledevice3.remote.native_tunnel import establish_native_rsd
from pymobiledevice3.services.accessibilityaudit import AccessibilityAudit
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.screenshot import Screenshot

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--press')
    parser.add_argument('--screenshot')
    parser.add_argument('--screenshot-only', action='store_true')
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)
    rsd = await establish_native_rsd(serial='00008101-000639912881401E')
    audit = AccessibilityAudit(rsd)
    try:
        async def walk():
            found = []
            async for item in audit.iter_elements():
                print(item.caption, flush=True)
                if args.press and item.caption == args.press:
                    found.append(item)
            if args.press:
                if len(found) != 1:
                    raise RuntimeError('Expected one exact matching accessibility element')
                await audit.perform_press(found[0].element.identifier)
                print('PRESS_SENT', args.press, flush=True)
        if not args.screenshot_only:
            await asyncio.wait_for(walk(), 25)
        if args.screenshot:
            async with DvtProvider(rsd) as dvt, Screenshot(dvt) as screenshot:
                Path(args.screenshot).write_bytes(await screenshot.get_screenshot())
    finally:
        await audit.close()
        await rsd.close()

asyncio.run(main())
