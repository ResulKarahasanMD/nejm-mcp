// Live smoke test: spawns index.js over stdio and calls every tool. No mocks.
//   npm test            # all
//   node test.mjs pmc   # filter by case name
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const filter = process.argv[2];
const client = new Client({ name: "nejm-test", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("./index.js", import.meta.url).pathname] }));

const cases = [
  ["tools-listed", null, null, async () => (await client.listTools()).tools.length === 5],
  ["access", "nejm_access_check", {}, (t) => (t.match(/✓/g) || []).length === 4],
  ["search-rct", "nejm_search", { query: "apixaban atrial fibrillation", journal: "nejm", pubType: "rct" }, (t) => t.includes("10.1056/NEJMoa1107039") && t.includes("Original Article")],
  ["search-evidence", "nejm_search", { journal: "evidence", sort: "date", limit: 5 }, (t) => /EVID/i.test(t) && t.includes("NEJM Evid")],
  ["search-kind-filter", "nejm_search", { query: "heart failure", journal: "nejm", kind: "ra", limit: 50 }, (t) => /tür süzgeci: ra/.test(t) && !/Original Article/.test(t)],
  ["search-daterange", "nejm_search", { query: "semaglutide", journal: "nejm", from: "2021", until: "2022" }, (t) => /2021\[dp\]|"2021"\[dp\]/.test(t) && !/ 2024 /.test(t)],
  ["latest-both", "nejm_latest", {}, (t) => t.includes("New England Journal of Medicine") && t.includes("NEJM Evidence") && t.includes("### Original Article")],
  ["latest-kind", "nejm_latest", { journal: "nejm", kind: "ra,cp" }, (t) => !t.includes("### Original Article")],
  ["article-doi", "nejm_article", { id: "10.1056/NEJMoa1107039" }, (t) => t.includes("NCT00412984") && t.includes("**RESULTS.**") && t.includes("www.nejm.org/doi/full/10.1056/NEJMoa1107039")],
  ["article-url", "nejm_article", { id: "https://www.nejm.org/doi/full/10.1056/NEJMoa1107039?af=R" }, (t) => t.includes("PMID 21870978")],
  ["article-evid", "nejm_article", { id: "10.1056/EVIDoa2400082" }, (t) => t.includes("PMID 38864749") && t.includes("evidence.nejm.org/doi/full/10.1056/EVIDoa2400082")],
  ["article-unknown-doi", "nejm_article", { id: "10.1056/EVIDoa9999999" }, (t) => t.includes("bulunamadı") && t.includes("DOI yanlış")],
  ["article-pmcid", "nejm_article", { id: "PMC10351614" }, (t) => /Pembrolizumab/i.test(t) && t.includes("· PMC10351614") && t.includes("id=\"PMC10351614\"")], // regression: reference ArticleIds leaked in
  ["pmc-toc", "nejm_pmc_fulltext", { id: "PMC10351614" }, (t) => t.includes("İçindekiler:") && t.includes("STATISTICAL ANALYSIS")],
  ["pmc-sections", "nejm_pmc_fulltext", { id: "PMC10351614", sections: "METHODS" }, (t) => t.includes("RANDOMIZATION") && !t.includes("## DISCUSSION")],
  ["pmc-find", "nejm_pmc_fulltext", { id: "PMC10351614", find: "hazard ratio" }, (t) => /hazard ratio/i.test(t) && t.length < 20000],
  ["pmc-tables", "nejm_pmc_fulltext", { id: "PMC10351614", sections: "^$", tables: true }, (t) => t.includes("### Table 1.") && t.includes("| --- |")],
  ["pmc-absent", "nejm_pmc_fulltext", { id: "10.1056/NEJMoa1107039" }, (t) => t.includes("PMC kopyası yok") && t.includes("Claude in Chrome")],
  ["bad-id", "nejm_article", { id: "hello" }, (t, isErr) => isErr && t.includes("Tanınmayan kimlik")],
];

let pass = 0, run = 0;
for (const [name, tool, args, check] of cases) {
  if (filter && !name.includes(filter)) continue;
  run++;
  const t0 = Date.now();
  try {
    let ok;
    if (!tool) ok = await check();
    else {
      const r = await client.callTool({ name: tool, arguments: args });
      const txt = r.content.map((c) => c.text).join("\n");
      ok = await check(txt, !!r.isError);
      if (!ok) console.log(`   çıktı: ${txt.slice(0, 400).replace(/\n/g, " ⏎ ")}`);
    }
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
console.log(`\n${pass}/${run} geçti`);
await client.close();
process.exit(pass === run ? 0 : 1);
