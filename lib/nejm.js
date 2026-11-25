// NEJM knowledge: journals, DOI article-type codes, RSS, PubMed, Europe PMC.

import { get, eutils, pubmedSearch } from "./http.js";

export const JOURNALS = {
  nejm: {
    name: "New England Journal of Medicine",
    base: "https://www.nejm.org",
    ta: '"N Engl J Med"[ta]',
    rss: "https://www.nejm.org/action/showFeed?jc=nejm&type=etoc&feed=rss",
  },
  evidence: {
    name: "NEJM Evidence",
    base: "https://evidence.nejm.org",
    ta: '"NEJM Evid"[ta]',
    rss: "https://evidence.nejm.org/action/showFeed?type=etoc&feed=rss&jc=evid",
  },
};

// DOI infix → article type. Only codes whose meaning was checked against article
// titles in the 2026-09-25 RSS feeds or are long-standing NEJM conventions.
// Unknown codes are shown raw rather than guessed.
const KINDS = {
  oa: "Original Article",
  ra: "Review Article",
  cp: "Clinical Practice",
  cps: "Clinical Problem-Solving",
  cpc: "Case Records of the MGH",
  e: "Editorial",
  p: "Perspective",
  c: "Correspondence",
  icm: "Images in Clinical Medicine",
  vcm: "Videos in Clinical Medicine",
  cibr: "Clinical Implications of Basic Research",
  sr: "Special Report",
  sa: "Special Article",
  ms: "Medicine and Society",
  clde: "Clinical Decisions",
  hpr: "Health Policy Report",
  x: "Correction",
  ctw: "Tomorrow's Trial",
  mr: "Morning Report",
};

export function parseDoi(input) {
  if (!input) return null;
  const m = String(input).match(/10\.1056\/[A-Za-z]+[0-9.x-]+[0-9a-z]*/i);
  return m ? m[0].replace(/[?#].*$/, "") : null;
}

export function journalOf(doi) {
  return /^10\.1056\/evid/i.test(doi) ? "evidence" : "nejm";
}

export function kindOf(doi) {
  const m = doi && doi.match(/^10\.1056\/(?:NEJM|EVID)([a-z]+)\d/i);
  if (!m) return null;
  const code = m[1].toLowerCase();
  return { code, label: KINDS[code] || `(kod: ${code})` };
}

export function fullTextUrl(doi) {
  return `${JOURNALS[journalOf(doi)].base}/doi/full/${doi}`;
}
export function pdfUrl(doi) {
  return `${JOURNALS[journalOf(doi)].base}/doi/pdf/${doi}`;
}

// ---------- tiny XML helpers (no dependency; inputs are well-formed feeds/efetch) ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
export function strip(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : "";
}
function tags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
}

// ---------- RSS (current issue table of contents) ----------
export async function latest(journal) {
  const xml = await get(JOURNALS[journal].rss);
  return [...xml.matchAll(/<item\s[^>]*>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const doi = strip(tag(it, "prism:doi")) || parseDoi(strip(tag(it, "link")));
    return {
      journal,
      doi,
      kind: kindOf(doi),
      title: strip(tag(it, "dc:title") || tag(it, "title")),
      // One dc:creator holding all names separated only by spaces: not safely splittable.
      authorsText: tags(it, "dc:creator").map(strip).join("; "),
      date: strip(tag(it, "dc:date")),
      volume: strip(tag(it, "prism:volume")),
      issue: strip(tag(it, "prism:number")),
      pages: [strip(tag(it, "prism:startingPage")), strip(tag(it, "prism:endingPage"))].filter(Boolean).join("-"),
      // content:encoded is only the citation line ("Volume 395, Issue 12, Page …"), not an abstract.
      citation: strip(tag(it, "content:encoded")),
    };
  });
}

// ---------- PubMed ----------
export const PUBTYPES = {
  any: "",
  rct: "randomized controlled trial[pt]",
  trial: "clinical trial[pt]",
  review: "review[pt]",
  "meta-analysis": "(meta-analysis[pt] OR systematic review[pt])",
  guideline: "(guideline[pt] OR practice guideline[pt])",
  case: "case reports[pt]",
};

export function buildQuery({ query, journal = "both", pubType = "any", from, until }) {
  const js = journal === "both" ? ["nejm", "evidence"] : [journal];
  const parts = [`(${js.map((j) => JOURNALS[j].ta).join(" OR ")})`];
  if (query) parts.push(`(${query})`);
  if (PUBTYPES[pubType]) parts.push(PUBTYPES[pubType]);
  if (from || until) parts.push(`("${from || "1812"}"[dp] : "${until || "3000"}"[dp])`);
  return parts.join(" AND ");
}

export async function search({ limit = 10, page = 1, sort = "relevance", ...q }) {
  const term = buildQuery(q);
  const { count, ids, fallback } = await pubmedSearch(term, { limit, page, sort });
  if (!ids.length) return { term, count, fallback, items: [] };
  const sum = JSON.parse(await eutils("esummary", { db: "pubmed", retmode: "json", id: ids.join(",") })).result;
  const items = ids.map((id) => {
    const r = sum[id] || {};
    const aid = Object.fromEntries((r.articleids || []).map((a) => [a.idtype, a.value]));
    const doi = aid.doi || parseDoi(r.elocationid);
    return {
      pmid: id,
      doi,
      pmcid: aid.pmc || null,
      kind: doi ? kindOf(doi) : null,
      title: strip(r.title),
      journal: r.source,
      date: r.pubdate,
      pubtypes: r.pubtype || [],
      firstAuthor: r.authors?.[0]?.name || "",
    };
  });
  return { term, count, fallback, items };
}

export async function pmidForDoi(doi) {
  return (await pubmedSearch(`${doi}[doi]`, { limit: 1 })).ids[0] || null;
}

export async function article(pmid) {
  const xml = await eutils("efetch", { db: "pubmed", id: pmid, retmode: "xml" });
  const art = tag(xml, "PubmedArticle");
  if (!art) return null;
  // Only the FIRST <ArticleIdList> is the article's own: <ReferenceList> entries carry
  // ArticleIds too, and fromEntries keeps the last one seen — that returned a cited
  // paper's DOI/PMCID (found 2026-09-25: PMID 41442501 → sciimmunol DOI of a reference).
  const ids = Object.fromEntries(
    [...tag(art, "ArticleIdList").matchAll(/<ArticleId IdType="([^"]+)">([^<]+)<\/ArticleId>/g)].map((m) => [m[1], m[2]])
  );
  const abstract = [...tag(art, "Abstract").matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(
    ([, attrs, body]) => ({ label: (attrs.match(/Label="([^"]+)"/) || [])[1] || "", text: strip(body) })
  );
  const authors = tags(art, "Author").map((a) => {
    const coll = strip(tag(a, "CollectiveName"));
    return coll || `${strip(tag(a, "LastName"))} ${strip(tag(a, "Initials"))}`.trim();
  });
  const d = tag(art, "PubDate");
  const trials = [...art.matchAll(/<AccessionNumber>([^<]+)<\/AccessionNumber>/g)].map((m) => m[1]);
  return {
    pmid,
    doi: ids.doi || null,
    pmcid: ids.pmc || null,
    title: strip(tag(art, "ArticleTitle")),
    journal: strip(tag(art, "Title")),
    citation: `${strip(tag(art, "ISOAbbreviation"))} ${strip(tag(d, "Year"))};${strip(tag(art, "Volume"))}(${strip(tag(art, "Issue"))}):${strip(tag(art, "MedlinePgn"))}`,
    date: [strip(tag(d, "Year")), strip(tag(d, "Month")), strip(tag(d, "Day"))].filter(Boolean).join(" "),
    authors,
    pubtypes: tags(art, "PublicationType").map(strip),
    mesh: tags(art, "DescriptorName").map(strip),
    trials,
    abstract,
    commentsOn: [...art.matchAll(/<CommentsCorrections RefType="(\w+)"[^>]*>[\s\S]*?<RefSource>([^<]+)<\/RefSource>/g)]
      .filter((m) => /CommentIn|ErratumIn|RetractionIn|UpdateIn/.test(m[1]))
      .map((m) => `${m[1]}: ${strip(m[2])}`),
  };
}

// ---------- PMC full text ----------
// NCBI efetch db=pmc, not Europe PMC: most NEJM PMC copies are NIH author manuscripts
// outside the OA subset; Europe PMC fullTextXML answers those with HTTP 500, while
// efetch returned the full body (measured 2026-09-25, PMC10351614: 17 sec, 3 tables).
export async function pmcFullText(pmcid) {
  const id = pmcid.toUpperCase().startsWith("PMC") ? pmcid.toUpperCase() : `PMC${pmcid}`;
  const xml = await eutils("efetch", { db: "pmc", id: id.slice(3), retmode: "xml" });
  if (!/<body[\s>]/.test(xml)) {
    const notice = strip((xml.match(/<!--[^>]*does not allow[\s\S]*?-->/) || [""])[0]);
    return { pmcid: id, available: false, notice };
  }
  // Linear walk instead of matching <sec>…</sec>: secs nest, and a lazy regex would stop
  // at the first inner </sec>. Every <title> opens a section; <p>s attach to the latest.
  // Figures/tables are removed first so their caption <title>s don't become sections.
  const body = tag(xml, "body").replace(/<(table-wrap|fig)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, "");
  const sections = [];
  let depth = 0;
  for (const m of body.matchAll(/<(\/?)sec(?:\s[^>]*)?>|<title>([\s\S]*?)<\/title>|<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
    if (m[0].startsWith("<sec")) depth++;
    else if (m[1] === "/") depth--;
    else if (m[2] !== undefined) sections.push({ title: strip(m[2]), depth, text: "" });
    else {
      if (!sections.length) sections.push({ title: "(giriş)", depth: 1, text: "" });
      const s = sections[sections.length - 1];
      s.text += (s.text ? "\n\n" : "") + strip(m[3]);
    }
  }
  const tables = tags(xml, "table-wrap").map((t) => ({
    label: strip(tag(t, "label")),
    caption: strip(tag(t, "caption")),
    rows: tags(t, "tr").map((tr) => [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => strip(c[1]))),
  }));
  const figures = tags(xml, "fig").map((f) => ({ label: strip(tag(f, "label")), caption: strip(tag(f, "caption")) }));
  return { pmcid: id, available: true, title: strip(tag(xml, "article-title")), sections, tables, figures };
}

export async function epmcStatus(doi) {
  const j = JSON.parse(
    await get(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&query=${encodeURIComponent(`DOI:"${doi}"`)}`
    )
  );
  const r = j.resultList?.result?.[0];
  return r ? { pmcid: r.pmcid || null, openAccess: r.isOpenAccess === "Y", inPMC: r.inPMC === "Y", license: r.license || null } : null;
}
