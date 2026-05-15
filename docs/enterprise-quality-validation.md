# Enterprise Quality Validation

PerkOS Knowledge is intended to serve paid agent/consumer queries, so every answer must expose provenance and confidence instead of presenting raw agent research as fact.

## Quality gates

1. **Evidence required by default**
   - `POST /api/ingest/research` rejects new submissions without `evidence[]` unless `KNOWLEDGE_REQUIRE_EVIDENCE=0` is set for a legacy migration.
   - Evidence can be URLs, API/RPC/explorer references, files, hashes, datasets, or other structured proof.

2. **Provenance required**
   - Provider submissions keep `contributor_agent_id`, organization scope, content hash, publication status, and sanitization status.
   - Unknown/non-onboarded provider writes are rejected by the provider submission checks.

3. **Confidence percentage**
   - New and backfilled items receive:
     - `quality_score` / `confidence_percent` from 0-100
     - `trust_tier`: `high`, `medium`, `low`, or `untrusted`
     - `quality_reasons[]` explaining missing/weak signals

4. **Independent validation workflow**
   - Admin/validator endpoint: `GET/POST /api/admin/quality`
   - `GET` lists quality stats and items by validation status.
   - `POST` assesses selected IDs or backfills a batch; approved items can become `validated` only when the score is >= 70.
   - Every assessment writes `contributor_quality_events` for audit/reputation.

5. **Answer-time disclosure**
   - `/skill/query`, `/knowledge/search`, and `/knowledge/brief/:agent` return `confidencePercent`, `trustTier`, and `qualityReasons` per item.
   - `/skill/query` defaults to `qualityMode=enterprise`, requiring `minConfidence=45` unless overridden.
   - Strict buyers can use `qualityMode=validated_only` or `requireValidated=true`.

## Query modes

- Default: `qualityMode=enterprise`, `minConfidence=45`
- Strict: `qualityMode=validated_only` or `requireValidated=true`
- Custom: `minConfidence=<0-100>`

## Next enterprise steps

- Add source fetch/verification workers for URL/RPC/explorer evidence.
- Add provider reputation derived from `contributor_quality_events`.
- Make paid tiers enforce stricter defaults: paid responses should prefer `validated` and include citations/evidence snippets.
- Build an admin UI over `/api/admin/quality`.
