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

   權威來源有兩個，而且它們回答的不是同一個問題 ——
   ------------------------------------------------------------------------
   ⑤⑥ 要跟 NYCU CS 的權威頁核對，而那頁的預設路徑是
   `C:/Users/thc1006/Desktop/MAY/personal-homepage/open-source/index.html`：一個
   本機 Windows 路徑。CI 上永遠不存在，所以 ⑤⑥ 永遠 skip —— 然後這支程式印
   「跑了 5/7 項檢查，略過 2 項」，緊接著印「OK 全部通過」並回傳 0。
   一個跳過檢查的 gate 說自己全部通過，就是這個 repo 每一支工具都在防的那個失敗。

   修法不是「skip 時改成失敗」（那會讓 CI 永遠紅），而是把權威資料變成**已提交的快照**：

     snapshots/authoritative-open-source.json   —— 權威頁的數字與 CNCF 分桶，committed

   於是 ⑤⑥ 在任何機器上都會**真的跑**，跑的是 repo 內的資料 vs repo 內的快照，
   完全 hermetic。快照本身會不會爛掉？在權威頁讀得到的機器上（維護者的機器、
   排程 observer），每次跑都會拿 live 權威頁重新核對快照 —— 那才是需要網路的那半，
   而它不在 PR 的必經 gate 上。

   用法：
     node tools/check-numbers.mts
     node tools/check-numbers.mts --require-authoritative
     node tools/check-numbers.mts --write-snapshot
     node tools/check-numbers.mts --page=<index.html> --authoritative=<open-source/index.html>
     node tools/check-numbers.mts --snapshot=<authoritative-open-source.json>

   --require-authoritative  沒有可用的權威快照就 FAIL（給 CI 用）。預設不加時，
                            快照不見只會降級成 skip，而 skip 永遠不會被說成「全部通過」。
   --write-snapshot         從 live 權威頁重新產生上面那個快照（需要讀得到權威頁）。

   --page 只影響 ①②（那兩項讀的是 HTML 文字本身）。指定它會關閉新鮮度閘門，
   因為抽取器只認得 repo 內的 index.html —— 關掉時會明講，而且結尾不會說「全部通過」。 */

import { readFileSync, writeFileSync, realpathSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..');
const DEFAULT_PAGE = join(REPO, 'index.html');
const DEFAULT_AUTH =
  process.env['AUTHORITATIVE_OPEN_SOURCE'] ??
  'C:/Users/thc1006/Desktop/MAY/personal-homepage/open-source/index.html';
const DEFAULT_SNAPSHOT = join(REPO, 'snapshots', 'authoritative-open-source.json');

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const BOOLEAN_FLAGS = new Set(['--require-authoritative', '--write-snapshot']);
const unknown = process.argv
  .slice(2)
  .filter((a) => !/^--(page|authoritative|snapshot)=/.test(a) && !BOOLEAN_FLAGS.has(a));
if (unknown.length > 0) {
  process.stderr.write(
    `\n  unknown option(s): ${unknown.join(', ')}\n` +
      `  known: --page=, --authoritative=, --snapshot=, ${[...BOOLEAN_FLAGS].join(', ')}\n\n`,
  );
  process.exit(2);
}

const PAGE = flag('page') ?? DEFAULT_PAGE;
/* --authoritative 是具名旗標，不是第二個位置參數。
   舊版把它放在 argv[3]，所以要跑跨 repo 的 ⑤⑥ 就必須先給 argv[2]，而 argv[2]
   會關掉新鮮度閘門 —— 想用文件寫的用法，就得先關掉最重要的那道檢查。 */
const AUTH = flag('authoritative') ?? DEFAULT_AUTH;
const SNAPSHOT = flag('snapshot') ?? DEFAULT_SNAPSHOT;
const REQUIRE_AUTHORITATIVE = process.argv.slice(2).includes('--require-authoritative');
const WRITE_SNAPSHOT = process.argv.slice(2).includes('--write-snapshot');

// ---------------------------------------------------------------------------
// 權威快照
// ---------------------------------------------------------------------------

interface AuthoritativeSnapshot {
  /** 這份快照是從哪個檔案抽出來的。人看的，不參與比對。 */
  capturedFrom: string;
  /** 抽出來的那天。人看的，不參與比對。 */
  capturedAt: string;
  metrics: { merged: number; projects: number; foundations: number };
  /** 權威 Ledger 的 CNCF section 列出的 repo，排序後存，才能逐字元 diff。 */
  cncfRepositories: string[];
}

/* 用一個 regex 字面量一次抓完所有 <dt>/<dd>，不拼字串——拼字串時跳脫層數很容易被
   heredoc/shell 吃掉一層，變成 \s 被當字面 s、regex 永遠不匹配卻無聲。 */
function parseMetrics(html: string): Partial<AuthoritativeSnapshot['metrics']> {
  const map = new Map<string, number>();
  for (const m of html.matchAll(/<dt>([^<]+)<\/dt>\s*<dd>[\s\S]*?<strong>(\d+)<\/strong>/g)) {
    map.set((m[1] ?? '').trim(), Number(m[2]));
  }
  const out: Partial<AuthoritativeSnapshot['metrics']> = {};
  const merged = map.get('Merged');
  const projects = map.get('Upstreams');
  const foundations = map.get('Foundations');
  if (merged !== undefined) out.merged = merged;
  if (projects !== undefined) out.projects = projects;
  if (foundations !== undefined) out.foundations = foundations;
  return out;
}

function parseCncf(ledgerHtml: string): string[] {
  const i = ledgerHtml.indexOf('foundation-section foundation-cncf');
  if (i < 0) return [];
  const body = ledgerHtml.slice(i, ledgerHtml.indexOf('</section>', i));
  return [
    ...new Set(
      [...body.matchAll(/>([\w.\-]+\/[\w.\-]+)<\/a> <span class="repo-stat"/g)].map(
        (m) => m[1] ?? '',
      ),
    ),
  ].sort();
}

/** live 權威頁 + 它旁邊的 Ledger。讀不到就回 null —— CI 上本來就讀不到，那不是錯。 */
function readLiveAuthoritative(): AuthoritativeSnapshot | null {
  let page: string;
  try {
    page = readFileSync(AUTH, 'utf8');
  } catch {
    return null;
  }
  const metrics = parseMetrics(page);
  if (metrics.merged === undefined || metrics.projects === undefined || metrics.foundations === undefined) {
    /* 讀得到但解析不出來 = 版型改了，那是真的要吵的事，不是「權威頁不在」。
       回 null 會把它偽裝成後者，所以這裡直接讓它變成一個失敗。 */
    process.stderr.write(`\n  ⑤ 權威頁 ${AUTH} 解析不出 os-metrics（版型改了？）\n\n`);
    process.exit(1);
  }
  let ledger = '';
  try {
    ledger = readFileSync(join(dirname(AUTH), 'ledger', 'index.html'), 'utf8');
  } catch {
    /* Ledger 讀不到時 cncfRepositories 會是空陣列，⑥ 會據此明說它無法核對。 */
  }
  return {
    capturedFrom: AUTH,
    capturedAt: new Date().toISOString().slice(0, 10),
    metrics: { merged: metrics.merged, projects: metrics.projects, foundations: metrics.foundations },
    cncfRepositories: parseCncf(ledger),
  };
}

const live = readLiveAuthoritative();

if (WRITE_SNAPSHOT) {
  if (live === null) {
    process.stderr.write(
      `\n  --write-snapshot 需要讀得到 live 權威頁，但 ${AUTH} 讀不到。\n` +
        '  這支旗標只在有權威頁的機器上有意義（維護者的機器、排程 observer）。\n\n',
    );
    process.exit(2);
  }
  if (live.cncfRepositories.length === 0) {
    process.stderr.write(
      `\n  --write-snapshot 從 ${join(dirname(AUTH), 'ledger', 'index.html')} 解析不出任何 CNCF repo。\n` +
        '  寫出一份空的 CNCF 清單會讓 ⑥ 從此對任何東西都「一致」，拒絕寫。\n\n',
    );
    process.exit(2);
  }
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(live, null, 2) + '\n', 'utf8');
  process.stdout.write(
    `  寫入 ${SNAPSHOT}\n` +
      `  metrics ${live.metrics.merged}/${live.metrics.projects}/${live.metrics.foundations}，` +
      `CNCF ${live.cncfRepositories.length} 個 repo\n`,
  );
  process.exit(0);
}

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

/* ⑤⑥ 的權威資料來源。優先序刻意是這樣：
     1. live 權威頁（讀得到才有）—— 它同時被用來核對快照，見 ⑧
     2. 已提交快照 snapshots/authoritative-open-source.json —— hermetic，CI 走這條
   兩個都沒有時 ⑤⑥ 才 skip，而 skip 之後結尾就不會說「全部通過」，
   `--require-authoritative` 更會直接失敗。 */
let snapshot: AuthoritativeSnapshot | null = null;
let snapshotError: string | null = null;
if (existsSync(SNAPSHOT)) {
  try {
    snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as AuthoritativeSnapshot;
    if (
      typeof snapshot.metrics?.merged !== 'number' ||
      typeof snapshot.metrics?.projects !== 'number' ||
      typeof snapshot.metrics?.foundations !== 'number' ||
      !Array.isArray(snapshot.cncfRepositories)
    ) {
      snapshotError = `${SNAPSHOT} 的欄位形狀不對（metrics.{merged,projects,foundations} 與 cncfRepositories）`;
      snapshot = null;
    }
  } catch (e) {
    snapshotError = `${SNAPSHOT} 不是合法 JSON：${(e as Error).message}`;
  }
} else {
  snapshotError = `找不到 ${SNAPSHOT}`;
}

const authority = live ?? snapshot;
const authoritySource = live !== null ? `live 權威頁 ${AUTH}` : `已提交快照 ${SNAPSHOT}`;

if (REQUIRE_AUTHORITATIVE && snapshot === null) {
  /* CI 的契約是「權威快照一定在，⑤⑥ 一定跑」。快照不見時降級成 skip 是本檔原本的
     bug；在 --require-authoritative 下它必須是失敗，而且要說出是哪個檔案不見。 */
  bad(`權威快照不可用：${snapshotError ?? 'unknown'}`);
  console.log('      --require-authoritative 下這是失敗，不是略過。');
  console.log('      重新產生：node tools/check-numbers.mts --write-snapshot（需要讀得到 live 權威頁）');
}

/* 快照的新鮮度閘門。只有讀得到 live 權威頁的機器才跑得動它 —— 但那正是唯一能
   讓快照過期的地方（權威頁動了、沒人重跑 --write-snapshot）。所以：
   讀得到 live 而快照不一致 = 失敗，不是提醒。
   這不編號，因為它跟檔案開頭那道 src/data 新鮮度閘門是同一類東西：
   它建立的是「⑤⑥ 拿來比的東西是不是最新的」這個前置條件，不是七項檢查之一。 */
let snapshotFreshness = '';
if (live !== null && snapshot !== null) {
  const same =
    JSON.stringify([live.metrics, live.cncfRepositories]) ===
    JSON.stringify([snapshot.metrics, snapshot.cncfRepositories]);
  if (same) {
    snapshotFreshness = `已提交快照與 live 權威頁一致（${SNAPSHOT}）`;
  } else {
    bad(
      `已提交快照與 live 權威頁不一致 —— 快照過期了。` +
        `\n      live     ${live.metrics.merged}/${live.metrics.projects}/${live.metrics.foundations}，CNCF ${live.cncfRepositories.length} repos` +
        `\n      snapshot ${snapshot.metrics.merged}/${snapshot.metrics.projects}/${snapshot.metrics.foundations}，CNCF ${snapshot.cncfRepositories.length} repos` +
        `\n      重新產生：node tools/check-numbers.mts --write-snapshot`,
    );
    snapshotFreshness = '已提交快照與 live 權威頁不一致';
  }
} else if (live !== null) {
  snapshotFreshness = `讀得到 live 權威頁，但沒有可比對的已提交快照（${snapshotError ?? 'unknown'}）`;
} else if (snapshot !== null) {
  snapshotFreshness = 'live 權威頁不在本機，⑤⑥ 比的是已提交快照；快照本身這一輪未與 live 核對';
} else {
  snapshotFreshness = `兩個來源都沒有 —— live 權威頁不在本機，${snapshotError ?? 'unknown'}`;
}

if (authority === null) {
  skip(`⑤ 沒有可用的權威來源（${snapshotError ?? 'unknown'}），略過`);
  skip('⑥ 沒有可用的權威來源，略過');
} else {
  console.log(
    `權威 os-metrics（來源：${authoritySource}）: ` +
      `merged=${authority.metrics.merged} projects=${authority.metrics.projects} foundations=${authority.metrics.foundations}`,
  );

  /* ⑤ 與 NYCU CS 權威數字比對 */
  const { merged: am, projects: ap, foundations: af } = authority.metrics;
  am === merged && ap === projects && af === foundations
    ? ok('⑤ 與 NYCU CS 權威來源一致')
    : bad(`⑤ 與權威來源不一致：本站 ${merged}/${projects}/${foundations} vs 權威 ${am}/${ap}/${af}`);

  /* ⑥ contribTop 的 CNCF 旗標必須與權威 Ledger 的 CNCF section 一致。
        以前 -Foundation CNCF 靠寫死的關鍵字 regex 判斷，換 repo 就判錯（argo-workflows 與
        community-operators 被漏掉）。現在旗標在資料裡，這裡拿權威分桶逐列核。 */
  const cncf = new Set(authority.cncfRepositories);
  if (cncf.size === 0) {
    skip('⑥ 權威來源沒有 CNCF 分桶（Ledger 解析不出或快照是空的），略過');
  } else {
    const wrong = top.filter((t) => cncf.has(t.repository) !== t.cncf);
    wrong.length > 0
      ? bad(
          `⑥ CNCF 旗標與權威分桶不符：${wrong
            .map((t) => `${t.repository}(標${t.cncf ? 1 : 0}，實際${cncf.has(t.repository) ? 1 : 0})`)
            .join(', ')}`,
        )
      : ok(`⑥ contribTop ${top.length} 列的 CNCF 旗標全部與權威分桶一致`);
  }
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
console.log(`\n跑了 ${ran}/${TOTAL} 項檢查` + (skipped > 0 ? `，略過 ${skipped} 項` : ''));
console.log(`權威來源：${snapshotFreshness}`);
if (fails > 0) {
  console.log(`FAIL ${fails} 項`);
  process.exit(1);
}

/* 「全部通過」是一句很強的話，只有在下面三件事都成立時才可以說：
     - 沒有失敗
     - 沒有略過。一個 skip 掉的檢查說自己通過，就是這支程式的原始 bug：
       權威頁的預設路徑是本機 Windows 路徑，CI 上永遠不存在，於是 ⑤⑥ 永遠略過，
       而結尾照樣印「OK 全部通過」並回傳 0。
     - 前置條件建立了。①② 讀的是 --page 指的檔案，③④⑥⑦ 讀的是 src/data，
       沒有閘門就沒人證明那兩者是同一份資料。
   注意這裡刻意不 exit 1：略過不是失敗，只是「不知道」。想把「不知道」變成失敗的，
   用 --require-authoritative —— 那正是 CI 的用法。 */
const caveats: string[] = [];
if (skipped > 0) caveats.push(`略過了 ${skipped} 項，沒有人檢查過它們`);
if (!preconditionEstablished) {
  caveats.push('前置條件未建立：--page 與 src/data 未經證明同步，①② 與 ③④⑥⑦ 可能在談不同的資料');
}
console.log(
  caveats.length === 0 ? 'OK 全部通過' : `OK 但不是全部通過 —— ${caveats.join('；')}`,
);
