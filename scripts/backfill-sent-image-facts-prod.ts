// scripts/backfill-sent-image-facts-prod.ts
// 送った物件の資料の画像（sent_image_properties・facts が空）を本番の行まで DeepSeek で読み直す。既定は数えるだけ。
// 2026-10-06 竹内さん（このセッションで直接）「まだ読み取っていない画像3,540枚を DeepSeek で読み直す」「画像の読みなおしもおこなう」。
//   ⑰の調査: 🌟とスコアの一致を上げる一番の壁は材料の欠け（候補の設備 9%・築年 17%…）。重みを変える前に材料を埋める。
// 歯止め（⑰の案のまま・どれか1つでも当たれば読まない）:
//   ・置き場は property-images だけ（お客様の画像の置き場・売上サポの期限切れは読まない）
//   ・見積書（source が aix:estimate_sheet）は読まない（お客様の名前入り）
//   ・同じ画像の messages の行がお客様の送信、または本人確認書類・収入/身元の書類なら読まない
//   ・申込以降の会話は loadDeepseekCutoff の線に従う（null＝読まない・ISO＝その時刻より後の画像だけ）
//   ・書くのは facts が空の行だけ
// 実行: npx tsx --env-file=.env.local scripts/backfill-sent-image-facts-prod.ts [--days=400] [--apply] [--max=N] [--conc=6]
import { createClient } from "@supabase/supabase-js";
import { readPropertyImage } from "../app/lib/property-image-read";
import { factsFromImageRead } from "../app/lib/candidate-facts";
import { loadDeepseekCutoff, NO_CUTOFF, type DeepseekCutoff } from "../app/lib/post-apply";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "400"), 10);
const MAX = parseInt(String(args.max ?? "100000"), 10);
const CONC = Math.max(1, Math.min(8, parseInt(String(args.conc ?? "6"), 10)));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ?? "");
type Row = Record<string, any>;

async function all(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
  }
  return out;
}

const inPropertyImages = (u: string) => /\/property-images\//.test(u);
const isEstimate = (s: unknown) => /estimate/i.test(String(s ?? ""));

async function main() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const rows = await all((a, b) => sb.from("sent_image_properties").select("image_url, conversation_id, property_name, room_no, source, created_at, facts").is("facts", null).gte("created_at", since).order("created_at").range(a, b) as never);
  const skip: Record<string, number> = { notPropertyImages: 0, estimate: 0, customerOrDoc: 0, postApply: 0 };
  const cutoffCache = new Map<string, DeepseekCutoff>();
  const ok: Row[] = [];
  for (const r of rows) {
    const url = String(r.image_url ?? "");
    if (!inPropertyImages(url)) { skip.notPropertyImages++; continue; }
    if (isEstimate(r.source)) { skip.estimate++; continue; }
    ok.push(r);
  }
  // 同じ画像の messages の行（お客様の送信・書類）を調べる
  const urls = ok.map((r) => String(r.image_url));
  const bad = new Set<string>();
  for (let i = 0; i < urls.length; i += 25) {
    const { data, error } = await sb.from("messages").select("image_url, sender, image_type").in("image_url", urls.slice(i, i + 25));
    if (error) throw new Error(error.message);
    for (const m of (data ?? []) as Row[]) {
      if (m.sender === "customer" || /id_document|income_document/.test(String(m.image_type ?? ""))) bad.add(String(m.image_url));
    }
  }
  const targets: Row[] = [];
  for (const r of ok) {
    if (bad.has(String(r.image_url))) { skip.customerOrDoc++; continue; }
    const cid = String(r.conversation_id ?? "");
    if (!cutoffCache.has(cid)) cutoffCache.set(cid, await loadDeepseekCutoff(sb as never, cid || null));
    const cut = cutoffCache.get(cid)!;
    const allowed = cut === NO_CUTOFF || (typeof cut === "string" && Date.parse(r.created_at) > Date.parse(cut));
    if (!allowed) { skip.postApply++; continue; }
    targets.push(r);
  }
  console.log(`facts が空の行（${since.slice(0, 10)} 以降）: ${rows.length}`);
  console.log(`読まない: ${JSON.stringify(skip)}`);
  console.log(`読む対象: ${targets.length}`);
  if (!args.apply) { console.log("（数えるだけ。書く時は --apply）"); return; }

  const work = targets.slice(0, MAX);
  let done = 0, wrote = 0, unread = 0, failed = 0, tin = 0, tout = 0;
  let idx = 0;
  async function worker() {
    while (idx < work.length) {
      const r = work[idx++];
      try {
        const read = await readPropertyImage(String(r.image_url), { timeoutMs: 80_000 });
        tin += Number(read.usage?.input ?? 0); tout += Number(read.usage?.output ?? 0);
        const item = read.items.length === 1 ? read.items[0] : null;
        if (!item) { unread++; }
        else {
          const f = factsFromImageRead(item);
          const facts = { ...f, src: "image", model: process.env.PROPERTY_IMAGE_MODEL ?? "deepseek-flash", backfill: true };
          const { error } = await sb.from("sent_image_properties").update({ facts, facts_read_at: new Date().toISOString() })
            .eq("image_url", r.image_url).eq("conversation_id", r.conversation_id).is("facts", null);
          if (error) failed++; else wrote++;
        }
      } catch { failed++; }
      done++;
      if (done % 100 === 0) console.log(`  ${done}/${work.length} 書いた ${wrote}・読めない ${unread}・失敗 ${failed}・tokens in ${tin} out ${tout}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`完了: ${done}/${work.length} 書いた ${wrote}・読めない ${unread}・失敗 ${failed}・tokens in ${tin} out ${tout}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
