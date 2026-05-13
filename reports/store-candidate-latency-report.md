# Store Candidate Latency Report

Generated: 2026-05-13T09:30:35.775Z

Log source: `journalctl --user -u manga-reader.service --since '2026-05-11 13:02:32' --until now`

DB source: `/home/visar/.local/state/manga-reader/cache.sqlite`

## Scope

The current random candidate collection started with `todo.md` at commit `6a23b8a` on `2026-05-11 13:02:32 +0200`. This report uses reader image candidate logs from that point forward.

Parsed frontend candidate attempts: 8092

Candidate sessions: 6223

Durable DB store-status rows: 7966

Durable DB latency-observation rows: 0

## Latency Ranking From Logs

| Rank | Host | Attempts | OK | Success | First-choice OK | Sessions | Session wins | Median OK | Avg OK | P90 OK | P95 OK | P98 OK | Max OK | Statuses |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| 1 | `j24n.wowpic4.store` | 347 | 347 | 100% | 100% | 333 | 267 | 318ms | 589ms | 775ms | 1572ms | 3914ms | 24370ms | 200:347 |
| 2 | `jloo.wowpic5.store` | 347 | 347 | 100% | 100% | 334 | 264 | 327ms | 535ms | 824ms | 1905ms | 2990ms | 11082ms | 200:347 |
| 3 | `jloo.wowpic1.store` | 327 | 327 | 100% | 100% | 319 | 263 | 317ms | 376ms | 619ms | 796ms | 1252ms | 3960ms | 200:327 |
| 4 | `j24n.wowpic1.store` | 334 | 334 | 100% | 100% | 329 | 263 | 335ms | 577ms | 1008ms | 2044ms | 3413ms | 12677ms | 200:334 |
| 5 | `ek10.wowpic5.store` | 345 | 345 | 100% | 100% | 329 | 263 | 337ms | 568ms | 834ms | 1493ms | 2869ms | 12644ms | 200:345 |
| 6 | `jloo.wowpic3.store` | 334 | 334 | 100% | 100% | 330 | 263 | 338ms | 527ms | 873ms | 1580ms | 2712ms | 12526ms | 200:334 |
| 7 | `ek10.wowpic3.store` | 346 | 346 | 100% | 100% | 335 | 262 | 316ms | 558ms | 900ms | 1958ms | 3237ms | 12643ms | 200:346 |
| 8 | `ek10.wowpic4.store` | 332 | 332 | 100% | 100% | 319 | 262 | 346ms | 527ms | 880ms | 1616ms | 2830ms | 6273ms | 200:332 |
| 9 | `j24n.wowpic5.store` | 337 | 337 | 100% | 100% | 321 | 260 | 334ms | 650ms | 828ms | 1388ms | 2844ms | 48188ms | 200:337 |
| 10 | `80pd.wowpic5.store` | 336 | 336 | 100% | 100% | 325 | 258 | 312ms | 534ms | 841ms | 1925ms | 3347ms | 11774ms | 200:336 |
| 11 | `jdpw.wowpic2.store` | 339 | 339 | 100% | 100% | 329 | 257 | 304ms | 432ms | 571ms | 926ms | 2162ms | 12246ms | 200:339 |
| 12 | `jdpw.wowpic1.store` | 314 | 314 | 100% | 100% | 307 | 255 | 320ms | 480ms | 798ms | 1326ms | 2454ms | 7263ms | 200:314 |
| 13 | `jloo.wowpic2.store` | 339 | 339 | 100% | 100% | 324 | 253 | 325ms | 472ms | 851ms | 1317ms | 2236ms | 9064ms | 200:339 |
| 14 | `jdpw.wowpic5.store` | 318 | 318 | 100% | 100% | 306 | 253 | 326ms | 550ms | 887ms | 1928ms | 3349ms | 12658ms | 200:318 |
| 15 | `ek10.wowpic1.store` | 324 | 324 | 100% | 100% | 319 | 252 | 339ms | 542ms | 975ms | 1521ms | 3043ms | 11599ms | 200:324 |
| 16 | `jdpw.wowpic3.store` | 310 | 310 | 100% | 100% | 301 | 243 | 328ms | 518ms | 811ms | 1821ms | 2517ms | 12656ms | 200:310 |
| 17 | `80pd.wowpic2.store` | 304 | 304 | 100% | 100% | 295 | 240 | 322ms | 505ms | 907ms | 1591ms | 2083ms | 12518ms | 200:304 |
| 18 | `80pd.wowpic4.store` | 309 | 309 | 100% | 100% | 300 | 240 | 325ms | 468ms | 979ms | 1543ms | 2243ms | 3577ms | 200:309 |
| 19 | `jloo.wowpic4.store` | 312 | 312 | 100% | 100% | 296 | 240 | 327ms | 532ms | 958ms | 1909ms | 2776ms | 12479ms | 200:312 |
| 20 | `j24n.wowpic3.store` | 288 | 288 | 100% | 100% | 283 | 231 | 340ms | 702ms | 913ms | 1581ms | 3444ms | 41422ms | 200:288 |
| 21 | `ek10.wowpic2.store` | 306 | 306 | 100% | 100% | 299 | 230 | 311ms | 453ms | 671ms | 1301ms | 2296ms | 10075ms | 200:306 |
| 22 | `80pd.wowpic1.store` | 314 | 314 | 100% | 100% | 302 | 229 | 323ms | 537ms | 805ms | 2044ms | 3282ms | 12296ms | 200:314 |
| 23 | `j24n.wowpic2.store` | 308 | 308 | 100% | 100% | 299 | 228 | 325ms | 560ms | 898ms | 1506ms | 3310ms | 12608ms | 200:308 |
| 24 | `80pd.wowpic3.store` | 324 | 324 | 100% | 100% | 309 | 225 | 340ms | 514ms | 1030ms | 1630ms | 2268ms | 5024ms | 200:324 |
| 25 | `jdpw.wowpic4.store` | 298 | 298 | 100% | 100% | 293 | 222 | 332ms | 506ms | 785ms | 1272ms | 2524ms | 17644ms | 200:298 |

## Durable Status Ranking From DB

This table is the latest-status summary. Detailed latency observations live in `image_store_observations` after the adaptive selector migration.

| Rank | Host | Rows | OK | Success | Statuses | Latest check |
| ---: | --- | ---: | ---: | ---: | --- | --- |
| 1 | `ek10.wowpic3.store` | 340 | 340 | 100% | 200:340 | 2026-05-13T06:48:50.694Z |
| 2 | `jloo.wowpic5.store` | 340 | 340 | 100% | 200:340 | 2026-05-13T08:10:34.441Z |
| 3 | `ek10.wowpic5.store` | 335 | 335 | 100% | 200:335 | 2026-05-13T08:10:31.879Z |
| 4 | `j24n.wowpic4.store` | 335 | 335 | 100% | 200:335 | 2026-05-12T22:33:09.035Z |
| 5 | `j24n.wowpic5.store` | 334 | 334 | 100% | 200:334 | 2026-05-12T22:34:43.436Z |
| 6 | `jdpw.wowpic2.store` | 333 | 333 | 100% | 200:333 | 2026-05-12T22:35:33.920Z |
| 7 | `jloo.wowpic3.store` | 332 | 332 | 100% | 200:332 | 2026-05-13T08:10:36.553Z |
| 8 | `jloo.wowpic2.store` | 332 | 332 | 100% | 200:332 | 2026-05-12T22:34:55.619Z |
| 9 | `ek10.wowpic4.store` | 331 | 331 | 100% | 200:331 | 2026-05-12T22:35:25.044Z |
| 10 | `j24n.wowpic1.store` | 329 | 329 | 100% | 200:329 | 2026-05-13T06:48:54.529Z |
| 11 | `80pd.wowpic5.store` | 326 | 326 | 100% | 200:326 | 2026-05-13T06:49:39.363Z |
| 12 | `ek10.wowpic1.store` | 323 | 323 | 100% | 200:323 | 2026-05-13T06:48:51.840Z |
| 13 | `jloo.wowpic1.store` | 322 | 322 | 100% | 200:322 | 2026-05-12T22:32:45.720Z |
| 14 | `80pd.wowpic3.store` | 317 | 317 | 100% | 200:317 | 2026-05-12T22:35:33.907Z |
| 15 | `jdpw.wowpic1.store` | 313 | 313 | 100% | 200:313 | 2026-05-13T08:10:34.440Z |
| 16 | `jdpw.wowpic3.store` | 313 | 313 | 100% | 200:313 | 2026-05-13T08:10:35.701Z |
| 17 | `80pd.wowpic1.store` | 311 | 311 | 100% | 200:311 | 2026-05-13T06:48:51.712Z |
| 18 | `80pd.wowpic4.store` | 308 | 308 | 100% | 200:308 | 2026-05-13T06:48:50.575Z |
| 19 | `j24n.wowpic2.store` | 307 | 307 | 100% | 200:307 | 2026-05-12T22:34:10.898Z |
| 20 | `jloo.wowpic4.store` | 306 | 306 | 100% | 200:306 | 2026-05-13T08:10:31.893Z |
| 21 | `jdpw.wowpic5.store` | 306 | 306 | 100% | 200:306 | 2026-05-13T08:10:31.903Z |
| 22 | `ek10.wowpic2.store` | 302 | 302 | 100% | 200:302 | 2026-05-12T22:30:06.430Z |
| 23 | `jdpw.wowpic4.store` | 295 | 295 | 100% | 200:295 | 2026-05-12T22:33:51.426Z |
| 24 | `80pd.wowpic2.store` | 294 | 294 | 100% | 200:294 | 2026-05-12T22:34:30.049Z |
| 25 | `j24n.wowpic3.store` | 282 | 282 | 100% | 200:282 | 2026-05-13T06:48:51.670Z |

## Readout

Top session winners: `j24n.wowpic4.store` (267), `jloo.wowpic5.store` (264), `jloo.wowpic1.store` (263), `j24n.wowpic1.store` (263), `ek10.wowpic5.store` (263), `jloo.wowpic3.store` (263), `ek10.wowpic3.store` (262), `ek10.wowpic4.store` (262).

Slowest median successful hosts: `ek10.wowpic4.store` 346ms, `j24n.wowpic3.store` 340ms, `80pd.wowpic3.store` 340ms, `ek10.wowpic1.store` 339ms, `jloo.wowpic3.store` 338ms, `ek10.wowpic5.store` 337ms, `j24n.wowpic1.store` 335ms, `j24n.wowpic5.store` 334ms.

## Implication For Smart Ordering

- The frontend already consumes candidate order from the backend/provider response; it does not need to own ranking.
- Backend ordering should be adaptive, not hardcoded: persist `totalMs`, status, host, and session id in an observation table.
- A safe ordering policy should exploit recent winners while still reserving exploration slots for non-winners, otherwise the system stops learning.
- The current policy target is 80% exploit, 20% explore, with a 24h half-life and weighted tail score over p90/p95/p98/max.
