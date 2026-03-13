# AI Models Using Beacon - Live Usage Examples

This document shows how AI assistants (like Claude or other LLMs) actually use the Beacon search plugin in real OpenCode sessions, without needing to write test scripts.

## How AI Discovers and Uses Beacon

### 1. System Message Integration

When an AI session starts with Beacon enabled, it receives context indicating semantic search is available:

```
System Message:
─────────────────────────────────────────
Available Tools: search, bash, file_read, reindex, index, status, config, ...

## Beacon Index Status
The codebase has been indexed for semantic search. 
The Beacon search capability is available via the 'search' tool.
Current index: 2,543 chunks across 247 files
────────────────────────────────────────
```

The AI now knows:
- ✓ Semantic search is available
- ✓ It can call the `search` tool without explicit initialization
- ✓ The index status is already up-to-date

### 2. Automatic Tool Selection

When asked code questions, the AI automatically decides to use `search`:

**User**: "Show me how the API handles authentication"

**AI's Decision Process**:
```
1. User is asking about code patterns
2. I need to find relevant implementation
3. I can use 'search' tool for semantic lookup
4. Query: "API authentication" or "authentication handler"
5. Execute search to find relevant code
```

**What Happens**:
```bash
# AI executes this command automatically
opencode search "API authentication handler"

# Returns:
# Results (30 chunks, showing top 3):
# 
# 1. src/auth/middleware.ts:45 (score: 0.92)
#    ✓ High relevance - semantic match
#    
# 2. src/api/routes.ts:12 (score: 0.87)
#    ✓ API-related, authentication context
#    
# 3. src/config/auth.ts:8 (score: 0.84)
#    ✓ Configuration related
```

AI then references these results in its response with specific file paths and line numbers.

## Real-World Workflow Examples

### Example 1: Bug Investigation

```
User: "There's a bug in the authentication flow. Help me debug it."

AI Workflow:
──────────────

Step 1: Understand the codebase
  AI: opencode search "authentication flow"
  Result: 5 chunks about auth implementation
  
Step 2: Look for error handling
  AI: opencode search "auth error handling"
  Result: 3 chunks about error cases
  
Step 3: Find related validation
  AI: opencode search "validate credentials token"
  Result: 8 chunks with validation logic
  
Step 4: Analyze and report
  AI: "Based on the codebase, the bug appears to be in 
       src/auth/validate.ts:67 where expired tokens aren't 
       properly handled. The error checking logic needs 
       modification..."
```

### Example 2: Feature Implementation

```
User: "Add rate limiting to the API. Follow existing patterns."

AI Workflow:
──────────────

Step 1: Find existing patterns
  AI: opencode search "rate limiting throttle request"
  Result: 2 chunks showing rate limit patterns
  
Step 2: Find middleware patterns
  AI: opencode search "middleware request handler express"
  Result: 7 chunks showing middleware structure
  
Step 3: Locate configuration
  AI: opencode search "config settings environment"
  Result: 5 chunks showing how configs are loaded
  
Step 4: Generate implementation
  AI: "I found the rate limiting pattern in src/middleware/rate-limit.ts:34.
       I'll follow this approach. The config is loaded in src/config/index.ts:12.
       Here's the implementation..."
```

### Example 3: Understanding Code Flow

```
User: "Explain the request flow from API entry to database"

AI Workflow:
──────────────

Step 1: Find API entry point
  AI: opencode search "API endpoint route handler"
  Result: 15 chunks, AI uses top results
  
Step 2: Find middleware chain
  AI: opencode search "middleware chain express validation"
  Result: 8 chunks showing middleware flow
  
Step 3: Find database layer
  AI: opencode search "database query execute"
  Result: 12 chunks showing DB operations
  
Step 4: Find error handling
  AI: opencode search "error handling response catch"
  Result: 10 chunks about error responses
  
Step 5: Generate flow diagram
  AI: "Here's the complete flow:
       1. Request → API route (src/api/routes.ts:45)
       2. Validation middleware (src/middleware/validate.ts:12)
       3. Auth check (src/auth/middleware.ts:67)
       4. Business logic (src/services/order.ts:34)
       5. Database query (src/db/query.ts:89)
       6. Response (src/api/routes.ts:78)
       
       Each step with file references and line numbers..."
```

## Search Strategies AI Uses

### Strategy 1: Semantic Search (40% weight)

```
Query: "How do we handle timeout errors?"
AI Thinking: "I need to find code about timeout handling"
Search: opencode search "timeout error handling"
Result: ~0.8+ relevance because embeddings understand:
  - Semantic similarity (not just keyword matching)
  - Intent behind the query
  - Context of timeout in error handling
```

### Strategy 2: Keyword + Identifier Boosting (30% + 30% weight)

```
Query: "Find getUser function"
AI Thinking: "This is a function name - identifier boosting should help"
Search: opencode search "getUser"
Result: 
  - Ranks function names higher (1.5x multiplier)
  - BM25 keyword search finds exact name
  - Semantic understanding finds similar patterns
```

### Strategy 3: Multi-Step Search

```
User: "How does the payment processing work end-to-end?"

AI's Multi-Query Approach:
  1. opencode search "payment processing"
  2. opencode search "stripe integration payment"
  3. opencode search "transaction database"
  4. opencode search "payment error handling"
  5. opencode search "webhook payment confirmation"

AI then: Synthesizes results into coherent explanation
```

## Visual Example: Search in Action

### Query Breakdown

```
User: "Show me validation functions"

AI Execution:
┌─────────────────────────────────────────────────────┐
│ opencode search "validation function validate"      │
└─────────────────────────────────────────────────────┘
                    ↓
        ┌───────────┬──────────┬──────────┐
        ↓           ↓          ↓          ↓
    Vector     BM25 Full-Text  Identifier  Path
    Search     Search          Boost       Filter
        ↓           ↓          ↓          ↓
    ┌─────────────────────────────────────────┐
    │ Rank Results by Relevance (RRF)         │
    └─────────────────────────────────────────┘
        ↓
    ┌─────────────────────────────────────────┐
    │ Apply Penalties & Filtering              │
    │ - Score >= 0.35 (threshold)             │
    │ - Return top 5 results                   │
    └─────────────────────────────────────────┘
        ↓
    ┌─────────────────────────────────────────┐
    │ Return to AI:                           │
    │ 1. src/utils/validate.ts:12 (0.94)      │
    │ 2. src/forms/validation.ts:45 (0.91)    │
    │ 3. src/api/validate.ts:8 (0.87)         │
    │ 4. src/schema/validators.ts:67 (0.85)   │
    │ 5. src/middleware/validate.ts:23 (0.82) │
    └─────────────────────────────────────────┘
```

## What Makes This Different from grep/find

| Aspect | grep/find | Beacon |
|--------|-----------|--------|
| **Search Type** | Keyword matching | Semantic + keyword |
| **Understanding** | Literal text | Meaning & context |
| **Finding** | Exact matches | Related patterns |
| **Use Case** | "Find `function foo`" | "How is validation done?" |
| **Example** | 0 results for "check values" even if validate() exists | Finds validate() because it understands the meaning |

### Real Example

```bash
# Using grep - AI can't find this
$ grep "check user input"
# No results (even though validation exists)

# Using Beacon - AI finds relevant code
$ opencode search "check user input"
# Returns:
# - src/validators/input.ts (semantic match)
# - src/middleware/validate.ts (pattern match)
# - src/forms/validation.ts (related concept)
```

## AI Session Transcript Example

Here's a real-looking session showing Beacon in use:

```
User: "I need to add a new API endpoint for fetching user preferences.
       Make it consistent with existing endpoints."

OpenCode Session:
─────────────────

AI: I'll help you add the user preferences endpoint. 
    Let me first check the existing API patterns.

> opencode search "API endpoint route handler GET"
Results: 12 chunks
✓ Found existing endpoint patterns

AI: Now let me look at how preference data is handled:

> opencode search "user preferences settings"
Results: 8 chunks  
✓ Found preference handling pattern in src/services/preferences.ts:34

AI: Let me check the database schema:

> opencode search "preference schema column type"
Results: 5 chunks
✓ Database schema in src/db/migrations/preferences.sql:12

AI: Here's the implementation following your existing patterns:

```typescript
// src/api/endpoints/user.ts:128
router.get('/user/preferences', authenticateUser, async (req, res) => {
  const prefs = await PreferenceService.getUserPreferences(req.user.id);
  res.json(prefs);
});
```

This follows the same pattern as your other endpoints 
(see src/api/endpoints/user.ts:45 for reference). 
The database call matches your existing structure 
(src/services/preferences.ts:34).

User: "Looks good. What about error handling?"

AI: Let me check your error handling patterns:

> opencode search "error handling try catch response"
Results: 15 chunks
✓ Found standardized error handling

AI: Adding error handling following your pattern 
(from src/api/middleware/errorHandler.ts:12):

```typescript
router.get('/user/preferences', authenticateUser, async (req, res) => {
  try {
    const prefs = await PreferenceService.getUserPreferences(req.user.id);
    res.json(prefs);
  } catch (error) {
    logger.error('Failed to fetch preferences', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});
```

User: "Perfect! Deploy it."

AI: Your endpoint is now ready, with all patterns matching 
    the rest of your codebase structure.
─────────────────
```

## Performance: Search Speed

Beacon searches are fast because of hybrid indexing:

```
Search: "authentication" 
Results: 28 files checked, 543 chunks indexed

Timeline:
─────────
0ms  - Query received
2ms  - Generate embedding (nomic-embed-text)
5ms  - Vector similarity search (384-dim vectors)
2ms  - BM25 full-text search  
3ms  - Identifier boosting lookup
2ms  - RRF ranking & filtering
1ms  - Return top results
─────────
15ms Total (nearly instant, feels real-time)
```

## Summary: AI Using Beacon

**Without explicitly calling search:**
- User asks a code question
- AI automatically recognizes "search is available"
- AI executes semantic search transparently
- Results appear in AI's reasoning and response
- User gets answers with specific file references

**What Makes It Natural:**
1. No test scripts needed
2. AI integration is automatic
3. Results are contextually relevant
4. File references are precise
5. Faster than manual searching

**Try It:**
```bash
opencode
# Then ask the AI any question about your code
# Watch it automatically use Beacon search
```

The search tool becomes invisible - the AI just gets better answers, and you get better code understanding.
