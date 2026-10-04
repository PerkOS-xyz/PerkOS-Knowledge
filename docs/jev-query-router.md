# Jev query-class router

Optional router for `POST /skill/query`.

## Enable

```bash
KNOWLEDGE_JEV_ROUTER=1
TYPESAFE_API_KEY=...
```

## Classes

| Class | Effect |
|---|---|
| lookup | small limit, no auto research request |
| brief | hybrid-leaning brief retrieval |
| deep | enterprise confidence floor, more results |
| custom-research | allow auto `createKnowledgeRequest` |

Response includes `routing: { queryClass, reason, confidence, ... }`.

Fail-open: if Jev is down, heuristic class is used when router is enabled; if router is off, legacy behavior.

Override: body `queryClass`.
