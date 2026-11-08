// =============================================================================
// KITH INBOX INGEST — the single door for leads from every channel
// =============================================================================
// Every platform (website, WhatsApp, IG, FB, email, phone, BMG, GBP, etc.)
// POSTs to this endpoint. It:
//   1. Normalises the payload to the shape kith-inbox.html expects
//   2. Looks for a recent matching lead to avoid duplicates
//   3. Creates a new lead or appends the incoming message to the existing one
//   4. Writes the __leads__ row with optimistic-concurrency retry
//   5. Returns the lead_id + the normalised lead so the caller can confirm
//
// Triage + range + staff pings are left to kith-inbox.html's background logic
// (fires on the next inbox view — usually within seconds). A later
// round will add an inline=true flag that calls triage + brain synchronously
// so a website form can show the price range right on the page.
//
// Deploy: supabase functions deploy inbox-ingest
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-caller",
};

// Channels we recognise. Anything else falls back to 'unknown'.
const CHANNELS = new Set([
  "website","whatsapp","instagram","facebook","tiktok",
  "email","phone","bmg","gbp","sms","other"
]);

function normaliseReg(s: string) {
  return String(s || "").toUpperCase().replace(/\s+/g, "").trim();
}
function cleanPhone(s: string) {
  if (!s) return "";
  const d = String(s).replace(/[^\d+]/g, "");
  if (!d) return "";
  if (d.startsWith("+")) return d;
  if (d.startsWith("00")) return "+" + d.slice(2);
  if (d.startsWith("07") && d.length === 11) return "+44" + d.slice(1);
  if (d.startsWith("447")) return "+" + d;
  return d.startsWith("+") ? d : d;
}
function now() { return new Date(); }
function ts(d?: Date) { return (d || now()).toISOString(); }
function fmtRelative(d: Date) {
  const diff = Math.round((Date.now() - d.getTime()) / 60000);
  if (diff < 1) return "just now";
  if (diff < 60) return diff + "m ago";
  if (diff < 1440) return Math.round(diff / 60) + "h ago";
  return Math.round(diff / 1440) + "d ago";
}
function newLeadId() {
  // Match the "LD<ms>" shape kith-bot's makeLead() uses, plus a short random
  // suffix so two ingests in the same millisecond don't collide.
  return "LD" + Date.now() + Math.random().toString(36).slice(2, 5);
}

// Is a lead a plausible match for the incoming message? Same phone, email or
// handle, and under 48 hours old.
function isMatch(lead: any, b: any) {
  if (!lead) return false;
  const ageMs = Date.now() - (lead.t || 0);
  if (ageMs > 48 * 3600 * 1000) return false;
  const ph = cleanPhone(lead.phone || "");
  const bp = cleanPhone(b.sender_phone || "");
  if (ph && bp && ph === bp) return true;
  const em = String(lead.email || "").toLowerCase();
  const be = String(b.sender_email || "").toLowerCase();
  if (em && be && em === be) return true;
  const h1 = String(lead.handle || "").toLowerCase();
  const h2 = String(b.sender_handle || "").toLowerCase();
  if (h1 && h2 && h1 === h2) return true;
  return false;
}

function mergeLead(lead: any, b: any, channel: string, msgAt: Date): any {
  const merged = { ...lead };
  merged.name    = merged.name    || String(b.sender_name  || "").trim();
  merged.phone   = merged.phone   || cleanPhone(b.sender_phone || "");
  merged.email   = merged.email   || String(b.sender_email || "").trim();
  merged.handle  = merged.handle  || String(b.sender_handle|| "").trim();
  if (!merged.reg && b.reg)   merged.reg   = normaliseReg(b.reg);
  if (!merged.year && b.year) merged.year  = Number(b.year) || null;
  if (!merged.make && b.make) merged.make  = String(b.make);
  if (!merged.model && b.model) merged.model = String(b.model);
  const text = String(b.message_text || "").trim();
  if (text) {
    if (!merged.what) merged.what = text;
    merged.messages = (merged.messages || []).concat([{
      dir: "in", channel, at: fmtRelative(msgAt),
      t: msgAt.getTime(), text,
    }]);
    if (merged.messages.length > 100) merged.messages = merged.messages.slice(-100);
  }
  merged.t  = Math.max(merged.t || 0, msgAt.getTime());
  merged.at = fmtRelative(msgAt);
  // Force a re-triage by clearing the text_hash — kith-inbox.html picks it up
  if (merged.triage) merged.triage = Object.assign({}, merged.triage, { text_hash: undefined });
  return merged;
}

function newLead(b: any, channel: string, msgAt: Date) {
  const text  = String(b.message_text || "").trim();
  const phone = cleanPhone(b.sender_phone || "");
  const email = String(b.sender_email || "").trim();
  const handle = String(b.sender_handle || "").trim() || phone || email || "";
  // Shape matches kith-bot.js's makeLead() so kith-inbox.html treats it the
  // same as any manually-entered lead.
  return {
    id: newLeadId(),
    channel,
    handle,
    name:  String(b.sender_name || "").trim(),
    phone, email,
    reg:   b.reg ? normaliseReg(b.reg) : "",
    year:  b.year  ? Number(b.year) || null : null,
    make:  b.make  ? String(b.make)  : "",
    model: b.model ? String(b.model) : "",
    what:  text,
    state: "new",   // leadState() will recompute on the client
    jobId: "",
    notes: "",
    by:    "ingest/" + channel,
    at:    fmtRelative(msgAt),
    t:     msgAt.getTime(),
    source: channel,
    messages: text ? [{
      dir: "in", channel, at: fmtRelative(msgAt), t: msgAt.getTime(), text,
    }] : [],
  };
}

// Compare-and-swap write to the __leads__ row.
async function upsertLead(b: any, channel: string, msgAt: Date) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data: rows, error: readErr } = await sb
      .from("jobs").select("data,updated_at").eq("id", "__leads__").limit(1);
    if (readErr) throw new Error("read __leads__ failed: " + readErr.message);

    const existing = (rows && rows[0]) || null;
    const data = (existing && existing.data) || { leads: [] };
    const leads: any[] = Array.isArray(data.leads) ? data.leads.slice() : [];

    const matchIdx = leads.findIndex((l) => isMatch(l, b));
    let lead: any;
    let created = false;
    if (matchIdx >= 0) {
      lead = mergeLead(leads[matchIdx], b, channel, msgAt);
      leads[matchIdx] = lead;
    } else {
      lead = newLead(b, channel, msgAt);
      leads.unshift(lead);
      created = true;
    }

    const newData = { ...data, leads };
    const newStamp = new Date().toISOString();

    let writeRes;
    if (!existing) {
      // No row yet — INSERT
      writeRes = await sb
        .from("jobs")
        .insert({ id: "__leads__", data: newData, updated_at: newStamp });
    } else {
      // PATCH only if updated_at hasn't changed since we read
      const cond = sb.from("jobs").update({ data: newData, updated_at: newStamp }).eq("id", "__leads__");
      writeRes = await (existing.updated_at == null ? cond.is("updated_at", null) : cond.eq("updated_at", existing.updated_at));
    }
    if (!writeRes.error) {
      // Supabase .update does not surface "0 rows matched" as an error — read back to verify
      const { data: back } = await sb.from("jobs").select("updated_at").eq("id", "__leads__").limit(1);
      if (back && back[0] && back[0].updated_at === newStamp) {
        return { lead, created };
      }
      // Stamp didn't take — someone else saved in between, retry
    } else {
      // On a hard error, bail
      throw new Error("write __leads__ failed: " + writeRes.error.message);
    }
    await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
  }
  throw new Error("Too many writers on __leads__ — try again");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const rawChannel = String(body.channel || "").toLowerCase();
  const channel = CHANNELS.has(rawChannel) ? rawChannel : "other";
  const text = String(body.message_text || "").trim();
  if (!text && !body.sender_name && !body.sender_phone && !body.sender_email) {
    return json({ error: "need at least a message, name, phone, or email" }, 400);
  }

  const msgAt = body.received_at ? new Date(body.received_at) : now();

  try {
    const { lead, created } = await upsertLead(body, channel, msgAt);
    return json({
      ok: true,
      created,
      lead_id: lead.id,
      channel,
      lead_summary: {
        name: lead.name, phone: lead.phone, email: lead.email, handle: lead.handle,
        reg: lead.reg, what: lead.what, messages: (lead.messages || []).length
      }
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    headers: { ...CORS, "Content-Type": "application/json" },
    status,
  });
}
