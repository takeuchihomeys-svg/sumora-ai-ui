// YUMA で AIX テンプレートの2通目を複数パターン生成し、成約データ・直近の型と突き合わせる
//
// 2026-09-20 竹内「YUMA でテストして確認おねがい。設計知見と協力して実際の成約データや
//   直近の文のようになっているか確認」
//
// 基準は scripts/audit-second-message-style.ts の実測（AIX の2通目）:
//   長さ: 全体120字・4行 ／ 直近30日120字・4行 ／ **成約108字・3行**
//   要素（全体 / 直近30日 / 成約）:
//     名前呼びかけ 34.1/31.9/35.1 ／ 挨拶 11.9/11.2/8.8 ／ 物件名・号室 39.9/43.9/36.0
//     条件の復唱 38.3/36.5/30.7 ／ 箇条書き 21.7/21.6/20.2 ／ オススメの一言 16.9/15.4/13.2
//     内覧の誘導 7.2/8.2/6.1 ／ 申込の誘導 5.6/4.6/**8.8** ／ お気に召されましたら 10.2/9.3/9.6
//     気軽に言ってもらう締め 1.6/2.8/**0.0** ／ ご査収 17.2/16.6/14.0 ／ 何卒 2.7/2.5/**6.1**
//     全力サポート 0.7 ／ ごゆっくり 0.0 ／ 絵文字 57.5/63.0/51.8 ／ ！！ 61.5/64.2/**64.9**
//
// ⚠ 生成のみ。LINE へは送らない。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

/** 実測の型（全体 / 直近30日 / 成約）*/
const ELEMENTS: Array<{ key: string; re: RegExp; all: number; recent: number; won: number }> = [
  { key: "名前呼びかけ（〇〇さん）", re: /さん/, all: 34.1, recent: 31.9, won: 35.1 },
  { key: "挨拶（お世話に／お待たせ）", re: /お世話になっております|お待たせ(?:致|いた)?しました/, all: 11.9, recent: 11.2, won: 8.8 },
  { key: "物件名・号室・🌟", re: /[0-9０-９]{2,4}号室|🌟/, all: 39.9, recent: 43.9, won: 36.0 },
  { key: "条件の復唱（万・LDK・築・徒歩）", re: /[0-9０-９]{1,3}[\.．]?[0-9０-９]{0,2}万|[0-9０-９]{1,2}[LDKSldks]{1,4}|築[0-9０-９]{1,2}|徒歩[0-9０-９]{1,2}/, all: 38.3, recent: 36.5, won: 30.7 },
  { key: "箇条書き（・2行以上）", re: /^[・･][^\n]*\n[\s\S]*^[・･]/m, all: 21.7, recent: 21.6, won: 20.2 },
  { key: "オススメの一言（特に／かなり）", re: /特に[^\n。！!]{0,20}(?:オススメ|おすすめ)|かなり[^\n。！!]{0,12}(?:オススメ|おすすめ)/, all: 16.9, recent: 15.4, won: 13.2 },
  { key: "内覧の誘導", re: /ご案内(?:させて(?:頂|いただ)き|いたし|致し)ます|ご内覧(?:頂|いただ)け/, all: 7.2, recent: 8.2, won: 6.1 },
  { key: "申込の誘導", re: /お?申(?:し)?込[^\n。！!]{0,14}(?:押さえ|抑え|完了|進め)/, all: 5.6, recent: 4.6, won: 8.8 },
  { key: "お気に召されましたら", re: /お気に召され/, all: 10.2, recent: 9.3, won: 9.6 },
  { key: "気軽に言ってもらう締め", re: /お気軽|お申し付け|いつでも(?:ご連絡|お知らせ)/, all: 1.6, recent: 2.8, won: 0.0 },
  { key: "ご査収", re: /ご査収/, all: 17.2, recent: 16.6, won: 14.0 },
  { key: "何卒よろしく", re: /何卒(?:よろしく|宜しく)/, all: 2.7, recent: 2.5, won: 6.1 },
  { key: "全力でサポート", re: /全力でサポート/, all: 0.7, recent: 0.7, won: 0.9 },
  { key: "ごゆっくりご検討", re: /ごゆっくりご(?:検討|確認|相談)/, all: 0.0, recent: 0.0, won: 0.0 },
  { key: "絵文字（😊😌🙇🌟）", re: /😊|😌|🙇|🌟/, all: 57.5, recent: 63.0, won: 51.8 },
  { key: "！！（二重）", re: /！！/, all: 61.5, recent: 64.2, won: 64.9 },
];

/** 場面ごとの1通目（実送信の形をそのまま） */
const SCENES: Array<{ id: string; action: string; category: string; first: string }> = [
  {
    id: "① 物件ピックアップした の後",
    action: "property_send", category: "物件ピックアップした【AIX】",
    first: "YUMAさんお待たせ致しました！！\n\n難波周辺全域からYUMAさんご希望の家賃10万円以内・1LDK・駅徒歩10分以内のお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！",
  },
  {
    id: "② 物件オススメ の後",
    action: "property_recommendation", category: "物件オススメ【AIX】",
    first: "🌟スプランディッド大阪EAST 204号室\n\n（オススメポイント）\n・家賃106,000円・管理費12,500円（合計118,500円）\n・間取り：2LDK（リビング11.5帖、洋室3.8帖）\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n・大阪環状線「玉造」徒歩5分",
  },
  {
    id: "③ 見積書送る の後",
    action: "estimate_sheet", category: "見積書送る【AIX】",
    first: "【スプランディッド大阪EAST 204号室】\n\n初期費用さらに\n🌟22,000円割引させて頂き\n初期費用：139,000円\n\nイエヤスなら一般的な不動産業者より90,310円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。",
  },
  {
    id: "④ 物件確認した の後",
    action: "property_check_result", category: "物件確認した【AIX】",
    first: "YUMAさんお待たせ致しました！！\n\nスプランディッド大阪EAST 204号室、現在募集中で即日ご入居可能となります😊！！\n\n保証会社は日本セーフティーという比較的審査通過しやすい保証会社となっております！！",
  },
];

/**
 * 2026-09-21 竹内「付けるかはブレインが判断する。お客さんの反応見て刺さっているなら、誘導する」
 *   お客様の反応を差し替えて、CTA の有無が判断どおり変わるかを見る。
 *   実測（scripts/audit-cta-trigger.ts）: positive 30.6%（成約60%）／concern 3.2%／condition_change 1.1%
 */
const REACTIONS: Array<{ id: string; text: string; expect: "誘う" | "誘わない" }> = [
  { id: "A 内覧したい（positive/viewing_explicit・実測31.3%）", text: "この物件内覧したいです！", expect: "誘う" },
  { id: "B 良いと思う（positive/appraisal・実測45.5%）", text: "すごく良さそうなお部屋ですね！気に入りました", expect: "誘う" },
  { id: "C 懸念（concern・実測3.2%）", text: "1階だと防犯面が少し心配です…", expect: "誘わない" },
  { id: "D 条件変更（condition_change・実測1.1%）", text: "もう少し駅近で探してもらえますか？", expect: "誘わない" },
  { id: "E 相槌のみ（ack_only・実測8.4%）", text: "ありがとうございます", expect: "誘わない" },
];

async function main() {
  const rounds = Number(process.env.ROUNDS ?? 2);
  const { data: conv } = await sb.from("conversations").select("customer_name, status").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  const { data: ms } = await sb.from("messages").select("sender, text, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: true }).limit(200);
  const recentMessages = ((ms ?? []) as unknown as Array<Record<string, unknown>>).slice(-15).map((m) => ({
    sender: String(m.sender), text: String(m.text ?? ""), rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated,
  }));

  const results: Array<{ scene: string; text: string; ms: number }> = [];
  console.log(`=== YUMA で AIX テンプレートの2通目を ${SCENES.length}場面 × ${rounds}回 生成（送信しない）===\n`);

  for (const s of SCENES) {
    for (let r = 0; r < rounds; r++) {
      const t0 = Date.now();
      let text = "";
      try {
        const res = await fetch(`${BASE}/api/aix-template-generate`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionType: s.action, actionCategory: s.category, conversationId: YUMA,
            customerName: String(c.customer_name ?? "YUMA"), conversationState: String(c.status ?? "proposing"),
            recentMessages, customerConditions: "難波周辺・家賃10万円以内・1LDK・駅徒歩10分以内",
            noEmoji: false, staffMessagedToday: true, sentMessage: s.first,
          }),
        });
        const raw = await res.text();
        try { const j = JSON.parse(raw) as Record<string, unknown>; text = String(j.text ?? j.error ?? raw.slice(0, 200)); }
        catch { text = raw.slice(0, 200); }
      } catch (e) { text = `【エラー】${e instanceof Error ? e.message : String(e)}`; }
      const ms2 = Date.now() - t0;
      results.push({ scene: s.id, text, ms: ms2 });
      const ln = text.split("\n").filter((x) => x.trim()).length;
      console.log(`${"─".repeat(72)}`);
      console.log(`【${s.id}】${r + 1}回目 (${(ms2 / 1000).toFixed(1)}s ・ ${text.length}字 ・ ${ln}行)\n`);
      console.log(text || "（本文なし）");
      console.log("");
    }
  }

  // ── 成約データ・直近の型と突き合わせ ──
  const ok = results.filter((r) => r.text.length > 10 && !r.text.startsWith("【エラー】"));
  console.log(`${"─".repeat(72)}`);
  console.log(`=== 実送信の型と突き合わせ（生成 ${ok.length}通）===\n`);
  const lens = ok.map((r) => r.text.length).sort((a, b) => a - b);
  const lns = ok.map((r) => r.text.split("\n").filter((x) => x.trim()).length).sort((a, b) => a - b);
  console.log(`   長さ: 生成 中央値 ${lens[Math.floor(lens.length / 2)]}字・${lns[Math.floor(lns.length / 2)]}行`);
  console.log(`         実送信 全体 120字・4行 ／ 直近30日 120字・4行 ／ **成約 108字・3行**`);
  const over = ok.filter((r) => r.text.length > 180).length;
  console.log(`   180字超え: ${over}通 / ${ok.length}通\n`);
  console.log(`   ${"要素".padEnd(32)} 生成    全体   直近30日  成約   判定`);
  for (const e of ELEMENTS) {
    const n = ok.filter((r) => e.re.test(r.text)).length;
    const gen = ok.length ? (n / ok.length) * 100 : 0;
    // 成約データから大きく外れていないか（±25ポイントを目安に印を付ける）
    const d = gen - e.won;
    const mark = Math.abs(d) >= 25 ? (d > 0 ? "  ⚠ 多い" : "  ⚠ 少ない") : "";
    console.log(`   ${e.key.padEnd(32)} ${(`${gen.toFixed(0)}%`).padStart(5)}  ${(`${e.all}%`).padStart(6)}  ${(`${e.recent}%`).padStart(6)}  ${(`${e.won}%`).padStart(6)}${mark}`);
  }
  console.log(`\n   ※ 生成は ${ok.length}通なので率はざっくり（0/25/50/75/100% しか取れない）。`);
  console.log(`     見るのは「実送信に無い形が出ていないか」「多すぎる形が無いか」。`);

  // ── 抜け・エラーの点検（竹内「生成される文に抜けやエラーがないかも合わせて確認」）──
  console.log(`\n${"─".repeat(72)}`);
  console.log(`=== 抜け・エラーの点検 ===`);
  const failed = results.filter((r) => r.text.length <= 10 || r.text.startsWith("【エラー】") || /^\{"ok":false/.test(r.text));
  console.log(`   生成に失敗した: ${failed.length}通 / ${results.length}通`);
  for (const f of failed) console.log(`     [${f.scene}] ${f.text.slice(0, 120)}`);

  /** あってはいけない形（実送信365日で0通と分かっている物＋設計知見で禁止した物） */
  const DEFECTS: Array<[string, RegExp]> = [
    ["プロンプトの見出しの写し（【お客様に送る文】等）", /【(?:お客様に送る文|お客様の現在の状況|お客様名|物件情報|今回生成する)/],
    ["伏せ字のまま（〇〇さん／○○さん）", /[〇○]{1,2}さん/],
    ["AI の作業メモ（確認します／出力します）", /^[^\n]{0,20}(?:確認します|出力します|作成します)[。\s]*$/m],
    ["できない宣言", /出力(?:は|を)?行(?:い|え)ま?せん|情報が(?:不足|足りません)|特定できません/],
    ["禁止語 お待たせ（2通目は返信なので不可）", /お待たせ(?:致|いた)?しました/],
    ["禁止語 承知いたしました", /承知(?:いた|致)?しました/],
    ["禁止語 夜分に失礼", /夜(?:分)?遅くに失礼|夜分に失礼/],
    ["希少性の煽り", /埋まって(?:しまい|しまう)|残り\s*[0-9０-９]\s*(?:部屋|室)|他のお客様[^\n。！!]{0,12}(?:申込|お申込)/],
    ["マークダウン太字（LINE非対応）", /\*\*/],
    ["スタッフ名で呼びかけ", /^(?:鈴木|田中|佐藤|竹内)さん/m],
    ["会社名の名乗り", /(?:スモラ|イエヤス|ギガ賃貸)です[。！!]/],
    ["1文字〜3文字だけ", /^[\s\S]{1,3}$/],
    ["同じ行の重複", /^(.{12,})\n[\s\S]*^\1$/m],
  ];
  let defectTotal = 0;
  console.log(`\n   --- あってはいけない形（実送信0通の形）---`);
  for (const [label, re] of DEFECTS) {
    const hit = ok.filter((r) => re.test(r.text));
    if (hit.length === 0) continue;
    defectTotal += hit.length;
    console.log(`     ⛔ ${label}: ${hit.length}通`);
    for (const h of hit.slice(0, 2)) console.log(`        [${h.scene}] ${h.text.replace(/\n/g, " ／ ").slice(0, 110)}`);
  }
  if (defectTotal === 0) console.log(`     0件（どの形も出ていない）`);

  // 文の途中で終わっていないか
  //   ⚠ 末尾の閉じ記号（」）や絵文字を外してから見る（前は「！！」で終わる正常文を誤検知した）
  const tail = (s: string) => s.trim().replace(/[」』）)】\s]+$/u, "").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+$/u, "");
  const cut = ok.filter((r) => {
    const t = tail(r.text);
    return !/[。！!？?]$/.test(t) && !/(?:ください|ます|です|ました|幸いです)$/.test(t);
  });
  console.log(`\n   --- 文が途中で終わっている疑い: ${cut.length}通 ---`);
  for (const c of cut.slice(0, 3)) console.log(`     [${c.scene}] …${c.text.trim().slice(-40)}`);

  // 日本語として壊れた接続（「ので、！！」のような形。前に1件出た）
  const broken = ok.filter((r) => /[ので|から|ため|が]、\s*[！!]/.test(r.text) || /[、。]\s*[、。]/.test(r.text) || /！！\s*！！/.test(r.text));
  console.log(`\n   --- 壊れた接続・句読点: ${broken.length}通 ---`);
  for (const b of broken.slice(0, 3)) console.log(`     [${b.scene}] ${b.text.replace(/\n/g, " ／ ").slice(0, 110)}`);

  console.log(`\n   【まとめ】失敗 ${failed.length}通 ／ あってはいけない形 ${defectTotal}件 ／ 途中終わり ${cut.length}通 ／ 壊れた接続 ${broken.length}通`);

  // ── お客様の反応を変えて CTA の有無が変わるか（竹内「刺さっているなら誘導する」）──
  console.log(`\n${"─".repeat(72)}`);
  console.log(`=== お客様の反応ごとに CTA が変わるか（物件オススメの2通目で固定）===\n`);
  const CTA_RE = /ご案内(?:させて(?:頂|いただ)き|いたし|致し)ます|ご内覧(?:頂|いただ)け|お?申(?:し)?込[^\n。！!]{0,14}(?:押さえ|抑え|完了|進め|手続)/;
  const scene = SCENES[1]; // ② 物件オススメ の後
  for (const r of REACTIONS) {
    const msgs = [...recentMessages, { sender: "customer", text: r.text, rawCreatedAt: new Date().toISOString(), isAix: false }];
    let text = "";
    try {
      const res = await fetch(`${BASE}/api/aix-template-generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: scene.action, actionCategory: scene.category, conversationId: YUMA,
          customerName: String(c.customer_name ?? "YUMA"), conversationState: String(c.status ?? "proposing"),
          recentMessages: msgs, customerConditions: "難波周辺・家賃10万円以内・1LDK・駅徒歩10分以内",
          noEmoji: false, staffMessagedToday: true, sentMessage: scene.first,
        }),
      });
      const raw = await res.text();
      try { const j = JSON.parse(raw) as Record<string, unknown>; text = String(j.text ?? j.error ?? raw.slice(0, 200)); }
      catch { text = raw.slice(0, 200); }
    } catch (e) { text = `【エラー】${e instanceof Error ? e.message : String(e)}`; }
    const hasCta = CTA_RE.test(text);
    const ok2 = (r.expect === "誘う") === hasCta;
    console.log(`   ${ok2 ? "✅" : "❌"} ${r.id}`);
    console.log(`      客「${r.text}」 → 期待「${r.expect}」／実際「${hasCta ? "誘った" : "誘わなかった"}」(${text.length}字)`);
    console.log(`      ${text.replace(/\n/g, " ／ ").slice(0, 110)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
