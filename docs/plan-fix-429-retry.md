# Plan: Fix infinite 429 retry loop

**Priority:** P0 — correctness bug  
**File:** `background.js` only  
**Estimated changes:** ~10 lines

---

## Problem

`apiFetch()` (background.js line 150–153) handles HTTP 429 by sleeping 5 seconds and
recursively calling itself with no attempt counter:

```js
if (response.status === 429) {
  await sleep(5000);
  return apiFetch(endpoint, options);  // ← unbounded recursion
}
```

If the server keeps returning 429 (e.g. during a long discover run), this recurses
indefinitely, eventually causing a stack overflow or locking the service worker.

---

## Fix

Add an `attempt` parameter to `apiFetch` (default `0`). When a 429 is received,
increment attempt and recurse only up to `MAX_RETRIES` times. On the final attempt,
throw a descriptive error so the caller can surface it.

---

## Step-by-step

### Step 1 — Change the function signature

Find this line (background.js ~line 102):
```js
async function apiFetch(endpoint, options = ) {
```

Replace with:
```js
async function apiFetch(endpoint, options = {}, attempt = 0) {
```

### Step 2 — Replace the 429 handler block

Find this block (background.js ~lines 150–153):
```js
    if (response.status === 429) {
      await sleep(5000);
      return apiFetch(endpoint, options);
    }
```

Replace with:
```js
    if (response.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`API rate limited after ${MAX_RETRIES} retries — try again later.`);
      }
      const backoff = 5000 * Math.pow(2, attempt);   // 5s, 10s, 20s
      debugLog(`429 rate limit, retrying in ${backoff}ms (attempt ${attempt + 1})`);
      await sleep(backoff);
      return apiFetch(endpoint, options, attempt + 1);
    }
```

### Step 3 — Verify no other callers pass a third argument

Grep the file to confirm `apiFetch` is only called in two places (inside itself and from
`discoverClips`). Neither currently passes a third argument, so this change is backwards-
compatible.

```bash
grep -n "apiFetch(" background.js
```

Expected output: lines inside `discoverClips` body and inside `apiFetch` itself. No other
callers should exist.

---

## Verification

1. Load the unpacked extension in Chrome.
2. In the background service worker DevTools console, temporarily override the endpoint
   to return 429 (or use a proxy). Confirm that after 3 retries the error surfaces as
   `"API rate limited after 3 retries"` in the popup status bar — not a silent hang.
3. Confirm a normal discover run still works end-to-end.
