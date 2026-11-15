// scripts/audit-appeal-strength-lines.ts
// 竹内さんの「お送りさせて頂きましたお部屋の中でも」で、強さ（案内する／扉だけ／強く押す）と狙う返事（内覧／扉だけ／申込）を
// どの状況で選んでいるかの線を探す（読むだけ・LLM なし・費用0）。統括役の (a): 刺さり具合・場面・前の訴求からの間・地図の駅で分ける。
// 線が見つからない時は「見つからない」と出す（推測で線を作らない）。手本は竹内さんの送信だけ（従業員は数えない）。
//
// 分け方（決定論・文から読める物だけ）:
//   刺さり（お客様の直前の一言・送信の48時間前まで）: positive（気になる・いいですね・見たい・内覧）／question（？・ですか）／thanks（お礼だけ）／none
//   前の訴求からの間（同じ会話のスタッフの🌟・お部屋の中でも・オススメの送信）: 1時間未満／1〜24時間／24時間以上／初めて
//   場面（直前のスタッフの送信・3時間以内）: card（🌟のカード）／list（物件の一覧・資料）／estimate（御見積）／other
//   地図の駅（統括の situation_now）: 保存された値が無い番は「無し」で数える
// 実行: npx tsx --env-file=.env.local scripts/audit-appeal-strength-lines.ts [--days=90]
import { createClient } from "@supabase/supabase-js";
import { appealRecordFromText } from "../app/lib/appeal-record";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "90"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
type Row = Record<string, any>;
const H = 3600_000;

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const { data: sends } = await sb.from("messages").select("conversation_id, created_at, text").eq("sender", "staff").eq("staff_writer", "takeuchi").gte("created_at", since).like("text", "%お部屋の中でも%").limit(500);
  const rows = ((sends ?? []) as Row[]).filter((m) => m.conversation_id !== YUMA_CONVERSATION_ID);
  type Feat = { reaction: string; gap: string; scene: string; vacancy: string; aim: string; strength: string };
  const feats: Feat[] = [];
  for (const m of rows) {
    const t = Date.parse(m.created_at);
    const { data: around } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", m.conversation_id)
      .lt("created_at", m.created_at).gte("created_at", new Date(t - 30 * 864e5).toISOString()).order("created_at", { ascending: false }).limit(60);
    const prev = (around ?? []) as Row[];
    const cust = prev.find((x) => x.sender === "customer" && t - Date.parse(x.created_at) <= 48 * H);
    const ct = String(cust?.text ?? "");
    const reaction = !cust ? "none" : /気にな|いいですね|良いですね|良さそう|素敵|内覧|内見|見たい|見に行|見れ|魅力/.test(ct) ? "positive" : /[？?]|ですか|ますか/.test(ct) ? "question" : /ありがとう|承知|了解|わかりました|分かりました/.test(ct) ? "thanks" : "other";
    const lastAppeal = prev.find((x) => x.sender === "staff" && /🌟|お部屋の中でも|オススメ|おすすめ/.test(String(x.text ?? "")));
    const gh = lastAppeal ? (t - Date.parse(lastAppeal.created_at)) / H : null;
    const gap = gh == null ? "初めて" : gh < 1 ? "1時間未満" : gh < 24 ? "1〜24時間" : "24時間以上";
    const staffPrev = prev.find((x) => x.sender === "staff" && t - Date.parse(x.created_at) <= 3 * H);
    const st = String(staffPrev?.text ?? "");
    const scene = !staffPrev ? "other" : /^🌟|🌟/.test(st) ? "card" : /御見積|お見積/.test(st) ? "estimate" : /https?:\/\/|資料|物件/.test(st) ? "list" : "other";
    const r = appealRecordFromText(String(m.text), { surface: "reply", writer: "takeuchi" });
    const vacancy = r.whyNow.includes("退去予定") ? "退去予定" : r.whyNow.includes("空室") ? "空室" : "書いていない";
    feats.push({ reaction, gap, scene, vacancy, aim: r.aim, strength: r.strength });
  }
  const n = feats.length;
  console.log(`竹内さんの「お部屋の中でも」${n}通（${DAYS}日）・地図の駅（situation_now）は保存の欄が見つからず「無し」`);
  for (const key of ["reaction", "gap", "scene", "vacancy"] as const) {
    console.log(`\n=== ${key === "reaction" ? "刺さり（直前のお客様の一言）" : key === "gap" ? "前の訴求からの間" : key === "vacancy" ? "部屋の状況（文の中の退去予定・空室）" : "場面（直前のスタッフの送信）"} × 狙う返事／強さ ===`);
    const groups = new Map<string, Feat[]>();
    for (const f of feats) { const k = f[key]; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(f); }
    for (const [k, xs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const cnt = (field: "aim" | "strength") => { const m = new Map<string, number>(); for (const x of xs) m.set(x[field], (m.get(x[field]) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, c]) => `${v} ${c}`).join("・"); };
      console.log(`  ${k.padEnd(8)} ${String(xs.length).padStart(3)}通 ｜ 狙う返事: ${cnt("aim")} ｜ 強さ: ${cnt("strength")}`);
    }
  }
  // 線の候補: ある分けで「内覧に案内」が8割以上、または8割以下に落ちる（5通以上の組だけ）
  const base = feats.filter((f) => f.aim === "viewing").length / (n || 1);
  console.log(`\n全体で内覧に案内: ${Math.round(base * 100)}%`);
  const lines: string[] = [];
  for (const key of ["reaction", "gap", "scene", "vacancy"] as const) {
    const groups = new Map<string, Feat[]>(); for (const f of feats) { const k = f[key]; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(f); }
    for (const [k, xs] of groups) { if (xs.length < 5) continue; const v = xs.filter((x) => x.aim === "viewing").length / xs.length; if (v >= 0.8 || v <= base - 0.3) lines.push(`${key}=${k}（${xs.length}通）で内覧に案内 ${Math.round(v * 100)}%`); }
  }
  console.log(lines.length ? `線の候補（5通以上・内覧に案内が8割以上か全体より30点以上低い）:\n  ${lines.join("\n  ")}` : "線の候補: 見つからない（どの分けでも全体と大きく変わらない）");
})().catch((e) => { console.error(e); process.exit(1); });
