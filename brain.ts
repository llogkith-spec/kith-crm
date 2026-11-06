// =============================================================================
// KITH BRAIN — main endpoint (v3 — reads SOP from kith_sop_config table)
// =============================================================================
// Takes: { customer_type, vehicle, complaint, reg? }
// Returns: priced jobs with real SRTs from cache + AI estimates where cache missed
//
// Flow:
//   1. Load the live SOP from kith_sop_config (60s in-memory cache)
//   2. Claude identifies jobs + parts needed from the complaint
//   3. For each job, look up SRT cache + parts cache
//   4. For any cache miss, make ONE Claude fallback call to estimate everything
//      missing (SRT hours + parts net costs) in one batch
//   5. Apply SOP maths via the loaded config; flag is_firm=true only when ALL
//      inputs came from cache
//   6. Log the query
//
// Deploy: supabase functions deploy brain
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = "claude-sonnet-4-6";

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-caller",
};

// ─── SOP LOADER (60s in-memory cache) ─────────────────────────────────────────
// The SOP lives in the kith_sop_config table (one row with id='current').
// We cache it for 60s so a burst of quotes doesn't hammer the DB, but a
// director save propagates within a minute.
let _sopCache: { data: any; version: number; at: number } | null = null;
async function loadSop() {
  if (_sopCache && Date.now() - _sopCache.at < 60_000) return _sopCache;
  const { data, error } = await sb
    .from("kith_sop_config")
    .select("data,version")
    .eq("id", "current")
    .single();
  if (error || !data) {
    if (_sopCache) return _sopCache; // stale is better than nothing
    throw new Error("SOP config missing — run sop-schema.sql first");
  }
  _sopCache = { data: data.data, version: data.version, at: Date.now() };
  return _sopCache;
}

// ─── ENGINE (reads from the loaded SOP) ───────────────────────────────────────
// Builds the runtime CUSTOMERS shape from sop.customers + sop.rates, then
// applies labour and parts maths exactly as v8.0 specifies.

function buildCustomers(sop: any): Record<string, any> {
  const out: Record<string, any> = {};
  const baseRates = sop.rates || {};
  for (const [key, cc] of Object.entries(sop.customers || {}) as any) {
    if (cc.kind === "kith") {
      const rates: Record<string, number> = { BODY: baseRates.BODY };
      for (const t of (cc.tiers || [])) rates[t] = baseRates[t];
      out[key] = { rates, hasMed: (cc.tiers || []).includes("MED"), threshold: cc.threshold ?? 2.0, parts: "tiered", collapseMed: !!cc.collapseMed };
    } else {
      const rates: Record<string, number> = { ALL: cc.labourRate };
      if (cc.diagRate != null) rates.DIAG = cc.diagRate;
      if (cc.diagFixed != null) rates.DIAG = cc.diagFixed;
      out[key] = { rates, threshold: null, parts: "flat", flat: 1 + (cc.partsPct || 0), diagAuthMax: cc.diagAuthMax };
    }
  }
  return out;
}

function tierFor(tier: string, c: string, customers: Record<string, any>) {
  const cfg = customers[c];
  if (cfg && cfg.collapseMed && tier === "MED") return "TOP";
  return tier;
}
function multiplierFor(hours: number, alwaysDouble: boolean, c: string, sop: any, customers: Record<string, any>) {
  if (alwaysDouble) return (sop.multiplier?.normal?.lower) ?? 2.0;
  const cfg = customers[c];
  if (!cfg || cfg.threshold === null) return 1.0;
  const lower = sop.multiplier?.normal?.lower ?? 2.0;
  const upper = sop.multiplier?.normal?.upper ?? 1.5;
  return hours < cfg.threshold ? lower : upper;
}
function rateFor(tier: string, c: string, customers: Record<string, any>) {
  const cfg = customers[c];
  if (!cfg) throw new Error(`Unknown customer type: ${c}`);
  if (cfg.rates.ALL != null) return cfg.rates.ALL;
  const t = tierFor(tier, c, customers);
  const rate = cfg.rates[t] ?? cfg.rates.TOP;
  if (rate == null) throw new Error(`No rate for tier ${tier} on customer ${c}`);
  return rate;
}
function labourFor(hours: number, tier: string, alwaysDouble: boolean, c: string, sop: any, customers: Record<string, any>) {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  const minHours = sop.minimums?.labourHours ?? 0.5;
  return Math.max(hours * multiplierFor(hours, alwaysDouble, c, sop, customers), minHours) * rateFor(tier, c, customers);
}
function partsFor(net: number, c: string, sop: any, customers: Record<string, any>) {
  const cfg = customers[c];
  if (!Number.isFinite(net) || net <= 0) return 0;
  const escalate = sop.partsEscalateAbove ?? 2000;
  const topMult = sop.partsLadder?.[sop.partsLadder.length - 1]?.mult ?? 1.3;
  if (net > escalate) return net * topMult;
  if (cfg && cfg.parts === "flat") return net * (cfg.flat || 1.2);
  // Walk the ladder — find the first band whose `to` is >= net
  const ladder = sop.partsLadder || [];
  for (const b of ladder) {
    if (net <= b.to) return Math.max(net * b.mult, b.minSell || 0);
  }
  return net * topMult;
}

// ─── CLAUDE PROMPTS ───────────────────────────────────────────────────────────

const IDENTIFY_PROMPT = (vehicle: string, complaint: string, customerType: string) => `You help KITH Cars estimators turn a plain-English complaint into priced-ready job tickets.

CUSTOMER TYPE: ${customerType}
VEHICLE: ${vehicle}
COMPLAINT: ${complaint}

RULES:
- Break the complaint into specific jobs ("service and brakes" = 2 jobs)
- Classify each with normalised job key (snake_case) + tier (LOW/MED/TOP/BODY) + always_double flag
- If complaint is too vague, return jobs:[] and follow_up with 1-2 non-mechanical questions
- Safety signals (warning lights, grinding, smoke) → safety_concern

For each job, also list the main parts needed with normalised keys (e.g. front_brake_pads, front_brake_discs). The brain will look up prices separately.

Return ONLY JSON, no fences:

{
  "vehicle": { "make":"", "model":"", "engine_variant":"", "year":2015 },
  "jobs": [
    {
      "job_normalised": "rear_brake_pads_discs",
      "job_label": "Rear brake pads and discs replacement",
      "tier": "LOW",
      "is_always_double": false,
      "parts_needed": [
        { "part_normalised": "rear_brake_pads", "part_label": "Rear brake pads set" },
        { "part_normalised": "rear_brake_discs", "part_label": "Rear brake discs pair" }
      ]
    }
  ],
  "follow_up": "",
  "safety_concern": "",
  "confidence": "high|medium|low"
}`;

const ESTIMATE_PROMPT = (vehicle: any, srtMisses: any[], partMisses: any[]) => `You are estimating labour hours (SRT = Standard Repair Time from HaynesPro/Autodata) and UK trade-net parts costs for a ${vehicle.make || ''} ${vehicle.model || ''} ${vehicle.engine_variant || ''} ${vehicle.year || ''}.

Give realistic UK garage estimates. Be conservative — err slightly high rather than low. These numbers will be used to price customer quotes.

${srtMisses.length > 0 ? `LABOUR HOURS NEEDED (SRT estimates for this vehicle):
${srtMisses.map(j => `- ${j.job_normalised}: ${j.job_label}`).join('\n')}` : ''}

${partMisses.length > 0 ? `PARTS NET COSTS NEEDED (what a garage pays trade, inc VAT, for mid-market OE-equivalent brand — e.g. TRW, Bosch, Delphi — in £):
${partMisses.map(p => `- ${p.part_normalised}: ${p.part_label}`).join('\n')}` : ''}

Return ONLY JSON, no fences:
{
  "srts": [
    { "job_normalised": "rear_brake_pads_discs", "estimated_hours": 1.1, "notes": "typical for this make/model" }
  ],
  "parts": [
    { "part_normalised": "rear_brake_pads", "estimated_net_cost": 28, "brand": "TRW", "notes": "mid-range" }
  ]
}`;

// ─── CACHE LOOKUPS ────────────────────────────────────────────────────────────

async function lookupSrt(make: string, model: string, variant: string | null, jobNormalised: string) {
  let { data } = await sb
    .from("kith_srt_latest")
    .select("*")
    .eq("make", make)
    .eq("model", model)
    .eq("job_normalised", jobNormalised)
    .eq("engine_variant", variant)
    .limit(1);
  if (data && data.length) return { ...data[0], match: "exact" };

  ({ data } = await sb
    .from("kith_srt_latest")
    .select("*")
    .eq("make", make)
    .eq("model", model)
    .eq("job_normalised", jobNormalised)
    .limit(1));
  if (data && data.length) return { ...data[0], match: "model_only" };

  return null;
}

async function lookupPart(make: string, model: string, variant: string | null, partNormalised: string) {
  let { data } = await sb
    .from("kith_parts_latest")
    .select("*")
    .eq("make", make)
    .eq("model", model)
    .eq("part_normalised", partNormalised)
    .eq("engine_variant", variant)
    .limit(1);
  if (data && data.length) return { ...data[0], match: "exact" };

  ({ data } = await sb
    .from("kith_parts_latest")
    .select("*")
    .eq("make", make)
    .eq("model", model)
    .eq("part_normalised", partNormalised)
    .limit(1));
  if (data && data.length) return { ...data[0], match: "model_only" };

  return null;
}

async function callClaude(prompt: string, maxTokens = 1500): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = await res.json();
  return data.content.map((i: any) => i.text || "").join("");
}

function parseJson(text: string): any {
  return JSON.parse(text.replace(/```json/gi, "").replace(/```/g, "").trim());
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json();
  const { customer_type = "retail", vehicle = "", complaint, reg = "" } = body;
  if (!complaint) return json({ error: "complaint required" }, 400);

  const caller = req.headers.get("x-caller") || "unknown";

  // ─── Step 0: load SOP + build runtime customers ─────────────────────────────
  let sopEntry;
  let customers: Record<string, any>;
  try {
    sopEntry = await loadSop();
    customers = buildCustomers(sopEntry.data);
  } catch (e) {
    return json({ error: `sop load failed: ${(e as Error).message}` }, 500);
  }
  if (!customers[customer_type]) return json({ error: `unknown customer type: ${customer_type}` }, 400);
  const sop = sopEntry.data;

  // ─── Step 1: identify jobs from the complaint ───────────────────────────────
  let identified: any;
  try {
    const identText = await callClaude(IDENTIFY_PROMPT(vehicle, complaint, customer_type));
    identified = parseJson(identText);
  } catch (e) {
    return json({ error: `identify failed: ${(e as Error).message}` }, 502);
  }

  if (!identified.jobs || identified.jobs.length === 0) {
    return json({
      vehicle: identified.vehicle,
      jobs: [],
      follow_up: identified.follow_up || "Please tell us a bit more about what you need.",
      safety_concern: identified.safety_concern || "",
      confidence: identified.confidence || "low",
      total_inc_vat: 0,
      total_range: { lo: 0, hi: 0 },
      cache_stats: { srt_hits: 0, srt_misses: 0, parts_hits: 0, parts_misses: 0 },
      sop_version: sopEntry.version,
      all_firm: false,
    });
  }

  const v = identified.vehicle || {};
  const make = v.make || "";
  const model = v.model || "";
  const variant = v.engine_variant || null;

  // ─── Step 2: cache lookups ──────────────────────────────────────────────────
  let srtHits = 0, srtMisses = 0, partsHits = 0, partsMisses = 0;
  const pricedJobs: any[] = [];

  for (const job of identified.jobs) {
    const srtHit = await lookupSrt(make, model, variant, job.job_normalised);
    let srtHours: number | null = null;
    let srtSource = "no_data_available";
    let srtFromCache = false;

    if (srtHit) {
      srtHours = Number(srtHit.srt_hours);
      srtSource = `cache (${srtHit.match}, ${srtHit.sample_count} samples)`;
      srtFromCache = true;
      srtHits++;
    } else {
      srtMisses++;
    }

    const partsLines: any[] = [];
    for (const p of job.parts_needed || []) {
      const partHit = await lookupPart(make, model, variant, p.part_normalised);
      if (partHit) {
        partsLines.push({
          part_normalised: p.part_normalised,
          part_label: p.part_label,
          net: Number(partHit.net_cost),
          source: `${partHit.source} (${partHit.match})`,
          brand: partHit.part_brand,
          from_cache: true,
        });
        partsHits++;
      } else {
        partsLines.push({
          part_normalised: p.part_normalised,
          part_label: p.part_label,
          net: null,
          source: "no_data_available",
          from_cache: false,
        });
        partsMisses++;
      }
    }

    pricedJobs.push({
      job_normalised: job.job_normalised,
      job_label: job.job_label,
      tier: tierFor(job.tier, customer_type, customers),
      _tier_raw: job.tier,
      _is_always_double: job.is_always_double,
      srt_hours: srtHours,
      srt_source: srtSource,
      _srt_from_cache: srtFromCache,
      parts_lines: partsLines,
    });
  }

  // ─── Step 3: AI fallback for anything missed ────────────────────────────────
  const missedSrts: any[] = [];
  const missedParts: any[] = [];
  pricedJobs.forEach((j) => {
    if (!j._srt_from_cache) {
      missedSrts.push({ job_normalised: j.job_normalised, job_label: j.job_label });
    }
    j.parts_lines.forEach((p: any) => {
      if (!p.from_cache) {
        missedParts.push({ part_normalised: p.part_normalised, part_label: p.part_label });
      }
    });
  });

  let usedAiFallback = false;
  if (missedSrts.length > 0 || missedParts.length > 0) {
    try {
      const estText = await callClaude(ESTIMATE_PROMPT(v, missedSrts, missedParts));
      const estimates = parseJson(estText);
      usedAiFallback = true;

      for (const est of estimates.srts || []) {
        const job = pricedJobs.find(j => j.job_normalised === est.job_normalised);
        if (job && Number.isFinite(Number(est.estimated_hours)) && est.estimated_hours > 0) {
          job.srt_hours = Number(est.estimated_hours);
          job.srt_source = `ai_estimate${est.notes ? ' — ' + est.notes : ''}`;
        }
      }

      for (const est of estimates.parts || []) {
        for (const j of pricedJobs) {
          const p = j.parts_lines.find((x: any) => x.part_normalised === est.part_normalised);
          if (p && !p.from_cache && Number.isFinite(Number(est.estimated_net_cost)) && est.estimated_net_cost > 0) {
            p.net = Number(est.estimated_net_cost);
            p.source = `ai_estimate${est.brand ? ' (' + est.brand + ')' : ''}`;
            p.brand = est.brand || p.brand;
          }
        }
      }
    } catch (e) {
      console.error("AI fallback failed:", (e as Error).message);
    }
  }

  // ─── Step 4: apply SOP maths ────────────────────────────────────────────────
  for (const j of pricedJobs) {
    const labour = (j.srt_hours && j.srt_hours > 0)
      ? labourFor(j.srt_hours, j._tier_raw, j._is_always_double, customer_type, sop, customers)
      : 0;

    const partsCharge = j.parts_lines
      .filter((l: any) => l.net != null && l.net > 0)
      .reduce((s: number, l: any) => s + partsFor(l.net, customer_type, sop, customers), 0);

    const totalExVat = labour + partsCharge;
    const totalIncVat = totalExVat * 1.20;

    j.labour_ex_vat = Math.round(labour * 100) / 100;
    j.parts_charge_ex_vat = Math.round(partsCharge * 100) / 100;
    j.total_ex_vat = Math.round(totalExVat * 100) / 100;
    j.total_inc_vat = Math.round(totalIncVat * 100) / 100;
    j.is_firm = j._srt_from_cache && j.parts_lines.every((p: any) => p.from_cache);

    delete j._tier_raw;
    delete j._is_always_double;
    delete j._srt_from_cache;
    j.parts_lines.forEach((p: any) => delete p.from_cache);
  }

  // ─── Step 5: totals + logging ───────────────────────────────────────────────
  const total = pricedJobs.reduce((s, j) => s + (j.total_inc_vat || 0), 0);
  // Range from SOP (retail-instant-range widens it; otherwise the fallback-aware default)
  const retailLow  = (sop.instantRange?.lowerPct ?? 10) / 100;
  const retailHigh = (sop.instantRange?.upperPct ?? 25) / 100;
  const isRetail = customer_type === "retail";
  let totalLo: number, totalHi: number;
  if (isRetail) {
    totalLo = Math.round(total * (1 - retailLow)  * 100) / 100;
    totalHi = Math.round(total * (1 + retailHigh) * 100) / 100;
  } else {
    const spread = usedAiFallback ? 0.20 : 0.10;
    totalLo = Math.round(total * (1 - spread / 2) * 100) / 100;
    totalHi = Math.round(total * (1 + spread / 2) * 100) / 100;
  }

  let confidence = identified.confidence || "medium";
  if (usedAiFallback) confidence = pricedJobs.some(j => j.is_firm) ? "medium" : "low";

  await sb.from("kith_brain_queries").insert({
    caller,
    customer_type,
    reg,
    vehicle: `${make} ${model} ${variant || ""}`.trim(),
    complaint,
    jobs_requested: identified.jobs,
    srt_hits: srtHits,
    srt_misses: srtMisses,
    parts_hits: partsHits,
    parts_misses: partsMisses,
    total_quoted_lo: totalLo,
    total_quoted_hi: totalHi,
  });

  return json({
    vehicle: identified.vehicle,
    jobs: pricedJobs,
    safety_concern: identified.safety_concern || "",
    follow_up: identified.follow_up || "",
    confidence,
    total_inc_vat: Math.round(total * 100) / 100,
    total_range: { lo: totalLo, hi: totalHi },
    cache_stats: { srt_hits: srtHits, srt_misses: srtMisses, parts_hits: partsHits, parts_misses: partsMisses },
    used_ai_fallback: usedAiFallback,
    sop_version: sopEntry.version,
    all_firm: pricedJobs.every(j => j.is_firm),
  });
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    headers: { ...CORS, "Content-Type": "application/json" },
    status,
  });
}
