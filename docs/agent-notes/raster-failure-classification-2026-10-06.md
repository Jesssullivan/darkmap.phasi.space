# Raster upstream failure evidence candidate

Authority: root narrow source-only authorization; R-HOOK-CONVERGENCE-20261004,
R-N13; existing TIN-4177 reliability/data lane. Original Darkmap data owner.
Owned isolated carrier from frozen807520b; served2da image remains unchanged.

Existing one approved public diagnostic at22:47:58UTC returned403 JSON with
allowlisted message matching `upstream raster error`. Source route112-116
forwards RasterError.status; RasterClient61-66 creates that HTTP status only
from a failed upstream fetch response. No local auth/consent gate. This proves
wrapped upstream denial, not absent science data globally or invalid API keys.
No further provider request or raster download was made for this patch.

Candidate change: bound original unauthenticated WMS fetch with8s AbortSignal
deadline (also remains attached during response-body consumption); classify
HTTP/network/timeout/body-read failures. Route retains failed status semantics,
uses504 for deadline,502 for transport/body failures, and returns only closed
code/stage/reason/upstreamStatus fields plus the existing generic message.
Response is no-store; no upstream URL/cause/private metadata or invented raster.
Existing stale-cache fallback precedes this failure boundary and is unchanged.
No provider binding, scientific units/year/masks, credentials, UI or infra edits.

Small fixtures added: actual AbortSignal supplied; timeout versus network;
upstream403 classification; route closed-schema403/no-store/no address leakage.
git diff --check PASS. Fixtures are prepared but NOT executed: this clean local
carrier has no installed dependency graph; no install/build/remote producer
was authorized. This is NOT a live fix or full type/build qualification.
Next step: independent source review and admitted exact small raster/API test
targets before publication; retain served807/2da and prior rollback meanwhile.
