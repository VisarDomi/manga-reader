import {beforeEach, expect, it, vi} from 'vitest';

beforeEach(() => { vi.resetModules(); });
it('waits for cached-document activation before forwarding shared Home requests', async () => {
    let activate!: (value: string) => void;
    const postMessage = vi.fn(({command}) => command === 'activate'
        ? new Promise<string>(resolve => { activate = resolve; }) : Promise.resolve('{}'));
    const events = new Map<string, ()=>void>();
    vi.stubGlobal('addEventListener', (name:string, handler:()=>void)=>events.set(name,handler));
    vi.stubGlobal('window', {webkit:{messageHandlers:{asura:{postMessage}}}});
    const {native} = await import('../../apps/ios/web/native');
    events.get('pagehide')!();
    const frozen = native('read', {key:'views'});
    await Promise.resolve();
    expect(postMessage).not.toHaveBeenCalled();
    const activation = native('activate', {home:true});
    const fetch = native('fetch', {url:'https://example.test/catalog'});
    const history = native('read', {key:'database'});
    await Promise.resolve();
    expect(postMessage.mock.calls.map(([request])=>request.command)).toEqual(['activate']);
    activate('{}'); await Promise.all([activation, fetch, history, frozen]);
    expect(postMessage.mock.calls.map(([request])=>request.command)).toEqual(['activate','fetch','read','read']);
    vi.unstubAllGlobals();
});
