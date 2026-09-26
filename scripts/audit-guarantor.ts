// 保証会社について聞かれた時の監査（読み取りのみ・LLM は呼ばない・名前は伏せて出す）
// 2026-09-26 竹内「保証会社を聞かれたら画像から読み取って保証会社について説明できるように。聞かれた場合に読み取る形になっているか。
//   また保証会社のことについてちゃんと知識があるのか。知識の部分は過去の会話をみたらわかる」
//
// 測ること（直近 DAYS 日・グループと YUMA を除く・messages は 2026-05-17 から）:
//   ① お客様の保証会社・審査・保証人・緊急連絡先・保証料の質問を決定論で集め、種類ごとの件数・返信までの分・社名を答えたか・確認しますか・AIX
//   ② スタッフの実送信の文から、保証会社ごとの説明（種類の呼び名・緩い/厳しい）と一般的な説明（キャンセル料・審査期間・緊急連絡先…）を会話数で数える
//   ③ AI の下書きの同じ数え方（食い違い＝全保連・ジェイリースを「独立系」と書く 等）
//   ④ 保存済みの物件資料から保証会社名・料率が取れる割合（image_details の読み取り／property_pickups の文字層 realpro・itandi）
//
// 2026-09-26 の結論（設計知見「保証会社の質問は『物件の会社名』と『一般論』で道が違う…」）:
//   質問 ≈390ターン（申込フォーム・進捗を除くと≈280）。物件の保証会社はどこ/厳しいか は目で読んで26件・17会話（月6件）で、
//   スタッフは半分（13）をその場で社名つきで答え、確認します は5、48h返信なし・電話7。答えの社名は資料より管理会社への確認から来ている事が多い。
//   保存済みの読み取りで社名が取れるのは image_details 39%・realpro 文字層 48%（文字層のある行）・itandi 89%（料率も89%）。
//   AI の下書きは「独立系保証会社（全保連・Casa・ジェイリース等）」を4会話で書いた（出所は ai_reply_knowledge の imp9 の1行）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-guarantor.ts   （DAYS=180）
import { createClient } from "@supabase/supabase-js";
import { detectGuarantorInText } from "../app/lib/guarantor-companies";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page(table: string, cols: string, s: string | null, extra?: (q: any) => any): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for (let p = 0; p < 400; p++) {
    let q = sb.from(table).select(cols).range(p * 1000, p * 1000 + 999);
    if (s) q = q.gte("created_at", s);
    if (extra) q = extra(q);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const mask = (s: string) => (s ?? "").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/https?:\/\/\S+/g, "[URL]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/\s+/g, " ");

// ── ① お客様の質問
const GATE = /保証会社|保証人|保証料|緊急連絡先|審査|信販|独立系|LICC/;
const FORM = /生年月日|フリガナ|勤務先|ふりがな|現住所|携帯番号|続柄/;
const COND_FORM = /【お部屋お探し中|ご希望のお部屋探しご条件|①.{0,6}ご入居/;
const Q_KINDS: Array<[string, RegExp]> = [
  ["物件の保証会社はどこ", /保証会社[^。\n]{0,6}(は|って|が)?[^。\n]{0,4}(どこ|何|なに|どちら)|どこの保証会社|保証会社(名|の名前)/],
  ["種類（独立系・信販…）", /独立系|信販|LICC|信用系|クレカ系|クレジット系/],
  ["審査は厳しいか・通るか", /審査[^。\n]{0,10}(厳し|緩|ゆる|甘|通り|通る|通れ|きつ|キツ|難し|大丈夫|不安|心配)|通りやす|通りにく|保証会社[^。\n]{0,10}(緩|ゆる|厳し|きつ)/],
  ["保証料・更新料", /保証料|保証会社[^。\n]{0,12}(費用|料金|いくら|金額|%|％|更新)|初回保証|月額保証/],
  ["連帯保証人", /連帯保証人|保証人/],
  ["緊急連絡先", /緊急連絡先/],
  ["属性（夜職・滞納・外国籍…）", /外国|国籍|無職|夜職|水商売|ブラック|自己破産|債務整理|滞納|延滞|信用情報|個人事業|フリーランス|自営|学生|年金|生活保護|収入|育休/],
  ["審査期間", /審査[^。\n]{0,10}(何日|どのくらい|どれくらい|期間|日数|いつ)/],
];
const CONFIRM_RE = /確認(させて|さして|致し|いたし|します)|確認(出来|でき)次第|お調べ|問い合わせ/;

// ── ② ③ 説明の数え方
const COMPANY_RE: Array<[string, RegExp]> = [["日本セーフティー", /日本セーフティ/], ["Casa", /Casa|CASA|カーサ(?!Sun)/], ["エルズサポート", /エルズ/], ["いえらぶ", /いえらぶ/], ["アセス", /アセス/], ["全保連", /全保連/], ["ジェイリース", /ジェイリース/], ["ナップ", /ナップ/], ["エポス", /エポス/], ["オリコ", /オリコ/], ["クレディセゾン", /セゾン/], ["ジャックス", /ジャックス/], ["シノケン", /シノケン/], ["ほっと保証", /ほっと保証/], ["アーク", /アーク(賃貸)?保証/], ["K-net", /K-?net/i], ["JPMC", /JPMC/]];
const TYPE_RE: Array<[string, RegExp]> = [["独立系", /独立系/], ["LICC系", /LICC/i], ["信用系", /信用系/], ["信販系", /信販/], ["緩い", /緩|ゆる|通りやす|通過しやす/], ["厳しい", /厳し|審査基準が高/]];
const TOPIC_RE: Array<[string, RegExp]> = [
  ["キャンセル料は保証会社審査通過まで不要", /保証会社[^。！!\n]{0,30}(通過|承認)[^。！!\n]{0,25}キャンセル料|キャンセル料[^。！!\n]{0,30}保証会社[^。！!\n]{0,10}審査/],
  ["審査期間 3日〜10日", /3日[〜~～-]\s*10日/],
  ["審査期間 3〜5日", /3[日]?[〜~～-]\s*5日/],
  ["緊急連絡先は必須・3親等以内", /3親等|三親等|緊急連絡先[^。！!\n]{0,12}(必須|必要)/],
  ["緊急連絡先に支払い義務なし", /緊急連絡先[^。\n]{0,60}義務/],
  ["連帯保証人は実印・印鑑証明", /印鑑(登録)?証明/],
  ["独立系＝審査が緩い", /独立系[^。！!\n]{0,25}(緩|ゆる|通りやす|通過しやす|柔軟)/],
  ["通りやすい保証会社の物件中心に探す", /(通りやすい|通過しやすい|独立系|緩い)[^。\n]{0,6}保証会社[^。\n]{0,20}(中心|優先|メイン)/],
  ["保証会社が被ると同時審査不可", /(被|かぶ)[^。！!\n]{0,20}(同時|並行|1件)|同時審査/],
  ["独立系（全保連・ジェイリース…）の誤り", /独立系[^。！!\n]{0,6}保証会社?（[^）]*(全保連|ジェイリース)/],
];
const split = (t: string) => t.split(/\n|(?<=[！!。])(?=[^！!。])/).map((s) => s.trim()).filter((s) => s.length >= 4 && /保証|緊急連絡先|審査/.test(s));

(async () => {
  const convs = await page("conversations", "id, line_source_type", null);
  const ok = new Set<string>(); for (const c of convs) if (c.id !== YUMA && c.line_source_type !== "group") ok.add(c.id);
  const msgs = (await page("messages", "conversation_id, sender, text, image_url, created_at, is_aix_generated", since)).filter((m) => ok.has(m.conversation_id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const byConv = new Map<string, typeof msgs>(); for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  // ① 質問
  const stat: Record<string, { n: number; convs: Set<string>; noReply: number; mins: number[]; named: number; confirm: number; aix: number }> = {};
  const examples: Record<string, string[]> = {};
  for (const [cid, list] of byConv) for (let i = 0; i < list.length; i++) {
    const m = list[i]; if (m.sender !== "customer" || !m.text || !GATE.test(m.text) || FORM.test(m.text) || COND_FORM.test(m.text)) continue;
    const ks = Q_KINDS.filter(([, re]) => re.test(m.text)).map(([k]) => k); if (!ks.length) continue;
    let j = i + 1; while (j < list.length && list[j].sender === "customer") j++;
    const staff: typeof msgs = []; while (j < list.length && list[j].sender !== "customer") staff.push(list[j++]);
    const t = Date.parse(m.created_at); const first = staff[0] ? Date.parse(staff[0].created_at) : NaN;
    const reply = staff.length > 0 && first - t <= 48 * 3600e3;
    const stext = staff.map((s) => s.text ?? "").join(" / ");
    for (const k of ks) {
      const s = (stat[k] ??= { n: 0, convs: new Set(), noReply: 0, mins: [], named: 0, confirm: 0, aix: 0 });
      s.n++; s.convs.add(cid);
      if (!reply) { s.noReply++; continue; }
      s.mins.push(Math.round((first - t) / 60e3));
      if (detectGuarantorInText(stext)) s.named++;
      if (CONFIRM_RE.test(stext)) s.confirm++;
      if (staff.some((x) => x.is_aix_generated)) s.aix++;
      if ((examples[k] ??= []).length < 3) examples[k].push(`${cid.slice(0, 8)} Q「${mask(m.text).slice(0, 70)}」→ S「${mask(stext).slice(0, 90)}」`);
    }
  }
  console.log(`\n① お客様の質問（${DAYS}日・申込フォームと条件フォームを除く）`);
  console.log("種類\tターン\t会話\t48h返信なし\t返信までの分(中央)\t社名を答えた\t確認します\tAIXを含む");
  for (const [k] of Q_KINDS) { const s = stat[k]; if (!s) continue; const md = [...s.mins].sort((a, b) => a - b)[Math.floor(s.mins.length / 2)]; console.log(`${k}\t${s.n}\t${s.convs.size}\t${s.noReply}\t${md ?? "-"}\t${s.named}\t${s.confirm}\t${s.aix}`); }
  for (const [k, xs] of Object.entries(examples)) { console.log(`  例 ${k}`); for (const x of xs) console.log(`    ${x}`); }

  // ② ③ スタッフと下書きの説明
  const staffS = msgs.filter((m) => m.sender !== "customer" && m.text).flatMap((m) => split(m.text).map((s) => ({ cid: m.conversation_id as string, s })));
  const ex = (await page("ai_reply_examples", "conversation_id, ai_draft", since)).filter((r) => ok.has(r.conversation_id) && r.ai_draft);
  const draftS = ex.flatMap((r) => split(String(r.ai_draft)).map((s) => ({ cid: r.conversation_id as string, s })));
  const convCount = (arr: Array<{ cid: string; s: string }>, re: RegExp) => new Set(arr.filter((x) => re.test(x.s)).map((x) => x.cid)).size;
  console.log(`\n② 保証会社ごとの説明（会話数・スタッフ / 下書き）`);
  for (const [n, re] of COMPANY_RE) {
    const st = staffS.filter((x) => re.test(x.s)), dr = draftS.filter((x) => re.test(x.s));
    if (!st.length && !dr.length) continue;
    const lab = (arr: typeof st) => TYPE_RE.map(([k, r]) => { const c = new Set(arr.filter((x) => r.test(x.s)).map((x) => x.cid)).size; return c ? `${k}${c}` : ""; }).filter(Boolean).join(" ");
    console.log(`${n}\tスタッフ${new Set(st.map((x) => x.cid)).size}会話 [${lab(st)}]\t下書き${new Set(dr.map((x) => x.cid)).size}会話 [${lab(dr)}]`);
  }
  console.log(`\n③ 一般的な説明（会話数・スタッフ / 下書き）`);
  for (const [k, re] of TOPIC_RE) console.log(`${k}\t${convCount(staffS, re)}\t${convCount(draftS, re)}`);

  // ④ 保存済みの資料
  const idt = await page("image_details", "kind, lines", null);
  const NAME = /株式会社|インシュア|ギャランティ|セーフティ|サポート|Casa|カーサ|エポス|ジャックス|JACCS|K-net|全保連|アセス|オリコ|セゾン|エルズ|いえ[らる]ぶ|ナップ|GTN|ジェイリース|[ァ-ヶA-Za-z]{2,}(賃貸)?保証/;
  const gl = idt.filter((r) => r.kind === "property").map((r) => ((r.lines ?? []) as string[]).find((l) => /^保証会社/.test(l)) ?? null);
  const glv = gl.filter((x): x is string => !!x).map((x) => x.replace(/^保証会社[:：]\s*/, ""));
  console.log(`\n④ image_details 物件資料${gl.length} 保証会社の行${glv.length} 社名あり${glv.filter((x) => NAME.test(x.replace(/^(家賃保証|保証会社)/, ""))).length} 料率/金額${glv.filter((x) => /\d\s*[%％]|\d[\d,]*円/.test(x)).length}`);
  const pk = await page("property_pickups", "site, pdf_text", null);
  for (const site of ["realpro", "itandi"]) {
    const rows = pk.filter((r) => r.site === site); const text = rows.filter((r) => String(r.pdf_text ?? "").trim());
    const seg = text.map((r) => String(r.pdf_text).match(/保証会社[\s\S]{0,120}/)?.[0] ?? "").filter(Boolean);
    console.log(`property_pickups ${site}: 行${rows.length} 文字層${text.length} 保証会社の段${seg.length} 社名${seg.filter((s) => NAME.test(s.replace(/保証会社(利用必須|加入必須|利用可能|加⼊|要)?/g, ""))).length} 料率/年額${seg.filter((s) => /\d\s*[%％]|年間保証|更新/.test(s)).length}`);
  }
})();
