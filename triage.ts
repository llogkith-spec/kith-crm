// =============================================================================
// KITH TRIAGE — inbox message classifier (Phase 4)
// =============================================================================
// Reads every inbox message and decides:
//   - category: adviser / parts / accounts / director / unsure
//   - is_work_enquiry (does this need to go to intake?)
//   - is_mechanical / is_bodywork (rapid-fire eligibility)
//   - is_rapid_fire (retail + mechanical + has enough detail to price)
//   - is_ambiguous (don't act, send to Logan's queue)
//   - suggested_reply (customer-facing ack text, in Logan's voice)
//   - routed_to_roles (which staff roles get pinged)
//   - priority (low / normal / urgent)
//   - confidence + reasoning (for Logan to audit)
//
// Pulls recent director corrections from kith_triage_corrections so it
// learns from Logan's overrides over time.
//
// Deploy: supabase functions deploy triage
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

async function recentCorrections(): Promise<string> {
  try {
    const { data } = await sb
      .from("kith_triage_corrections")
      .select("original_text, original_category, corrected_category")
      .order("corrected_at", { ascending: false })
      .limit(20);
    if (!data || data.length === 0) return "";
    const lines = data.map((c: any) =>
      `- "${String(c.original_text).slice(0, 120)}" — AI said ${c.original_category}, actually ${c.corrected_category}`
    );
    return `\n\nRECENT CORRECTIONS from the director — learn from these mistakes:\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

const SYSTEM_PROMPT = (correctionsBlock: string) => `You are the KITH Cars inbox triage AI. KITH Cars is a mechanical garage + bodyshop in Hackbridge, South London. Every message that lands in the KITH unified inbox goes through you first, and you decide who should see it and how to respond.

THE PEOPLE YOU ROUTE TO:
- adviser  = Service Adviser (Ali, Elvis) — customer-facing: new work enquiries, bookings, job status questions, "when will my car be ready", complaints about service
- parts    = Parts team (Sudha, Giles, Harith, Paul) — parts counter orders, supplier calls, parts availability queries ("do you stock X"), consumables for staff
- accounts = Accounts (Sudha, Logan) — invoices, payment questions, statements, overdue reminders, refunds, finance queries
- director = Logan — big decisions, escalations, partner / supplier relationship stuff, business-level queries, press / media, anything of real financial consequence

Multiple categories are fine — split the message and route each part. For example "paid your invoice, also need a service" → ["adviser", "accounts"].

WORK ENQUIRY vs NOT:
- is_work_enquiry = true when the customer wants work done on a vehicle (service, repair, MOT, diagnosis, bodywork, tyres, tuning). Everything else is false.
- is_mechanical = work on mechanical / servicing / MOT / tyres / tuning / exhaust
- is_bodywork  = work on panels, paint, dents, accident damage

RAPID FIRE = AUTOMATED PRICE RANGE:
- is_rapid_fire = true ONLY when ALL of these hold:
  1. is_work_enquiry is true
  2. is_mechanical is true (bodywork rapid-fire only if damage is clearly described, otherwise false)
  3. Customer type appears to be retail (not trade, fleet, insurance, warranty, AA, PGC)
  4. There's enough detail to price (vehicle + what's needed), OR at least a generic service / MOT request
  5. Not ambiguous

AMBIGUOUS:
- is_ambiguous = true when the message is genuinely unclear or could be several things at once and you can't pick. Includes: cryptic one-liners, spam-ish, auto-replies, wrong number, out-of-scope requests (e.g. house removals). Logan triages these himself.

AUTO-REPLY:
- suggested_reply = a short friendly customer-facing acknowledgment in a warm but matter-of-fact UK garage tone, naming who will respond ("Thanks — Ali will be in touch shortly.", "Got it — Giles will come back to you on parts.", etc.). Never promise a time. Never promise a price. If is_rapid_fire is true, suggested_reply = "" (the price range IS the first reply, no ack needed). If is_ambiguous is true, suggested_reply = "" (Logan handles it).

PRIORITY:
- urgent  = customer is stuck somewhere (recovery, breakdown), car is in and they're waiting on us, something time-critical ("picking it up in an hour")
- normal  = default
- low     = cold enquiry, generic question, no urgency signal

CONFIDENCE: your honest read — high / medium / low.

REASONING: one short sentence explaining the call, in Logan's house tone — plain, concrete, no flowery language.${correctionsBlock}

Return ONLY a single JSON object, no fences, matching this shape exactly:
{
  "category": "adviser" | "parts" | "accounts" | "director" | "unsure",
  "secondary_categories": ["parts"],
  "is_work_enquiry": true,
  "is_mechanical": true,
  "is_bodywork": false,
  "is_rapid_fire": true,
  "is_ambiguous": false,
  "suggested_reply": "Thanks — Ali will be in touch shortly.",
  "routed_to_roles": ["adviser"],
  "priority": "normal",
  "confidence": "high",
  "reasoning": "New work enquiry for brakes on a 2015 Focus — straight to adviser, retail, mechanical, enough detail to rapid-fire."
}`;

async function callClaude(prompt: string, maxTokens = 1000): Promise<string> {
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json();
  const text = String(body.text || "").trim();
  if (!text) return json({ error: "text required" }, 400);

  const channel = body.channel || "unknown";
  const senderName = body.sender_name || "";
  const senderPhone = body.sender_phone || "";
  const contextHints = body.context_hints || "";
  const isKnownCustomer = !!body.is_known_customer;
  const prevMessages = Array.isArray(body.prev_messages) ? body.prev_messages.slice(-3) : [];

  const corrections = await recentCorrections();
  const system = SYSTEM_PROMPT(corrections);

  const msgBlock =
    `CHANNEL: ${channel}\n` +
    `SENDER NAME: ${senderName || "(unknown)"}\n` +
    `SENDER PHONE: ${senderPhone || "(unknown)"}\n` +
    `KNOWN KITH CUSTOMER: ${isKnownCustomer ? "yes" : "no"}\n` +
    (contextHints ? `CONTEXT: ${contextHints}\n` : "") +
    (prevMessages.length ? `PRIOR MESSAGES:\n${prevMessages.map((m: any) => `  ${m.dir || '?'}: ${m.text || ''}`).join("\n")}\n` : "") +
    `\nMESSAGE TO TRIAGE:\n${text}\n`;

  let result: any;
  try {
    const raw = await callClaude(system + "\n\n" + msgBlock);
    result = parseJson(raw);
  } catch (e) {
    return json({ error: `triage failed: ${(e as Error).message}` }, 502);
  }

  // Normalise + safety defaults
  result.category = result.category || "unsure";
  result.secondary_categories = Array.isArray(result.secondary_categories) ? result.secondary_categories : [];
  result.routed_to_roles = Array.isArray(result.routed_to_roles) ? result.routed_to_roles : [result.category];
  result.is_work_enquiry = !!result.is_work_enquiry;
  result.is_mechanical  = !!result.is_mechanical;
  result.is_bodywork    = !!result.is_bodywork;
  result.is_rapid_fire  = !!result.is_rapid_fire;
  result.is_ambiguous   = !!result.is_ambiguous;
  result.priority       = ["low","normal","urgent"].includes(result.priority) ? result.priority : "normal";
  result.confidence     = ["low","medium","high"].includes(result.confidence) ? result.confidence : "medium";
  result.suggested_reply = String(result.suggested_reply || "");
  result.reasoning       = String(result.reasoning || "");
  result.triaged_at      = new Date().toISOString();

  return json(result);
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    headers: { ...CORS, "Content-Type": "application/json" },
    status,
  });
}
