// scripts/hybrid-telemetry-report.mjs
// Read-only aggregation of operational Hybrid telemetry. This file intentionally
// reads only hybrid-meta.json and never opens prompts, council cards, or verdict text.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ratio(n, d) {
  return d > 0 ? Math.round((n / d) * 10000) / 10000 : null;
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)) * 100) / 100;
}

export function summarizeLatency(values) {
  const sorted = values.map(finiteNumber).filter((v) => v !== null && v >= 0).sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    mean: sorted.length ? Math.round((total / sorted.length) * 100) / 100 : null,
    p50: sorted.length >= 2 ? percentile(sorted, 0.50) : null,
    p95: sorted.length >= 5 ? percentile(sorted, 0.95) : null,
  };
}

function sanitizeCall(raw = {}) {
  return {
    at: typeof raw.at === "string" ? raw.at : null,
    role: typeof raw.role === "string" ? raw.role : "unknown",
    provider: typeof raw.provider === "string" ? raw.provider : "unknown",
    phase: typeof raw.phase === "string" ? raw.phase : (typeof raw.task === "string" ? raw.task : "unknown"),
    seat: typeof raw.seat === "string" ? raw.seat : null,
    ok: Boolean(raw.ok),
    duration_ms: Math.max(0, finiteNumber(raw.duration_ms) ?? 0),
    attempt: Math.max(1, Math.trunc(finiteNumber(raw.attempt) ?? 1)),
    retry_scheduled: Boolean(raw.retry_scheduled),
    fallback: Boolean(raw.fallback),
    error_type: typeof raw.error_type === "string" ? raw.error_type : null,
  };
}

function observedSpanMs(calls) {
  const windows = calls.map((call) => {
    const end = Date.parse(call.at || "");
    if (!Number.isFinite(end)) return null;
    return { start: end - call.duration_ms, end };
  }).filter(Boolean);
  if (!windows.length) return null;
  return Math.max(...windows.map((w) => w.end)) - Math.min(...windows.map((w) => w.start));
}

function phaseSummary(calls, { includeObservedSpan = true } = {}) {
  const failures = calls.filter((c) => !c.ok);
  const retries = calls.filter((c) => c.retry_scheduled);
  const fallbacks = calls.filter((c) => c.fallback);
  return {
    calls: calls.length,
    failures: failures.length,
    failure_rate: ratio(failures.length, calls.length),
    retries_scheduled: retries.length,
    retry_rate: ratio(retries.length, calls.length),
    fallbacks: fallbacks.length,
    fallback_rate: ratio(fallbacks.length, calls.length),
    provider_duration_sum_ms: calls.reduce((sum, c) => sum + c.duration_ms, 0),
    ...(includeObservedSpan ? { observed_provider_span_ms: observedSpanMs(calls) } : {}),
    latency_ms: summarizeLatency(calls.map((c) => c.duration_ms)),
  };
}

function summarizeRun(session, rawRun = {}) {
  const calls = Array.isArray(rawRun.provider_calls) ? rawRun.provider_calls.map(sanitizeCall) : [];
  const phases = {};
  for (const phase of [...new Set(calls.map((c) => c.phase))].sort()) {
    phases[phase] = phaseSummary(calls.filter((c) => c.phase === phase));
  }
  const chairCalls = calls.filter((c) => c.role === "chair");
  const failures = calls.filter((c) => !c.ok);
  const retries = calls.filter((c) => c.retry_scheduled);
  const fallbacks = calls.filter((c) => c.fallback);
  return {
    session,
    run_id: typeof rawRun.id === "string" ? rawRun.id : null,
    resumed: Boolean(rawRun.resumed),
    completed: Boolean(rawRun.completed_at),
    run_duration_ms: Math.max(0, finiteNumber(rawRun.duration_ms) ?? 0),
    run_duration_exact: Boolean(rawRun.completed_at),
    provider_calls: calls.length,
    failures: failures.length,
    failure_rate: ratio(failures.length, calls.length),
    retries_scheduled: retries.length,
    retry_rate: ratio(retries.length, calls.length),
    retry_rate_among_failures: ratio(retries.length, failures.length),
    fallbacks: fallbacks.length,
    fallback_rate: ratio(fallbacks.length, calls.length),
    latency_ms: summarizeLatency(calls.map((c) => c.duration_ms)),
    chair: {
      calls: chairCalls.length,
      provider_duration_sum_ms: chairCalls.reduce((sum, c) => sum + c.duration_ms, 0),
      latency_ms: summarizeLatency(chairCalls.map((c) => c.duration_ms)),
    },
    phases,
    events: calls.filter((c) => !c.ok || c.retry_scheduled || c.fallback).map((c) => ({
      role: c.role,
      provider: c.provider,
      phase: c.phase,
      seat: c.seat,
      ok: c.ok,
      duration_ms: c.duration_ms,
      attempt: c.attempt,
      retry_scheduled: c.retry_scheduled,
      fallback: c.fallback,
      error_type: c.error_type,
    })),
    _calls: calls,
  };
}

function groupCalls(calls, keyFn) {
  const map = new Map();
  for (const call of calls) {
    const key = keyFn(call);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(call);
  }
  return map;
}

function groupedSummary(calls, keyFn) {
  return [...groupCalls(calls, keyFn).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, subset]) => ({
    key,
    ...phaseSummary(subset, { includeObservedSpan: false }),
  }));
}

export function buildTelemetryReport(sessionsRoot, { prefix = "" } = {}) {
  const runs = [];
  const sessions = fs.existsSync(sessionsRoot)
    ? fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && (!prefix || entry.name.startsWith(prefix)))
    : [];

  for (const entry of sessions) {
    const metaPath = path.join(sessionsRoot, entry.name, "hybrid-meta.json");
    if (!fs.existsSync(metaPath)) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); }
    catch { continue; }
    const rawRuns = Array.isArray(meta?.runs) && meta.runs.length ? meta.runs : (meta?.latest_run ? [meta.latest_run] : []);
    for (const rawRun of rawRuns) runs.push(summarizeRun(entry.name, rawRun));
  }

  const calls = runs.flatMap((run) => run._calls);
  const failures = calls.filter((c) => !c.ok);
  const retries = calls.filter((c) => c.retry_scheduled);
  const fallbacks = calls.filter((c) => c.fallback);
  const errorTypes = [...groupCalls(failures.filter((c) => c.error_type), (c) => c.error_type).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([error_type, subset]) => ({
      error_type,
      count: subset.length,
      rate_of_calls: ratio(subset.length, calls.length),
      contexts: [...groupCalls(subset, (c) => `${c.provider}|${c.phase}`).entries()].map(([context, xs]) => {
        const [provider, phase] = context.split("|");
        return { provider, phase, count: xs.length };
      }),
    }));

  const publicRuns = runs.map(({ _calls, ...run }) => run);
  return {
    schema_version: 1,
    scope: { sessions_root: path.resolve(sessionsRoot), prefix: prefix || null },
    data_quality: {
      reads_only: "hybrid-meta.json",
      prompt_output_secret_fields_emitted: false,
      exact_phase_wall_clock_available: false,
      phase_duration_method: "observed_provider_span_ms = earliest(call completion - duration) to latest(call completion); excludes non-provider overhead",
      incomplete_run_duration_note: "run_duration_ms is exact only when completed=true; otherwise it is the duration at the last telemetry persistence",
      p50_min_samples: 2,
      p95_min_samples: 5,
    },
    totals: {
      sessions: new Set(runs.map((r) => r.session)).size,
      runs: runs.length,
      completed_runs: runs.filter((r) => r.completed).length,
      provider_calls: calls.length,
      failures: failures.length,
      failure_rate: ratio(failures.length, calls.length),
      retries_scheduled: retries.length,
      retry_rate: ratio(retries.length, calls.length),
      retry_rate_among_failures: ratio(retries.length, failures.length),
      fallbacks: fallbacks.length,
      fallback_rate: ratio(fallbacks.length, calls.length),
      latency_ms: summarizeLatency(calls.map((c) => c.duration_ms)),
    },
    by_error_type: errorTypes,
    by_role: groupedSummary(calls, (c) => c.role).map(({ key, ...rest }) => ({ role: key, ...rest })),
    by_provider: groupedSummary(calls, (c) => c.provider).map(({ key, ...rest }) => ({ provider: key, ...rest })),
    by_phase: groupedSummary(calls, (c) => c.phase).map(({ key, ...rest }) => ({ phase: key, ...rest })),
    by_provider_phase: groupedSummary(calls, (c) => `${c.provider}|${c.phase}`).map(({ key, ...rest }) => {
      const [provider, phase] = key.split("|");
      return { provider, phase, ...rest };
    }),
    runs: publicRuns,
  };
}

function cliArgs(argv) {
  let sessionsRoot = path.join(ROOT, "sessions");
  let prefix = "";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sessions") sessionsRoot = path.resolve(argv[++i] || sessionsRoot);
    else if (argv[i] === "--prefix") prefix = argv[++i] || "";
    else if (argv[i] === "--help") return { help: true, sessionsRoot, prefix };
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return { help: false, sessionsRoot, prefix };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = cliArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/hybrid-telemetry-report.mjs [--sessions PATH] [--prefix SESSION_PREFIX]");
  } else {
    console.log(JSON.stringify(buildTelemetryReport(args.sessionsRoot, { prefix: args.prefix }), null, 2));
  }
}
