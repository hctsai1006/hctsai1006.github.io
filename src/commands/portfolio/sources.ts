/**
 * sources.ts — the authoritative-source table `Get-Source` prints.
 *
 * THE ONE PORTFOLIO TABLE THAT IS NOT EXTRACTED, AND WHY THAT IS SAID OUT LOUD.
 *
 * Everything else these commands read comes from `src/data/*.json`, which
 * tools/extract-portfolio-data.mts lifts out of index.html and `npm run data --
 * --check` keeps honest. This table does not: in index.html it is a `const SRC`
 * object next to a `SITE` constant rather than a member of the `D` literal the
 * extractor evaluates, so there is nothing there for the extractor to pick up.
 *
 * Retyping it here is therefore a real duplication, and the mitigation is the
 * one v1 used: every URL is built from ONE `SITE` constant, so the only thing
 * that can drift is the site root, and it can only drift in one place. If a
 * future change teaches the extractor about `SRC`, this file should become a
 * read of `src/data/sources.json` and nothing else about `Get-Source` needs to
 * move.
 *
 * The banner is v1's, verbatim, because it is the point of the command: this
 * terminal is a secondary surface, and where the two disagree the website wins.
 */

export const SITE = 'https://people.cs.nycu.edu.tw/~hctsai1006';

export interface SourceRow {
  readonly label: string;
  readonly reference: string;
  readonly url: string;
}

export const SOURCES: readonly SourceRow[] = [
  { label: '個人網站', reference: 'people.cs.nycu.edu.tw/~hctsai1006', url: `${SITE}/` },
  { label: '著作', reference: '/publications/', url: `${SITE}/publications/` },
  { label: '開源', reference: '/open-source/', url: `${SITE}/open-source/` },
  { label: '榮譽', reference: '/honors/', url: `${SITE}/honors/` },
  { label: '經歷', reference: '/experience/', url: `${SITE}/experience/` },
  { label: '醫學', reference: '/medical/', url: `${SITE}/medical/` },
  { label: '教學', reference: '/teaching/', url: `${SITE}/teaching/` },
  { label: '部落格', reference: '/blog/', url: `${SITE}/blog/` },
  { label: '聯絡', reference: '/contact/', url: `${SITE}/contact/` },
  { label: 'CV', reference: 'cv.pdf', url: `${SITE}/cv.pdf` },
  { label: 'ORCID', reference: '0000-0001-7421-8027', url: 'https://orcid.org/0000-0001-7421-8027' },
  { label: 'GitHub', reference: '@thc1006', url: 'https://github.com/thc1006' },
  { label: '舊版終端機', reference: 'classic.html', url: 'classic.html' },
];

/** v1's banner, kept word for word: it is the command's actual message. */
export const SOURCE_BANNER: readonly string[] = [
  '這個終端機是次要展示面。所有內容以個人網站為準,',
  '若兩邊有出入,請以下列來源為準:',
];

/** Where each portfolio command points for its own numbers. */
export const SOURCE_URLS = {
  home: `${SITE}/`,
  publications: `${SITE}/publications/`,
  openSource: `${SITE}/open-source/`,
  advisories: `${SITE}/open-source/#advisories`,
  honors: `${SITE}/honors/`,
  experience: `${SITE}/experience/`,
  orcid: 'https://orcid.org/0000-0001-7421-8027',
  github: 'https://github.com/thc1006',
} as const;
