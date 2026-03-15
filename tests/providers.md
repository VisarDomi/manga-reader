# Providers

Tests assert business rules. If a test fails, the code is wrong — not the test.
The only exception is when a business rule changes.

---

### Dynamic Timeout

**T-BA-1: Timeout is 3x rolling average of last 100 responses**
Tests rule BA.
The timeout per provider is 3x the rolling average of the last 100 response times, persisted in the database.

**T-BA-2: First-use default is 10 seconds**
Tests rule BA.
On first use of a provider (no samples), the timeout is 10 seconds.

**T-BA-3: Each provider has independent timeout profile**
Tests rule BA.
Switching providers loads that provider's response history. Profiles don't cross-pollinate.

**T-BA-4: Server proxy has no product-level timeout**
Tests rule BA.
The server proxy defers to the app's dynamic timeout — it does not enforce its own timeout on proxied requests.

### Database Storage Bounds

**T-BE-1: Progress is one entry per manga**
Tests rule BE.
Progress store has one entry per `repoUrl:providerId:mangaId` (~50 bytes each).

**T-BE-2: Response times are fixed window of 100**
Tests rule BE.
Response times per provider are capped at 100 samples.

**T-BE-3: No images or large blobs in the database**
Tests rule BE.
The reader uses in-memory cached image data — no images stored in the database.

### First Launch

**T-BF-1: Empty state with "Add a provider" button**
Tests rule BF.
On first launch with no provider, list view shows "Add a provider to get started" with a button that pushes repos view. Search, filters, and provider-dependent features are disabled.

### Repository & Provider Management

**T-BG-1: Multiple repos listed together**
Tests rule BG.
Multiple repos can be added and all their providers are listed together.

**T-BG-2: Provider identity scoped by repo**
Tests rule BG.
A provider's unique key is `repoUrl:providerId`. Same ID from different repos are separate providers.

**T-BG-3: Install makes provider active and fires search**
Tests rule BG.
Installing a provider makes it active and fires an empty-query search. Swiping back reveals results.

**T-BG-4: Uninstall confirmation and cleanup**
Tests rule BG.
Uninstalling shows confirmation. On confirm, removes JS bundle and all associated data (progress, favorites, filters, group blacklist, response times). Falls back to another provider or empty state.

**T-BG-5: Tap installed provider switches to it**
Tests rule BG.
Tapping an installed provider (not the - button) switches to it and reloads the list view with that provider's context.

**T-BG-6: Auto-update on cold start and repos view entry**
Tests rule BG.
The app checks for newer provider versions on cold start (background) and when entering repos view. Updated bundles download silently and take effect on next provider load. Badge shown on success, toast on failure.

### Data Isolation

**T-BH-1: All data scoped by repoUrl:providerId**
Tests rule BH.
Database progress, database favorites, persisted filters, persisted group blacklist, database response times, and session snapshot activeProviderKey are all scoped by provider key.

**T-BH-2: Switching providers loads that provider's data**
Tests rule BH.
Switching providers loads the target provider's data context. The previous provider's data is untouched.

### Provider Loading

**T-BI-1: Loads activeProviderKey from session snapshot**
Tests rule BI.
On cold start, reads activeProviderKey from session snapshot and loads that provider's bundle from the database.

**T-BI-2: Falls back to first installed provider**
Tests rule BI.
If no activeProviderKey but providers are installed, activates the first installed provider.

### Cloudflare

**T-AW-1: Cloudflare gate drops new app-level requests**
Tests rule AW.
While Cloudflare solving is in progress, new user-initiated searches, manga opens, and chapter opens are dropped — not queued.

**T-AW-2: Provider in-flight operations can wait and retry**
Tests rule AW.
The provider's own in-flight operations (e.g. parallel chapter list fetches) wait for solving to complete and retry.

**T-AW-3: Callers retry if still relevant after solve**
Tests rule AW.
After solving completes: search fires with current query+filters, manga view re-fetches if still mounted, reader's observer re-fires for visible images. If caller navigated away, nothing retries.

**T-AW-4: Toast only on foreground block**
Tests rule AW.
Cloudflare solving is silent unless the user's foreground action is blocked.
