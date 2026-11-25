# nejm-mcp

> **English summary.** A discovery MCP server (stdio) for NEJM and NEJM Evidence that uses only open channels: PubMed E-utilities, NCBI PMC and the journals' official RSS feeds. It does not fetch subscriber full text and does not try to get past the publisher's bot protection.
> The rest of this README is in Turkish.

NEJM ve NEJM Evidence için keşif MCP sunucusu (Node ESM, stdio). Yalnız açık kanalları kullanır: PubMed E-utilities, NCBI PMC efetch ve dergilerin resmî RSS'i.

Abonelik tam metnini bu sunucu çekmez. nejm.org ve evidence.nejm.org sayfaları anonim isteklere Cloudflare doğrulamasıyla yanıt verir; sunucu bunu aşmaya çalışmaz (çerez yeniden oynatma, TLS taklidi ya da gizlenme yok). Tam metin gerekiyorsa makaleyi kendi tarayıcında, kendi aboneliğinle aç.

## Araçlar

| Araç | Ne yapar |
|---|---|
| `nejm_search` | NEJM ve NEJM Evidence makalelerini PubMed üzerinden arar; PMID, DOI, makale türü ve PMCID döner. PubMed sözdizimini (MeSH, `[tiab]`, AND/OR) kabul eder. |
| `nejm_latest` | Güncel sayının içindekileri (resmî RSS). Tür koduyla ya da başlık ve yazar kelimesiyle süzülebilir; özet içermez. |
| `nejm_article` | Tek makalenin künyesi, yapılandırılmış özeti, MeSH terimleri, trial kaydı, yorum ve düzeltme bağlantıları, PMC durumu. Kimlik: DOI, NEJM adresi, PMID ya da PMCID. |
| `nejm_pmc_fulltext` | PMC'deki tam metin. Çoğu NEJM kopyası NIH yazar el yazmasıdır. Bölüm başlığı, terim ve tablo seçimiyle daraltılabilir. |
| `nejm_access_check` | Açık kanalların (iki RSS, PubMed, PMC) erişim teşhisi ve NCBI anahtarı durumu. |

## Kurulum

```bash
npm install
claude mcp add nejm -- node /path/to/nejm-mcp/index.js
```

`NCBI_API_KEY` ortam değişkeni isteğe bağlıdır; verilirse NCBI'ın hız sınırı yükselir.

## Test

```bash
npm run test:unit   # ağ gerektirmez
npm test            # birim testleri + canlı vakalar (PubMed, PMC, RSS)
node test.mjs pmc   # canlı vakaları ada göre süz
```

## Sınırlar

- RSS'te yazar adları tek alanda, yalnız boşlukla ayrılmış gelir ve bölünemez. `content:encoded` künye satırıdır, özet değildir; özet için `nejm_article` kullanılır.
- Europe PMC'nin `fullTextXML` ucu NIH yazar el yazmalarında hata verir; tam metin NCBI `efetch db=pmc` ile alınır.
- PubMed araması arızalanırsa PMID listesi Europe PMC'den alınır ve çıktıda bunu belirten bir uyarı görünür; toplam ve sıralama PubMed'den biraz farklı olabilir.

## Lisans

[MIT](LICENSE). Bu proje NEJM ya da Massachusetts Medical Society ile bağlantılı değildir; makale içeriğinin hakları yayıncıya aittir.
