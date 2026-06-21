# web_search

## Failure modes

- Tool returned "Tool web_search not found" — calling `search_tool_bm25` with query "web search" activates it. Never stop at "not found"; always try `search_tool_bm25` first.
