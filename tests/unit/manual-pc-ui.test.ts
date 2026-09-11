// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const call=vi.hoisted(()=>vi.fn());
vi.mock('../../src/core/compute/transport',()=>({computeRequest:call}));
import { installManualPC } from '../../src/core/home-backup';
beforeEach(()=>{document.body.replaceChildren();call.mockReset();});
it('hides controls offline and only transfers state on Load/Save clicks',async()=>{
 call.mockResolvedValue(false);installManualPC(document.body,'asurascans',()=>{});
 await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(1));
 expect(document.querySelector<HTMLElement>('.hs-home-pc')!.hidden).toBe(true);
 document.body.replaceChildren();call.mockClear();call.mockResolvedValue(true);const loaded=vi.fn();
 const status=document.createElement('p');status.textContent='Loaded 343 of 343 series';document.body.append(status);
 installManualPC(document.body,'asurascans',loaded);
 await vi.waitFor(()=>expect(document.querySelector<HTMLElement>('.hs-home-pc')!.hidden).toBe(false));
 expect(call.mock.calls.map(c=>c[1].action)).toEqual(['available']);
 const buttons=document.querySelectorAll('button');buttons[0].click();
 await vi.waitFor(()=>expect(loaded).toHaveBeenCalledOnce());buttons[1].click();
 await vi.waitFor(()=>expect(call.mock.calls.map(c=>c[1].action)).toEqual(['available','load','save']));
 expect(document.querySelector('.hs-home-pc')!.previousElementSibling).toBe(status);
});
