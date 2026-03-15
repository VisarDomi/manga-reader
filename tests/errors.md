# Errors

Tests assert business rules. If a test fails, the code is wrong — not the test.
The only exception is when a business rule changes.

---

### Loading Watchdog

**T-AX-1: Watchdog resets after 15 seconds**
Tests rule AX.
If `isLoading` stays true for 15+ seconds, the watchdog force-resets to idle, logs `console.error`, and shows "Something went wrong — pull down to refresh."

```contract
constant: WATCHDOG_TIMEOUT_MS
assert: value === 15_000
```

### Pagination Errors

**T-AY-1: Transient errors roll back page and allow retry**
Tests rule AY.
On transient errors: page counter rolls back, hasMore stays true, toast shows "Slow connection, scroll to retry."

```contract
given: error with kind and optional status
returns: whether the error is transient
assert: returns true for { kind: 'upstream', status: 408 }
assert: returns true for { kind: 'upstream', status: 429 }
assert: returns true for { kind: 'upstream', status: 500 }
assert: returns true for { kind: 'upstream', status: 502 }
assert: returns true for { kind: 'upstream', status: 503 }
assert: returns true for { kind: 'upstream', status: 504 }
assert: returns true for { kind: 'timeout' }
assert: returns true for { kind: 'network' }
```

**T-AY-2: Permanent errors stop pagination**
Tests rule AY.
On permanent errors: hasMore set to false, pagination stops, toast shows "Failed to load more results."

```contract
given: error with kind and optional status
returns: whether the error is transient
assert: returns false for { kind: 'upstream', status: 400 }
assert: returns false for { kind: 'upstream', status: 403 }
assert: returns false for { kind: 'upstream', status: 404 }
assert: returns false for { kind: 'parse' }
assert: returns false for { kind: 'cloudflare' } (safe fallback — cloudflare should never reach pagination per AW)
```

**T-AY-3: All errors logged with full context**
Tests rule AY.
Errors are logged with URL, status, response body snippet, and timestamp.

```contract
type: ErrorLogEntry = { url: string; kind: string; status?: number; body?: string; timestamp: number }
given: error (kind + optional status), url, optional body
returns: ErrorLogEntry
case 1: input: { kind: 'upstream', status: 404 }, 'https://api.com/search', '{"error":"not found"}'
  assert: returns { url: 'https://api.com/search', kind: 'upstream', status: 404, body: '{"error":"not found"}', timestamp: <number> }
case 2: input: { kind: 'timeout' }, 'https://api.com/search'
  assert: returns { url: 'https://api.com/search', kind: 'timeout', timestamp: <number> }
case 3: input: { kind: 'network' }, 'https://api.com/chapters'
  assert: returns { url: 'https://api.com/chapters', kind: 'network', timestamp: <number> }
```

### Error Types

**T-AZ-1: Errors are a tagged union of 5 kinds**
Tests rule AZ.
All errors are classified into 5 kinds: `upstream` (HTTP, carries status), `timeout`, `network` (no connection), `cloudflare` (Cloudflare block), or `parse` (response received but unparseable). Each kind maps to a user-facing message. No error information is lost in classification. UI pattern-matches on `kind`.

```contract
function: loadErrorMessage(err: LoadError) → string
case 1: { kind: 'upstream', status: 404 } → contains 'Server error' and '404'
case 2: { kind: 'timeout' }              → contains 'timed out'
case 3: { kind: 'network' }              → contains 'Network error'
case 4: { kind: 'cloudflare' }           → contains 'Cloudflare'

given: raw error from fetch boundary
returns: classified error with kind
case 1: HTTP 404 error         → { kind: 'upstream', status: 404 }
case 2: timeout error          → { kind: 'timeout' }
case 3: network error          → { kind: 'network' }
case 4: cloudflare error       → { kind: 'cloudflare' }
case 5: parse error            → { kind: 'network' } (catch-all)
case 6: unknown error          → { kind: 'network' } (catch-all)
```

### Error Display

**T-BB-1: Initial failure shows persistent error with retry**
Tests rule BB.
When the initial search or manga open fails, the app shows a persistent error state with error kind and "Tap to retry". No disappearing toast for an empty screen.

**T-BB-2: Pagination failure shows toast**
Tests rule BB.
When pagination fails (results already on screen), a transient toast is shown.

```contract
class: SearchState
case 1 (transient — timeout):
  setup: initial search succeeded with results + hasMore=true
  action: loadNextPage(), api rejects with timeout error
  assert: currentPage rolled back to 1
  assert: hasMore still true (can retry)
  assert: toast contains "Slow connection, scroll to retry"
  assert: error remains null (not persistent — results already on screen)
case 2 (permanent — 404):
  setup: initial search succeeded with results + hasMore=true
  action: loadNextPage(), api rejects with HTTP 404 error
  assert: hasMore set to false (pagination stops)
  assert: toast contains "Failed to load more results"
  assert: error remains null
case 3 (transient HTTP — 429):
  setup: initial search succeeded with results + hasMore=true
  action: loadNextPage(), api rejects with HTTP 429 error
  assert: currentPage rolled back to 1, hasMore still true
  assert: toast contains "Slow connection, scroll to retry"
```

### Chapter Image Retry

**T-BC-1: Transient errors retry once after 1 second**
Tests rule BC.
On transient image fetch errors (408, 429, 5xx, network, timeout), one automatic retry after 1s delay. If retry fails, persistent error state with retry.

### Provider Boot Failures

**T-BD-1: First search failure shows persistent error**
Tests rule BD.
If the first search on cold start fails (no cache, no session), persistent error state with error kind and "Tap to retry".

```contract
class: SearchState
case 1 (network):
  setup: no prior results, no session
  action: search('naruto'), api rejects with network error
  assert: error.kind === 'network'
  assert: results === [], hasMore === false, isLoading === false
case 2 (timeout):
  setup: no prior results, no session
  action: search('naruto'), api rejects with timeout error
  assert: error.kind === 'timeout'
case 3 (HTTP 500):
  setup: no prior results, no session
  action: search('naruto'), api rejects with HTTP 500 error
  assert: error.kind === 'upstream'
case 4 (retry clears):
  setup: error state from case 1
  action: search('naruto'), api resolves with results
  assert: error === null
```

**T-BD-2: Corrupted provider bundle shows "Provider unavailable"**
Tests rule BD.
If loading the provider's JS bundle from the database fails, "Provider unavailable" with retry.

**T-BD-3: No provider installed shows empty state**
Tests rule BD + BF.
If no provider is installed, show empty state with prompt to add a provider.
