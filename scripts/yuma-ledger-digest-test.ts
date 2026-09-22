// ①「これより前にお伝えしたこと」で、もう言った宣言の言い直しが減るか（YUMA・本番と同じ経路）
//
// 2026-09-23 竹内「実際にテストしてみて質上がったか確認おねがい」
//
// 【何を試すか】行動台帳は直近6件しかブレイン・生成に見せていない。実測で 59.7% が窓から落ち、
//   その種類の最後の1回まで落ちたのが 御見積書の宣言40会話・ピックアップ宣言35・確認の約束31。
//   → 窓から落ちた種類の最後の1回を1行ずつ足した（droppedKindDigest）。
//   この場面で「もう言ったこと」を言い直すかどうかを見る。
//
// 【場面の作り方】想像で作らない。実データの会話 60e6d3ab の台帳の並びをそのまま写す
//   （見積書の宣言 → 物件送付 → ピックアップ宣言 → 見積書送付 → 確認の宣言 → 待ち合わせ案内 …）。
//   古い宣言が**窓から落ちる**ように、後ろに6件以上の新しい行を積む。
//
// 【測り方】生成文に「窓から落ちた宣言」の未来形が再び出るか（＝言い直し）。
//   ⚠ 言い直しは**禁止ではない**（設計知見「繰り返しは禁止にできない」）。
//     新しい具体（日付・物件・金額）が足されていれば正しい言い直し。だから2つに分けて数える。
//
// 【A/B】LEDGER_DIGEST=off で dev サーバーを起動し直すと①が切れる。同じ場面を両方で回して比べる。
//
// ⚠ 書き込みを伴う（YUMA に場面を入れて、生成後に必ず消す）。テスト会話 YUMA だけで動かす。
// 実行: npx tsx --env-file=.env.local scripts/yuma-ledger-digest-test.ts [REPS=3]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: string[] = [];

type Turn = { who: "staff" | "customer"; text: string; minutesAgo: number };
type Scene = {
  id: string;
  /** 古→新。最後はお客様の発言 */
  turns: Turn[];
  /** 窓から落ちる宣言（これを言い直したら数える） */
  dropped: { label: string; redeclare: RegExp };
  /** 言い直してもよくなる「新しい具体」 */
  freshBits: RegExp;
};

const SCENES: Scene[] = [
  {
    // 実データ 60e6d3ab の並び: 見積書の宣言 → 物件送付 → ピックアップ宣言 → 見積書送付 → 確認の宣言 → 待ち合わせ案内
    id: "①御見積書を作ると宣言済み（窓から落ちる）→ その後6件 → お客様が了承だけ返す",
    turns: [
      { who: "staff", text: "かしこまりました！！\nグランドール難波301号室の初期費用の御見積書作成しお送りさせて頂きます！！", minutesAgo: 14400 },
      { who: "customer", text: "ありがとうございます！", minutesAgo: 14300 },
      { who: "staff", text: "YUMAさん\n初期費用の御見積書お送りさせて頂きます！！\nお手隙の際にご査収ください😌！！", minutesAgo: 14200 },
      { who: "customer", text: "確認しました！", minutesAgo: 14100 },
      { who: "staff", text: "YUMAさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！", minutesAgo: 10000 },
      { who: "customer", text: "よろしくお願いします", minutesAgo: 9900 },
      { who: "staff", text: "お送り頂きましたお部屋の募集状況確認させて頂きます！！", minutesAgo: 6000 },
      { who: "customer", text: "はい", minutesAgo: 5900 },
      { who: "staff", text: "管理会社に確認させて頂き、こちらのお部屋現在募集中となります！！", minutesAgo: 4000 },
      { who: "customer", text: "ありがとうございます", minutesAgo: 3900 },
      { who: "staff", text: "9/25 15:00 現地エントランスお待ち合わせでお部屋ご案内させて頂きます！！", minutesAgo: 2000 },
      { who: "customer", text: "承知しました！", minutesAgo: 1900 },
      { who: "staff", text: "かしこまりました！！\n当日は何卒よろしくお願い致します😊！！", minutesAgo: 60 },
      { who: "customer", text: "はい、よろしくお願いします", minutesAgo: 5 },
    ],
    dropped: { label: "御見積書を作成しお送りする宣言", redeclare: /(御見積書|お見積書|見積書)[^。\n]{0,14}(作成|お作り)[^。\n]{0,10}(お送り|送らせて|送付)|(御見積書|見積書)[^。\n]{0,10}(お送りさせて|送付させて)(いただき|頂き)ます/ },
    freshBits: /9\s*[\/月]\s*25|15\s*[:：]?\s*00|グランドール|募集中/,
  },
  {
    id: "②ピックアップを宣言済み（窓から落ちる）→ その後6件 → お客様が短く返す",
    turns: [
      { who: "staff", text: "梅田まで1本で行ける沿線から、YUMAさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！", minutesAgo: 14400 },
      { who: "customer", text: "よろしくお願いします！", minutesAgo: 14300 },
      { who: "staff", text: "🌟グランドール難波 301号室\n家賃 8.5万円\nこちらのお部屋如何でしょうか😊！！", minutesAgo: 12000 },
      { who: "customer", text: "いいですね！", minutesAgo: 11900 },
      { who: "staff", text: "初期費用の御見積書お送りさせて頂きます！！\nお手隙の際にご査収ください😌！！", minutesAgo: 10000 },
      { who: "customer", text: "ありがとうございます", minutesAgo: 9900 },
      { who: "staff", text: "お送り頂きましたお部屋の募集状況確認させて頂きます！！", minutesAgo: 6000 },
      { who: "customer", text: "はい", minutesAgo: 5900 },
      { who: "staff", text: "管理会社に確認させて頂き、こちらのお部屋現在募集中となります！！", minutesAgo: 4000 },
      { who: "customer", text: "承知しました", minutesAgo: 3900 },
      { who: "staff", text: "9/25 15:00 現地エントランスお待ち合わせでお部屋ご案内させて頂きます！！", minutesAgo: 2000 },
      { who: "customer", text: "はい！", minutesAgo: 1900 },
      { who: "staff", text: "かしこまりました！！\n当日は何卒よろしくお願い致します😊！！", minutesAgo: 60 },
      { who: "customer", text: "ありがとうございます", minutesAgo: 5 },
    ],
    dropped: { label: "オススメのお部屋をピックアップする宣言", redeclare: /(ピックアップ|お探し|探させて)[^。\n]{0,12}(お送り|送らせて|させて(いただき|頂き)ます)|オススメ[^。\n]{0,10}お部屋[^。\n]{0,12}(お送り|ピックアップ)/ },
    freshBits: /9\s*[\/月]\s*25|15\s*[:：]?\s*00|グランドール|募集中/,
  },
];

async function armConversation() {
  await sb.from("conversations").update({
    last_sender: "customer", ai_draft: null, ai_draft_check: null,
    draft_attempted_at: null, draft_pending_at: null,
    draft_fail_count: 0, draft_last_error: null,
  }).eq("id", YUMA);
}

async function waitForDraft(timeoutMs = 240_000): Promise<{ draft: string; aix: unknown }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000);
    const { data, error } = await sb.from("conversations")
      .select("ai_draft, suggested_next_aix, suggested_aix_meta").eq("id", YUMA).maybeSingle();
    if (error) return { draft: "", aix: null };
    const row = (data ?? {}) as Record<string, unknown>;
    const aix = row.suggested_next_aix ?? (row.suggested_aix_meta as Record<string, unknown> | null)?.action ?? null;
    const d = String(row.ai_draft ?? "");
    if (d === "[AIX誘導中]") return { draft: "", aix };
    if (d && d !== "__SHOWN__") return { draft: d, aix };
  }
  return { draft: "", aix: null };
}

/** 途中で止めた時に残った作り物を消す（3時間以内・この台本の本文だけ） */
async function sweepLeftovers() {
  const since = new Date(Date.now() - 3 * 3600_000).toISOString();
  const texts = new Set(SCENES.flatMap((s) => s.turns.map((t) => t.text)));
  const { data } = await sb.from("messages").select("id, text").eq("conversation_id", YUMA).gte("created_at", since);
  const ids = ((data ?? []) as Array<{ id: string; text: string | null }>).filter((r) => texts.has(String(r.text ?? ""))).map((r) => r.id);
  if (ids.length) { await sb.from("messages").delete().in("id", ids); console.log(`=== 前回の残り ${ids.length}件を片付けた ===`); }
}

async function main() {
  const reps = Number(process.env.REPS ?? 3);
  const label = (process.env.LEDGER_DIGEST ?? "on").toLowerCase() === "off" ? "①なし（LEDGER_DIGEST=off）" : "①あり";
  console.log(`=== ${label} ／ ${SCENES.length}場面 × ${reps}回 ===`);
  console.log(`※ dev サーバー側の LEDGER_DIGEST が効く。サーバーを起動し直してから回すこと\n`);
  await sweepLeftovers();

  let redeclare = 0, redeclareWithFresh = 0, clean = 0, empty = 0;
  for (const s of SCENES) {
    for (let k = 0; k < reps; k++) {
      const now = Date.now();
      const ins = await sb.from("messages").insert(
        s.turns.map((t) => ({
          conversation_id: YUMA, sender: t.who, text: t.text,
          created_at: new Date(now - t.minutesAgo * 60_000).toISOString(),
        })),
      ).select("id");
      if (ins.error) { console.log(`【${s.id}】場面を作れず: ${ins.error.message}`); continue; }
      cleanup.push(...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id));

      let skipped = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        await armConversation();
        try {
          const res = await fetch(`${BASE}/api/generate-draft-bg-async`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversation_id: YUMA, source: "direct" }),
          });
          skipped = String(((await res.json()) as Record<string, unknown>).skipped ?? "");
        } catch (e) { skipped = `fetch失敗:${e instanceof Error ? e.message : String(e)}`; }
        if (skipped !== "in_progress") break;
        await sleep(20_000);
      }
      const { draft, aix } = await waitForDraft();
      // 片付け（次の回に持ち越さない）
      if (cleanup.length) { await sb.from("messages").delete().in("id", cleanup); cleanup = []; }

      const head = `【${s.id}】[${k + 1}]`;
      if (!draft) { empty++; console.log(`${head} 下書きなし（AIX=${String(aix ?? "-")}・skipped=${skipped}）`); continue; }
      const again = s.dropped.redeclare.test(draft);
      const fresh = s.freshBits.test(draft);
      if (again && fresh) { redeclareWithFresh++; console.log(`${head} △ 言い直したが新しい具体あり`); }
      else if (again) { redeclare++; console.log(`${head} ✗ ${s.dropped.label}を言い直した（新しい具体なし）`); }
      else { clean++; console.log(`${head} ✓ 言い直していない`); }
      console.log(`      ${draft.replace(/\n/g, " / ").slice(0, 150)}`);
    }
  }
  const total = redeclare + redeclareWithFresh + clean;
  console.log(`\n=== ${label} の結果（${total}回・下書きなし ${empty}） ===`);
  console.log(`   ✓ 言い直していない        ${clean}`);
  console.log(`   △ 言い直したが具体あり    ${redeclareWithFresh}`);
  console.log(`   ✗ 言い直した（具体なし）  ${redeclare}`);
  console.log(`   ＝ 悪い言い直しの率 ${total ? ((redeclare / total) * 100).toFixed(1) : "—"}%`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (cleanup.length) { await sb.from("messages").delete().in("id", cleanup); console.log(`片付け: ${cleanup.length}件`); } });
