const puppeteer = require("puppeteer");
const db = require("../db/schema");
const { DateTime } = require("luxon");
const path = require("path");
const fs = require("fs");
const { NormalizationService } = require("../services/normalization");

async function parseShowcase(showcaseId, retryCount = 0) {
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
    ],
  });

  const page = await browser.newPage();

  // Эмуляция реального пользователя
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  await page.setViewport({ width: 1280, height: 1080 });

  try {
    console.log(`[Scraper] Начинаю парсинг: ${showcase.url}`);
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
    const domainSlug = urlObj.hostname.replace(/\./g, "_");
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
            INSERT INTO parsing_runs (showcase_id, status, screenshot_path)
            VALUES (?, ?, ?)
        `,
      )
      .run(showcaseId, "success", `/screenshots/${screenshotName}`);

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

    // 3. Логика парсинга офферов (Cluster Match v5.0)
    const customSelector = showcase.custom_selector || '';
    const data = await page.evaluate((knownBrands, customSelector) => {
      const results = [];
      const keywords = ["займ", "деньги", "получить", "оформить", "взять", "заявку", "кредит", "на карту", "выплата", "выбрать", "подробнее", "бесплатно", "одобр"];
      const finTerms = ["сумма", "срок", "ставка", "процент", "дней", "руб"];
      
      // Известные партнерские домены для идентификации ссылок
      const affiliateDomains = [
        "leadgid.ru", "leads.su", "leads.tech", "pxl.leads.su", "t.leads.tech", 
        "go.leadgid.ru", "vldmnt.ru", "finlaba.ru", "trnsfx.ru", "credyi.ru", "ads.guruleads.ru"
      ];

      function isMoney(text) {
        const low = (text || "").toLowerCase().trim();
        return keywords.some((k) => low.includes(k)) || (low.length > 2 && low.length < 25 && (low.includes("одобр") || low.includes("выбр") || low.includes("подать")));
      }

      function isTrashName(text) {
        const low = (text || "").toLowerCase().trim();
        if (!low || low.length < 2) return true;
        // Числа и валюты - мусор для названия
        if (/^[0-9\s%рубдней.+-]+$/.test(low)) return true;
        if (low.startsWith("до ") || low.startsWith("от ")) return true;
        // Технические слова и заголовки колонок
        const stopWords = ["сумма", "срок", "ставка", "отзыв", "подробнее", "получить", "заявка", "logo", "выплата", "минуту", "руб", "дней", "процент", "без отказа", "онлайн", "на карту", "кредит", "займ"];
        if (stopWords.some(sw => low === sw || (low.includes(sw) && low.length < 15))) return true;
        // Технические строки
        if (/^[a-z]\s[a-f0-9]{10,}/.test(low)) return true;
        if (low.includes("logo") && /[a-z0-9]{5,}/.test(low)) return true;
        return false;
      }

      // 0. Анализ паттернов ссылок
      const allLinks = Array.from(document.querySelectorAll('a[href*="http"]'))
        .map((a) => {
          try {
            const url = new URL(a.href);
            return { hostname: url.hostname, href: a.href };
          } catch (e) { return null; }
        })
        .filter(Boolean);

      const domainCounts = {};
      allLinks.forEach((l) => (domainCounts[l.hostname] = (domainCounts[l.hostname] || 0) + 1));
      const topDomain = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

      const processedContainers = new Set();
      let targets = [];

      // 1. Кастомный селектор
      if (customSelector && customSelector.trim()) {
          try {
              const customElements = document.querySelectorAll(customSelector);
              if (customElements.length > 0) targets = Array.from(customElements);
          } catch(e) {}
      }

      // 2. Эвристика (кнопки и ссылки с призывом)
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
            for (let i = 0; i < 12; i++) {
              if (!curr || curr === document.body) break;

              const className = (curr.className || "").toString().toLowerCase();
              const rect = curr.getBoundingClientRect();
              const innerText = (curr.innerText || "").toLowerCase();

              const hasImg = curr.querySelector("img");
              const hasKnownBrand = knownBrands.some((b) => innerText.includes(b.toLowerCase()));
              const hasFinTerms = finTerms.filter((t) => innerText.includes(t)).length >= 1; // Снизил до 1
              const isCardClass = /card|offer|item|row|tile|product|block/.test(className);
              const isSignificant = rect.height > 40 && rect.width > 80;

              // Проверка ссылки: либо topDomain, либо любой из affiliateDomains
              const cardLinks = Array.from(curr.querySelectorAll('a[href*="http"]'));
              const hasAffLink = cardLinks.some(al => {
                  try {
                      const host = new URL(al.href).hostname;
                      return (topDomain && host === topDomain) || affiliateDomains.some(ad => host.includes(ad));
                  } catch(e) { return false; }
              });

              let factors = 0;
              if (isCardClass) factors++;
              if (hasKnownBrand) factors += 2;
              if (hasFinTerms) factors++;
              if (hasImg) factors++;
              if (hasAffLink) factors += 2;

              if (factors >= 2 && isSignificant) { // Порог снижен до 2 для большей охвата
                card = curr;
                break;
              }
              curr = curr.parentElement;
            }
        }

        if (card && !processedContainers.has(card)) {
          processedContainers.add(card);

          const imgs = Array.from(card.querySelectorAll("img"));
          const img = imgs.find(i => i.width > 20) || imgs[0];
          let name = "";

          // Извлечение имени
          // 1. ПРИОРИТЕТ: Из имени файла картинки (на Zyamer названия часто зашиты в src)
          if (img && img.src) {
              let srcName = img.src.split('/').pop().split('.')[0]
                  .replace(/[-_]/g, ' ')
                  .replace(/[0-9]+x[0-9]+/g, '') // Убираем размеры типа 150x150
                  .replace(/[0-9]{4}/g, '')      // Убираем года типа 2024
                  .trim();
              
              if (srcName && srcName.length > 2 && !isTrashName(srcName)) {
                  name = srcName;
              }
          }

          // 2. Если из файла не вышло, пробуем Альт
          if (!name && img) name = img.alt || img.title || "";
          
          if (!name || isTrashName(name)) {
            // Ищем в заголовках и болдах
            const heads = Array.from(card.querySelectorAll('h1, h2, h3, h4, b, strong, [class*="title"], [class*="name"]'));
            for (const h of heads) {
              const val = h.innerText.trim();
              if (val && !isTrashName(val)) { name = val; break; }
            }
          }

          if (!name || isTrashName(name)) {
            // Пробуем взять текст самой ссылки-кнопки (если там не мусор)
            const btnText = el.innerText.trim();
            if (btnText && !isMoney(btnText) && !isTrashName(btnText)) name = btnText;
          }

          // 3. НОВИНКА v5.3: Глубокое сопоставление по словарю (если другие методы не дали точного имени)
          if (!name || isTrashName(name) || name === "Offer") {
             const html = card.outerHTML.toLowerCase();
             for (const b of knownBrands) {
                 // Ищем только если название бренда достаточно длинное ( > 3 символов) чтобы избежать ложных срабатываний
                 if (b.length > 3 && html.includes(b.toLowerCase())) {
                     name = b;
                     break;
                 }
             }
          }

          // Если всё еще нет - ставим "Offer" и пусть бэкенд вынимает из ссылки
          if (!name || isTrashName(name)) name = "Offer";

          // Извлечение ссылки
          let href = (el.tagName === 'A') ? el.href : null;
          
          // Если кнопки/ссылки нет или она пустая, ищем ЛЮБУЮ внешнюю ссылку в карточке
          if (!href || href.includes('javascript') || href.endsWith('#') || href === window.location.href) {
              const allCardLinks = Array.from(card.querySelectorAll('a[href^="http"]'));
              const validAffLink = allCardLinks.find(al => {
                  try {
                      const host = new URL(al.href).hostname;
                      return host !== window.location.hostname && (topDomain && host === topDomain || affiliateDomains.some(ad => host.includes(ad)));
                  } catch(e) { return false; }
              });
              if (validAffLink) href = validAffLink.href;
          }

          if (href && href.startsWith('http')) {
              results.push({
                company_name: name.substring(0, 40).trim(),
                link: href,
                image_url: img?.src || null,
                placement_type: "main",
              });
          }
        }
      });

      // Дедупликация (но разрешаем "Offer" несколько раз, если ссылки разные)
      const final = [];
      const seenLinks = new Set();
      results.forEach((item) => {
        if (!seenLinks.has(item.link)) {
          seenLinks.add(item.link);
          final.push(item);
        }
      });

      return final;
    }, brandNames, customSelector);

    // --- DOUBLE LOGIC: FALLBACK V2 (OdobrenZaym & Co) ---
    let fallbackData = null;
    if (data.length === 0) {
      console.log(
        `[Scraper] Основной алгоритм (0 офферов). Запускаю Fallback (JSON + SimpleDOM)...`,
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
              json.offers_logo_base_url || "https://offers.credilead.ru/"; // Default base

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
        } catch (e) {
          /* Ignore JSON error */
        }

        // 2. SimpleDOM Fallback (Если JSON не сработал)
        // Ищем тупо по классам "card" или "item" и берем первую ссылку
        if (results.length === 0) {
          // 0. Если был задан кастомный селектор, но основной проход ничего не нашел (редко, но бывает)
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
                
                // Если ссыпа у самого контейнера
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

          // 2. SimpleDOM Fallback (Если JSON не сработал)
          // Ищем тупо по классам "card" или "item" и берем первую ссылку
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
        } // Closing the inner if (results.length === 0)

        return { results, method };
      }, customSelector);

      if (fallbackData.results && fallbackData.results.length > 0) {
        console.log(
          `[Scraper] Fallback спас ситуацию! Найдено: ${fallbackData.results.length}`,
        );
        data.push(...fallbackData.results);
      }
    }

    console.log(`[Scraper] Парсинг завершен. Найдено карточек: ${data.length}`);

    // Определяем метод парсинга
    let parsingMethod = null;
    // Проверяем, использовался ли fallback (данные были добавлены из fallback)
    const usedFallback = fallbackData && fallbackData.results && fallbackData.results.length > 0;
    
    if (usedFallback && fallbackData.method) {
      // Если использовался fallback
      parsingMethod = fallbackData.method;
    } else if (data.length > 0) {
      // Если основной алгоритм дал результаты
      if (customSelector && customSelector.trim()) {
        parsingMethod = "DOM (Custom Selector)";
      } else {
        parsingMethod = "DOM (Cluster Match v4.0)";
      }
    }

    // Обновляем запись с методом парсинга
    if (parsingMethod) {
      try {
        db.prepare(
          `UPDATE parsing_runs SET parsing_method = ? WHERE id = ?`
        ).run(parsingMethod, runId);
      } catch (e) {
        // Если колонка не существует, просто игнорируем ошибку
        console.warn('[Scraper] Не удалось сохранить метод парсинга:', e.message);
      }
    }

    // Отладка для Sravni
    if (isSravni && data.length === 0) {
      console.warn(
        `[Scraper] ВНИМАНИЕ: Sravni.ru вернул 0 офферов! Возможно, контент загружается через iframe или требуется больше времени.`,
      );
    }

    const insertOffer = db.prepare(`
            INSERT INTO offer_stats (run_id, position, company_name, link, image_url, placement_type)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

    data.forEach((offer, index) => {
      const normalizedName = NormalizationService.normalize(
        offer.company_name,
        offer.link,
      );
      insertOffer.run(
        runId,
        index + 1,
        normalizedName,
        offer.link,
        offer.image_url,
        offer.placement_type,
      );
    });

    return { success: true, count: data.length };
  } catch (error) {
    console.error(
      `Ошибка при парсинге ${showcase.url} (Attempt ${retryCount + 1}):`,
      error.message,
    );

    // Авто-рестарт при "detached frame" или таймлауте (макс 2 попытки)
    if (
      retryCount < 1 &&
      (error.message.includes("detached") || error.message.includes("timeout"))
    ) {
      console.log(`[Scraper] Обнаружена критическая ошибка, пробую еще раз...`);
      await browser.close();
      return parseShowcase(showcaseId, retryCount + 1);
    }

    db.prepare(
      `
            INSERT INTO parsing_runs (showcase_id, status, error_message)
            VALUES (?, ?, ?)
        `,
    ).run(showcaseId, "error", error.message);
    return { success: false, error: error.message };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { parseShowcase };
