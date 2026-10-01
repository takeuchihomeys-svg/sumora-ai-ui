// tmp(コミットしない): AIX テンプレート（2通目）を YUMA の材料で**送らずに**生成だけ回す（場面ごと・何回も）
// 実行: SIM_BASE=http://localhost:3200 npx tsx --env-file=.env.local scripts/tmp-second-style-gen.ts --scene=a,b,c,d1,d2 --n=5 [--out=名前]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { findAiPhrases, styleStatsOf } from "../app/lib/second-message-style";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const BASE = process.env.SIM_BASE ?? "http://localhost:3200";
const SP = "C:/Users/竹内悠~1/AppData/Local/Temp/claude/c--Users-------sumora-ai-ui/90d5437f-9ec8-479d-94e9-1097dde86432/scratchpad";
const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = Number(arg("n", "5"));
const WANT = arg("scene", "a,b,c,d1,d2").split(",");
const OUT = arg("out", `gen-${Date.now()}`);

// 1通目（今日 YUMA に実際に届いた AIX 物件オススメの本文）を sends/*.json から取る
function firstOf(id: number): string {
  const f = readdirSync(`${SP}/sends`).filter((x) => x.endsWith(`chain_${id}.json`)).sort().pop();
  if (!f) throw new Error(`sends に chain_${id} が無い`);
  const j = JSON.parse(readFileSync(`${SP}/sends/${f}`, "utf8")) as { gen1?: { text?: string } };
  // 1通目の出口の重複（同じ締めが2回）は今日直っているので、重複行は1つにする
  const t = String(j.gen1?.text ?? "");
  const paras = t.split(/\n\n/); const seen = new Set<string>();
  return paras.filter((p) => { const k = p.replace(/召し/, "召され"); if (seen.has(k)) return false; seen.add(k); return true; }).join("\n\n");
}
const F2676 = firstOf(2676).replace(/空室のため即入居可能です。?/, "").trim(); // S-RESIDENCE福島玉川Deux 208（玉川4分・2023年築）
const F2677 = firstOf(2677); // プレミアム新福島 505
const F2670 = firstOf(2670); // レオパレス天満 107
const F2672 = firstOf(2672); // エスリード福島第5 503

type Scene = { key: string; label: string; pickupType: string | null; first: string; note?: string };
const SCENES: Scene[] = [
  { key: "a", label: "(a) 複数送った中で1件を推す（継続ピックアップ）", pickupType: "継続ピックアップ", first: F2676 },
  { key: "a2", label: "(a) 複数送った中で1件を推す・別の物件", pickupType: "継続ピックアップ", first: F2677 },
  { key: "b", label: "(b) 新着1件", pickupType: "新着1件", first: F2672 },
  { key: "c", label: "(c) 1件だけのオススメ（新規ピックアップ）", pickupType: "新規ピックアップ", first: F2670 },
  { key: "c0", label: "(c) ピッカーなし（今日の通しと同じ body）", pickupType: null, first: F2676 },
  { key: "d1", label: "(d) 退去予定（刺さる→申込誘導）", pickupType: "継続ピックアップ",
    first: F2676.replace(/\n\nお気に召[^\n]+$/, "\n\n10月15日退去予定のため、10月16日以降ご内覧可能です！！\n\nお気に召されましたらお申込しお部屋抑えさせて頂きます😊！！") },
  { key: "d2", label: "(d) 退去予定・新着", pickupType: "新着1件",
    first: F2677.replace(/\n\nお手隙[^\n]+$/, "\n\n10月末退去予定のため、11月1日以降ご内覧可能です！！\n\nお手隙の際にご査収ください😊！！") },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatConditions(c: Record<string, any>): string {
  const lines: string[] = [];
  if (c.desired_area) lines.push(`エリア: ${c.desired_area}`);
  if (c.floor_plan) lines.push(`間取り: ${c.floor_plan}`);
  if (c.rent_max) lines.push(`家賃: ${c.rent_max / 10000}万円以内`);
  if (c.walk_minutes) lines.push(`駅徒歩: ${c.walk_minutes}分以内`);
  if (c.move_in_time) lines.push(`入居: ${c.move_in_time}`);
  if (c.building_age) lines.push(`築年数: ${c.building_age}年以内`);
  if (c.preferences) lines.push(`希望: ${c.preferences}`);
  if (c.ng_points) lines.push(`NG: ${c.ng_points}`);
  if (c.other_requests) lines.push(`その他: ${c.other_requests}`);
  return lines.join("\n");
}

async function main() {
  const { data: conv } = await sb.from("conversations").select("customer_name, status").eq("id", Y).single();
  const c = conv as { customer_name: string; status: string };
  const { data: pcr } = await sb.from("property_customers").select("*").eq("id", PC).single();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pc = pcr as Record<string, any>;
  const customerConditions = formatConditions(pc);
  const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(14);
  const base = ((ms ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated }));
  const out: string[] = [];
  const log = (s: string) => { console.log(s); out.push(s); };
  for (const sc of SCENES.filter((s) => WANT.includes(s.key))) {
    log(`\n━━━━ ${sc.label} ／ pickupType=${sc.pickupType ?? "なし"}\n【1通目】${sc.first.replace(/\n/g, " ⏎ ")}`);
    const now = new Date().toISOString();
    const recent = [...base, { sender: "staff", text: "[画像]", rawCreatedAt: now, isAix: true }, { sender: "staff", text: sc.first, rawCreatedAt: now, isAix: true }].slice(-15);
    for (let i = 0; i < N; i++) {
      const t0 = Date.now();
      const r = await fetch(`${BASE}/api/aix-template-generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        actionType: "property_recommendation", actionCategory: "物件オススメ【AIX】", conversationId: Y, customerName: c.customer_name ?? "YUMA", conversationState: c.status,
        recentMessages: recent, customerConditions, customerSummary: pc.ai_summary ?? null, noEmoji: false, pendingScheduledMessages: [], staffMessagedToday: true,
        pickupType: sc.pickupType, lastAixCheckPattern: null, sentMessage: sc.first,
      }), signal: AbortSignal.timeout(150_000) });
      const j = await r.json().catch(() => ({})) as { ok?: boolean; text?: string; error?: string };
      const text = String(j.text ?? "");
      const st = styleStatsOf(text);
      const hits = findAiPhrases(text).map((h) => h.key);
      log(`\n[${sc.key}-${i + 1}] ${((Date.now() - t0) / 1000).toFixed(1)}s ${text.length}字 絵文字${st.emoji} ${hits.length ? `⚠AI語:${hits.join(",")}` : "AI語なし"}${j.error ? ` ERROR:${j.error}` : ""}\n${text}`);
    }
  }
  writeFileSync(`${SP}/s2/${OUT}.txt`, out.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
