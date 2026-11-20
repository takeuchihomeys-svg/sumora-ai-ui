// scripts/audit-shared-property-ref.ts — 「お送り頂きました物件」への置き換え（shared-property-ref）の守り SHARED_REF_GUARD_1121 の全件監査（読むだけ・LLM なし）
//   2026-11-21 作業員G（#454）。line_watch_turns の番ごとに、お客様の連投（番の中のお客様の通）を作り直し、
//   下書き（draft_last）と店の実送信（staff_texts）それぞれに 守り off／on の置き換えを当てて、変わる所を全部出す（目で読む）。
//   off で書き換わる店の実送信＝今の置き換えの誤削除の候補。on で止まった所＝守りが効いた所（壊れた文を止めたか・要る置き換えを止めたか）。
//   ⚠ 9〜22時は回さない（全件読み）。使い方: npx tsx --env-file=<.env.local> scripts/audit-shared-property-ref.ts [--days=120]
import { createClient } from "@supabase/supabase-js";
import { normalizeSharedPropertyReference } from "../app/lib/shared-property-ref";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120"));
const h = new Date().getHours();
if (h >= 9 && h < 22 && !process.argv.includes("--force")) { console.error("9〜22時は回さない"); process.exit(1); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "＜番号＞").replace(/\s+/g, " ");

function run(text: string, turn: string, guard: "on" | "off") {
  process.env.SHARED_REF_GUARD_1121 = guard;
  return normalizeSharedPropertyReference(text, turn);
}
/** 変わった所の前後だけ */
function diffSnip(a: string, b: string): string {
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return `「${mask(a.slice(Math.max(0, i - 20), a.length - j + 10))}」→「${mask(b.slice(Math.max(0, i - 20), b.length - j + 10))}」`;
}

async function main() {
  type W = { id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; draft_last: string | null; staff_texts: Array<{ text?: string }> | null };
  const turns: W[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, draft_last, staff_texts").gte("customer_turn_at", since).order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    turns.push(...((data ?? []) as W[])); if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, W[]>();
  for (const t of turns.filter((x) => !isTestConversation(x.conversation_id))) { const a = byConv.get(t.conversation_id) ?? []; a.push(t); byConv.set(t.conversation_id, a); }
  const n = { turns: 0, shared: 0, draftOff: 0, draftOnStopped: 0, staffOff: 0, staffOnStopped: 0 };
  const convIds = [...byConv.keys()];
  for (let c = 0; c < convIds.length; c += 30) {
    const ch = convIds.slice(c, c + 30);
    const msgs: Array<{ conversation_id: string; created_at: string; text: string | null }> = [];
    for (let i = 0; ; i += 1000) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, text").in("conversation_id", ch).eq("sender", "customer").gte("created_at", since).order("created_at").range(i, i + 999);
      if (error) throw new Error(error.message);
      msgs.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
    }
    for (const cid of ch) {
      for (const t of byConv.get(cid) ?? []) {
        n.turns++;
        const a = Date.parse(t.customer_turn_at) - 60_000, b = Date.parse(t.customer_last_at ?? t.customer_turn_at) + 60_000;
        const turn = msgs.filter((m) => m.conversation_id === cid && Date.parse(m.created_at) >= a && Date.parse(m.created_at) <= b).map((m) => m.text ?? "").join("\n");
        if (!/https?:\/\/|\[画像\]|徒歩/.test(turn)) continue;
        n.shared++;
        const check = (label: "下書き" | "店", text: string) => {
          if (!text) return;
          const off = run(text, turn, "off"), on = run(text, turn, "on");
          if (off.count) { if (label === "下書き") n.draftOff++; else n.staffOff++; }
          if (off.text !== on.text) {
            if (label === "下書き") n.draftOnStopped++; else n.staffOnStopped++;
            console.log(`[${label}] ${cid.slice(0, 8)} ${t.customer_turn_at.slice(0, 10)} 守りで止めた: off ${diffSnip(text, off.text)} ／ on ${on.text === text ? "書き換えなし" : diffSnip(text, on.text)}`);
          } else if (off.count && label === "店") {
            console.log(`[店・今の置き換えが実送信を書き換える] ${cid.slice(0, 8)} ${t.customer_turn_at.slice(0, 10)} ${diffSnip(text, off.text)}`);
          }
        };
        check("下書き", t.draft_last ?? "");
        check("店", (t.staff_texts ?? []).map((s) => s.text ?? "").join("\n"));
      }
    }
  }
  delete process.env.SHARED_REF_GUARD_1121;
  console.log(JSON.stringify(n));
}
main().catch((e) => { console.error(e); process.exit(1); });
