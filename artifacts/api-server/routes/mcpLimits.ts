/**
 * The most array elements and object members one tools/call may carry, on every
 * MCP server here. Each tool takes a few fields and lists of a few dozen items
 * at most; GHSA-46jr-4wx8-v453 is a payload of millions that exhausts the heap
 * while it is validated. The body itself is already held to express.json's 100 KB.
 */
export const MCP_TOOL_INPUT_ELEMENTS_V1 = 1_000;
