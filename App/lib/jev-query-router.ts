/**
 * Jev query-class router for PerkOS Knowledge /skill/query.
 *
 * Mirrors PerkOS-LLM TypeSafe routing, but chooses a retrieval/request policy
 * class instead of an LLM wire model. Fail-open: if Jev is off/unavailable,
 * return null and keep current query behavior.
 */

export const QUERY_CLASSES = [
  "lookup",
  "brief",
  "deep",
  "custom-research",
] as const;

export type QueryClass = (typeof QUERY_CLASSES)[number];

export type QueryRoutePolicy = {
  queryClass: QueryClass;
  limit: number;
  minCoverageResults: number;
  createRequestOnMiss: boolean;
  qualityMode: "standard" | "enterprise" | "validated_only";
  requireValidated: boolean;
  minConfidence: number;
  priority: "low" | "normal" | "high";
  forceHybrid: boolean;
  confidence: number | null;
  routeReason: string;
};

type AskResult = {
  queryClass: QueryClass | null;
  confidence: number | null;
};

function env(name: string): string {
  return String((process as NodeJS.Process)["env"][name] || "");
}

function routerEnabled(): boolean {
  if (env("KNOWLEDGE_JEV_ROUTER") === "0") return false;
  // default on when key present; explicit 1 forces attempt
  return env("KNOWLEDGE_JEV_ROUTER") === "1" || Boolean(env("TYPESAFE_API_KEY"));
}

export function policyForClass(
  queryClass: QueryClass,
  confidence: number | null,
  requestedLimit: number,
): QueryRoutePolicy {
  const base = Math.max(1, Math.min(requestedLimit || 8, 25));
  switch (queryClass) {
    case "lookup":
      return {
        queryClass,
        limit: Math.min(base, 5),
        minCoverageResults: 1,
        createRequestOnMiss: false,
        qualityMode: "standard",
        requireValidated: false,
        minConfidence: 0,
        priority: "low",
        forceHybrid: false,
        confidence,
        routeReason: "jev:lookup",
      };
    case "brief":
      return {
        queryClass,
        limit: Math.min(Math.max(base, 6), 10),
        minCoverageResults: 2,
        createRequestOnMiss: false,
        qualityMode: "standard",
        requireValidated: false,
        minConfidence: 0,
        priority: "normal",
        forceHybrid: true,
        confidence,
        routeReason: "jev:brief",
      };
    case "deep":
      return {
        queryClass,
        limit: Math.min(Math.max(base, 10), 20),
        minCoverageResults: 3,
        createRequestOnMiss: false,
        qualityMode: "enterprise",
        requireValidated: false,
        minConfidence: 45,
        priority: "normal",
        forceHybrid: true,
        confidence,
        routeReason: "jev:deep",
      };
    case "custom-research":
      return {
        queryClass,
        limit: Math.min(Math.max(base, 8), 15),
        minCoverageResults: 3,
        createRequestOnMiss: true,
        qualityMode: "standard",
        requireValidated: false,
        minConfidence: 0,
        priority: "high",
        forceHybrid: true,
        confidence,
        routeReason: "jev:custom-research",
      };
  }
}

function heuristicClass(query: string, mode: string): QueryClass {
  const q = query.toLowerCase();
  if (
    /\b(write|produce|commission|custom research|deep dive|investigate|missing)\b/.test(q) ||
    mode === "research"
  ) {
    return "custom-research";
  }
  if (/\b(compare|analyze|synthesis|landscape|risks?|competitive)\b/.test(q) || query.length > 280) {
    return "deep";
  }
  if (/\b(brief|summary|overview|explain)\b/.test(q) || mode === "brief") {
    return "brief";
  }
  return "lookup";
}

async function askJev(query: string, mode: string, agentId: string | null): Promise<AskResult> {
  const apiKey = env("TYPESAFE_API_KEY");
  if (!apiKey) {
    return { queryClass: null, confidence: null };
  }
  const url = env("TYPESAFE_API_URL") || "https://api.typesafe.ai/v1/systemone";
  const model = env("TYPESAFE_MODEL") || "jev-latest";
  const timeoutMs = Number(env("TYPESAFE_TIMEOUT_MS") || 2500);

  const body = {
    state: {
      product: "perkos-knowledge",
      endpoint: "/skill/query",
      mode,
      agent: agentId || "unknown",
      query_chars: query.length,
      preview: query.slice(0, 500),
    },
    model,
    questions: {
      query_class: {
        type: "choice",
        instructions:
          "Choose the best PerkOS Knowledge retrieval class for this consumer query. Prefer cheaper/lighter classes when a short lookup is enough. Prefer custom-research only when the corpus is likely insufficient and new research should be commissioned.",
        criteria: {
          lookup: "Short factual lookup; few results; do not create research requests",
          brief: "Needs a short synthesized brief from existing knowledge; hybrid ok",
          deep: "Comparative / high-stakes analysis; prefer higher quality and more results",
          "custom-research":
            "Likely miss; should allow auto-creating a knowledge request for providers",
        },
      },
    },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { queryClass: null, confidence: null };
    const data = JSON.parse(text) as {
      answers?: { query_class?: { value?: string; choice?: string; confidence?: number } };
    };
    const qc = data.answers?.query_class || {};
    const value = String(qc.value || qc.choice || "");
    const queryClass = (QUERY_CLASSES as readonly string[]).includes(value)
      ? (value as QueryClass)
      : null;
    return {
      queryClass,
      confidence: typeof qc.confidence === "number" ? qc.confidence : null,
    };
  } catch {
    return { queryClass: null, confidence: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve Knowledge query policy via Jev, with heuristic fallback.
 * Returns null when router disabled.
 */
export async function resolveQueryRoute(opts: {
  query: string;
  mode?: string;
  agentId?: string | null;
  requestedLimit?: number;
  /** If body already forces class */
  forcedClass?: string | null;
}): Promise<QueryRoutePolicy | null> {
  if (!routerEnabled() && !opts.forcedClass) return null;

  const mode = String(opts.mode || "context");
  const forced = String(opts.forcedClass || "").toLowerCase();
  if ((QUERY_CLASSES as readonly string[]).includes(forced)) {
    return policyForClass(forced as QueryClass, 1, opts.requestedLimit || 8);
  }

  let queryClass: QueryClass | null = null;
  let confidence: number | null = null;

  if (routerEnabled()) {
    const asked = await askJev(opts.query, mode, opts.agentId || null);
    queryClass = asked.queryClass;
    confidence = asked.confidence;
  }

  if (!queryClass) {
    queryClass = heuristicClass(opts.query, mode);
    return {
      ...policyForClass(queryClass, confidence, opts.requestedLimit || 8),
      routeReason: `heuristic:${queryClass}`,
    };
  }

  return policyForClass(queryClass, confidence, opts.requestedLimit || 8);
}
