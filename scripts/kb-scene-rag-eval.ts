// scripts/kb-scene-rag-eval.ts — 返信の場面ごとに設計知見の引き方の当たり方を測る（3巡目・10/07 竹内「的確なRAG検索できるように」）
//   問いは「場面の言葉＋誤差の型」（作業中に実際に打つ形）。正解は人が選んだ行（id の先頭8字）。1問に正解が複数ある時はどれか1つが上位に入れば当たり。
//   比べる物: plain（今の kb.ts --q）／scene（--scene=<場面> で場面の札・語を足す）
// 実行: npx tsx --env-file=.env.local scripts/kb-scene-rag-eval.ts [--k=5] [--holdout] [--show-miss]
//   OpenAI の埋め込みを問いの数だけ呼ぶ（1回 約0.0000004ドル）。DB は読むだけ
import { createClient } from "@supabase/supabase-js";
import { searchKb } from "../app/lib/design-knowledge-rag-server";
import type { RagRow } from "../app/lib/design-knowledge-rag";
import type { ReplyScene } from "../app/lib/reply-scene";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const K = Number((process.argv.find((a) => a.startsWith("--k=")) ?? "--k=5").split("=")[1]);

type Q = { scene: ReplyScene; q: string; gold: string[] };
export const SCENE_EVAL: Q[] = [
  // 短いお礼・了承
  { scene: "ack", q: "短いお礼の番で前の約束を復唱してしまう", gold: ["c4b4faf2", "c9368e68", "25655edd"] },
  { scene: "ack", q: "締めの挨拶に物件探しの宣言を足した", gold: ["1ccdfdef", "f309f843"] },
  { scene: "ack", q: "こちらが締めた後のお礼に返すか待つか", gold: ["6e0add96", "7fbf1dae", "f309f843"] },
  { scene: "ack", q: "了承への返しがかしこまりましたになる", gold: ["14baf0b3", "0d351e0d", "8e10fc96"] },
  // 検討中
  { scene: "considering", q: "検討しますと言われた時の締めの一文", gold: ["b651d8eb", "4bb2df59", "ce45cbad"] },
  { scene: "considering", q: "検討中のお客様に申込でお部屋を抑える訴求を入れてよいか", gold: ["b651d8eb", "aef0a1df"] },
  { scene: "considering", q: "また連絡しますの保留への返事", gold: ["69b29bb5", "3fb1b269", "4bb2df59"] },
  { scene: "considering", q: "少し考えますを急かさず受け止める", gold: ["ce45cbad", "b651d8eb", "3fb1b269"] },
  // 質問
  { scene: "question", q: "質問に答えずに確認の約束に逃げる", gold: ["e506807a", "50488b2f", "295460ee", "8731265b"] },
  { scene: "question", q: "家賃の相場を聞かれた時の答え方", gold: ["dd7adce8", "d71fcffe", "8731265b"] },
  { scene: "question", q: "審査の期間や必要書類の手続きの質問", gold: ["ebe40a2c", "8ec5d550", "f7ddd71b"] },
  { scene: "question", q: "設備があるか聞かれた", gold: ["aa5280ce", "bea8152f"] },
  { scene: "question", q: "保証会社について聞かれた", gold: ["00d0d8f4", "6ab8f464"] },
  // 条件
  { scene: "conditions", q: "お客様が条件を言い直した", gold: ["571856cc", "8495318d", "2176304f"] },
  { scene: "conditions", q: "条件を受けて探しますと宣言する返信", gold: ["cbaec2af", "d43db7aa", "c9737b16"] },
  { scene: "conditions", q: "条件ヒアリングのフォームの書き方", gold: ["091573b8", "1dadbc5d", "81692a10"] },
  { scene: "conditions", q: "気に入ったけどあと一つ足りないと言われた", gold: ["0b6d95a0", "dc6338d7"] },
  // 物件を送ってきた
  { scene: "property_share", q: "お客様がSUUMOのURLを送ってきた", gold: ["f979a363", "c9737b16", "40b4a65a"] },
  { scene: "property_share", q: "持ち込み物件の初期費用を聞かれた", gold: ["9de893ed", "aab3afbc", "973824ce"] },
  { scene: "property_share", q: "お客様の画像がこちらの送った物件か見分ける", gold: ["277094fd", "c3cd087e"] },
  { scene: "property_share", q: "物件の画像が届いた時の募集状況の確認", gold: ["f979a363", "8be608c4", "c9737b16"] },
  // 初期費用・見積
  { scene: "cost", q: "初期費用を知りたいと言われた", gold: ["67b9f566", "973824ce", "9de893ed"] },
  { scene: "cost", q: "見積書の後に総額を聞かれた", gold: ["b748b152"] },
  { scene: "cost", q: "初期費用に何が含まれるか聞かれた", gold: ["16fb8382"] },
  { scene: "cost", q: "初期費用が安くて怪しまれた", gold: ["96f485fc"] },
  // 内覧・日程
  { scene: "viewing", q: "内覧したいと言われた", gold: ["fb0b44cb", "ee24fa7c"] },
  { scene: "viewing", q: "内覧の候補日をどう出す", gold: ["5290cb77", "e8933426"] },
  { scene: "viewing", q: "決まっていない内覧の日時を返信に書いた", gold: ["ce02cbef", "ee24fa7c", "541e62b0"] },
  { scene: "viewing", q: "内覧の誘いを入れるタイミング", gold: ["aef0a1df", "5248d927", "c969d47f"] },
  // 申込・審査
  { scene: "apply", q: "申込に必要な書類を聞かれた", gold: ["f7ddd71b"] },
  { scene: "apply", q: "お部屋を仮押さえしたいと言われた", gold: ["cdd11c67"] },
  { scene: "apply", q: "申込を決めたお客様に申込誘導を出した", gold: ["2ac8d630", "f944b4e2"] },
  { scene: "apply", q: "審査に落ちたと言われた", gold: ["2bd614c7"] },
];

// 重みや札を決めるのに使っていない問い（当て直しの過学習を見る）
export const SCENE_HOLDOUT: Q[] = [
  { scene: "ack", q: "よろしくお願いしますだけの返事に何を書く", gold: ["1ccdfdef", "c4b4faf2", "4775e00b", "a92ec31b"] },
  { scene: "considering", q: "持ち帰って考えたいと言われた", gold: ["4bb2df59", "b651d8eb", "ce45cbad"] },
  { scene: "question", q: "家賃に管理費込みか聞かれた", gold: ["cd7b30cc"] },
  { scene: "question", q: "審査だけ先に出せるか聞かれた", gold: ["fc5a9c1a"] },
  { scene: "conditions", q: "他の物件も見たいと言われた", gold: ["3ac3d479", "cbaec2af"] },
  { scene: "property_share", q: "初回にお客様が物件の画像を送ってきた最初の一手", gold: ["c9737b16", "f979a363"] },
  { scene: "cost", q: "物件の話が無いのに費用だけ聞かれた", gold: ["a99b988a", "74b2587d"] },
  { scene: "cost", q: "初期費用を分割で払いたいと言われた", gold: ["bd416419", "2ebe308c"] },
  { scene: "viewing", q: "内覧の別の日程を聞かれた", gold: ["31dda200"] },
  { scene: "viewing", q: "待ち合わせ場所の住所", gold: ["1290264c", "0de29196"] },
  { scene: "apply", q: "申込誘導を書きすぎる", gold: ["69d76722", "aef0a1df"] },
  { scene: "apply", q: "申込後の審査の進捗を聞かれた", gold: ["06d1bef5", "e52ff713"] },
];

const SETS = process.argv.includes("--holdout") ? SCENE_HOLDOUT : process.argv.includes("--all") ? [...SCENE_EVAL, ...SCENE_HOLDOUT] : SCENE_EVAL;
const isGold = (r: RagRow, g: string) => r.id.startsWith(g);

(async () => {
  const rows: RagRow[] = [];
  for (let p = 0; p < 10; p++) {
    const { data, error } = await sb.from("system_design_thinking").select("id, title, insight, rationale, context, tags, is_current, created_at").eq("is_current", true).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as RagRow[]));
    if ((data ?? []).length < 1000) break;
  }
  const missing = SETS.flatMap((e) => e.gold.filter((g) => !rows.some((r) => isGold(r, g))));
  if (missing.length) console.log("⚠ 正解の行が現行に無い:", missing.join(", "));
  const vecCache = new Map<string, Map<string, number>>();
  // plain＝今の kb.ts／expand＝問いに場面の語だけ／boostN＝場面の行に点 N だけ／bothN＝両方
  const W = (process.argv.find((a) => a.startsWith("--w="))?.slice(4) ?? "0.1,0.2,0.3,0.5").split(",").map(Number);
  const variants: Array<{ name: string; scene: boolean; expand: boolean; w: number }> = [
    { name: "plain", scene: false, expand: false, w: 0 }, { name: "expand", scene: true, expand: true, w: 0 },
    ...W.map((w) => ({ name: `boost${w}`, scene: true, expand: false, w })), ...W.map((w) => ({ name: `both${w}`, scene: true, expand: true, w })),
  ];
  const modes = variants.map((v) => v.name);
  const res: Record<string, { hit: number; hit8: number; mrr: number; gold: number; byScene: Record<string, number[]> }> = {};
  for (const m of modes) res[m] = { hit: 0, hit8: 0, mrr: 0, gold: 0, byScene: {} };
  const misses: string[] = [];
  for (const e of SETS) {
    for (const v of variants) {
      const m = v.name;
      const list = (await searchKb(sb, e.q, { k: 8, rows, vecCache, scene: v.scene ? e.scene : undefined, expand: v.expand, sceneWeight: v.w })).map((s) => s.row);
      const idx = list.findIndex((r) => e.gold.some((g) => isGold(r, g)));
      const goldIn = list.slice(0, K).filter((r) => e.gold.some((g) => isGold(r, g))).length;
      const R = res[m];
      if (idx >= 0 && idx < K) { R.hit++; R.mrr += 1 / (idx + 1); }
      if (idx >= 0) R.hit8++;
      R.gold += goldIn / Math.min(K, e.gold.length);
      (R.byScene[e.scene] ??= [0, 0])[0] += idx >= 0 && idx < K ? 1 : 0;
      R.byScene[e.scene][1]++;
      if ((idx < 0 || idx >= K) && process.argv.includes("--show-miss")) misses.push(`[${m}] ${e.scene} ${e.q} → 1位: ${list[0]?.title.slice(0, 60) ?? "なし"}`);
    }
  }
  console.log(`=== 場面ごとの設計知見の引き方（問い ${SETS.length}・上位${K}）`);
  for (const m of modes) {
    const R = res[m];
    console.log(`  ${m.padEnd(9)} recall@${K} ${(R.hit / SETS.length).toFixed(2)}（${R.hit}/${SETS.length}）・recall@8 ${(R.hit8 / SETS.length).toFixed(2)}・MRR ${(R.mrr / SETS.length).toFixed(2)}・正解の取り込み率 ${(R.gold / SETS.length).toFixed(2)}`);
    console.log(`         場面別 ${Object.entries(R.byScene).map(([s, [h, n]]) => `${s} ${h}/${n}`).join("・")}`);
  }
  for (const x of misses) console.log("   - " + x);
})().catch((e) => { console.error(e); process.exit(1); });
