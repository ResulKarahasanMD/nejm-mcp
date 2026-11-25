#!/usr/bin/env node
// nejm-mcp — discovery + open full text for NEJM and NEJM Evidence.
//
// Subscriber full text is NOT fetched here: nejm.org sits behind a Cloudflare managed
// challenge that also rejects automation-launched browsers (measured 2026-09-25). The
// companion skill reads it through the user's own Chrome (Claude in Chrome), where the
// user passes the challenge. This server only uses open channels: RSS, PubMed, PMC.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as N from "./lib/nejm.js";
import { get, NCBI_KEY } from "./lib/http.js";

const server = new McpServer({ name: "nejm", version: "0.1.0" });
const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `HATA: ${e.message || e}` }] });
const fallbackNote = (r) =>
  r.fallback
    ? `\n⚠ PubMed esearch arızalı → PMID listesi Europe PMC yedeğinden (aynı MEDLINE kayıtları, SRC:MED; toplam ve sıralama PubMed'den biraz farklı olabilir; künyeler yine NCBI esummary'den).` +
      `\n  Europe PMC sorgusu: ${r.fallback.query}\n  Sebep: ${r.fallback.reason.slice(0, 200)}`
    : "";
const tool = (name, desc, shape, fn) =>
  server.tool(name, desc, shape, async (args) => {
    try { return text(await fn(args)); } catch (e) { return fail(e); }
  });

const chromeHint = (doi) =>
  `Abonelik tam metni: ${N.fullTextUrl(doi)}\n` +
  `→ Claude in Chrome ile aç + get_page_text. Cloudflare doğrulaması çıkarsa kullanıcı geçer (Claude tıklamaz).`;

// id: DOI | DOI/NEJM URL | PMID | PMCID  →  { doi, pmid, pmcid }
async function resolve(id) {
  const s = String(id).trim();
  if (/^PMC\d+$/i.test(s)) return { pmcid: s.toUpperCase() };
  if (/^\d{5,9}$/.test(s)) return { pmid: s };
  const doi = N.parseDoi(s);
  if (!doi) throw new Error(`Tanınmayan kimlik: "${s}". DOI (10.1056/…), NEJM URL'i, PMID ya da PMCID ver.`);
  return { doi, pmid: await N.pmidForDoi(doi) };
}

function mdTable(t) {
  const w = Math.max(...t.rows.map((r) => r.length), 1);
  const rows = t.rows.map((r) => [...r, ...Array(w - r.length).fill("")].map((c) => c.replace(/\|/g, "\\|")));
  if (!rows.length) return "";
  return [`| ${rows[0].join(" | ")} |`, `|${" --- |".repeat(w)}`, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

// ---------------------------------------------------------------- tools

tool(
  "nejm_search",
  "NEJM ve/veya NEJM Evidence makalelerini PubMed üzerinden ara (Cloudflare'siz). PMID, DOI, makale türü (DOI kodundan: Original Article, Review, Clinical Practice…), PMCID döner. Sorgu PubMed sözdizimini kabul eder (MeSH, [tiab], AND/OR).",
  {
    query: z.string().optional().describe("Konu; İngilizce. Boşsa yalnız filtrelerle listeler"),
    journal: z.enum(["nejm", "evidence", "both"]).default("both"),
    pubType: z.enum(Object.keys(N.PUBTYPES)).default("any").describe("PubMed yayın türü filtresi"),
    kind: z.string().optional().describe("DOI tür kodu süzgeci, virgülle: oa (Original Article), ra (Review), cp (Clinical Practice), cps, cpc, e, p, c… Sonuç sayfası içinde süzer"),
    from: z.string().optional().describe("YYYY veya YYYY/MM/DD"),
    until: z.string().optional(),
    sort: z.enum(["relevance", "date"]).default("relevance"),
    limit: z.number().int().min(1).max(50).default(10),
    page: z.number().int().min(1).default(1),
  },
  async ({ kind, ...a }) => {
    const r = await N.search(a);
    const want = kind ? new Set(kind.split(",").map((k) => k.trim().toLowerCase())) : null;
    const items = want ? r.items.filter((i) => i.kind && want.has(i.kind.code)) : r.items;
    const lines = items.map(
      (i, k) =>
        `${k + 1 + (a.page - 1) * a.limit}. ${i.title}\n   ${i.journal} ${i.date} · ${i.kind?.label || "?"} · ${i.firstAuthor}\n` +
        `   PMID ${i.pmid} · DOI ${i.doi || "-"}${i.pmcid ? ` · ${i.pmcid} (PMC'de)` : ""}`
    );
    return (
      `Sorgu: ${r.term}\nToplam ${r.count} kayıt; sayfa ${a.page}` +
      (want ? ` (tür süzgeci: ${[...want].join(",")} → ${items.length}/${r.items.length})` : "") +
      fallbackNote(r) +
      `\n\n${lines.join("\n") || "(sonuç yok)"}\n\nAyrıntı/özet: nejm_article(id=PMID veya DOI).`
    );
  }
);

tool(
  "nejm_latest",
  "Güncel sayının içindekileri (NEJM ve/veya NEJM Evidence resmî RSS'i). Tür kodu ve başlık/yazar kelimesiyle süzülebilir. Özet içermez; özet için nejm_article.",
  {
    journal: z.enum(["nejm", "evidence", "both"]).default("both"),
    kind: z.string().optional().describe("Virgüllü DOI tür kodları, ör. 'oa,ra,cp'"),
    grep: z.string().optional().describe("Başlık veya yazarda aranacak kelime(ler), '|' ile VEYA"),
  },
  async ({ journal, kind, grep }) => {
    const js = journal === "both" ? ["nejm", "evidence"] : [journal];
    const want = kind ? new Set(kind.split(",").map((k) => k.trim().toLowerCase())) : null;
    const re = grep ? new RegExp(grep, "i") : null;
    const out = [];
    for (const j of js) {
      const all = await N.latest(j);
      const items = all.filter((i) => (!want || (i.kind && want.has(i.kind.code))) && (!re || re.test(`${i.title} ${i.authorsText}`)));
      const head = all[0] ? `Cilt ${all[0].volume}, Sayı ${all[0].issue}` : "";
      out.push(`## ${N.JOURNALS[j].name} — ${head} (${items.length}/${all.length})`);
      const byKind = {};
      for (const i of items) (byKind[i.kind?.label || "?"] ||= []).push(i);
      for (const [k, arr] of Object.entries(byKind)) {
        out.push(`\n### ${k}`);
        for (const i of arr) out.push(`- ${i.title}\n  ${i.doi} · ${i.date.slice(0, 10)}${i.pages ? ` · s. ${i.pages}` : ""}`);
      }
      out.push("");
    }
    return out.join("\n");
  }
);

tool(
  "nejm_article",
  "Tek makalenin künyesi + yapılandırılmış özeti (PubMed), MeSH, trial kaydı (NCT), yorum/düzeltme bağlantıları, PMC durumu ve tam metin yolu. id: DOI, NEJM URL'i, PMID veya PMCID.",
  { id: z.string() },
  async ({ id }) => {
    const r = await resolve(id);
    if (!r.pmid && r.pmcid) {
      const c = JSON.parse(await get(`https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${r.pmcid}&format=json`)).records?.[0];
      r.pmid = c?.pmid; r.doi = c?.doi;
    }
    if (!r.pmid)
      return `PubMed'de bulunamadı (${r.doi}): ya çok yeni (henüz indekslenmedi) ya da DOI yanlış.\n${r.doi ? chromeHint(r.doi) : ""}`;
    const a = await N.article(r.pmid);
    const doi = a.doi || r.doi;
    const k = doi && N.kindOf(doi);
    const parts = [
      `# ${a.title}`,
      `${a.citation} · ${k?.label || ""}`,
      `PMID ${a.pmid} · DOI ${doi || "-"}${a.pmcid ? ` · ${a.pmcid}` : ""}`,
      `Yazarlar (${a.authors.length}): ${a.authors.slice(0, 8).join(", ")}${a.authors.length > 8 ? ", …" : ""}`,
      `Yayın türü: ${a.pubtypes.join("; ")}`,
      a.trials.length ? `Kayıt: ${a.trials.join(", ")}` : "",
      a.mesh.length ? `MeSH: ${a.mesh.join("; ")}` : "",
      a.commentsOn.length ? `Bağlantılı: ${a.commentsOn.slice(0, 10).join(" · ")}` : "",
      "",
      "## Özet",
      a.abstract.length ? a.abstract.map((x) => (x.label ? `**${x.label}.** ${x.text}` : x.text)).join("\n\n") : "(PubMed'de özet yok)",
      "",
      "## Tam metin",
      a.pmcid ? `PMC kopyası var → nejm_pmc_fulltext(id="${a.pmcid}") (Cloudflare'siz, yazar el yazması olabilir; son yayın sürümüyle küçük farklar olabilir).` : "PMC kopyası yok.",
      doi ? chromeHint(doi) : "",
    ];
    return parts.filter((x) => x !== "").join("\n");
  }
);

tool(
  "nejm_pmc_fulltext",
  "PMC'deki tam metin (NCBI; Cloudflare'siz). Çoğu NEJM kopyası NIH yazar el yazmasıdır. Bölüm başlığı, terim (find) ve tablo seçimiyle daraltılabilir. id: PMCID, PMID veya DOI.",
  {
    id: z.string(),
    sections: z.string().optional().describe("Bölüm başlığında geçen kelimeler, '|' ile (ör. 'METHODS|STATISTICAL')"),
    find: z.string().optional().describe("Metinde terim(ler), '|' ile; eşleşen paragrafları döner"),
    tables: z.boolean().default(false).describe("Tabloları markdown olarak ekle"),
    maxChars: z.number().int().min(1000).max(200000).default(30000),
  },
  async ({ id, sections, find, tables, maxChars }) => {
    let r = await resolve(id);
    let pmcid = r.pmcid;
    if (!pmcid && r.pmid) pmcid = (await N.article(r.pmid))?.pmcid;
    if (!pmcid) return `PMC kopyası yok.${r.doi ? `\n${chromeHint(r.doi)}` : ""}`;
    const ft = await N.pmcFullText(pmcid);
    if (!ft.available) return `${pmcid}: PMC tam metni XML olarak verilmiyor. ${ft.notice || ""}${r.doi ? `\n${chromeHint(r.doi)}` : ""}`;
    const secRe = sections ? new RegExp(sections, "i") : null;
    const findRe = find ? new RegExp(find, "i") : null;
    const out = [`# ${ft.title}`, `${ft.pmcid} · ${ft.sections.length} bölüm · ${ft.tables.length} tablo · ${ft.figures.length} şekil`, ""];
    if (!secRe && !findRe) out.push("İçindekiler: " + ft.sections.map((s) => s.title).join(" | "), "");
    let parentHit = false;
    for (const s of ft.sections) {
      // A matching parent (e.g. METHODS) pulls in its deeper subsections.
      const hit = !secRe || secRe.test(s.title) || (parentHit && s.depth > 1);
      if (secRe && s.depth === 1) parentHit = secRe.test(s.title);
      if (!hit) continue;
      let body = s.text;
      if (findRe) body = body.split("\n\n").filter((p) => findRe.test(p)).join("\n\n");
      if (!body) continue;
      out.push(`${"#".repeat(Math.min(s.depth + 1, 4))} ${s.title}`, body, "");
    }
    if (tables) for (const t of ft.tables) out.push(`### ${t.label} ${t.caption}`, mdTable(t), "");
    else if (ft.tables.length) out.push("Tablolar: " + ft.tables.map((t) => `${t.label} ${t.caption.slice(0, 80)}`).join(" · ") + " → tables=true");
    if (ft.figures.length) out.push("Şekiller: " + ft.figures.map((f) => `${f.label} ${f.caption.slice(0, 100)}`).join(" · "));
    const s = out.join("\n");
    return s.length > maxChars ? s.slice(0, maxChars) + `\n\n… [${s.length - maxChars} karakter kesildi; sections/find ile daralt]` : s;
  }
);

tool(
  "nejm_access_check",
  "Açık kanalların (NEJM RSS ×2, PubMed, PMC) erişim teşhisi ve NCBI anahtarı durumu. Abonelik tam metni bu sunucudan değil Chrome'dan okunur.",
  {},
  async () => {
    const rows = [];
    const probe = async (label, fn) => {
      const t = Date.now();
      try { rows.push(`✓ ${label}: ${await fn()} (${Date.now() - t} ms)`); } catch (e) { rows.push(`✗ ${label}: ${e.message.slice(0, 160)}`); }
    };
    await probe("NEJM RSS", async () => `${(await N.latest("nejm")).length} öğe`);
    await probe("NEJM Evidence RSS", async () => `${(await N.latest("evidence")).length} öğe`);
    // NCBI ERROR bodies now throw in eutils(); a whole journal at 0 is also never healthy.
    // Europe PMC fallback keeps search working, but esearch itself is still reported ✗.
    let pm;
    await probe("PubMed", async () => {
      pm = await N.search({ journal: "evidence", limit: 1 });
      if (pm.fallback) throw new Error(pm.fallback.reason);
      if (!pm.count) throw new Error("0 NEJM Evid kaydı — PubMed yanıtı şüpheli");
      return `${pm.count} NEJM Evid kaydı`;
    });
    if (pm?.fallback) rows.push(`${pm.count ? "✓" : "✗"} Europe PMC yedeği: ${pm.count} NEJM Evid kaydı (arama bununla sürüyor)`);
    await probe("PMC efetch", async () => { const f = await N.pmcFullText("PMC10351614"); return f.available ? `${f.sections.length} bölüm` : "gövde yok"; });
    rows.push(`NCBI API anahtarı: ${NCBI_KEY ? "var (10 istek/sn)" : "YOK (3 istek/sn)"}`);
    rows.push("Abonelik tam metni: Claude in Chrome (kullanıcının Chrome'u). nejm.org doğrudan HTTP'ye Cloudflare challenge verir — bu sunucu denemez.");
    return rows.join("\n");
  }
);

await server.connect(new StdioServerTransport());
// stdio servers must exit when the client goes away (see memory semantic-scholar-mcp).
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
