import { afterEach, expect, it, vi } from 'vitest';
import { fetchAsuraHome } from '../../src/provider/asura-catalog';
afterEach(()=>vi.unstubAllGlobals());
it('includes an Asura series whose catalog entry has no chapters field',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:[{
  slug:'coming-soon',title:'Coming soon',cover:'https://asurascans.com/cover.webp',public_url:'/comics/coming-soon-1234abcd',
 }],meta:{total:1,has_more:false}}))));
 const page=await fetchAsuraHome(null);
 expect(page.series).toHaveLength(1);expect(page.series[0].chapters).toEqual([]);
});
