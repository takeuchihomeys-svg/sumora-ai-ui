// scripts/audit-our-send-uptake.ts — 竹内さんの198通で「こちらの直前の送信が、部分ごとにどう受け取られたか」と、竹内さんの返し方を数える（読むだけ・LLM なし・DB は id の索引だけ・作業員16・2026-11-12）
//   竹内さん 11/12「こちらから送っている事に対して、お客さんはどこの部分を理解して、どこの部分を理解できていないか等も読み取れるようになっているか」。
//   純関数は app/lib/our-send-uptake.ts。材料: exam-cache/anatomy-roles/roles-r1.json（竹内さんの返信・お客様の文）＋ messages（竹内さんの返信の id → 同じ会話の直前のこちらの送信だけ）。
//   決まり: 申込の書類・個人の値は入れない（turn-application-gate と同じ線で外す）・外部の API に渡さない・出力は --out の手元の json だけ（名前は伏せる）。
// 実行: npx tsx --env-file=<.env> scripts/audit-our-send-uptake.ts --out=<json> [--fetch]（--fetch の無い時は --out の json を読み直して数えるだけ・DB を読まない）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { takeuchiMove } from "./next-move-score";
import { NEXT_DEST_LABEL } from "../app/lib/next-move-types";
import { splitOurSend, readUptake, takeuchiRepairOf, type OurSendPart, type PartUptake } from "../app/lib/our-send-uptake";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CACHE = join(__dirname, "..", "..", "..", "exam-cache");
const OUT = arg("out");
if (!OUT) { console.error("--out=<json> が要る"); process.exit(1); }

type Roles = { id: string; scene: string; customer?: string; sentences?: string[] };
type Row = { id: string; scene: string; ourSend: string | null; customer: string; takeuchi: string[] };
const UPTAKE_SHORT: Record<string, string> = { passed: "流した", asked_again: "聞き返した", misread: "取り違えた", answered: "答えた", accepted: "了承" };
const mask = (s: string) => s.replace(/[一-龠ぁ-んァ-ヶA-Za-z]{1,8}(?:さん|様)/g, "YUMAさん").replace(/0\d{1,4}-?\d{2,4}-?\d{3,4}/g, "〈番号〉").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "〈メール〉");
const APPLY_DOC = /本人確認|免許証|保険証|マイナンバー|生年月日|年収|源泉|勤務先の電話|緊急連絡先の/;

async function fetchRows(R: Roles[]): Promise<Row[]> {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
  const ids = R.map((r) => r.id);
  const meta = new Map<string, { conversation_id: string; created_at: string }>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, created_at").in("id", ids.slice(i, i + 100));
    if (error) throw error;
    for (const m of (data ?? []) as Array<{ id: string; conversation_id: string; created_at: string }>) meta.set(m.id, m);
  }
  const out: Row[] = [];
  for (const r of R) {
    const m = meta.get(r.id);
    let ourSend: string | null = null;
    if (m) {
      // 竹内さんの返信の前の 12 通（索引: conversation_id × created_at）。お客様の今の一通の前の、こちらの最後の送信の塊を取る
      const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", m.conversation_id).lt("created_at", m.created_at).order("created_at", { ascending: false }).limit(12);
      const rows = (data ?? []) as Array<{ sender: string; text: string | null }>;
      let i = 0;
      while (i < rows.length && rows[i].sender === "customer") i++; // お客様の今の一通（連投）を飛ばす
      const ours: string[] = [];
      while (i < rows.length && rows[i].sender !== "customer") { if (rows[i].text) ours.unshift(rows[i].text!); i++; }
      const t = ours.join("\n").trim();
      ourSend = t && !APPLY_DOC.test(t) ? mask(t).slice(0, 1500) : null;
    }
    out.push({ id: r.id, scene: r.scene, ourSend, customer: mask(r.customer ?? "").slice(0, 600), takeuchi: (r.sentences ?? []).map(mask) });
  }
  return out;
}

(async () => {
  const R = JSON.parse(readFileSync(join(CACHE, "anatomy-roles", "roles-r1.json"), "utf8")) as Roles[];
  let rows: Row[];
  if (process.argv.includes("--fetch") || !existsSync(OUT)) { rows = await fetchRows(R); writeFileSync(OUT, JSON.stringify(rows, null, 1)); }
  else rows = JSON.parse(readFileSync(OUT, "utf8")) as Row[];
  const S = new Map((JSON.parse(readFileSync(join(CACHE, "anatomy-seven", "seven-all198.json"), "utf8")) as Array<Parameters<typeof takeuchiMove>[0]>).map((x) => [x.id, x]));
  const hookMove = new Map<string, number>();
  const hookEx = new Map<string, string[]>();
  let withSend = 0;
  const partCount = new Map<OurSendPart["kind"], number>();
  const upCount = new Map<string, number>();
  const repair = new Map<string, number>();
  const ex = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.ourSend) continue; withSend++;
    const parts = splitOurSend(r.ourSend);
    for (const p of parts) partCount.set(p.kind, (partCount.get(p.kind) ?? 0) + 1);
    const ups: PartUptake[] = readUptake(parts, r.customer);
    for (const u of ups) upCount.set(`${u.part.kind}:${u.uptake}`, (upCount.get(`${u.part.kind}:${u.uptake}`) ?? 0) + 1);
    const sv = S.get(r.id), rr = R.find((x) => x.id === r.id);
    if (sv && rr) {
      const mv = takeuchiMove(sv, rr);
      const seen = new Set<string>(); // 1つの番は1回だけ数える（同じ送信の物件の部分が何個あっても）
      for (const u of ups) {
        if (!u.hook || u.hook.kind === "neutral") continue;
        const sk = `${u.hook.kind}:${u.hook.degree}:${u.hook.reason}`; if (seen.has(sk)) continue; seen.add(sk);
        const k =`${u.hook.kind === "hooked" ? "刺さった" : "刺さらない"}:${u.hook.point ?? u.hook.reason ?? "点不明"}:${u.hook.degree ?? "-"} → ${NEXT_DEST_LABEL[mv.dest]}×${mv.strength}`;
        hookMove.set(k, (hookMove.get(k) ?? 0) + 1);
        const e = hookEx.get(k) ?? []; if (e.length < 2) e.push(`客「${r.customer.replace(/\s+/g, " ").slice(0, 36)}」`); hookEx.set(k, e);
      }
    }
    // 伝わっていない部分＝聞いた事を流した・誘いを流した・説明済みを聞き返した・約束を取り違えた（伝えた事実を流すのは普通＝数えない）
    const gap = ups.filter((u) => u.uptake === "asked_again" || u.uptake === "misread" || (u.uptake === "passed" && (u.part.kind === "question" || u.part.kind === "invite")));
    if (!gap.length) continue;
    const rp = takeuchiRepairOf(gap, r.takeuchi);
    const kinds = [...new Set(gap.map((g) => `${UPTAKE_SHORT[g.uptake]}:${g.part.kind}`))].sort();
    const k = `${kinds.join("+")} → ${rp.kind}`;
    repair.set(k, (repair.get(k) ?? 0) + 1);
    const e = ex.get(k) ?? []; if (e.length < 2) e.push(`客「${r.customer.replace(/\s+/g, " ").slice(0, 40)}」／竹「${r.takeuchi.join("").slice(0, 50)}」`); ex.set(k, e);
  }
  console.log(`直前のこちらの送信が取れた番 ${withSend}/${rows.length}`);
  console.log("部分の種類:", Object.fromEntries(partCount));
  console.log("受け取られ方:", Object.fromEntries([...upCount.entries()].sort((a, b) => b[1] - a[1])));
  console.log("\n伝わっていない・流された部分があった番の竹内さんの返し方:");
  for (const [k, v] of [...repair.entries()].sort((a, b) => b[1] - a[1])) console.log(`${v}\t${k}\n\t${(ex.get(k) ?? []).join("\n\t")}`);
  console.log("\n刺さった・刺さらなかった部分 → 竹内さんの次の一手（行き先×強さ）:");
  for (const [k, v] of [...hookMove.entries()].sort((a, b) => b[1] - a[1])) console.log(`${v}\t${k}\t${(hookEx.get(k) ?? []).join(" ／ ")}`);
})().catch((e) => { console.error(e); process.exit(1); });
