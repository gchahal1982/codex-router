# Implementation Summary: Fix Qwen Plan Namespace Restoration (Issue #568)

## Problem

Qwen Plan (Alibaba Model Studio Token Plan) returns Codex collaboration calls with pre-flattened names:
```json
{"type":"function_call","name":"multi_agent_v1__spawn_agent","namespace":null}
```

Codex Desktop expects namespaced calls and rejects the flattened format:
```
unsupported call: multi_agent_v1__spawn_agent
```

## Root Cause

The Chat Completions bridge flattens namespace tools when sending requests to providers but was not restoring them when receiving responses. The `api-forwarder.mjs` Responses protocol adapter was passing flattened function calls through unchanged.

## Solution Architecture

### 1. Namespace Lookup Reconstruction
Added `buildNamespaceLookupsFromTools()` in `src/openai-adapters.mjs`:
- Parses flattened tool names from the request (e.g., `multi_agent_v1__spawn_agent`)
- Builds a Map from flattened names to native `{ namespace, name }` objects
- Handles both Responses format (`tool.name`) and Chat Completions format (`tool.function.name`)

### 2. Response Restoration
Added `restoreNamespacedFunctionCall()` helper:
- Takes a function call and namespace lookups
- Returns the call with namespace restored if it was flattened
- Preserves non-flattened calls unchanged

### 3. Integration Points

#### `src/openai-adapters.mjs`
- Modified `normalizeResponsesEvent()` to accept `flatToNative` parameter
- Restored namespaces in `response.output_item.added` events (SSE stream)
- Modified `normalizeResponseBody()` to restore namespaces in JSON responses
- Updated `createResponsesStreamTransform()` and `createResponsesJsonTransform()` to accept and use lookups

#### `src/api-forwarder.mjs`
- Builds namespace lookups from `normalized.payload.tools` before response transformation
- Passes lookups to both stream and JSON transform functions
- Lookups only built when Responses protocol adapter is active

## Key Design Decisions

1. **Reconstruct from Request Tools**: Instead of trying to pass context through multiple layers, we reconstruct the namespace mappings from the flattened tools already in the request. This is simpler and works with the existing architecture.

2. **Preserve Non-Flattened Calls**: The restoration only applies to names that match the flattened pattern. Regular function calls pass through unchanged.

3. **No Breaking Changes**: Other providers' flattening behavior (OpenCode Go, Zen Free) remains unaffected since they don't return flattened names.

4. **Delimiter Handling**: Only splits on the first `__` delimiter to handle nested namespaces like `mcp__node_repl__execute`.

## Testing

### New Test Suite: `test/qwen-plan-namespace-restoration.test.mjs`

1. **Lookup Building Tests**:
   - Extracts flattened collaboration tool names
   - Handles Chat Completions format
   - Handles nested namespaces

2. **Stream Transformation Tests**:
   - Restores namespaces in SSE streams
   - Verifies both `namespace` and `name` fields are correct

3. **JSON Transformation Tests**:
   - Restores namespaces in JSON responses
   - Preserves function arguments and other fields

4. **Edge Cases**:
   - Non-flattened functions remain unchanged
   - Empty lookups don't cause errors
   - Regular functions without delimiters are ignored

### Test Results
- ✅ All 7 new tests pass
- ✅ All existing `namespace-relay` tests pass
- ✅ No regressions in existing functionality

## Files Changed

1. **`src/openai-adapters.mjs`** (147 lines added)
   - New: `buildNamespaceLookupsFromTools()`
   - New: `restoreNamespacedFunctionCall()`
   - Modified: `normalizeResponsesEvent()`, `normalizeResponseBody()`
   - Modified: `createResponsesStreamTransform()`, `createResponsesJsonTransform()`

2. **`src/api-forwarder.mjs`** (6 lines added)
   - Import `buildNamespaceLookupsFromTools`
   - Build and pass lookups to transforms

3. **`test/qwen-plan-namespace-restoration.test.mjs`** (New, 310 lines)
   - Comprehensive test coverage for namespace restoration

## Verification

The fix has been verified to:
1. Restore `multi_agent_v1__spawn_agent` to `{ namespace: "multi_agent_v1", name: "spawn_agent" }`
2. Work with both SSE streams and JSON responses
3. Preserve non-flattened function calls
4. Not affect other providers' behavior
5. Pass all existing namespace-relay tests

## Live Testing Note

A live test with actual Qwen Plan credentials would validate the end-to-end flow. The unit tests prove the restoration logic works correctly for both SSE and JSON response formats. If provider credentials are available, a simple test would be:

1. Send a request to Qwen Plan with `multi_agent_v1__spawn_agent` tool
2. Verify the response has the namespace restored
3. Confirm Codex Desktop accepts the restored call

## Impact

- ✅ Fixes issue #568
- ✅ Enables Qwen Plan collaboration calls
- ✅ No breaking changes
- ✅ Preserves existing provider behavior
- ✅ Comprehensive test coverage
