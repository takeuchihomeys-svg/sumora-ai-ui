// 内覧が終わった後の返信が「内覧前の文」にならないか（YUMA・本番と同じ generate-reply 経由）
//
// 2026-09-21 竹内（まりあさん事例）「なんでここ明日会えるの楽しみ等今の分からない文がでているのか。
//   ブレインの部分は判断できている。ブレインと文生成の部分にズレが起きている」
//   実物の下書き: 「はい😊！！／明日お会い出来るのを楽しみにしております！！／お気をつけてお越しください😌！！」
//   原因: 行動台帳が待ち合わせを日付だけで見て、内覧後のお礼を送った後も「この内覧は決まっている」と渡していた
//
// 場面（まりあさんの実物の流れを今日の日付で再現）:
//   前日 22:33 こちら「明日16:00に…現地エントランスお待ち合わせ」→ 当日 13:40「本日16時よりご案内」
//   → 15:51 お客様「数分遅れるかもです」→ 16:04 こちら「お気をつけてお越しください」
//   → 20:13 こちら「本日お時間頂きありがとうございました…お母様を連帯保証人様に…」→ お客様「母に聞いてみます！」
//
// ⚠ テストの見方: ①下書きが出たか ②内覧前の文（会う予定・楽しみ・道中の気遣い）が無いか を別々に出す。3回動かす。
// ⚠ 書き込みを伴う（YUMA に場面を入れて、確認後に必ず消す）。
// 実行: npx tsx --env-file=.env.local scripts/yuma-after-viewing-test.ts [--runs=3]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const RUNS = Number((process.argv.find((a) => a.startsWith("--runs=")) ?? "--runs=3").split("=")[1]);
/** 内覧前・当日の段取りの言葉（済んだ内覧の後には出てはいけない） */
const PRE_VIEWING_RE = /お会い(?:出来る|できる)のを楽しみ|お気をつけてお越し|明日[^\n]{0,10}(?:お会い|ご案内)|本日[^\n]{0,6}\d{1,2}時[^\n]{0,10}ご案内/;
const FAIL_RE = /生成に失敗|AI返信の生成/;

function jst(dayOffset: number, hm: string): string {
  const now = new Date(Date.now() + 9 * 3600_000);
  const ymd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset)).toISOString().slice(0, 10);
  return new Date(`${ymd}T${hm}:00+09:00`).toISOString();
}

async function main() {
  // 今が当日 20:30 より前なら、場面の時刻が未来になってしまう
  const nowJstH = new Date(Date.now() + 9 * 3600_000).getUTCHours();
  if (nowJstH < 21) { console.log("⚠ 日本時間 21時以降に動かす（場面の時刻が未来になるため）"); return; }
  const scene = [
    { sender: "staff", text: "明日16:00にRISING Maison 本町橋 \n現地エントランスお待ち合わせで何卒よろしくお願い致します😌！！\n住所: 大阪府大阪市中央区本町橋8-1", createdAt: jst(-1, "22:33") },
    { sender: "customer", text: "わかりました！", createdAt: jst(-1, "22:38") },
    { sender: "staff", text: "YUMAさんお世話になっております！！\n本日16時よりお部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！", createdAt: jst(0, "13:40") },
    { sender: "customer", text: "数分遅れるかもですすみません💦", createdAt: jst(0, "15:51") },
    { sender: "staff", text: "かしこまりました！！\nお気をつけてお越しください😌！！", createdAt: jst(0, "16:04") },
    { sender: "staff", text: "YUMAさん\n本日お時間頂きありがとうございました！！\nスプランディッド堀江お気に召されましたらお申込みさせていただきます😊！！\n\nお申込みの際にお母様を連帯保証人様に設定可能かもご連絡お待ちしております😌！！", createdAt: jst(0, "20:13") },
    { sender: "customer", text: "母に聞いてみます！", createdAt: jst(0, "21:15") },
  ];
  const { data: before } = await sb.from("conversations").select("status, has_viewed").eq("id", YUMA).maybeSingle();
  const orig = (before ?? {}) as { status?: string; has_viewed?: boolean };
  const ins = await sb.from("messages").insert(scene.map((m) => ({ conversation_id: YUMA, sender: m.sender, text: m.text, created_at: m.createdAt }))).select("id");
  if (ins.error) { console.log(`場面を作れず: ${ins.error.message}`); return; }
  const made = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  await sb.from("conversations").update({ status: "viewing", has_viewed: true }).eq("id", YUMA);
  const results: Array<{ drafted: boolean; clean: boolean }> = [];
  try {
    for (let i = 0; i < RUNS; i++) {
      let draft = "";
      try {
        const res = await fetch(`${BASE}/api/generate-reply`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "母に聞いてみます！", customerMessages: ["母に聞いてみます！"], state: "viewing",
            conversationId: YUMA, customerName: "YUMA", hasViewed: true, activeTaskTypes: [],
            recentMessages: scene.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt, isAix: false })),
          }),
          signal: AbortSignal.timeout(300_000),
        });
        const raw = await res.text();
        const nl = raw.indexOf("\n");
        const meta = nl >= 0 ? (JSON.parse(raw.slice(0, nl)) as { ok?: boolean; reason?: string }) : { ok: false };
        draft = meta.ok ? raw.slice(nl + 1) : `（生成されず: ${(meta as { reason?: string }).reason ?? "?"}）`;
      } catch (e) { draft = `（エラー: ${e instanceof Error ? e.message : String(e)}）`; }
      const body = draft.replace(/\n?<<<[A-Z_]+:[\s\S]*?(?:>>>|$)/g, "").trim();
      const drafted = body.length > 5 && !FAIL_RE.test(body) && !/^（/.test(body);
      const clean = drafted && !PRE_VIEWING_RE.test(body);
      results.push({ drafted, clean });
      console.log(`\n── ${i + 1}回目 ──\n${body.replace(/\n/g, " ／ ").slice(0, 260)}`);
      console.log(`   ${drafted ? "✅ 下書きが出た" : "⚠ 下書きが出ていない"} ／ ${clean ? "✅ 内覧前の文なし" : "⚠ 内覧前の文あり"}`);
    }
  } finally {
    await sb.from("messages").delete().in("id", made);
    await sb.from("conversations").update({ status: orig.status ?? "proposing", has_viewed: orig.has_viewed ?? false, ai_draft: null, ai_draft_check: null }).eq("id", YUMA);
  }
  console.log(`\n=== まとめ ===\n   下書きが出た ${results.filter((r) => r.drafted).length}/${RUNS} ／ 内覧前の文なし ${results.filter((r) => r.clean).length}/${RUNS}`);
  console.log(`   後片付け: 場面 ${made.length}件を削除・YUMA の段階を ${orig.status} に戻した`);
}
main().catch((e) => { console.error(e); process.exit(1); });
