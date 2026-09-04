/* check-numbers.mts — 這個終端機的計數一致性檢查。
   設計前提：計數的唯一來源是 index.html 裡的 `D.stats`。四個渲染點（profile accent、
   README.md 種子、timeline、Get-Contribution 標題）都從它算，所以不會漂。
   但 <noscript> 那段是給 SEO 與無 JS 讀者的靜態文字、不能由 JS 產生 ——
   它是唯一還要手動同步的地方，本檔就是為了盯它。

   計數與 contribTop 都是從 src/data/*.json 讀的，不是掃 index.html。訊息裡仍寫
   「D.stats」，而那是準確的 —— 但只在下面那道新鮮度閘門通過之後才準確：閘門先證明
   src/data 就是 index.html 當前的抽取結果，兩者才是同一個數字。

   為什麼不再用 regex 掃 index.html 取 contribTop / cncf：
   一次敵意審查示範過，把一段舊的 <script> 註解掉塞進 index.html，舊版的
   `contribTop:\[...\]` 會先命中被註解掉的那一段，然後回報「1/1 列全部解析成功且合理」——
   真正的 18 列從頭到尾沒被檢查，而且什麼都沒說。資料已經被真正的 parser 抽出來、
   而且新鮮度閘門保證它是最新的，再用 regex 掃一次結構只是把同一個坑重新挖開。

   用法：
     node tools/check-numbers.mts
     node tools/check-numbers.mts --page=<index.html> --authoritative=<open-source/index.html>

   --page 只影響 ①②（那兩項讀的是 HTML 文字本身）。指定它會關閉新鮮度閘門，
   因為抽取器只認得 repo 內的 index.html —— 關掉時會明講，而且結尾不會說「全部通過」。 */

import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..');
const DEFAULT_PAGE = join(REPO, 'index.html');
const DEFAULT_AUTH =
  process.env['AUTHORITATIVE_OPEN_SOURCE'] ??
  'C:/Users/thc1006/Desktop/MAY/personal-homepage/open-source/index.html';

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const unknown = process.argv.slice(2).filter((a) => !/^--(page|authoritative)=/.test(a));
if (unknown.length > 0) {
  process.stderr.write(`\n  unknown option(s): ${unknown.join(', ')}\n  known: --page=, --authoritative=\n\n`);
  process.exit(2);
}

const PAGE = flag('page') ?? DEFAULT_PAGE;
/* --authoritative 是具名旗標，不是第二個位置參數。
   舊版把它放在 argv[3]，所以要跑跨 repo 的 ⑤⑥ 就必須先給 argv[2]，而 argv[2]
   會關掉新鮮度閘門 —— 想用文件寫的用法，就得先關掉最重要的那道檢查。 */
const AUTH = flag('authoritative') ?? DEFAULT_AUTH;

/* 同一個檔案可以有很多種寫法（index.html、./index.html、絕對路徑、大小寫不同的磁碟機代號）。
   字串比對會把它們全都當成「別的檔案」而放行，於是
   `node tools/check-numbers.mts --page=index.html` 就繞過了閘門。 */
const samePath = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

let skipped = 0;
let fails = 0;
let preconditionEstablished = true;
const skip = (m: string): void => {
  console.log('  - ' + m);
  skipped++;
};
const bad = (m: string): void => {
  console.log('  x ' + m);
  fails++;
};
const ok = (m: string): void => console.log('  v ' + m);

if (!existsSync(PAGE)) {
  /* --page 現在收使用者給的路徑，而一個 ENOENT stack trace 不是錯誤訊息。 */
  process.stderr.write(`\n  找不到 --page 指定的檔案：${PAGE}\n\n`);
  process.exit(2);
}
const s = readFileSync(PAGE, 'utf8');

// ---------------------------------------------------------------------------
// 前置條件：src/data 必須是 index.html 當前的抽取結果
// ---------------------------------------------------------------------------

/* 沒有這道閘門時的實際行為：把 D.stats.merged 從 276 改成 999、<noscript> 保持 276、
   不重新產生 src/data —— 本檔會拿舊的 276 去比對 276，然後印
   「① noscript 與 D.stats 一致（276/79/8）… OK 全部通過」並回傳 0。 */
if (samePath(PAGE, DEFAULT_PAGE)) {
  const fresh = spawnSync(
    process.execPath,
    [join(import.meta.dirname, 'extract-portfolio-data.mts'), '--check'],
    { encoding: 'utf8' },
  );
  const detail = `${fresh.stderr ?? ''}${fresh.stdout ?? ''}`.trim();
  if (fresh.status === null) {
    /* 跑不起來跟資料過期是兩回事，而「先跑 npm run data」對前者是無效建議。
       repo 裡的 verify-release-truth.mts 也是這樣分的：1 是漂移，2 是無法檢查。 */
    process.stdout.write('  x 抽取器無法執行 —— 無法判斷 src/data 是否為最新\n');
    if (detail) console.log(detail.split('\n').map((l) => '      ' + l).join('\n'));
    console.log(`\n無法完成檢查（前置條件跑不起來，需要 Node >= 24 才有 .mts type-stripping；本機是 ${process.version}）`);
    process.exit(2);
  }
  if (fresh.status !== 0) {
    bad('src/data 與 index.html 不同步 —— 本檔的計數來自抽取結果，先跑 npm run data');
    if (detail) console.log(detail.split('\n').map((l) => '      ' + l).join('\n'));
    console.log('\nFAIL 1 項（前置條件未滿足，其餘檢查未執行）');
    process.exit(1);
  }
} else {
  preconditionEstablished = false;
  console.log(`  - 新鮮度前置條件：--page 指向 ${PAGE}，抽取器只認得 repo 內的 index.html`);
}

// ---------------------------------------------------------------------------
// 抽取結果
// ---------------------------------------------------------------------------

interface Profile {
  stats: { merged: number; projects: number; foundations: number; asOf: string };
}
interface Contributions {
  foundations: { cncf: { label: string; merged: number; repositories: number } };
  top: Array<{ repository: string; merged: number; cncf: boolean }>;
}

const readJson = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

const DATA = join(REPO, 'src', 'data');
for (const f of ['profile.json', 'contributions.json']) {
  if (!existsSync(join(DATA, f))) {
    console.log(`  x 找不到 src/data/${f} —— 先跑 npm run data`);
    process.exit(1);
  }
}

const profile = readJson<Profile>(join(DATA, 'profile.json'));
const contributions = readJson<Contributions>(join(DATA, 'contributions.json'));
const { merged, projects, foundations, asOf } = profile.stats;
console.log(`src/data/profile.json: merged=${merged} projects=${projects} foundations=${foundations} asOf=${asOf}`);

// ---------------------------------------------------------------------------

/* ① noscript 的靜態句子必須與 D.stats 相符 */
const ns = s.match(/<p>(\d+) 個已合併的上游 pull request,橫跨 (\d+) 個專案與 (\d+) 個基金會。<\/p>/);
if (ns === null) bad('① noscript 找不到那句計數（版型改了？）');
else {
  const t = [Number(ns[1]), Number(ns[2]), Number(ns[3])] as const;
  t[0] === merged && t[1] === projects && t[2] === foundations
    ? ok(`① noscript 與 D.stats 一致（${t.join('/')}）`)
    : bad(`① noscript ${t.join('/')} != D.stats ${merged}/${projects}/${foundations}`);
}

/* ② 四個渲染點必須是「算出來的」，不可再出現寫死的舊數字 */
const hard = [...s.matchAll(/'(\d{2,4}) merged (?:upstream PRs|pull requests)/g)].map((m) => m[1]);
hard.length === 0
  ? ok('② 四個渲染點都由 D.stats 計算，沒有寫死的計數字串')
  : bad(`② 仍有寫死的計數字串：${hard.join(', ')}（應改成讀 D.stats）`);

/* ③ contribTop 是 top 清單，逐列加總本來就 < merged；但任一列都不該超過總數，也不該重複。 */
const top = contributions.top;
if (top.length === 0) bad('③ contributions.json 的 top 是空的');
else {
  const over = top.filter((t) => t.merged > merged);
  const seen = new Set<string>();
  const dup = top.map((t) => t.repository).filter((r) => (seen.has(r) ? true : (seen.add(r), false)));
  if (over.length > 0) bad(`③ contribTop 有列超過總數：${over.map((t) => `${t.repository}=${t.merged}`).join(', ')}`);
  if (dup.length > 0) bad(`③ contribTop 有重複 repo：${[...new Set(dup)].join(', ')}`);
  if (over.length === 0 && dup.length === 0) {
    const sum = top.reduce((a, t) => a + t.merged, 0);
    ok(`③ contribTop ${top.length} 列全部合理（加總 ${sum} < ${merged}）`);
  }
}

/* ④ CNCF 的 merged 不可大於總 merged */
const cncfBucket = contributions.foundations.cncf;
cncfBucket.merged <= merged
  ? ok(`④ CNCF ${cncfBucket.merged} merged / ${cncfBucket.repositories} repos（<= 總數 ${merged}）`)
  : bad(`④ CNCF ${cncfBucket.merged} > 總 merged ${merged}`);

/* ⑤ 與 NYCU CS 權威頁比對（權威頁不在時只提醒，不算失敗）。
      用一個 regex 字面量一次抓完所有 <dt>/<dd>，不拼字串——拼字串時跳脫層數很容易被
      heredoc/shell 吃掉一層，變成 \s 被當字面 s、regex 永遠不匹配卻無聲。 */
try {
  const a = readFileSync(AUTH, 'utf8');
  const map = new Map<string, number>();
  for (const m of a.matchAll(/<dt>([^<]+)<\/dt>\s*<dd>[\s\S]*?<strong>(\d+)<\/strong>/g)) {
    map.set((m[1] ?? '').trim(), Number(m[2]));
  }
  const am = map.get('Merged');
  const ap = map.get('Upstreams');
  const af = map.get('Foundations');
  console.log(`權威頁 os-metrics: merged=${am} projects=${ap} foundations=${af}`);
  if (am === undefined || ap === undefined || af === undefined) bad('⑤ 權威頁解析不出 os-metrics（版型改了？）');
  else if (am === merged && ap === projects && af === foundations) ok('⑤ 與 NYCU CS 權威頁一致');
  else bad(`⑤ 與權威頁不一致：本站 ${merged}/${projects}/${foundations} vs 權威 ${am}/${ap}/${af}`);
} catch (e) {
  skip(`⑤ 讀不到權威頁，略過（${(e as NodeJS.ErrnoException).code ?? 'unknown'}）`);
}

/* ⑥ contribTop 的 CNCF 旗標必須與權威頁 Ledger 的 CNCF section 一致。
      以前 -Foundation CNCF 靠寫死的關鍵字 regex 判斷，換 repo 就判錯（argo-workflows 與
      community-operators 被漏掉）。現在旗標在資料裡，這裡拿權威頁逐列核。 */
try {
  const lg = readFileSync(join(dirname(AUTH), 'ledger', 'index.html'), 'utf8');
  const i = lg.indexOf('foundation-section foundation-cncf');
  const body = lg.slice(i, lg.indexOf('</section>', i));
  const cncf = new Set(
    [...body.matchAll(/>([\w.\-]+\/[\w.\-]+)<\/a> <span class="repo-stat"/g)].map((m) => m[1] ?? ''),
  );
  if (cncf.size === 0) skip('⑥ 權威 Ledger 解析不出 CNCF section，略過');
  else {
    const wrong = top.filter((t) => cncf.has(t.repository) !== t.cncf);
    wrong.length > 0
      ? bad(
          `⑥ CNCF 旗標與權威分桶不符：${wrong
            .map((t) => `${t.repository}(標${t.cncf ? 1 : 0}，實際${cncf.has(t.repository) ? 1 : 0})`)
            .join(', ')}`,
        )
      : ok(`⑥ contribTop ${top.length} 列的 CNCF 旗標全部與權威 Ledger 一致`);
  }
} catch (e) {
  skip(`⑥ 讀不到權威 Ledger，略過（${(e as NodeJS.ErrnoException).code ?? 'unknown'}）`);
}

/* ⑦ asOf 必須是合法日期且不在未來。
      以前它被解構出來、印出來，然後就沒有下文了 —— 一個被讀進來卻不檢查的欄位，
      看起來像有人檢查過。 */
const asOfDate = new Date(asOf);
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(asOfDate.getTime())) {
  bad(`⑦ asOf "${asOf}" 不是合法的 YYYY-MM-DD 日期`);
} else if (asOfDate.getTime() > Date.now() + 86_400_000) {
  bad(`⑦ asOf ${asOf} 在未來`);
} else {
  ok(`⑦ asOf ${asOf} 是合法日期且不在未來`);
}

// ---------------------------------------------------------------------------

const TOTAL = 7;
const ran = TOTAL - skipped;
console.log(`\n跑了 ${ran}/${TOTAL} 項檢查` + (skipped > 0 ? `，略過 ${skipped} 項（權威頁不在本機）` : ''));
if (fails > 0) {
  console.log(`FAIL ${fails} 項`);
  process.exit(1);
}
/* 前置條件沒建立時不能說「全部通過」——①② 讀的是 --page 指的檔案，
   ③④⑥⑦ 讀的是 src/data，而沒有閘門就沒人證明那兩者是同一份資料。 */
console.log(
  preconditionEstablished
    ? 'OK 全部通過'
    : 'OK 但前置條件未建立：--page 與 src/data 未經證明同步，①② 與 ③④⑥⑦ 可能在談不同的資料',
);
