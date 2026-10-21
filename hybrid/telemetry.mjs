// hybrid/telemetry.mjs
function iso(ms) {
  return new Date(ms).toISOString();
}

function safeRuns(base) {
  return Array.isArray(base?.runs) ? [...base.runs] : [];
}

export function classifyProviderError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("timed out") || message.includes("timeout") || message.includes("etimedout")) return "timeout";
  if (message.includes("429") || message.includes("rate limit") || message.includes("too many requests")) return "rate_limit";
  if (message.includes("econnreset") || message.includes("econnrefused") || message.includes("socket hang up") || message.includes("network")) return "network";
  if (message.includes("not found") || message.includes("enoent") || message.includes("cli entry not found")) return "not_found";
  if (message.includes("invalid score card") || message.includes("no json object") || message.includes("json")) return "invalid_output";
  if (message.includes("exited")) return "process_exit";
  return "provider_error";
}

export function createSessionTelemetry({
  resumed = false,
  now = Date.now,
  pid = process.pid,
} = {}) {
  const startedMs = now();
  const run = {
    id: `${startedMs.toString(36)}-${pid}`,
    started_at: iso(startedMs),
    resumed: Boolean(resumed),
    pid,
    provider_calls: [],
  };
  let document = { runs: [] };
  let persist = null;

  function save() {
    const current = now();
    run.duration_ms = Math.max(0, current - startedMs);
    document.latest_run = run;
    document.updated_at = iso(current);
    if (persist) persist(document);
  }

  function attach(base, writer) {
    document = {
      ...(base || {}),
      runs: [...safeRuns(base), run],
    };
    persist = writer;
    save();
  }

  function provider(call) {
    const current = now();
    run.provider_calls.push({
      at: iso(current),
      role: call.role,
      task: call.task,
      phase: call.phase || call.task || call.role,
      provider: call.provider,
      ok: Boolean(call.ok),
      duration_ms: Math.max(0, Number(call.duration_ms) || 0),
      attempt: Math.max(1, Math.trunc(Number(call.attempt) || 1)),
      fallback: Boolean(call.fallback),
      ...(call.seat ? { seat: call.seat } : {}),
      ...(call.retry_scheduled ? { retry_scheduled: true } : {}),
      ...(call.error_type ? { error_type: call.error_type } : {}),
    });
    save();
  }

  function complete(extra = {}) {
    Object.assign(run, extra, { completed_at: iso(now()) });
    save();
  }

  function snapshot() {
    return structuredClone(document);
  }

  return { attach, provider, complete, save, snapshot, run };
}
