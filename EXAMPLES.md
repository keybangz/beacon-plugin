# Beacon — Example Use Cases

Real-world scenarios showing how Beacon improves code search in OpenCode. All examples use a fictional Express e-commerce API (`shopwave`) to keep things concrete.

---

## 1. Finding Code by Intent

**Scenario:** You're debugging a login issue and need to find the authentication flow.

### Without Beacon (grep)

```
> grep -r "auth" src/

src/routes/auth.ts:        // auth routes
src/routes/products.ts:    // requires auth
src/middleware/auth.ts:     // auth middleware
src/config/auth.ts:        // auth config
src/utils/logger.ts:       // auth log prefix
src/tests/auth.test.ts:    // auth tests
src/tests/cart.test.ts:    // mock auth header
src/types/auth.d.ts:       // auth types
src/docs/openapi.yaml:     # auth section
...47 more matches
```

Every file that mentions the word "auth" — configs, tests, comments, docs. You still have to manually figure out where the actual flow lives.

### With Beacon

```
> /search-code where is the authentication flow?

1. src/middleware/auth.ts        — JWT verification + session refresh logic
2. src/routes/auth.ts            — login, logout, register endpoints
3. src/services/tokenService.ts  — token generation + rotation helpers
```

Three ranked results. The middleware that runs on every request is first, the route handlers are second, and the token service that both call into is third. You can start reading immediately.

**Why it matters:** Beacon understands that "authentication flow" means the code that *performs* auth — not every file that happens to contain the string "auth."

---

## 2. Navigating an Unfamiliar Codebase

**Scenario:** You just cloned the repo and need to understand how API errors are handled across the project.

### Without Beacon (grep)

```
> grep -rn "error" src/ | head -20

src/routes/products.ts:42:      } catch (error) {
src/routes/products.ts:43:        next(error);
src/routes/cart.ts:18:           } catch (error) {
src/routes/cart.ts:19:           next(error);
src/utils/logger.ts:7:          level: 'error',
src/utils/logger.ts:22:         logger.error(msg);
src/config/db.ts:31:            console.error('DB connection failed');
src/tests/products.test.ts:88:  expect(res.body.error).toBe('Not found');
src/tests/cart.test.ts:44:      expect(res.body.error).toBeDefined();
...hundreds more
```

The word "error" appears in every file. You get a wall of `catch (error) { next(error) }` blocks, log calls, and test assertions — nothing that explains the *system*.

### With Beacon

```
> /search-code how do API errors get handled?

1. src/middleware/errorHandler.ts  — central Express error middleware, maps exceptions to HTTP status codes
2. src/errors/AppError.ts         — custom error base class with status, code, and isOperational flag
3. src/errors/NotFoundError.ts    — 404 subclass thrown by service layer
4. src/utils/asyncWrap.ts         — async route wrapper that forwards rejected promises to error middleware
```

Beacon returns the four files that *define* the error-handling architecture: the middleware, the error class hierarchy, and the async wrapper. You now understand the pattern without reading a single route handler.

**Why it matters:** For "how does X work?" questions, Beacon surfaces the *structural* code — not every *usage* of X scattered across the project.

---

## 3. Tracking Down a Specific Function

**Scenario:** A stack trace mentions `validateSessionToken`. You need to find the definition and understand where it's called.

### Without Beacon (grep)

```
> grep -rn "validateSessionToken" src/

src/middleware/auth.ts:14:    const payload = validateSessionToken(token);
src/services/tokenService.ts:47:  export function validateSessionToken(token: string): TokenPayload {
src/services/tokenService.ts:89:  // validateSessionToken also checks expiry
src/tests/tokenService.test.ts:23:  describe('validateSessionToken', () => {
src/tests/auth.test.ts:8:   jest.mock('../services/tokenService', () => ({ validateSessionToken: jest.fn() }));
```

Five matches, unranked. The definition is on line 3. You have to visually scan every result to find it.

### With Beacon

```
> /search-code validateSessionToken

1. src/services/tokenService.ts:47  — function definition: validates JWT, checks expiry + signature
2. src/middleware/auth.ts:14        — primary call site: runs on every authenticated request
3. src/tests/tokenService.test.ts   — unit tests for the function
```

The definition is ranked first thanks to Beacon's identifier boost. The most important call site is second. Tests are third for context.

**Why it matters:** Beacon's identifier extraction recognizes `validateSessionToken` as a function name and boosts the chunk that *defines* it, so you don't have to scan through usages to find the source.

---

## 4. Zero-Maintenance Search That Stays Current

**Scenario:** You just added a new `RateLimiter` middleware and want to confirm it's searchable.

### Without Beacon (external tools)

With a standalone code search tool, you'd need to:
1. Edit the file
2. Manually re-run the indexer
3. Wait for re-indexing to complete
4. Then search

If you forget step 2, the new code doesn't exist in the index and search returns stale results.

### With Beacon

```
# You write a new file
> Edit src/middleware/rateLimiter.ts

# Beacon's PostToolUse hook re-embeds the file automatically (~200ms)

# Immediately searchable
> /search-code rate limiting middleware

1. src/middleware/rateLimiter.ts  — sliding window rate limiter, per-IP with Redis backing
```

No manual step. Beacon's hooks detect the edit, re-embed the changed file, and update the index — all before your next search.

**Why it matters:** Beacon hooks into Claude Code's tool lifecycle. Every file changes are automatically re-indexed.
