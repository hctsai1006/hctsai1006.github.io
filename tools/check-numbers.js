/* check-numbers.js — 這個終端機的計數一致性檢查。
   設計前提：計數的唯一來源是 index.html 裡的 `D.stats`。四個渲染點（profile accent、
   README.md 種子、timeline、Get-Contribution 標題）都從它算，所以不會漂。
   但 <noscript> 那段是給 SEO 與無 JS 讀者的靜態文字、不能由 JS 產生 ——
   它是唯一還要手動同步的地方，本檔就是為了盯它。

   計數是從 src/data/profile.json 讀的，不是直接掃 index.html。訊息裡仍寫「D.stats」，
   而那是準確的 —— 但只在下面那道新鮮度閘門通過之後才準確：閘門先證明 src/data
   就是 index.html 當前的抽取結果，兩者才是同一個數字。沒有閘門的話，這些訊息會
   拿舊的抽取結果去談 D.stats，講的是一個 index.html 裡已經不存在的數字。

   另可帶第二個參數指向 NYCU CS 的 open-source/index.html，一併比對是否與權威頁一致。
   用法：node tools/check-numbers.js [index.html] [權威 open-source/index.html] */
/* ESM: the repo gained a package.json with "type":"module", so this file is now
   an ES module. import.meta.dirname replaces the CommonJS directory global
   (Node 20.11+). */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const DEFAULT_FILE = path.join(import.meta.dirname, '..', 'index.html');
const FILE = process.argv[2] || DEFAULT_FILE;
/* The authoritative NYCU CS page lives outside this repo, so checks 5 and 6 can
   only run on a machine that has it. That is fine — but it must be VISIBLE.
   Previously CI ran 4 of the 6 checks under a step named "portfolio counts are
   consistent" and reported success, so the two cross-repo checks were silently
   absent from every CI run. The summary now states what actually ran. */
const AUTH = process.argv[3] || process.env.AUTHORITATIVE_OPEN_SOURCE ||
  'C:/Users/thc1006/Desktop/MAY/personal-homepage/open-source/index.html';
let skipped = 0;
const skip = m => { console.log('  - ' + m); skipped++; };
let fails = 0;
const bad = m => { console.log('  x ' + m); fails++; };
const ok = m => console.log('  v ' + m);

const s = fs.readFileSync(FILE, 'utf8');

/* 計數改從抽出來的 src/data/profile.json 讀，不再用 regex 掃 index.html。
   regex 掃結構正是當初讓計數從 115 漂到 148 沒被發現的同一類手法；
   src/data 由 tools/extract-portfolio-data.mts 用真正的 JS parser 抽出，
   而且它自己的 --check 會確保跟 index.html 不會脫節。 */
const DATA = path.join(import.meta.dirname, '..', 'src', 'data', 'profile.json');
if (!fs.existsSync(DATA)) {
  bad(`找不到 ${DATA} —— 先跑 npm run data`);
  process.exit(1);
}
/* 新鮮度是前置條件，不是「順便」。
   沒有這道閘門時的實際行為：把 index.html 的 D.stats.merged 從 276 改成 999、
   <noscript> 保持 276、不重新產生 src/data —— 本檔會拿舊的 276 去比對 276，
   然後印「① noscript 與 D.stats 一致（276/79/8）… OK 全部通過」並回傳 0。
   index.html 自己前後矛盾，而唯一盯著這件事的工具通過了。
   本檔讀的是「抽取結果」而非 index.html，所以必須先證明兩者同步，
   ①②③④ 的結論才有意義。 */
if (FILE === DEFAULT_FILE) {
  const fresh = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, 'extract-portfolio-data.mts'), '--check'],
    { encoding: 'utf8' },
  );
  if (fresh.status !== 0) {
    bad('src/data 與 index.html 不同步 —— 本檔的計數來自抽取結果，先跑 npm run data');
    const detail = (fresh.stderr || fresh.stdout || '').trim();
    if (detail) console.log(detail.split('\n').map(l => '      ' + l).join('\n'));
    console.log('\nFAIL 1 項（前置條件未滿足，其餘檢查未執行）');
    process.exit(1);
  }
} else {
  /* 指定了別的檔案，抽取器的 --check 只認得 repo 內的 index.html，
     所以這裡無法證明新鮮度。說出來，不要假裝檢查過。
     不用 skip()：那個計數器屬於下面那 6 項檢查，前置條件混進去會讓
     結尾印出「跑了 5/6」——用錯的方式描述實際跑了什麼。 */
  console.log('  - 新鮮度前置條件：指定了非預設的 index.html，抽取結果無從比對');
}

const profile = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const { merged, projects, foundations, asOf } = profile.stats;
console.log(`src/data/profile.json: merged=${merged} projects=${projects} foundations=${foundations} asOf=${asOf}`);

/* ① noscript 的靜態句子必須與 D.stats 相符 */
const ns = s.match(/<p>(\d+) 個已合併的上游 pull request,橫跨 (\d+) 個專案與 (\d+) 個基金會。<\/p>/);
if (!ns) bad('① noscript 找不到那句計數（版型改了？）');
else {
  const t = [+ns[1], +ns[2], +ns[3]];
  (t[0] === merged && t[1] === projects && t[2] === foundations)
    ? ok(`① noscript 與 D.stats 一致（${t.join('/')}）`)
    : bad(`① noscript ${t.join('/')} != D.stats ${merged}/${projects}/${foundations}`);
}

/* ② 四個渲染點必須是「算出來的」，不可再出現寫死的舊數字 */
const hard = [...s.matchAll(/'(\d{2,4}) merged (?:upstream PRs|pull requests)/g)].map(m => m[1]);
hard.length === 0
  ? ok('② 四個渲染點都由 D.stats 計算，沒有寫死的計數字串')
  : bad(`② 仍有寫死的計數字串：${hard.join(', ')}（應改成讀 D.stats）`);

/* ③ contribTop 是 top 清單，逐列加總本來就 < merged；但任一列都不該超過總數，也不該重複。
      ⚠️ 先數出區塊裡「應該有幾列」，再比對 regex 實際解析到幾列 —— 只檢查解析結果會漏掉
      「格式變了、regex 靜默少抓幾列」這種情況（實測過：多加一欄就從 18 列變 16 列還說通過）。 */
/* 用陣列結尾 ]], 當錨，不要用 \n —— 這個 repo 是 CRLF，`],\n` 永遠不匹配、整個檢查會靜默失效。 */
const ctBlock = (s.match(/contribTop:\[([\s\S]*?\])\],/) || [])[1] || '';   /* 捕捉要含最後一列的收尾 ] */
const expectRows = (ctBlock.match(/\['/g) || []).length;
const top = [...ctBlock.matchAll(/\['([\w.\-\/]+)',(\d+)(?:,[01])?\]/g)].map(m => [m[1], +m[2]]);
if (!expectRows) bad('③ 找不到 contribTop 區塊');
else if (top.length !== expectRows) bad(`③ contribTop 區塊有 ${expectRows} 列，但只解析到 ${top.length} 列（格式變了、regex 失效）`);
else {
  const over = top.filter(t => t[1] > merged);
  const dup = top.map(t => t[0]).filter((r, i, a) => a.indexOf(r) !== i);
  if (over.length) bad(`③ contribTop 有列超過總數：${over.map(t => t.join('=')).join(', ')}`);
  if (dup.length) bad(`③ contribTop 有重複 repo：${[...new Set(dup)].join(', ')}`);
  if (!over.length && !dup.length) ok(`③ contribTop ${top.length}/${expectRows} 列全部解析成功且合理（加總 ${top.reduce((a, t) => a + t[1], 0)} < ${merged}）`);
}

/* ④ CNCF 的 merged 不可大於總 merged */
const cn = s.match(/cncf:\['CNCF',(\d+),(\d+)\]/);
if (!cn) bad('④ 找不到 D.cncf');
else (+cn[1] <= merged) ? ok(`④ CNCF ${cn[1]} merged / ${cn[2]} repos（<= 總數 ${merged}）`)
                        : bad(`④ CNCF ${cn[1]} > 總 merged ${merged}`);

/* ⑤ 與 NYCU CS 權威頁比對（權威頁不在時只提醒，不算失敗）。
      用一個 regex 字面量一次抓完所有 <dt>/<dd>，不拼字串——拼字串時跳脫層數很容易被
      heredoc/shell 吃掉一層，變成 \s 被當字面 s、regex 永遠不匹配卻無聲。 */
try {
  const a = fs.readFileSync(AUTH, 'utf8');
  const map = {};
  for (const m of a.matchAll(/<dt>([^<]+)<\/dt>\s*<dd>[\s\S]*?<strong>(\d+)<\/strong>/g)) map[m[1].trim()] = +m[2];
  const am = map['Merged'], ap = map['Upstreams'], af = map['Foundations'];
  console.log(`權威頁 os-metrics: merged=${am} projects=${ap} foundations=${af}`);
  if (am == null || ap == null || af == null) bad('⑤ 權威頁解析不出 os-metrics（版型改了？）');
  else (am === merged && ap === projects && af === foundations)
    ? ok('⑤ 與 NYCU CS 權威頁一致')
    : bad(`⑤ 與權威頁不一致：本站 ${merged}/${projects}/${foundations} vs 權威 ${am}/${ap}/${af}`);
} catch (e) {
  skip('⑤ 讀不到權威頁，略過（' + e.code + '）');
}

/* ⑥ contribTop 的 CNCF 旗標必須與權威頁 Ledger 的 CNCF section 一致。
      以前 -Foundation CNCF 靠寫死的關鍵字 regex 判斷，換 repo 就判錯（argo-workflows 與
      community-operators 被漏掉）。現在旗標在資料裡，這裡拿權威頁逐列核。 */
try {
  const lg = fs.readFileSync(path.join(path.dirname(AUTH), 'ledger', 'index.html'), 'utf8');
  const i = lg.indexOf('foundation-section foundation-cncf');
  const body = lg.slice(i, lg.indexOf('</section>', i));
  const cncf = new Set([...body.matchAll(/>([\w.\-]+\/[\w.\-]+)<\/a> <span class="repo-stat"/g)].map(m => m[1]));
  const rows = [...ctBlock.matchAll(/\['([\w.\-\/]+)',(\d+),([01])\]/g)].map(m => [m[1], +m[3]]);
  if (rows.length !== expectRows) bad(`⑥ CNCF 旗標只解析到 ${rows.length}/${expectRows} 列（有列缺旗標或格式不符）`);
  if (!rows.length) bad('⑥ contribTop 沒有 CNCF 旗標欄（第三欄）');
  else if (!cncf.size) skip('⑥ 權威 Ledger 解析不出 CNCF section，略過');
  else {
    const wrong = rows.filter(r => (cncf.has(r[0]) ? 1 : 0) !== r[1]);
    wrong.length
      ? bad(`⑥ CNCF 旗標與權威分桶不符：${wrong.map(r => r[0] + '(標' + r[1] + '，實際' + (cncf.has(r[0]) ? 1 : 0) + ')').join(', ')}`)
      : ok(`⑥ contribTop ${rows.length} 列的 CNCF 旗標全部與權威 Ledger 一致`);
  }
} catch (e) {
  skip('⑥ 讀不到權威 Ledger，略過（' + e.code + '）');
}

const ran = 6 - skipped;
console.log(`\n跑了 ${ran}/6 項檢查` + (skipped ? `，略過 ${skipped} 項（權威頁不在本機）` : ''));
console.log(fails === 0 ? 'OK 全部通過' : `FAIL ${fails} 項`);
process.exit(fails ? 1 : 0);
