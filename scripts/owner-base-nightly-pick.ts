// scripts/owner-base-nightly-pick.ts — 毎晩の取りこぼしの網（owner-base-nightly.ts）の拾い方の純関数（テスト用に分けた）
/** 竹内さんの発言でない物（通知・system-reminder・要約の続き 等） */
export const SKIP_RE = /^(<task-notification|<system-reminder|<command-|<local-command|Caveat:|\[Request interrupted|<user-prompt-submit-hook|This session is being continued|<artifact-content|<cross-session-message)/;
/** 指摘・依頼・決定・なぜの言い方（どれかがあれば拾う） */
export const FEEDBACK_RE = /(る形|感じてしまう|感じさせ|する形|かたち|形とする|しない|入れない|いれない|いらない|不要|おかしい|違和感|なぜ|何故|原因|改善|強化|ずれ|ズレ|間違|まちが|ではなく|ではない|べき|ように|オススメで|おすすめで|推奨で|それでよい|それで良い|良い$|よい$|ダメ|だめ|NG)/;
/** 進め方・費用・時間の質問だけの発言（拾わない） */
export const PROGRESS_RE = /^(.{0,40})(どれくらい|いつ頃|いつごろ|完了|作業員|外出|進めて|続けて|おねがい！！|お願い！！|止めて|とめて|保存して|上げて)[^。]{0,30}[？?！!]?$/;
/** 選択式の答え（「１ おすすめ ２ はい」「A1 すぐAIX」「No.39 …」） */
export const CHOICE_RE = /(^|\s)(?:No\.?\s?\d+|[A-Z]?[0-9０-９]{1,2})\s*[ 　.:：）)]?\s*(おすすめ|オススメ|推奨|はい|いいえ|よい|良い|それで|状況による|入れ|そう|×|○)/;

/** 他の AI（Cursor 等）の伝言の貼り付け・作業の依頼文 */
export const RELAY_RE = /(app\/lib\/|app\/api\/|\.ts\b|ブランチ|【状況】|してください。|実装が(?:終わ|済み))/;
/** 返信・AIX・ブレインの土台に関わる語（無ければ拾わない） */
export const DOMAIN_RE = /(お客|返信|LINE|ライン|AIX|ブレイン|統括|文|下書き|内覧|申込|見積|物件|初期費用|審査|ピッカー|竹内|約束|挨拶|締め|かしこまりました|名前|呼び|サポート|言い回し|場面|入居|家賃|条件)/;
/** 拡張・PC・段取りの話（土台ではない） */
export const OPS_RE = /(カーソル|Cursor|拡張|USB|フォルダ|自動モード|PC|作業員|外出|メモリ|push|デプロイ)/;



export const clean = (s: string) => String(s ?? "").replace(/[\s　、。・！!？?「」『』（）()＝=\-—…,.:：〇]+/g, "");
export const bigrams = (s: string) => { const o = new Set<string>(); const c = clean(s); for (let i = 0; i < c.length - 1; i++) o.add(c.slice(i, i + 2)); return o; };
export const cover = (a: Set<string>, b: Set<string>) => { if (!a.size) return 0; let h = 0; for (const g of a) if (b.has(g)) h++; return h / a.size; };
/** 拾うか（純関数・テストできる形） */
export function shouldPick(text: string, images: number): { pick: boolean; pasted: boolean; choice: boolean } {
  const t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  const pasted = /<pasted_content/.test(t);
  const choice = CHOICE_RE.test(t);
  if (!t && !images) return { pick: false, pasted, choice };
  if (SKIP_RE.test(t)) return { pick: false, pasted, choice };
  // 11/11 の試し（11/10 の 136発言 → 35拾い）: 他の AI の伝言の貼り付け（Cursor 等・コードの道筋入り）と、拡張・PC の段取りが半分を占めた＝返信・ブレインの土台ではない
  if (RELAY_RE.test(t)) return { pick: false, pasted, choice };
  const domain = DOMAIN_RE.test(t);
  if (OPS_RE.test(t) && !domain) return { pick: false, pasted, choice };
  if (choice) return { pick: true, pasted, choice };
  if ((images > 0 || pasted) && (domain || t.length < 40)) return { pick: true, pasted, choice };
  if (t.length < 15 || !domain) return { pick: false, pasted, choice };
  if (/[？?]\s*$/.test(t) && !FEEDBACK_RE.test(t.replace(/[^。！!]*[？?]\s*$/, ""))) return { pick: false, pasted, choice }; // 問いだけの発言
  if (PROGRESS_RE.test(t) && !FEEDBACK_RE.test(t.replace(PROGRESS_RE, ""))) return { pick: false, pasted, choice };
  return { pick: FEEDBACK_RE.test(t), pasted, choice };
}
