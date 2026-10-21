// Reads a supplier invoice (photo or PDF) with Claude and returns its line items for review in the app.
// Deploy: Supabase dashboard -> Edge Functions -> deploy "scan-invoice" with this file (see SETUP.md).
// Needs the secret ANTHROPIC_API_KEY. SUPABASE_URL is provided by Supabase.
// Sign-in is checked by the database (scan_begin), so the function's own "Verify JWT" setting can be off.
import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BASE64 = 14_000_000; // about 10 MB of file

const SYSTEM = `You read supplier invoices, receipts and packing lists for a small retail business so the products can be added to its inventory.
Return every product line, in the order it appears. For each line give:
- name: the product description as printed, cleaned of stray codes and line numbers.
- code: the supplier's SKU, item number or UPC for the line, or "" if none is printed.
- quantity: the number of units received. If the line is sold in packs or cases and the units per pack are printed, multiply to get single units and say so in note.
- unit_cost: the cost of one unit after any line discount, or 0 if no price is shown.
- line_total: the line's total as printed, or 0 if not shown.
- note: anything the person should double-check (unreadable text, pack math, a crossed-out quantity), otherwise "".
Leave out shipping, tax, fees, deposits, discounts that apply to the whole invoice, and subtotal or total rows.
If the image is not an invoice or list of products, return no lines and explain in warning.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["supplier", "invoice_number", "invoice_date", "currency", "lines", "warning"],
  properties: {
    supplier: { type: "string" },
    invoice_number: { type: "string" },
    invoice_date: { type: "string", description: "YYYY-MM-DD if a date is printed, otherwise empty" },
    currency: { type: "string", description: "ISO code such as USD" },
    warning: { type: "string" },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "code", "quantity", "unit_cost", "line_total", "note"],
        properties: {
          name: { type: "string" },
          code: { type: "string" },
          quantity: { type: "number" },
          unit_cost: { type: "number" },
          line_total: { type: "number" },
          note: { type: "string" },
        },
      },
    },
  },
};

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Use POST" });

  let body: { company_id?: string; media_type?: string; data?: string };
  try { body = await req.json(); } catch { return reply(400, { error: "Send JSON" }); }
  const { company_id, media_type, data } = body;
  if (!company_id || !media_type || !data) return reply(400, { error: "Missing company_id, media_type or data" });
  if (media_type !== "application/pdf" && !IMAGE_TYPES.includes(media_type)) {
    return reply(400, { error: "Use a photo (JPEG, PNG, WebP) or a PDF" });
  }
  if (data.length > MAX_BASE64) return reply(413, { error: "That file is too large. Use a file under 10 MB." });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return reply(500, { error: "Invoice scanning is not set up yet (missing API key)." });

  // Act as the signed-in person, so the database rules decide whether they may scan.
  // The app sends its public key as "apikey"; fall back to the project's anon key.
  const publicKey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, publicKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: scanId, error: denied } = await db.rpc("scan_begin", { cid: company_id });
  if (denied) return reply(403, { error: denied.message });

  const file = media_type === "application/pdf"
    ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data } }
    : { type: "image" as const, source: { type: "base64" as const, media_type: media_type as "image/jpeg", data } };

  const client = new Anthropic({ apiKey });
  try {
    const msg = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: [file, { type: "text", text: "List the product lines on this invoice." }] }],
    });
    const usage = msg.usage;
    if (msg.stop_reason === "refusal") {
      await db.rpc("scan_finish", { scan_id: scanId, ok: false, in_tokens: usage.input_tokens, out_tokens: usage.output_tokens });
      return reply(422, { error: "This file could not be read as an invoice." });
    }
    if (msg.stop_reason === "max_tokens") {
      await db.rpc("scan_finish", { scan_id: scanId, ok: false, in_tokens: usage.input_tokens, out_tokens: usage.output_tokens });
      return reply(422, { error: "This invoice is too long to read in one go. Try scanning it a page at a time." });
    }
    const text = msg.content.find((b) => b.type === "text");
    const invoice = text && text.type === "text" ? JSON.parse(text.text) : null;
    if (!invoice || !Array.isArray(invoice.lines)) throw new Error("No invoice data in the reply");
    await db.rpc("scan_finish", { scan_id: scanId, ok: true, in_tokens: usage.input_tokens, out_tokens: usage.output_tokens });
    return reply(200, { invoice });
  } catch (e) {
    await db.rpc("scan_finish", { scan_id: scanId, ok: false, in_tokens: 0, out_tokens: 0 });
    if (e instanceof Anthropic.AuthenticationError) return reply(500, { error: "The Claude API key is not valid. Check the ANTHROPIC_API_KEY secret." });
    if (e instanceof Anthropic.RateLimitError) return reply(429, { error: "Too many scans right now. Try again in a minute." });
    if (e instanceof Anthropic.BadRequestError) return reply(400, { error: "Claude could not read this file: " + e.message });
    if (e instanceof Anthropic.APIError) return reply(502, { error: "Claude is not available right now (" + e.status + "). Try again shortly." });
    return reply(500, { error: "Scanning failed: " + String((e as Error)?.message ?? e) });
  }
});
