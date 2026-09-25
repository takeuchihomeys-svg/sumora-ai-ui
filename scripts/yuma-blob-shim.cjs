// scripts/yuma-pickup-customers-test.ts 専用: @vercel/blob の put/del の代わり（ローカルには Blob の鍵が無い）。
// 何もアップロードしない。テストが借りた本番の資料（同じ PDF・同じ描画）の公開 URL に ?yst=<印> を付けて返す＝
// 本番の recordPickupBatch をそのまま通しつつ、置き場にゴミを残さない（印で image_details の行を本番と分け、片付けで消す）
exports.put = async function put(pathname, _body, opts) {
  const f = globalThis.__YST_PUT;
  if (typeof f !== "function") throw new Error("yuma-blob-shim: 対応表が無い");
  const url = f(pathname);
  if (!url) throw new Error("yuma-blob-shim: 借りた資料が無い " + pathname);
  return { url, downloadUrl: url, pathname, contentType: opts && opts.contentType, contentDisposition: "" };
};
exports.del = async function del() { /* 何も消さない（本番の資料を消さない） */ };
