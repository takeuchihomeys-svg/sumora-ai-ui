// 「直前に自分が送った文の焼き直し」が今も出るか（YUMA・本番と同じ経路）
//
// 2026-09-21 竹内（スクショ: ゆーたさん 13:39 の実送信）
//   「生成した文は送った内容と同じ内容を再度送っていた形となるので、これを防ぐ。
//    これ今日の改善前なんやけど、このように全く同じようなLINEが生成されないようにはなってるんかな？」
//
// 【経路】最初 generate-reply を直接叩いたら、6場面すべてでブレインの判断が phone_call のまま動かず、
//   本文が「お電話大丈夫です！！」になった（＝ AIX_ACTION_REPLY_DIRECTION.phone_call の受付例文）。
//   原因は**ブレインを回していなかった**こと（判断は DB の suggested_aix_meta にあり、
//   messages を直接入れても更新されない）。本番は line-webhook → generate-draft-bg-async で
//   **ブレイン→生成**の順に走る。テストもこの経路にする（設計知見「本番検証は画面が渡すのと同じ形で渡す」）。
//
// 【場面の作り方】想像で作らない。scripts/audit-repeat-previous.ts が実データから拾った
//   「焼き直し」の実物（直前のスタッフ送信）をそのまま使う。竹内さんのスクショも1件入れる。
//
// 【測り方】phrase-shape の述部集合（設計知見「繰り返しの検査は定型を数えない」）。
//   生成文の述部が全部「直前のスタッフ送信」に有る＝焼き直し。
//   ⚠ 実送信でも「はい😊！！＋定型の締め」だけの返信は存在する（audit-after-ack: 12件中2件）。
//     だから焼き直しは**禁止**ではなく、**固有の1つ**（確定した日付・物件名・次の予定）が
//     足せる場面で足せているかを見る。
//
// ⚠ 書き込みを伴う（YUMA に場面の2通を入れて、生成後に必ず消す）。テスト会話 YUMA だけで動かす。
// 実行: npx tsx --env-file=.env.local scripts/yuma-repeat-test.ts
//   ※ 前に save / 後に restore: npx tsx --env-file=.env.local scripts/yuma-snapshot.ts save|restore
import { createClient } from "@supabase/supabase-js";
import { predicateOf, splitClauses, messageSimilarity } from "../app/lib/phrase-shape";

/**
 * 全文の近さの線。実送信の連続2通で 2.1%・生成で 0.7% が超える点
 * （scripts/audit-repeat-previous.ts ⑤・直近180日）。
 * ここを超えたら「言い換えただけの焼き直し」として目で読む（自動では何もしない）。
 */
const SIM_WARN = 0.70;

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

/** 入れた行の id を必ず控えて消す（messages に目印カラムが無いため） */
let cleanup: string[] = [];

function predicateSet(text: string): Set<string> {
  const s = new Set<string>();
  for (const c of splitClauses(text)) { const p = predicateOf(c, 8); if (p && p.length >= 4) s.add(p); }
  return s;
}
function judge(cur: string, prev: string) {
  const a = predicateSet(cur), b = predicateSet(prev);
  const fresh = [...a].filter((p) => !b.has(p));
  const sim = messageSimilarity(cur, prev);
  return {
    total: a.size, fresh, sim,
    isReuse: a.size > 0 && fresh.length === 0,     // 述部が全部同じ
    isParaphrase: sim >= SIM_WARN,                  // 言い換えただけ
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 実データから拾った「焼き直しが起きた場面」（staff が直前に送った文 → お客様の返し） */
const SCENES: Array<{ id: string; staff: string; customer: string; want?: RegExp; wantNote?: string; watch?: RegExp; watchNote?: string }> = [
  {
    id: "①竹内さんのスクショ（内覧後の締め→了承）",
    staff: "はい！！\nその間もYUMAさん気になる点出てきましたらお気軽にご質問ください😊！！\n何卒よろしくお願い致します！！",
    customer: "はい！ありがとうございます",
  },
  {
    id: "②内覧後の締め→お礼（9/07 実例）",
    staff: "YUMAさん本日お時間頂きありがとうございました！！\n\nお気に召されましたらお申込しお部屋抑えさせて頂きます！\n\nYUMAさんご帰宅後ご相談いただきご返事お待ちしております😊！！\n気になる点出てきましたらお気軽にご連絡ください！",
    customer: "ありがとうございます",
  },
  {
    id: "③見積書を送った後→お礼（9/12 実例）",
    staff: "こちら初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！\n何卒よろしくお願い致します！！",
    customer: "ありがとうございます！",
  },
  {
    id: "④内覧日が確定した後→了承（9/02 実例）",
    staff: "かしこまりました！！\n9/8（火）ご案内させて頂きます！！\n\n9/8 15:00にウェルスクエア池田井口堂 \n現地エントランスお待ち合わせで何卒よろしくお願い致します！！",
    customer: "はい！",
    want: /9\s*[\/月]\s*8|15\s*[:：]\s*00|ウェルスクエア/,
    wantNote: "実送信はここで日付・時刻・物件名を復唱している（audit-after-ack の実物4件）",
    watch: /ご都合[^\n]{0,12}(?:お日にち|日程)|候補日|ご都合の(?:良|よ)い/,
    watchNote: "日程は確定済み。「ご都合よろしいお日にちに」は前の型の接ぎ木（設計知見・あや 9/16）",
  },
  {
    id: "⑤返答待ちの締め→「明日連絡します」（9/15 実例）",
    staff: "かしこまりました！！\nご返答お待ちしております😊！！\n気になる点等出てきましたらいつでもお気軽にご連絡ください！！",
    customer: "明日の午前中に連絡します",
    want: /明日|午前/,
    wantNote: "お客様が「明日の午前中」と言ったので、そこを受ける（実送信 9/15 は「明日午前中のご連絡お待ちしております」）",
  },
  {
    id: "⑥ピックアップの約束→了承（約束が未履行なので復唱してよい場面）",
    staff: "かしこまりました！！\n塚本・大国町エリアでもオススメ出来るお部屋ピックアップさせて頂きます！！\nピックアップ出来次第ご連絡させて頂きます😌！！",
    customer: "はい、よろしくお願いします",
  },
];

/**
 * bg-async の前提を作る（お客様のターン・下書き無し・生成中の印なし）。
 *
 * ⚠ AIX の判断（suggested_next_aix / suggested_aix_meta）は**消さない**。
 *   一度消して回したら、ブレインが6場面とも property_send（＝AIXを押す場面）と判断し、
 *   reply_mode=aix で下書きが1通も出なくなった。ブレインは前回の判断の上に積む作りなので、
 *   まっさらにすると本番と違う判断になる（設計知見「本番検証は画面が渡すのと同じ形で渡す」）。
 *   場面をまたぐ持ち越しは、場面ごとに messages を入れ替えてブレインを回し直すことで解ける。
 */
async function armConversation() {
  await sb.from("conversations").update({
    last_sender: "customer", ai_draft: null, ai_draft_check: null,
    draft_attempted_at: null, draft_pending_at: null,
    draft_fail_count: 0, draft_last_error: null,
  }).eq("id", YUMA);
}

/**
 * 下書きが書かれるまで待つ。
 * ⚠ カラム名は suggested_next_aix（suggested_aix は存在しない）。
 *   最初 suggested_aix で select したら data が null になり、下書きが保存されているのに
 *   「出なかった」と出続けた（サーバーログには draft saved OK と出ていた）。
 */
async function waitForDraft(timeoutMs = 240_000): Promise<{ draft: string; aix: unknown }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000);
    const { data, error } = await sb.from("conversations")
      .select("ai_draft, suggested_next_aix, suggested_aix_meta, draft_last_error").eq("id", YUMA).maybeSingle();
    if (error) { console.log(`   ⚠ 下書きを読めない: ${error.message}`); return { draft: "", aix: null }; }
    const row = (data ?? {}) as Record<string, unknown>;
    const aix = row.suggested_next_aix ?? (row.suggested_aix_meta as Record<string, unknown> | null)?.action ?? null;
    const d = String(row.ai_draft ?? "");
    if (d === "[AIX誘導中]") return { draft: "", aix };
    if (d && d !== "__SHOWN__") return { draft: d, aix };
  }
  return { draft: "", aix: null };
}

/** 前の実行を途中で止めた時に残った作り物を消す（3時間以内に入れた物だけ） */
async function sweepLeftovers() {
  const since = new Date(Date.now() - 3 * 3600_000).toISOString();
  const texts = SCENES.flatMap((s) => [s.staff, s.customer]);
  const { data } = await sb.from("messages").select("id, text, created_at")
    .eq("conversation_id", YUMA).gte("created_at", since);
  const ids = ((data ?? []) as Array<{ id: string; text: string | null }>)
    .filter((r) => texts.includes(String(r.text ?? ""))).map((r) => r.id);
  if (ids.length) {
    await sb.from("messages").delete().in("id", ids);
    console.log(`=== 前回の残り ${ids.length}件を片付けた ===`);
  }
}

async function main() {
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  // 同じ場面を何回ずつ回すか。
  // ⚠ 1回ずつだと生成のばらつきに埋もれて、直した効果か偶然かが分からない
  //   （設計知見「率をプロンプトで釣ると振り子になる」）。A/B を比べる時は REPS=3 以上にする。
  const reps = Number(process.env.REPS ?? 1);
  await sweepLeftovers();
  let reuse = 0, ok = 0, watchHit = 0, wantMiss = 0, empty = 0;
  const sims: number[] = [];

  const runs = SCENES.flatMap((s) => Array.from({ length: reps }, (_, k) => ({ ...s, id: reps > 1 ? `${s.id}[${k + 1}]` : s.id })));
  for (const s of runs) {
    if (only && !only.some((o) => s.id.includes(o))) continue;

    const now = Date.now();
    const ins = await sb.from("messages").insert([
      { conversation_id: YUMA, sender: "staff", text: s.staff, created_at: new Date(now - 10 * 60_000).toISOString() },
      { conversation_id: YUMA, sender: "customer", text: s.customer, created_at: new Date(now - 60_000).toISOString() },
    ]).select("id");
    if (ins.error) { console.log(`【${s.id}】場面を作れず: ${ins.error.message}`); continue; }
    const made = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    cleanup.push(...made);

    // 前の場面の生成が dev サーバー側でまだ走っている事があるので、in_progress は一度だけ待って撃ち直す
    let skipped = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      await armConversation();
      try {
        const res = await fetch(`${BASE}/api/generate-draft-bg-async`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation_id: YUMA, source: "direct" }),
        });
        const j = await res.json() as Record<string, unknown>;
        skipped = String(j.skipped ?? "");
      } catch (e) { skipped = `fetch失敗:${e instanceof Error ? e.message : String(e)}`; }
      if (skipped !== "in_progress") break;
      await sleep(20_000);
    }

    const { draft, aix } = skipped ? { draft: "", aix: null } : await waitForDraft();
    const out = draft.replace(/\n?<<<[A-Z_]{3,}[\s\S]*?(?:>>>|$)/g, "").trim();

    // 後片付け
    await sb.from("messages").delete().in("id", made);
    cleanup = cleanup.filter((x) => !made.includes(x));
    await sb.from("conversations").update({ ai_draft: null, ai_draft_check: null, draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null }).eq("id", YUMA);
    await sleep(8000);   // dev サーバー側の後処理が次の場面に混ざらないように間を空ける

    console.log(`${"─".repeat(78)}`);
    if (!out) {
      empty++;
      console.log(`【${s.id}】 ⚠ 下書きが出なかった${skipped ? `（skipped=${skipped}）` : "（AIX誘導 or タイムアウト）"}  suggested_aix=${JSON.stringify(aix)}`);
      console.log(`   直前送信: ${s.staff.replace(/\n/g, " ／ ")}`);
      console.log(`   お客様  : ${s.customer}`);
      continue;
    }
    const j = judge(out, s.staff);
    const w = !!(s.watch && s.watch.test(out));
    const wantOk = !s.want || s.want.test(out);
    const bad = j.isReuse || j.isParaphrase;
    if (bad) reuse++; else ok++;
    sims.push(j.sim);
    if (w) watchHit++;
    if (!wantOk) wantMiss++;

    console.log(`【${s.id}】 ${bad ? `❌ 焼き直し（${j.isReuse ? "新しい述部 0個" : `言い換えただけ 近さ${j.sim.toFixed(2)}`}）` : `✅ 中身あり（新しい述部 ${j.fresh.length}個・近さ${j.sim.toFixed(2)}）`}`
      + `${w ? "  ⚠ 見張り語" : ""}${!wantOk ? "  ⚠ 足すべき具体が無い" : ""}`);
    console.log(`   suggested_aix: ${JSON.stringify(aix)}`);
    console.log(`   直前送信: ${s.staff.replace(/\n/g, " ／ ")}`);
    console.log(`   お客様  : ${s.customer}`);
    console.log(`   生成文  : ${out.replace(/\n/g, " ／ ")}`);
    if (!wantOk && s.wantNote) console.log(`   ⚠ ${s.wantNote}`);
    if (w && s.watchNote) console.log(`   ⚠ ${s.watchNote}`);
    if (j.fresh.length) console.log(`   新しい述部: ${j.fresh.join(" / ")}`);
  }

  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.log(`\n${"─".repeat(78)}`);
  const avg = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
  console.log(`=== まとめ: 中身あり ${ok} / 焼き直し ${reuse} / 具体の抜け ${wantMiss} / 見張り語 ${watchHit} / 下書き無し ${empty}`
    + ` ／ 直前との近さ 平均${avg.toFixed(3)}（${sims.length}件）（後片付けの残り ${cleanup.length}件）===`);
  console.log(`※ 終わったら: npx tsx --env-file=.env.local scripts/yuma-snapshot.ts restore`);
}
main().catch(async (e) => {
  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.error(e); process.exit(1);
});
