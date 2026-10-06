// app/lib/new-arrival-hook.ts（純関数・DB/LLM なし）
// 新着1件の🌟（物件オススメで1件だけ送る新着）に、お客様が刺さったか。
//
// 2026-10-06 竹内「新着1件は別となる　これは条件近いのを送ってお客さんに連絡を入れるフックなので
//   新着1件でお客さんささっているのは、ちゃんと決めにいっている物件」:
//   ・新着1件の🌟は束から一番を選んだ物ではない（連絡のきっかけ）→ 🌟の並べ方の一致率の物差しから外す（scripts/audit-star-fit-d.ts の既定）
//   ・ただし新着1件にお客様が刺さった（その物件の内覧・見積書・申込・前向きな返事）物件は「決めに行っている物件」＝強い正の材料
//   正誤の決まり（feedback_property_selection_label: 正解はスタッフが選んで送った事実・反応で正誤を決めない）とは別の物:
//     ここで出すのは「フックが刺さった物件の特徴」を学ぶための印。刺さらなかった新着を「間違い」とは扱わない（no は no_signal であって負例ではない）
import { nameKey, sameBuildingName } from "./candidate-facts";

export type HookMessage = { sender: string; text: string | null; created_at: string; referenced_property_id?: unknown };
export type HookAix = { aix_type: string; generated_text: string | null; created_at: string };
export type NewArrivalHook = {
  /** 刺さった（内覧・見積書・申込のどれかがその物件で動いた／お客様がその物件に前向きに返した） */
  hooked: boolean;
  /** 刺さった印（viewing・estimate・apply・positive_reply・quoted） */
  signals: string[];
  /** お客様がその物件を断った（刺さらなかった印・負例ではない） */
  declined: boolean;
};

/** 前向きの言葉（新着1件への返事でスタッフが内覧・見積書へ進めた形）。実物: 「ここ内覧お願いいたします」「初期費用いくらですか？」「見積りお願いしたいです」 */
const POSITIVE_RE = /内覧|内見|見学|見に行|見積|初期費用|申込|申し込|空いて(?:ます|い)|気にな(?:ります|る|って)|いいですね|良いですね|良さそう|ここ(?:に|が|で|内覧)/;
/** 別の物件を送ってきた返事（ポータルの URL・画面の画像）は、この物件への反応ではない */
const OTHER_LISTING_RE = /https?:\/\/|【物件の画面|\[画像\]/;
/** 断り・懸念（刺さらなかった） */
const DECLINE_RE = /微妙|やめ|辞め|見送|合わな|ないです(?!か)|無しで|ナシ|古い|狭い|遠い|高い(?:です|かな|ので)|NG|いらな|不要|大丈夫です|結構です|厳しい|懸念|残念|😭|別で(?:物件)?見つか|一旦停止/;

const mentions = (text: string, name: string) => {
  const k = nameKey(name);
  return k.length >= 3 && nameKey(text).includes(k.slice(0, Math.min(k.length, 6)));
};

/**
 * 新着1件の🌟（物件名・送った時刻）→ 刺さったか。
 *   AIX（内覧調整・待ち合わせ・見積書・申込）は 14日以内でその物件の名前が出る物
 *   お客様の返事は 48時間以内: 物件名を言う／引用返信／（1件だけ送ったので）最初の返事が前向き。断りの言葉があれば刺さったに数えない
 */
export function newArrivalHookOf(input: { starName: string; sentAt: string; messages: ReadonlyArray<HookMessage>; aix: ReadonlyArray<HookAix>; replyHours?: number; aixDays?: number }): NewArrivalHook {
  const t = Date.parse(input.sentAt);
  const replyMs = (input.replyHours ?? 48) * 36e5, aixMs = (input.aixDays ?? 14) * 864e5;
  const signals: string[] = [];
  for (const a of input.aix) {
    const at = Date.parse(a.created_at);
    if (!(at > t && at <= t + aixMs) || !mentions(String(a.generated_text ?? ""), input.starName)) continue;
    if (/viewing_invite|meeting_place|viewing/.test(a.aix_type)) signals.push("viewing");
    else if (/estimate/.test(a.aix_type)) signals.push("estimate");
    else if (/application/.test(a.aix_type)) signals.push("apply");
  }
  const replies = input.messages.filter((m) => m.sender === "customer" && Date.parse(m.created_at) > t && Date.parse(m.created_at) <= t + replyMs)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let declined = false;
  replies.forEach((m, i) => {
    const s = String(m.text ?? "");
    // その物件の話か: 名前を言う／引用返信／（1件だけ送ったので）最初の返事で、別の物件（URL・画面の画像）を送ってきた返事でない
    const named = mentions(s, input.starName) || !!m.referenced_property_id;
    if (!named && !(i === 0 && !OTHER_LISTING_RE.test(s))) return;
    if (DECLINE_RE.test(s)) { declined = true; return; }
    if (POSITIVE_RE.test(s)) signals.push(m.referenced_property_id ? "quoted" : "positive_reply");
  });
  const uniq = [...new Set(signals)];
  return { hooked: uniq.length > 0 && !(declined && uniq.every((x) => x === "positive_reply" || x === "quoted")), signals: uniq, declined };
}

// ─── 監査用: お客様の返事の種類（scripts/audit-new-arrival-hook-criteria.ts）──────────────
export type HookReplyKind = "画像" | "URL・別の物件" | "断り・懸念" | "内覧" | "見積・初期費用" | "申込" | "前向き" | "質問" | "確認します" | "お礼だけ" | "空・スタンプ" | "その他";
export function classifyHookReply(m: { text?: string | null; image_url?: string | null }): HookReplyKind {
  const s = String(m.text ?? "").trim();
  if (m.image_url && !s.replace(/\[画像\]/g, "").trim()) return "画像";
  if (!s) return "空・スタンプ";
  if (OTHER_LISTING_RE.test(s)) return "URL・別の物件";
  if (DECLINE_RE.test(s)) return "断り・懸念";
  if (/内覧|内見|見学|見に行/.test(s)) return "内覧";
  if (/見積|初期費用/.test(s)) return "見積・初期費用";
  if (/申込|申し込/.test(s)) return "申込";
  if (POSITIVE_RE.test(s)) return "前向き";
  if (/[?？]|ですか|ますか/.test(s)) return "質問";
  if (/確認(?:します|しま|させ)|検討|見てみ|考え/.test(s)) return "確認します";
  if (/ありがと|有難|有り難|了解|承知|わかりました|分かりました|かしこまり/.test(s)) return "お礼だけ";
  if (/^\(.*\)$|^［.*］$|スタンプ/.test(s)) return "空・スタンプ";
  return "その他";
}


// ─── 2026-10-06 v2: 刺さった基準の作り直し（scripts/audit-new-arrival-hook-criteria.ts で 538回を目で読んだ結果）──────────
// 竹内さん「刺さった基準ちゃんと調査」。v1（newArrivalHookOf）を実物で読んで分かった誤りと漏れ:
//   誤り ① 「新着1件」の記録の多くは実はピックアップの束の中の🌟（直前に他の部屋の画像が何枚も・「全てピックアップさせて頂きました」）。
//          束の後の「最初の返事が前向き」は別の部屋の話が混ざる（実物: 「プレサンス心斎橋ブライト気になります！」が🌟Luxe難波南の回に・
//          「一応申し込みお願いします」が同じ時に送った別の部屋アーバネックス東梅田の話）
//        ② 返事に別の部屋の名前（「セレニテ本町の初期費用」）・直後にお客様の画像（他のサイトの画面）
//        ③ 「こちらの物件数日前に内覧しました😢」が 内覧 で前向きに数えられていた（過去形は断り）・「初期費用が高かったのでもう少し抑えたい」も
//        ④ スタッフが新着と一緒に同封した見積書（送った時の自分の見積書）は、お客様の反応ではない
//        ⑤ 🌟の物件名が本文の読み違い（「お申込み後の流れとなります。」「1件新着で〇〇さんに…」）の記録は物件ではない
//   漏れ ① 最初の返事がお礼で、2通目以降に「これだと初期費用いくらぐらい」「ここ内見いけますか？」（v1 は名前なしの返事を最初の1通だけ見た）
//        ② 引用返信（quoted_message_id）を見ていなかった（v1 は referenced_property_id だけ）→ 引用先の文・画像の物件で決める
//        ③ 物件名の綴りの揺れ（🌟 LOCHAS豊中稲津町 ↔ 見積書 LOHAS豊中稲津町）で見積書の AIX が結べない
//        ④ 見積書の記録（estimate_records）・内覧の記録（viewing_history）の物件名を見ていなかった
//        ⑤ 断りの言葉が同じ文にあると、内見したい（強い依頼）まで消していた
// 形:
//   お客様の文ごとに「どの部屋の話か」を 名前 → 引用先 → 別の部屋の名前・URL・お客様の画像 → 今の話題の部屋（直前にスタッフが出した部屋）→
//   スタッフの次の返事が名前を言うか、の順で決める。束の中の🌟で名前の無い返事は、スタッフの次の返事が🌟の名前を言った時だけ🌟の話にする。
//   強い刺さり（strong）: その部屋の 内覧・見積・申込 を頼んだ／AIX（内覧調整・待ち合わせ・見積書・申込）か見積書・内覧の記録がその部屋で、送った後にお客様の文がある
//   弱い刺さり（weak）: その部屋に前向きな言葉だけ（気になる・いいですね・入居いつから）。断り（過去形の内覧・高かった等）があれば数えない
//   学習の強い材料に使うのは strong（weak は報告と確かめ用）。v1 は残す（前の版の当て直し用）

export type HookMessageV2 = HookMessage & { image_url?: string | null; line_message_id?: string | null; quoted_message_id?: string | null };
export type HookLevel = "strong" | "weak" | "none";
export type NewArrivalHookV2 = {
  level: HookLevel;
  /** strong: ask_viewing・ask_estimate・ask_apply・aix_viewing・aix_estimate・aix_apply・estimate_record・viewing_record／weak: positive */
  signals: string[];
  declined: boolean;
  /** 束の中の🌟（前後に他の部屋も送った）か */
  bundle: boolean;
  /** 🌟の物件名が物件でない（本文の読み違い） */
  badName: boolean;
  /** 根拠（目で読む用・短い） */
  evidence: string[];
};

export const HOOK_V2_RULE = {
  replyHours: 72,
  aixDays: 14,
  viewingDays: 30,
  /** 束とみなす: 送った時刻の前 bundleBeforeMin 分〜後 5 分にスタッフの画像がこれ以上（🌟の画像を含む） */
  bundleImages: 3,
  bundleBeforeMin: 20,
  /** お客様の画像・URL が前後この分にあれば、その文は他のサイトの部屋の話 */
  ownListingMin: 10,
  /** スタッフの次の返事で決める時の長さ（時間） */
  confirmHours: 24,
};
export type HookV2Rule = typeof HOOK_V2_RULE;

/** 物件名らしくない🌟の名前（本文の読み違い） */
export function isPlausibleStarName(name: string | null | undefined): boolean {
  const s = String(name ?? "").trim();
  if (!s || s.length > 40) return false;
  return !/となります|ました|ください|お申込|新着で|オススメ|おすすめ|お世話|致し|させて/.test(s);
}

function editLe1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}
/**
 * 文が物件名を言っているか（照合の鍵 nameKey）。鍵全体／先頭6字（他に同じ先頭の部屋が無い時だけ）／先頭5字以上で1字違い（LOCHAS↔LOHAS）
 *   「エステムコート」のような同じシリーズの先頭だけでは決めない（others に同じ先頭がある時は先頭8字まで見る）
 */
export function textNamesProperty(text: string | null | undefined, name: string | null | undefined, others: ReadonlyArray<string> = []): boolean {
  const k = nameKey(name);
  const t = nameKey(text);
  if (k.length < 3 || !t) return false;
  if (t.includes(k)) return true;
  const head = k.slice(0, Math.min(k.length, 6));
  const shared = others.some((o) => { const ok = nameKey(o); return ok !== k && ok.startsWith(head); });
  if (shared) {
    // 同じシリーズ（スプランディッド堀江↔スプランディッド本町グラン）: 同じ先頭の後ろの2字まで合う時だけ
    const common = Math.max(...others.map((o) => { const ok = nameKey(o); if (ok === k) return 0; let i = 0; while (i < ok.length && i < k.length && ok[i] === k[i]) i++; return i; }));
    const need = k.slice(0, Math.min(k.length, common + 2));
    return need.length > common && t.includes(need);
  }
  if (head.length >= 3 && t.includes(head)) return true;
  // 略した名前＋助詞（「リーゾナブルの初期費用」「ARTと」）: 鍵の先頭4字以上の後に の/と/が/は/も/で/って/だと/さん。他の部屋と同じ先頭なら使わない
  for (let L = Math.min(k.length - 1, 10); L >= 4; L--) {
    const p = k.slice(0, L);
    if (others.some((o) => { const ok = nameKey(o); return ok !== k && ok.startsWith(p); })) break;
    const i = t.indexOf(p);
    if (i >= 0 && /^(?:の|と|が|は|も|で|って|だと|さん|,|、)/.test(t.slice(i + L))) return true;
  }
  // 1字違いは英字の名前だけ（LOCHAS↔LOHAS）。カナは同じシリーズ（セレニテ難波↔セレーテ難波）を拾うので使わない
  if (head.length >= 5 && /^[a-z0-9]+$/.test(head)) {
    for (let i = 0; i + head.length - 1 <= t.length; i++) {
      for (const L of [head.length - 1, head.length, head.length + 1]) { const w = t.slice(i, i + L); if (w.length === L && editLe1(w, head)) return true; }
    }
  }
  return false;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
/** 画像の読み取りの物件名（「グラントコート難波」↔「グランドコート難波」）と同じ物件か: 鍵6字以上で1字だけの違い */
export function ocrSameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = nameKey(a), y = nameKey(b);
  if (Math.min(x.length, y.length) < 6) return false;
  // 1字だけ（2字違いは同じシリーズの別の建物「スプランディッド堀江↔本町」と見分けられない）
  return editDistance(x, y) <= 1;
}

/** スタッフの文が出した部屋の名前（🌟〇〇・【〇〇 101号室】） */
export function staffIntroNames(text: string | null | undefined): string[] {
  const s = String(text ?? "");
  const out: string[] = [];
  for (const m of s.matchAll(/🌟\s*([^\n！!]{2,40}?)(?:\s*[0-9０-９A-Za-z]{1,5}号室?)?\s*(?:\n|$)/gu)) out.push(m[1].trim());
  for (const m of s.matchAll(/【([^】\n]{2,40})】/g)) {
    const n = m[1].replace(/\s*[0-9０-９A-Za-z-]{1,6}号室?$/, "").trim();
    if (!/物件の画面|お申込者|賃貸/.test(n)) out.push(n);
  }
  return [...new Set(out)].filter(isPlausibleStarName);
}

const STRONG_VIEW_RE = /内覧|内見|見学|見に行|案内(?:して|お願|可能|でき)/;
const PAST_VIEW_RE = /(?:内覧|内見|見学)(?:し|済|行き|行っ)(?:ました|てきました|みました|み)|見てきました|既に見|数日前に|(?:内覧|内見).{0,8}(?:もらった|させてもらった|した)(?:とこ|ところ|物件|部屋)/;
// 内覧を取り消す・他社で見る（「〇〇の内見はやはりなしで」「別の不動産で内覧予定です」）
const VIEW_CANCEL_RE = /(?:内覧|内見).{0,6}(?:なし|無し|キャンセル|やめ|取り消|大丈夫です)|別の(?:不動産|会社)|他社(?:さん|様)?で/;
// 見積は「頼む・聞く」形だけ（条件の一覧「初期費用10万以内」・お部屋探しの書式は依頼ではない）
const STRONG_EST_RE = /見積(?:もり|り|書)?(?:を|も)?(?:お願|ほし|欲し|頂|いただ|出し|出せ|だし|だせ|でき|可能|もら|下さ|くださ|知り|しり|教え)|初期費用(?:は|って|が|の|等|とか|も)?.{0,14}(?:いくら|どれ|どの|教え|知り|しり|出し|出せ|お願|伺|概算|わかり|分かり|調べ|ほし|欲し)|いくら(?:ぐらい|くらい|かか|でしょう|ですか|になり)|概算/;
// 申込は「したい・お願い」の形だけ（「申し込みの際」「申込んでしまうとキャンセル…」は依頼ではない）
const STRONG_APPLY_RE = /(?:申込|申し込)み?(?:を)?(?:お願|したい|させ|します|希望|進め|で(?:お願|大丈夫))|部屋(?:を)?抑え|抑えて(?:ほし|欲し|下さ|くださ|頂|いただ|て)|抑える(?:だけ|こと)|ここで決め|ここに(?:決め|します)|契約(?:したい|させ|お願)|仮(?:お|押)さえ/;
// 「いいな」は「〜がいいなって思ってる」（別の希望）で広すぎるので入れない
const WEAK_RE = /気にな|いいですね|良いですね|良さそう|よさそう|素敵|すてき|好き|魅力|ここ(?:が|も)?(?:いい|良い)|空いて(?:ます|い)|まだ(?:空|募集)|入居(?:は)?(?:いつ|何日|何月)|すごく良|めっちゃいい|いいと思/;
const DECLINE_V2_RE = /微妙|やめ|辞め|見送|合わな|ないです(?!か)|無しで|ナシ|古い|狭い|遠い|高い(?:です|かな|ので|な)|高かった|高くて|もう少し(?:安|抑え)|もっと(?:安|抑え)|NG|いらな|不要|結構です|厳しい|懸念|残念|😭|別で(?:物件)?見つか|他(?:社|で)(?:で)?決ま|決まりました|一旦停止|ごめんなさい|好きじゃ|好きでは|(?:じゃ|では)ないんです|(?:ですが|ですけど|けど|けれど)[、,]?.{0,20}(?:もう少し|もっと|ちょっと|場所|遠|狭|高|古)/;
const COST_DECLINE_RE = /高かった|高くて|もう少し(?:安|抑え)|もっと(?:安|抑え)/;

type Ref = "star" | "other" | "ambiguous";
const toHalfRoom = (r: unknown) => String(r ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");
const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").slice(0, n);

/**
 * 新着1件の🌟（または束の中の🌟）にお客様が刺さったか（v2）。純関数。
 *   imageNameOf … 画像 URL → その画像の物件名（sent_image_properties）。無ければ画像は名前なしとして扱う
 *   otherNames … 同じ会話で前後に出た他の部屋の名前（送付の記録・画像の読み取り）。スタッフの文の🌟／【】からも自動で拾う
 */
export function newArrivalHookV2Of(input: {
  starName: string; starRoom?: string | null; sentAt: string;
  messages: ReadonlyArray<HookMessageV2>; aix: ReadonlyArray<HookAix>;
  estimates?: ReadonlyArray<{ property_name: string | null; room_no?: string | null; created_at: string }>;
  viewings?: ReadonlyArray<{ property_name: string | null; created_at: string }>;
  imageNameOf?: (url: string) => string | null | undefined;
  otherNames?: ReadonlyArray<string>;
  rule?: Partial<HookV2Rule>;
}): NewArrivalHookV2 {
  const R: HookV2Rule = { ...HOOK_V2_RULE, ...(input.rule ?? {}) };
  const star = input.starName;
  const t = Date.parse(input.sentAt);
  const at = (m: { created_at: string }) => Date.parse(m.created_at);
  const evidence: string[] = [];
  if (!isPlausibleStarName(star)) return { level: "none", signals: [], declined: false, bundle: false, badName: true, evidence };

  const msgs = [...input.messages].sort((a, b) => at(a) - at(b));
  const imgName = (u: string | null | undefined) => (u && input.imageNameOf ? input.imageNameOf(u) ?? null : null);
  const isStarName = (n: string | null | undefined) => !!n && (sameBuildingName(n, star) || textNamesProperty(n, star) || ocrSameName(n, star));
  // 他の部屋の名前: 引数＋スタッフの文の🌟/【】＋画像の名前（🌟と同じ建物は除く）
  const others = new Set<string>();
  for (const n of input.otherNames ?? []) if (n && !isStarName(n)) others.add(n);
  for (const m of msgs) {
    if (m.sender === "customer" || Math.abs(at(m) - t) > 7 * 864e5) continue;
    for (const n of staffIntroNames(m.text)) if (!isStarName(n)) others.add(n);
    const n = imgName(m.image_url); if (n && !isStarName(n)) others.add(n);
  }
  const otherList = [...others];
  const namesStar = (s: string) => textNamesProperty(s, star, otherList);
  // 他の部屋はお客様が短く言う（「ブラービの内覧」「レオンコンフォートは」）→ 鍵の先頭4字（かな・カナ・漢字・英字）でも当てる。🌟の名前を言っていない時だけ使う
  const namesOther = (s: string) => {
    const t = nameKey(s);
    return otherList.some((o) => {
      if (textNamesProperty(s, o, [star, ...otherList.filter((x) => x !== o)])) return true;
      const k = nameKey(o).slice(0, 4);
      return k.length === 4 && !nameKey(star).startsWith(k) && t.includes(k);
    });
  };

  // 束か: 送った時刻の前後にスタッフの画像が多い／他の部屋を出している／「全てピックアップ」の文
  const near = msgs.filter((m) => m.sender !== "customer" && at(m) >= t - R.bundleBeforeMin * 60_000 && at(m) <= t + 5 * 60_000);
  const nearImgs = near.filter((m) => !!m.image_url || /^\s*\[画像\]\s*$/.test(String(m.text ?? ""))).length;
  const nearOther = near.some((m) => staffIntroNames(m.text).some((n) => !isStarName(n)) || (!!imgName(m.image_url) && !isStarName(imgName(m.image_url))));
  const bundle = nearImgs >= R.bundleImages || nearOther
    || near.some((m) => /全て(?:の)?(?:お部屋)?ピックアップ|全域から|(?:物件|お部屋)?ピックアップ(?:し)?(?:させて頂きました|させていただきました|しお送り)|お送りさせて頂いた(?:お部屋|物件)の中/.test(String(m.text ?? "")));

  // スタッフが部屋を出した流れ（話題の部屋）
  type Intro = { at: number; who: "star" | "other" };
  const intros: Intro[] = [{ at: t, who: "star" }];
  for (const m of msgs) {
    if (m.sender === "customer") continue;
    const head = String(m.text ?? "").slice(0, 80);
    const n = imgName(m.image_url);
    const st = (/🌟|【/.test(head) && namesStar(head)) || (n != null && isStarName(n));
    const ot = staffIntroNames(head).some((x) => !isStarName(x)) || (n != null && !isStarName(n));
    if (st && !ot) intros.push({ at: at(m), who: "star" });
    else if (ot && !st) intros.push({ at: at(m), who: "other" });
  }
  intros.sort((a, b) => a.at - b.at);

  const byLineId = new Map(msgs.filter((m) => m.line_message_id).map((m) => [String(m.line_message_id), m]));
  const replies = msgs.filter((m) => m.sender === "customer" && at(m) > t && at(m) <= t + R.replyHours * 36e5);
  const ownListingNear = (m: HookMessageV2) => msgs.some((x) => x.sender === "customer" && Math.abs(at(x) - at(m)) <= R.ownListingMin * 60_000
    && (!!x.image_url || /https?:\/\//.test(String(x.text ?? "")) || /^\s*\[画像\]/.test(String(x.text ?? ""))));
  // スタッフの次の返事（24時間・最初の6通）で最初に名前の出た部屋。「かしこまりました！！ 〇〇の御見積書…」「【〇〇 206号室】初期費用…」
  const staffConfirm = (m: HookMessageV2): Ref | null => {
    // お客様の次の文より前（その文への返事）だけ。先の別の話（次の依頼への見積書）で決めない
    const nextCust = msgs.find((x) => x.sender === "customer" && at(x) > at(m) + 60_000 && String(x.text ?? "").trim());
    const until = Math.min(at(m) + R.confirmHours * 36e5, nextCust ? at(nextCust) : Infinity);
    const nx = msgs.filter((x) => x.sender !== "customer" && at(x) > at(m) && at(x) <= until).slice(0, 6);
    for (const x of nx) {
      const s = String(x.text ?? "").slice(0, 160), n = imgName(x.image_url);
      const st = namesStar(s) || (n != null && isStarName(n)), ot = namesOther(s) || (n != null && !isStarName(n));
      if (st && ot) return "ambiguous";
      if (st) return "star";
      if (ot) return "other";
    }
    return null;
  };

  const refOf = (m: HookMessageV2): { ref: Ref; how: string } => {
    const s = String(m.text ?? "");
    // お客様の画像（他のサイトの画面の読み取り）は名前が似ていても🌟の話ではない
    if (m.image_url || /^\s*\[画像\]/.test(s)) return { ref: "other", how: "お客様の画像" };
    if (namesStar(s)) return { ref: "star", how: "名前" };
    if (m.quoted_message_id) {
      const q = byLineId.get(String(m.quoted_message_id));
      if (q) {
        const qs = String(q.text ?? ""), qn = imgName(q.image_url);
        if (namesStar(qs) || (qn && isStarName(qn))) return { ref: "star", how: "引用" };
        if (namesOther(qs) || (qn && !isStarName(qn))) return { ref: "other", how: "引用（別の部屋）" };
        if (Math.abs(at(q) - t) <= 3 * 60_000 && !bundle) return { ref: "star", how: "引用（送った時の文）" };
        if (Math.abs(at(q) - t) > 3 * 60_000) return { ref: "other", how: "引用（別の時の文）" };
      }
    }
    if (namesOther(s)) return { ref: "other", how: "別の部屋の名前" };
    // 一覧に無い別の部屋の名前（「ブラービの内覧ですが」「十三ブロッサムが気になって」）: カナ4字以上＋の/が/は＋内覧・見積・気になる
    {
      const mm = s.match(/([゠-ヿ一-鿿A-Za-z]{0,6}[゠-ヿA-Za-z]{4,}[゠-ヿ一-鿿A-Za-z]{0,6})(?:の|が|は|も)(?:内覧|内見|見積|初期費用|件|気にな|お願い)/);
      if (mm && !textNamesProperty(mm[1], star) && !/^(?:こちら|そちら|お部屋|物件|インターネット|オートロック|カウンター|キッチン)/.test(mm[1])) return { ref: "other", how: "一覧に無い別の部屋の名前" };
    }
    if (/他(?:に|の|で)(?:物件|部屋|お部屋)?(?:見て|比較|検討して)|前回(?:オススメ|おすすめ|送)/.test(s)) return { ref: "other", how: "他の部屋の話" };
    if (/https?:\/\//.test(s) || /【物件の画面|^\s*\[画像\]/.test(s) || m.image_url || ownListingNear(m)) return { ref: "other", how: "URL・お客様の画像" };
    const last = [...intros].reverse().find((x) => x.at <= at(m));
    const c = staffConfirm(m);
    if (last?.who === "other") return c === "star" ? { ref: "star", how: "スタッフの返事が名前" } : { ref: "other", how: "話題は別の部屋" };
    if (c) return { ref: c, how: c === "star" ? "スタッフの返事が名前" : c === "other" ? "スタッフの返事が別の部屋" : "スタッフの返事が🌟と別の部屋の両方" };
    if (bundle) return { ref: "ambiguous", how: "束の中で名前なし" };
    return { ref: "star", how: "話題の部屋（新着1件）" };
  };

  const signals: string[] = [];
  let declined = false, weakSeen = false;
  for (const m of replies) {
    const s = String(m.text ?? "");
    if (!s.trim()) continue;
    const r = refOf(m); if ((globalThis as any).__HOOKDBG) console.log("REF", r, s.slice(0, 30));
    if (r.ref !== "star") continue;
    const past = PAST_VIEW_RE.test(s) || VIEW_CANCEL_RE.test(s);
    const sv = STRONG_VIEW_RE.test(s) && !past, se0 = STRONG_EST_RE.test(s) && !VIEW_CANCEL_RE.test(s), sa = STRONG_APPLY_RE.test(s) && !VIEW_CANCEL_RE.test(s);
    const se = se0 && !COST_DECLINE_RE.test(s);
    if (sv || se || sa) {
      if (sv) signals.push("ask_viewing");
      if (se) signals.push("ask_estimate");
      if (sa) signals.push("ask_apply");
      evidence.push(`${r.how}: ${oneLine(s, 50)}`);
      continue;
    }
    if (past || DECLINE_V2_RE.test(s)) { declined = true; evidence.push(`断り(${r.how}): ${oneLine(s, 40)}`); continue; }
    // 内覧の日程の流れの中で🌟の名前を言って「お願いします」（「シャトードルチェ City Spire クレアジオーネ の3つでお願いします！」）
    const prevStaff = [...msgs].reverse().find((x) => x.sender !== "customer" && at(x) < at(m));
    if (r.how === "名前" && /お願い/.test(s) && /内覧|内見|ご案内/.test(String(prevStaff?.text ?? ""))) { signals.push("ask_viewing"); evidence.push(`内覧の流れで名前: ${oneLine(s, 50)}`); continue; }
    if (WEAK_RE.test(s)) { weakSeen = true; evidence.push(`前向き(${r.how}): ${oneLine(s, 40)}`); }
  }
  // 記録: 送った後にお客様の文がある物だけ（スタッフが新着に同封した見積書は数えない）
  // 送った後の最初のお客様の文（72時間に限らない）。これより前の AIX・記録はスタッフが自分から送った物（新着に同封の見積書など）
  const firstCustMsg = msgs.find((m) => m.sender === "customer" && at(m) > t && String(m.text ?? m.image_url ?? "").trim());
  const firstCust = firstCustMsg ? at(firstCustMsg) : Infinity;
  // スタッフがお客様の文に応えて🌟の名前で動いた（「かしこまりました！！ ネスト谷六205号室お申込みさせていただきます」）
  for (const x of msgs) {
    if (x.sender === "customer" || at(x) <= firstCust || at(x) > t + R.aixDays * 864e5) continue;
    const s = String(x.text ?? "");
    // 「かしこまりました」「ご查収いただきありがとうございます！！ かしこまりました😊！！ 〇〇と△△の…御見積書」（先頭40字の中）
    if (!/かしこまり|承知/.test(s.slice(0, 40)) || !namesStar(s.slice(0, 120))) continue;
    const prevCust = [...msgs].reverse().find((y) => y.sender === "customer" && at(y) < at(x));
    if (!prevCust || at(x) - at(prevCust) > 24 * 36e5) continue;
    const head = s.slice(0, 160);
    if (/キャンセル|取り消|なしで|見送/.test(head)) continue;
    let sig: string | null = null;
    if (/お?申込み?(?:させ|手続|進め|頂|いただ)|申し込み(?:させ|進め)/.test(head)) sig = "staff_apply";
    else if (/ご案内させ|ご内覧|内覧日/.test(head)) sig = "staff_viewing";
    else if (/見積/.test(head)) {
      // 続けて送った見積書（【〇〇 201号室】）が別の部屋だけなら、文の名前は書き間違い（「エステムコート…の御見積書」→【ハーモニーテラス市岡】）
      const segs = msgs.filter((y) => y.sender !== "customer" && at(y) >= at(x) && at(y) <= at(x) + 12 * 36e5)
        .flatMap((y) => [...String(y.text ?? "").matchAll(/【([^】]+)】/g)].map((m) => m[1].replace(/\s*[0-9０-９A-Za-z-]{1,6}号室?\s*$/, "")))
        .filter((n) => !/お申込者|物件の画面/.test(n));
      sig = segs.length && !segs.some((n) => isStarName(n) || namesStar(n)) ? null : "staff_estimate";
    }
    if (sig) { signals.push(sig); evidence.push(`スタッフ: ${oneLine(s, 50)}`); }
  }
  for (const a of input.aix) {
    const x = Date.parse(a.created_at);
    if (!(x > t && x <= t + R.aixDays * 864e5) || x < firstCust) continue;
    const g = String(a.generated_text ?? "");
    // 見積書は複数の部屋をまとめて出す（①【〇〇】②【〇〇】）ので全文・他は先頭だけ（内覧調整の本文の後ろの別の物件を拾わない）
    const segNames = [...g.matchAll(/【([^】]+)】/g)].map((x) => x[1].replace(/\s*[0-9０-９A-Za-z-]{1,6}号室?\s*$/, ""));
    if (!namesStar(/estimate/.test(a.aix_type) ? g : g.slice(0, 200)) && !segNames.some((n) => isStarName(n))) continue;
    // 見積書の【〇〇 205号室】が🌟の号室と違う（同じ建物の別の部屋）は数えない
    if (/estimate/.test(a.aix_type) && input.starRoom) {
      const segs = [...g.matchAll(/【([^】]+)】/g)].map((x) => x[1]).filter((x) => namesStar(x) || isStarName(x.replace(/\s*[0-9０-９A-Za-z-]{1,6}号室?\s*$/, "")));
      const b = toHalfRoom(input.starRoom);
      const rooms = segs.map((x) => toHalfRoom((x.match(/([0-9０-９A-Za-z-]{1,6})号室?\s*$/) ?? [])[1] ?? ""));
      if (segs.length && b && rooms.every((r) => r && r !== b)) continue;
    }
    let sig: string | null = null;
    if (/viewing_invite|meeting_place|viewing/.test(a.aix_type)) sig = "aix_viewing";
    else if (/estimate/.test(a.aix_type)) sig = "aix_estimate";
    else if (/application/.test(a.aix_type)) sig = "aix_apply";
    if (!sig) continue;
    signals.push(sig); evidence.push(`AIX ${a.aix_type}`);
  }
  for (const e of input.estimates ?? []) {
    const x = Date.parse(e.created_at);
    if (!(x > t && x <= t + R.aixDays * 864e5) || x < firstCust || !isStarName(e.property_name)) continue;
    const a = toHalfRoom(e.room_no), b = toHalfRoom(input.starRoom);
    if (a && b && a !== b) continue;
    signals.push("estimate_record"); evidence.push(`見積書の記録 ${e.property_name}`);
  }
  for (const v of input.viewings ?? []) {
    const x = Date.parse(v.created_at);
    if (!(x > t && x <= t + R.viewingDays * 864e5) || x < firstCust || !isStarName(v.property_name)) continue;
    signals.push("viewing_record"); evidence.push(`内覧の記録 ${v.property_name}`);
  }
  const uniq = [...new Set(signals)];
  if (uniq.length) return { level: "strong", signals: uniq, declined, bundle, badName: false, evidence };
  if (weakSeen && !declined) return { level: "weak", signals: ["positive"], declined, bundle, badName: false, evidence };
  return { level: "none", signals: [], declined, bundle, badName: false, evidence };
}
