const puppeteer = require("puppeteer");
const db = require("../db/schema");
const { DateTime } = require("luxon");
const path = require("path");
const fs = require("fs");
const { NormalizationService, BRAND_ALIASES } = require("../services/normalization");
const VERSIONS = require("../config/versions");
const { parseV3 } = require("./v3_logic");
const SecondStageStrategy = require("./strategies/second_stage");

/**
 * Вспомогательная функция для определения бренда через переход по ссылке (Redirect Resolve)
 */
async function resolveBrandFromRedirect(browser, url) {
  if (!url || !url.startsWith("http")) return null;

  let page = null;
  try {
    console.log(`[Scraper] [RedirectResolve] Переход по ссылке для определения бренда: ${url}`);
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    await page.setViewport({ width: 1280, height: 800 });

    // Переходим и ждем, пока URL перестанет меняться (завершатся редиректы)
    await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 }).catch(e => {
        console.log(`[Scraper] [RedirectResolve] Таймаут или ошибка перехода, пробуем извлечь что есть: ${e.message}`);
    });

    const metadata = await page.evaluate(() => {
      const getMeta = (name) => {
        const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"], meta[property="og:${name}"]`);
        return el ? el.getAttribute("content") : null;
      };

      return {
        title: document.title,
        siteName: getMeta("site_name") || getMeta("application-name") || getMeta("apple-mobile-web-app-title"),
        ogTitle: getMeta("title") || getMeta("og:title"),
        description: getMeta("description") || getMeta("og:description")
      };
    });

    const candidates = [
        metadata.siteName,
        metadata.title,
        metadata.ogTitle
    ].filter(Boolean);

    await page.close();
    page = null;

    for (const text of candidates) {
        // Очищаем от лишнего мусора
        const potentialBrand = text.split(/[|-]/)[0]
            .replace(/(официальный сайт|онлайн|займ|кредит|банк|вход|личный кабинет)/gi, "")
            .trim();
        
        if (potentialBrand && potentialBrand.length > 2) {
            console.log(`[Scraper] [RedirectResolve] Найдено потенциальное имя: "${potentialBrand}"`);
            return potentialBrand;
        }
    }

    return null;
  } catch (error) {
    console.error(`[Scraper] [RedirectResolve] Ошибка:`, error.message);
    if (page) try { await page.close(); } catch(e) {}
    return null;
  }
}

async function parseShowcase(showcaseId, version = VERSIONS.PARSER.STABLE, retryCount = 0) {
  const showcase = db
    .prepare("SELECT * FROM showcases WHERE id = ?")
    .get(showcaseId);
  if (!showcase) throw new Error("Showcase not found");

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-dev-shm-usage", // Использовать /tmp вместо /dev/shm (важно для Railway/Docker)
      "--disable-gpu",           // Отключить GPU для экономии RAM
      "--no-zygote",             // Экономит память, не создавая лишние процессы
      "--disable-extensions",    // Отключить расширения
      "--single-process",        // Опционально: запускать в одном процессе (экспериментально, но экономит память)
    ],
  });

  const page = await browser.newPage();

  // Эмуляция реального пользователя
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  await page.setViewport({ width: 1280, height: 1080 });

  try {
    console.log(`[Scraper v${version}] Начинаю парсинг: ${showcase.url}`);
    await page.goto(showcase.url, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // 1. Ждем немного для прогрузки JS-виджетов
    await new Promise((r) => setTimeout(r, 6000));

    // 2. Эмуляция прокрутки (триггер ленивой загрузки)
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        let distance = 400;
        let timer = setInterval(() => {
          let scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight || totalHeight > 10000) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 120);
      });
    });

    // 2.5 КРИТИЧНО: Даем время на выполнение JS-редиректов и подмену ссылок
    console.log(`[Scraper] Ожидание стабилизации элементов после скролла...`);
    await new Promise((r) => setTimeout(r, 4000));

    // Генерация имени скриншота
    const urlObj = new URL(showcase.url);
    const currentHost = urlObj.hostname;
    const topDomain = currentHost.split('.').slice(-2).join('.');
    const domainSlug = currentHost.replace(/\./g, "_");
    const timestamp = DateTime.now().toFormat("yyyy-MM-dd_HH-mm");
    const screenshotName = `${domainSlug}_${timestamp}.png`;
    const screenshotPath = path.join(
      __dirname,
      "../../public/screenshots",
      screenshotName,
    );

    const screenshotDir = path.dirname(screenshotPath);
    if (!fs.existsSync(screenshotDir))
      fs.mkdirSync(screenshotDir, { recursive: true });

    // Безопасный скриншот (для длинных или медленных страниц)
    try {
      await page.setViewport({ width: 1280, height: 1080 }); // Принудительный Desktop для скрина
      
      const pageHeight = await page.evaluate(() => document.body.scrollHeight);
      const isVisible = await page.evaluate(() => {
        const body = document.body;
        return body && body.innerText.trim().length > 100 && !body.innerText.includes("Not Found");
      });

      if (!isVisible) {
          console.warn(`[Scraper] Страница кажется пустой или "Not Found", жду еще 5сек...`);
          await new Promise(r => setTimeout(r, 5000));
      }

      if (pageHeight > 12000) {
        // Очень длинная страница — делаем viewport скриншот
        console.warn(
          `[Scraper] Страница слишком длинная (${pageHeight}px), делаю viewport скриншот`,
        );
        await page.screenshot({ path: screenshotPath, fullPage: false });
      } else {
        // Нормальная страница — fullPage с таймаутом 15 сек
        await page.screenshot({
          path: screenshotPath,
          fullPage: true,
          timeout: 15000,
        });
      }
    } catch (e) {
      console.warn(
        "[Scraper] Не удалось сделать fullPage скриншот, делаю viewport:",
        e.message,
      );
      try {
        await page.screenshot({ path: screenshotPath, fullPage: false });
      } catch (e2) {
        console.error("[Scraper] Скриншот полностью провалился:", e2.message);
      }
    }

    const runResult = db
      .prepare(
        `
            INSERT INTO parsing_runs (showcase_id, status, screenshot_path, parsing_method)
            VALUES (?, ?, ?, ?)
        `,
      )
      .run(showcaseId, "success", `/screenshots/${screenshotName}`, `v${version}`);

    const runId = runResult.lastInsertRowid;

    // 2.6 Ожидаем стабилизации сети (Sravni: уменьшен таймаут по просьбе)
    const isSravni = showcase.url.includes("sravni.ru");
    try {
      await page.waitForNetworkIdle({
        idleTime: 1000,
        timeout: isSravni ? 5000 : 5000,
      });
      // Убрана дополнительная задержка для Sravni
    } catch (e) {
      console.log(`[Scraper] Timeout waiting for network idle, continuing...`);
    }

    const brandNames = Object.keys(NormalizationService.BRAND_ALIASES);
    const brandAliases = NormalizationService.BRAND_ALIASES;
    const allKnownAliases = Object.values(brandAliases).flat().map(a => a.toLowerCase());

    // 3. Логика парсинга офферов
    let data = [];
    const customSelector = showcase.custom_selector || '';
    
    // Pattern Clustering v6.0: Автоматический поиск повторяющихся структур
    if (version === VERSIONS.PARSER.PATTERN_CLUSTERING) {
      console.log('[Scraper] Используется Pattern Clustering v6.0...');
      
      // Внедряем Pattern Detector в страницу
      await page.addScriptTag({ path: require.resolve('./strategies/pattern_detector.js') });
      
      // Запускаем поиск паттерна
      const patternSelector = await page.evaluate(() => {
        return PatternDetector.findOfferPattern(5, 50);
      });
      
      if (patternSelector) {
        console.log(`[Pattern Clustering] Найден паттерн: ${patternSelector}`);
        
        // Используем найденный паттерн как customSelector
        data = await page.evaluate((selector, knownBrands, aliasesMap, allAliases) => {
          const results = [];
          const cards = document.querySelectorAll(selector);
          
          console.log(`[Pattern Clustering] Обработка ${cards.length} карточек...`);
          
          cards.forEach((card, idx) => {
            // Извлекаем данные из карточки
            const img = card.querySelector('img');
            const link = card.querySelector('a[href]');
            const button = card.querySelector('button, .btn, [class*="button"]');
            
            let name = '';
            
            // Пытаемся извлечь название
            const titleEl = card.querySelector('[class*="name"], [class*="title"], h1, h2, h3, h4');
            if (titleEl) {
              name = titleEl.innerText.trim();
            }
            
            // Если не нашли, пробуем alt изображения
            if (!name && img && img.alt) {
              name = img.alt.trim();
            }
            
            // Если не нашли, пробуем имя файла изображения
            if (!name && img && img.src) {
              const extracted = PatternDetector.extractBrandFromImage(img.src, img.alt);
              if (extracted) name = extracted;
            }
            
            if (name && link) {
              results.push({
                company_name: name,
                link: link.href,
                image_url: img ? img.src : '',
                position: idx + 1
              });
            }
          });
          
          return results;
        }, patternSelector, brandNames, brandAliases, allKnownAliases);
        
        console.log(`[Pattern Clustering] Извлечено ${data.length} офферов`);
      } else {
        console.log('[Pattern Clustering] Паттерн не найден, fallback к Cluster Match...');
      }
    }
    
    // Если Pattern Clustering не использовался или не нашел паттерн, используем стандартную логику
    if (version !== VERSIONS.PARSER.PATTERN_CLUSTERING || data.length === 0) {
      // 3. Логика парсинга офферов (Cluster Match v5.3)
    data = await page.evaluate((knownBrands, aliasesMap, allAliases, customSelector, scraperVersion, currentHost) => {
      const results = [];
      const keywords = ["займ", "деньги", "получить", "оформить", "взять", "заявку", "кредит", "на карту", "выплата", "выбрать", "подробнее", "бесплатно", "одобр"];
      const filterPhrases = ["все займы", "новые", "популярные", "лучшие", "с плохой ки", "без процентов", "на карту", "без отказа"];
      const finTerms = ["сумма", "срок", "ставка", "процент", "дней", "руб"];
      
      const affiliateDomains = [
        "leadgid.ru", "leads.su", "leads.tech", "pxl.leads.su", "t.leads.tech", 
        "go.leadgid.ru", "vldmnt.ru", "finlaba.ru", "trnsfx.ru", "credyi.ru", "ads.guruleads.ru", "guruleads.ru"
      ];

      function isMoney(text) {
        const low = (text || "").toLowerCase().trim();
        // v2.3 Исключаем общие фразы фильтров
        if (filterPhrases.includes(low)) return false;
        
        return keywords.some((k) => low.includes(k)) || (low.length > 2 && low.length < 25 && (low.includes("одобр") || low.includes("выбр") || low.includes("подать")));
      }

      function isTrashName(text) {
        const low = (text || "").toLowerCase().trim();
        if (!low || low.length < 2) return true;
        
        // КРИТИЧНО v2.1: Если слово является известным алиасом, это НЕ мусор
        if (allAliases.includes(low)) return false;

        if (/^[0-9\s%рубдней.+-]+$/.test(low)) return true;
        
        const stopWords = [
            "сумма", "срок", "ставка", "отзыв", "подробнее", "получить", "заявка", "logo", 
            "выплата", "минуту", "руб", "дней", "процент", "без отказа", "онлайн", 
            "на карту", "кредит", "займ", "взять", "оформить", "рублей", "выдача",
            "лицензия", "вход", "кабинет", "мин", "условие", "рейтинг", "фильтр"
        ];
        
        // КРИТИЧНО v2.1: Используем более точное сопоставление для длинных стоп-слов
        if (stopWords.some(sw => {
            if (low === sw) return true;
            if (sw === "займ" || sw === "сумма" || sw === "срок" || sw === "ставка") {
                return low === sw || low.includes(" " + sw) || low.includes(sw + " ");
            }
            return low.includes(sw) && low.length < 15;
        })) return true;

        if (low.startsWith("до ") || low.startsWith("от ")) return true;
        return false;
      }

      // 0. Анализ паттернов ссылок

      const allLinks = Array.from(document.querySelectorAll('a[href*="http"]'))
        .map((a) => {
          try {
            const url = new URL(a.href);
            // v2.3 Игнорируем ссылки на текущий хост при подсчете топ-домена
            if (url.hostname === currentHost) return null;
            return { hostname: url.hostname, href: a.href };
          } catch (e) { return null; }
        })
        .filter(Boolean);

      const domainCounts = {};
      allLinks.forEach((l) => (domainCounts[l.hostname] = (domainCounts[l.hostname] || 0) + 1));
      const topDomain = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

      const processedContainers = new Set();
      let targets = [];

      if (customSelector && customSelector.trim()) {
          try {
              const customElements = document.querySelectorAll(customSelector);
              if (customElements.length > 0) targets = Array.from(customElements);
          } catch(e) {}
      }

      if (targets.length === 0) {
          targets = Array.from(document.querySelectorAll('a, button, [role="button"], .btn, .button'))
            .filter((el) => isMoney(el.innerText || el.value || ""));
      }

      targets.forEach((el) => {
        let card = null;

        if (customSelector && customSelector.trim()) {
             card = el;
        } else {
            let curr = el;
            let lastValid = null;
            // Ищем САМЫЙ ВНЕШНИЙ контейнер, но не выше разумного (v2.6)
            for (let i = 0; i < 10; i++) {
              if (!curr || curr === document.body || curr.tagName === 'HTML') break;



              // Универсальный поиск: проверяем атрибуты на наличие слов card, offer, product
              // v2.8 Smart Attribute Scan
              let isExplicitCard = false;
              if (curr.tagName === 'DIV' || curr.tagName === 'ARTICLE' || curr.tagName === 'LI') {
                  // Проверяем явные маркеры в любых атрибутах (class, id, data-*, create-*, etc.)
                  for (const attr of curr.attributes) {
                      const val = (attr.value || "").toLowerCase();
                      // Ищем полные слова или четкие вхождения
                      // 'card', 'offer-card', 'product-item', 'microloan-product'
                      if (/(^|[-_ ])(card|offer-card|product-card|offer-item|product-item|microloan-item)([-_ ]|$)/.test(val)) {
                           if (!val.includes('wrapper') && !val.includes('container') && !val.includes('list') && !val.includes('grid')) {
                               isExplicitCard = true;
                               break;
                           }
                      }
                      // Специальная обработка для data-qa = "Card" (Sravni) и подобных коротких значений
                      if ((attr.name.includes('data-') || attr.name.includes('test')) && (val === 'card' || val === 'offer' || val === 'product')) {
                          isExplicitCard = true;
                          break;
                      }
                  }
              }

              if (isExplicitCard) {
                   lastValid = curr;
                   factors = 100; // Force valid
                   break;
              }

              const className = (curr.className || "").toString().toLowerCase();
              const idName = (curr.id || "").toString().toLowerCase();
              
              if (/(nav|menu|filter|tags|breadcrumb|footer|header|sidebar)/.test(className + idName)) {
                  break; 
              }

              const rect = curr.getBoundingClientRect();
              const innerText = (curr.innerText || "").toLowerCase();
              const hasImg = curr.querySelector("img");
              const hasKnownBrand = allAliases.some(a => innerText.includes(a));
              const hasFinTerms = finTerms.filter((t) => innerText.includes(t)).length >= 1; 
              const isCardClass = /card|offer|item|row|tile|product|block/.test(className);
              const isSignificant = rect.height > 60 && rect.width > 120 && rect.height < (window.innerHeight * 0.85);

              const cardLinks = Array.from(curr.querySelectorAll('a[href*="http"]'));
              const hasAffLink = cardLinks.some(al => {
                  try {
                      const url = new URL(al.href);
                      const host = url.hostname;
                      if (host === currentHost) return false;
                      return (topDomain && host === topDomain) || affiliateDomains.some(ad => host.includes(ad)) || al.href.includes('/go/') || al.href.includes('/click/');
                  } catch(e) { return false; }
              });

              factors = 0;
              if (isCardClass) factors++;
              if (hasKnownBrand) factors += 2; // hasKnownBrand берется из замыкания
              if (hasFinTerms) factors++;
              if (hasImg) factors++;
              if (hasAffLink) factors += 2;

              if (factors >= 2 && isSignificant) { 
                lastValid = curr;
              }
              curr = curr.parentElement;
            }
            card = lastValid;
        }

        if (card && !processedContainers.has(card)) {
          processedContainers.add(card);

          const imgs = Array.from(card.querySelectorAll("img"));
          const img = imgs.find(i => i.width > 30) || imgs[0];
          let name = "";

          // v3.0 Smart Title Scan (Универсальный поиск заголовка с приоритетом)
          // Приоритет 1: Семантические теги
          const semanticTitle = card.querySelector('[itemprop="name"], [data-role="title"], [data-name="title"]');
          if (semanticTitle) {
               const val = semanticTitle.innerText.trim();
               if (val && !isTrashName(val)) name = val;
          }

          // Приоритет 2: CSS-классы с явными названиями (offer__name, card-title и т.д.)
          if (!name) {
            const classTitleSelectors = [
                '.offer__name', '.offer-name', '.offer__title', '.offer-title',
                '.card__name', '.card-name', '.card__title', '.card-title',
                '.product__name', '.product-name', '.product__title', '.product-title',
                '.brand-name', '.company-name', '.mfo-name',
                '[class*="__name"]', '[class*="-name"]', '[class*="__title"]', '[class*="-title"]'
            ];
            
            for (const selector of classTitleSelectors) {
                try {
                    const titleEl = card.querySelector(selector);
                    if (titleEl) {
                        const val = titleEl.innerText.trim();
                        if (val && !isTrashName(val)) {
                            name = val;
                            break;
                        }
                    }
                } catch(e) {
                    // Игнорируем невалидные селекторы
                }
            }
          }

          // Приоритет 3: data-атрибуты (универсально)
          if (!name) {
               const potentialTitles = Array.from(card.querySelectorAll('*'));
               for (const el of potentialTitles) {
                   // Проверяем все data-атрибуты элемента
                   const isTitle = Array.from(el.attributes).some(attr => {
                       return (attr.name.startsWith('data-') || attr.name.includes('test')) && 
                              (attr.value === 'title' || attr.value === 'brand-name' || attr.value === 'company-name');
                   });
                   
                   if (isTitle) {
                       const val = el.innerText.trim();
                       if (val && !isTrashName(val)) {
                           name = val;
                           break;
                       }
                   }
               }
          }

          // [Иерархия извлечения имени v2.1-v2.5 сохраняется]

          if (!name) {
              const elementsWithTechnicalData = Array.from(card.querySelectorAll('[onclick], [data-offer], [data-name], [data-brand], [data-qa], [data-testid]'));
              for (const te of elementsWithTechnicalData) {
                  const technicalString = 
                    (te.getAttribute('onclick') || '') + ' ' + 
                    (te.getAttribute('data-offer') || '') + ' ' + 
                    (te.getAttribute('data-name') || '') + ' ' + 
                    (te.getAttribute('data-brand') || '') + ' ' +
                    (te.getAttribute('data-qa') || '') + ' ' +
                    (te.getAttribute('data-testid') || '');
                  
                  const foundAlias = allAliases.find(a => a.length > 2 && technicalString.toLowerCase().includes(a));
                  if (foundAlias) {
                      for (const [brand, aliases] of Object.entries(aliasesMap)) {
                          if (aliases.some(as => as.toLowerCase() === foundAlias)) { name = brand; break; }
                      }
                      if (name) break;
                  }
              }
          }

          if (!name && img && img.src) {
              let srcName = img.src.split('/').pop().split('.')[0].replace(/[-_]/g, ' ').replace(/[0-9]+x[0-9]+/g, '').replace(/[0-9]{4}/g, '').trim();
              if (srcName && srcName.length > 2 && !isTrashName(srcName)) name = srcName;
          }

          if (!name && img) name = img.alt || img.title || "";
          
          if (!name || isTrashName(name)) {
            const heads = Array.from(card.querySelectorAll('h1, h2, h3, h4, b, strong'));
            for (const h of heads) {
              const val = h.innerText.trim();
              if (val && !isTrashName(val)) { name = val; break; }
            }
          }

          if (scraperVersion >= "2.0" && (!name || isTrashName(name) || name === "Offer")) {
              const text = card.innerText.toLowerCase();
              for (const [brand, aliases] of Object.entries(aliasesMap)) {
                  if (aliases.some(a => text.includes(a.toLowerCase()))) { name = brand; break; }
              }
          }

          if (!name || isTrashName(name)) name = "Offer";

          // Ссылка
          let href = (el.tagName === 'A') ? el.href : null;
          if (!href || href.includes('javascript') || href.endsWith('#') || href === window.location.href) {
              const allCardLinks = Array.from(card.querySelectorAll('a[href^="http"]'));
              const validAffLink = allCardLinks.find(al => {
                  try {
                      const url = new URL(al.href);
                      const host = url.hostname;
                      if (host === currentHost) return false;
                      return (topDomain && host === topDomain) || affiliateDomains.some(ad => host.includes(ad)) || al.href.includes('/go/') || al.href.includes('/click/');
                  } catch(e) { return false; }
              });
              if (validAffLink) href = validAffLink.href;
          }

          results.push({
            company_name: name.substring(0, 40).trim(),
            link: href || "#unknown",
            image_url: img?.src || null,
            placement_type: "main",
          });
        }
      });

      // v2.6 Мягкая дедупликация: 
      // Оставляем всё, кроме ПОЛНЫХ дублей (имя + ссылка одинаковые)
      // Если у компании есть нормальная ссылка и есть вариант с #unknown — убираем вариант с #unknown
      const final = [];
      results.forEach((item) => {
        const duplicateIndex = final.findIndex(f => 
            f.company_name === item.company_name && (f.link === item.link || (f.link === '#unknown' || item.link === '#unknown'))
        );

        if (duplicateIndex === -1) {
            final.push(item);
        } else {
            // Если нашли дубль по имени и один из них без ссылки — берем тот, что со ссылкой
            if (item.link !== '#unknown' && final[duplicateIndex].link === '#unknown') {
                final[duplicateIndex] = item;
            }
        }
      });

      return final;
    }, brandNames, brandAliases, allKnownAliases, customSelector, version);
    } // Конец блока if (version !== VERSIONS.PARSER.PATTERN_CLUSTERING || data.length === 0)

    // --- ОБРАБОТКА РЕЗУЛЬТАТОВ V3.0 И НЕИЗВЕСТНЫХ БРЕНДОВ ---
    let finalData = data;
    if (version === VERSIONS.PARSER.STABLE_V3) {
        console.log(`[Scraper] Используется логика v3.0...`);
        finalData = await parseV3(page, browser, {
            brandNames,
            brandAliases,
            allAliasesMap: BRAND_ALIASES,
            version
        });


    }

    console.log(`[Scraper v${version}] Парсинг завершен. Итого офферов: ${finalData.length}`);

    // --- DOUBLE LOGIC: FALLBACK V2 ---
    let fallbackData = null;
    if (finalData.length === 0) {
      console.log(
        `[Scraper] Основной алгоритм v${version} (0 офферов). Запускаю Fallback (JSON + SimpleDOM)...`,
      );

      fallbackData = await page.evaluate((customSelector) => {
        const results = [];
        let method = null;

        function buildCustomTarget(rawValue) {
          const raw = (rawValue || "").trim();
          if (!raw) return null;

          if (raw.startsWith("<")) {
            try {
              const doc = new DOMParser().parseFromString(raw, "text/html");
              const root = doc.body.firstElementChild;
              if (!root) return null;

              const tag = root.tagName.toLowerCase();
              const classes = Array.from(root.classList);
              const selector = classes.length
                ? `${tag}.${classes.join(".")}`
                : tag;

              const classSet = new Set();
              doc.body.querySelectorAll("*").forEach((el) => {
                el.classList.forEach((c) => classSet.add(c));
              });

              return {
                selector,
                requiredClasses: Array.from(classSet),
                isTemplate: true,
              };
            } catch (e) {
              return null;
            }
          }

          return { selector: raw, requiredClasses: [], isTemplate: false };
        }

        const customConfig = buildCustomTarget(customSelector);

        // 1. Попытка через JSON (CrediyShop)
        try {
          const appData = document.getElementById("app-data");
          if (appData) {
            const json = JSON.parse(appData.textContent);
            const offersBlock =
              json.blocks && json.blocks.find((b) => b.block_type === "offers");
            const baseUrl =
              json.offers_logo_base_url || "https://offers.credilead.ru/";

            if (offersBlock && offersBlock.offers) {
              offersBlock.offers.forEach((o) => {
                results.push({
                  company_name: o.site_name || o.name,
                  link: o.url,
                  image_url: o.logo ? baseUrl + o.logo : null,
                  placement_type: "main",
                });
              });
              method = "JSON";
            }
          }
        } catch (e) {}

        // 2. SimpleDOM Fallback
        if (results.length === 0) {
          if (customConfig && customConfig.selector) {
             let customElements = Array.from(document.querySelectorAll(customConfig.selector));
             if (customConfig.requiredClasses.length > 0) {
               customElements = customElements.filter((el) =>
                 customConfig.requiredClasses.every(
                   (cls) => el.classList.contains(cls) || el.querySelector(`.${cls}`),
                 ),
               );
             }
             customElements.forEach((c) => {
                const linkEl = c.querySelector('a[href*="http"], a[href^="/"]');
                const imgEl = c.querySelector("img");
                let name = "";

                if (imgEl) name = imgEl.alt || imgEl.title;
                if (!name) name = c.innerText.split("\n")[0];
                
                let finalLink = linkEl ? linkEl.href : c.getAttribute('href');
                 if (finalLink && !finalLink.startsWith('http')) {
                    finalLink = window.location.origin + finalLink;
                 }

                if (finalLink && name && name.length > 2) {
                  results.push({
                    company_name: name.trim(),
                    link: finalLink,
                    image_url: imgEl ? imgEl.src : null,
                    placement_type: "main",
                  });
                }
             });
             if (results.length > 0 && !method) {
               method = "DOM (Custom Selector Fallback)";
             }
          }

          if (results.length === 0) {
              const simpleCards = document.querySelectorAll(
                ".card, .offer-item, .item, .offer-card, .product-layout",
              );
              simpleCards.forEach((c) => {
                const linkEl = c.querySelector('a[href*="http"], a[href^="/"]');
                const imgEl = c.querySelector("img");
                let name = "";

                if (imgEl) name = imgEl.alt || imgEl.title;
                if (!name) name = c.innerText.split("\n")[0];

                if (linkEl && name && name.length > 2) {
                  results.push({
                    company_name: name.trim(),
                    link: linkEl.href,
                    image_url: imgEl ? imgEl.src : null,
                    placement_type: "main",
                  });
                }
              });
              if (results.length > 0 && !method) {
                method = "DOM (Simple Fallback)";
              }
          }
        }

        return { results, method };

      }, brandNames, brandAliases, allKnownAliases, customSelector, version, currentHost);

      if (fallbackData.results && fallbackData.results.length > 0) {
        console.log(
          `[Scraper] Fallback спас ситуацию! Найдено: ${fallbackData.results.length}`,
        );
        data.push(...fallbackData.results);
      }
    }

    // Определяем метод парсинга для записи в БД
    let finalMethod = `v${version}`;
    if (fallbackData && fallbackData.results && fallbackData.results.length > 0) {
      finalMethod += ` (Fallback: ${fallbackData.method})`;
    } else if (customSelector && customSelector.trim()) {
      finalMethod += ` (Custom Selector)`;
    } else {
      finalMethod += ` (Cluster Match)`;
    }

    db.prepare(`UPDATE parsing_runs SET parsing_method = ? WHERE id = ?`)
      .run(finalMethod, runId);

    // --- REDIRECT RESOLVE v2.2 (Определяем бренды для "Offer") ---
    for (let i = 0; i < data.length; i++) {
        const offer = data[i];
        if (offer.company_name === "Offer" && offer.link) {
            const resolvedName = await resolveBrandFromRedirect(browser, offer.link);
            if (resolvedName) {
                console.log(`[Scraper] [RedirectResolve] Бренд определен: "${resolvedName}" (был Offer)`);
                offer.company_name = resolvedName;
            }
        }
    }

    // Сохраняем в БД
    let finalOfFinal = fallbackData || finalData;

    // --- SECOND STAGE: REFINEMENT (v2.7) ---
    // Запускаем ТОЛЬКО если выбрана версия с поддержкой Second Stage
    if (version === VERSIONS.PARSER.STABLE_V3_SS) {
        console.log(`[Scraper] Запуск Second Stage (выбрана версия ${version})...`);
        try {
            finalOfFinal = SecondStageStrategy.process(finalOfFinal);
        } catch(e) {
            console.error(`[Scraper] Ошибка во время Second Stage:`, e.message);
        }
    } else {
        console.log(`[Scraper] Second Stage пропущен (версия ${version}).`);
    }

    // --- СОХРАНЕНИЕ НЕИЗВЕСТНЫХ БРЕНДОВ (Общее для всех версий) ---
    // Перенесено из блока V3, чтобы работало везде
    for (const item of finalOfFinal) {
        if (item.company_name === "Unknown" || item.company_name === "Offer" || (item.is_recognized === false)) {
            try {
                // Пытаемся избежать дублей (уникальность по raw_name + run_id)
                // Но проще просто игнорировать ошибки unique constraint если они возникнут
                const debugJson = item.debug_logs ? JSON.stringify(item.debug_logs) : null;
                db.prepare(`
                    INSERT INTO unknown_brands (showcase_id, run_id, raw_name, link, position, debug_json)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(showcaseId, runId, item.company_name, item.link, item.position || 0, debugJson);
            } catch (e) {
                // Игнорируем ошибки дублей, логируем остальные
                if (!e.message.includes('UNIQUE constraint failed')) {
                     console.error(`[DB] Ошибка записи неизвестного бренда:`, e.message);
                }
            }
        } else if (item.is_recognized && item.image_url && item.image_url.startsWith('http')) {
            // v2.9: Сохраняем качественные логотипы для известных брендов
            // Если домен доверенный (например, Sravni.ru или любой другой), обновляем логотип
            const isHighQualitySource = currentHost.includes('sravni.ru') || currentHost.includes('banki.ru');
            
            if (isHighQualitySource) {
                 try {
                     db.prepare(`
                        INSERT INTO persistent_logos (brand_name, logo_url, source_domain, updated_at)
                        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(brand_name) DO UPDATE SET
                        logo_url=excluded.logo_url,
                        source_domain=excluded.source_domain,
                        updated_at=CURRENT_TIMESTAMP
                     `).run(item.company_name, item.image_url, currentHost);
                 } catch (e) {
                     // Silent fail logic update
                 }
            }
        }
    }

    const insertStat = db.prepare(`
        INSERT INTO offer_stats (run_id, company_name, link, image_url, placement_type, position)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    finalOfFinal.forEach((item, index) => {
        insertStat.run(
            runId,
            item.company_name,
            item.link,
            item.image_url,
            item.placement_type || 'main',
            item.position || (index + 1)
        );
    });

    return { success: true, count: data.length, version };
  } catch (error) {
    console.error(
      `Ошибка при парсинге ${showcase.url} (Attempt ${retryCount + 1}):`,
      error.message,
    );

    if (
      retryCount < 1 &&
      (error.message.includes("detached") || error.message.includes("timeout"))
    ) {
      console.log(`[Scraper] Обнаружена критическая ошибка, пробую еще раз...`);
      await browser.close();
      return parseShowcase(showcaseId, version, retryCount + 1);
    }

    db.prepare(
      `
            INSERT INTO parsing_runs (showcase_id, status, error_message, parsing_method)
            VALUES (?, ?, ?, ?)
        `,
    ).run(showcaseId, "error", error.message, `v${version}`);
    return { success: false, error: error.message };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { parseShowcase };
