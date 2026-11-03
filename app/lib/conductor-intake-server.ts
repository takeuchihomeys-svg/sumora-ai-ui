// app/lib/conductor-intake-server.ts — 入口の統括の最初の読み（Sonnet・作り置きつき）と、5番に1番の DeepSeek との比べ（記録だけ）
//
// 2026-11-04 竹内さん（KB P1 75da346a）: 最初の読みは Sonnet。記録だけの1週間は5番に1番を DeepSeek でも読んで当たりを比べる。
//   作り置き: system の先頭（intakePrefix）に cache_control を付ける。先頭は版が変わる時だけ変わる（取扱説明書の短い形は1時間の控え）。
//   作り置きの点検: 名札 conductor_intake の llm_usage_logs の cache_read の割合を毎週の表で数える（8割を下回ったら統括役に知らせる）。
//   繊細な会話（alt-pii-gate が止める会話）は DeepSeek に送らない（Sonnet だけ）。失敗・時間切れは null（呼ぶ側は今まで通り）。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sumoraLlmMarks } from "./llm-usage-recorder";
import { intakePrefix, intakeUser, parseIntake, intakeCompareTurn, intakeAgreement, type IntakeAnswer } from "./conductor-intake";

let _admin: SupabaseClient | null = null;
function admin(): SupabaseClient | null {
  if (_admin) return _admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _admin = createClient(url, key, { auth: { persistSession: false } });
  return _admin;
}
let manualsCache: { at: number; rows: Array<{ brain: string; short: string }> } | null = null;
/** 取扱説明書の短い形（1時間の控え・サーバーの鍵だけ・無ければ []） */
export async function loadManualShortForms(): Promise<Array<{ brain: string; short: string }>> {
  if (manualsCache && Date.now() - manualsCache.at < 3_600_000) return manualsCache.rows;
  const sb = admin();
  if (!sb) return [];
  try {
    const { data } = await sb.from("brain_manuals").select("brain, short_form").eq("item", "summary");
    const rows = ((data ?? []) as Array<{ brain: string; short_form: string | null }>).filter((r) => r.short_form).map((r) => ({ brain: r.brain, short: r.short_form as string }));
    manualsCache = { at: Date.now(), rows };
    return rows;
  } catch { return []; }
}

export type IntakeRun = { answer: IntakeAnswer | null; ds: IntakeAnswer | null; agree: ReturnType<typeof intakeAgreement>; ms: number; cacheRead: number | null; skippedDs: string | null };

export async function runConductorIntake(o: {
  conversationId: string; turnAt: string | null; customerTurn: string; lastStaff: string | null; ledgerBlock: string; carryLine: string; ruleMeta: string; timeoutMs?: number;
}): Promise<IntakeRun | null> {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  if (!key) return null;
  const t0 = Date.now();
  const prefix = intakePrefix(await loadManualShortForms());
  const user = intakeUser(o);
  const sonnet = (async (): Promise<{ answer: IntakeAnswer | null; cacheRead: number | null }> => {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: AbortSignal.timeout(o.timeoutMs ?? 8_000),
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...sumoraLlmMarks("conductor_intake", o.conversationId) },
        body: JSON.stringify({
          model: "claude-sonnet-5", max_tokens: 300, thinking: { type: "disabled" },
          system: [{ type: "text", text: prefix, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!r.ok) { console.warn(JSON.stringify({ tag: "conductor:intake-http", status: r.status })); return { answer: null, cacheRead: null }; }
      const d = (await r.json()) as { content?: Array<{ type: string; text?: string }>; usage?: { cache_read_input_tokens?: number } };
      return { answer: parseIntake(d.content?.find((b) => b.type === "text")?.text ?? ""), cacheRead: d.usage?.cache_read_input_tokens ?? null };
    } catch (e) { console.warn(JSON.stringify({ tag: "conductor:intake-failed", error: e instanceof Error ? e.message : String(e) })); return { answer: null, cacheRead: null }; }
  })();
  let skippedDs: string | null = null;
  const compare = intakeCompareTurn(o.conversationId, o.turnAt);
  let dsP: Promise<IntakeAnswer | null> = Promise.resolve(null);
  if (compare) {
    const { altPiiSignal } = await import("./alt-pii-gate");
    const pii = altPiiSignal(`${o.customerTurn}\n${o.lastStaff ?? ""}\n${o.ledgerBlock}`);
    if (pii) skippedDs = `pii:${pii}`;
    else {
      const { callDeepSeek } = await import("./vision-alt-provider");
      dsP = callDeepSeek(prefix, user, { maxTokens: 300, thinking: false, temperature: 0, timeoutMs: o.timeoutMs ?? 8_000 })
        .then((res) => parseIntake(res?.text ?? ""))
        .catch(() => null);
    }
  }
  const [s, ds] = await Promise.all([sonnet, dsP]);
  return { answer: s.answer, ds, agree: intakeAgreement(s.answer, ds), ms: Date.now() - t0, cacheRead: s.cacheRead, skippedDs };
}
