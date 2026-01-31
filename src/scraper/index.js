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
    await new Promise((r) => setTimeout(r, 4000));

    // 2. Эмуляция прокрутки (триггер ленивой загрузки)
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        let distance = 300;
        let timer = setInterval(() => {
          let scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight || totalHeight > 5000) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 100);
      });
    });

    // 2.5 КРИТИЧНО: Даем время на выполнение JS-редиректов и подмену ссылок
    console.log(`[Scraper] Ожидание загрузки JS-редиректов...`);
    await new Promise((r) => setTimeout(r, 3000));

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
      // Проверяем высоту страницы
      const pageHeight = await page.evaluate(() => document.body.scrollHeight);

      if (pageHeight > 10000) {
        // Очень длинная страница — делаем viewport скриншот
        console.warn(
          `[Scraper] Страница слишком длинная (${pageHeight}px), делаю viewport скриншот`,
        );
        await page.screenshot({ path: screenshotPath, fullPage: false });
      } else {
        // Нормальная страница — fullPage с таймаутом 10 сек
        await page.screenshot({
          path: screenshotPath,
          fullPage: true,
          timeout: 10000, // 10 секунд — если дольше, то глобальная проблема
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

    // 3. Логика парсинга офферов (Cluster Match v4.0)
    const customSelector = showcase.custom_selector || '';
    const data = await page.evaluate((knownBrands, customSelector) => {
      const results = [];
      const keywords = [
        "займ",
        "деньги",
        "получить",
        "оформить",
        "взять",
        "заявку",
        "отправить",
        "кредит",
        "на карту",
        "выплата",
        "микрозайм",
        "заполнить",
        "выбрать",
        "узнать",
        "подробнее",
        "подать",
        "бесплатно",
        "инфо",
      ];
      const finTerms = ["сумма", "срок", "ставка", "процент", "дней", "руб"];
      const stopWords = [
        "получить деньги",
        "оформить заявку",
        "взять займ",
        "подробнее",
        "подать заявку",
        "получить на карту",
        "выплата",
        "деньги на карту",
        "сумма",
        "срок",
        "ставка",
        "одобрение",
        "заявка",
      ];

      function isMoney(text) {
        const low = (text || "").toLowerCase().trim();
        // Для Sravni и Zyamer учитываем более короткие кнопки
        return (
          keywords.some((k) => low.includes(k)) ||
          (low.length > 2 &&
            low.length < 20 &&
            (low.includes("одобр") || low.includes("выбр")))
        );
      }

      function isTrashName(text) {
        const low = (text || "").toLowerCase().trim();
        if (!low || low.length < 2) return true;
        if (
          stopWords.some(
            (s) => low === s || (low.includes(s) && low.length < 20),
          )
        )
          return true;
        if (/^[0-9\s%рубдней.]+$/.test(low)) return true; // Только цифры, валюты, знаки
        if (low.startsWith("до ") || low.startsWith("от ")) return true; // Суммы

        // Фильтр для мусорных имен из файлов (хеши, длинные ID)
        // Пример: "n 56cd8a16afda9", "logo moneza e175...", "ekva e175..."
        if (/^[a-z]\s[a-f0-9]{10,}/.test(low)) return true;
        if (low.includes("logo") && /[a-z0-9]{5,}/.test(low)) return true;
        if (low.length > 15 && !/[а-яА-ЯёЁ]/.test(low) && /[0-9]{3,}/.test(low))
          return true; // Длинные латинские строки с цифрами без кириллицы

        return false;
      }

      // 0. Анализ паттернов ссылок
      const allLinks = Array.from(document.querySelectorAll('a[href*="http"]'))
        .map((a) => {
          try {
            return new URL(a.href).hostname;
          } catch (e) {
            return null;
          }
        })
        .filter((h) => h && h !== window.location.hostname);

      const domainCounts = {};
      allLinks.forEach((d) => (domainCounts[d] = (domainCounts[d] || 0) + 1));
      const topDomain = Object.entries(domainCounts).sort(
        (a, b) => b[1] - a[1],
      )[0]?.[0];

      const processedContainers = new Set();
      // const customSelector = '${showcase.custom_selector || ''}'; // Removed: causing syntax error
      // customSelector passed as argument

      let targets = [];

      // 1. Если задан пользовательский селектор, используем его
      if (customSelector && customSelector.trim()) {
          try {
              const customElements = document.querySelectorAll(customSelector);
              if (customElements.length > 0) {
                  // Превращаем NodeList в массив и помечаем как "карточки"
                  targets = Array.from(customElements);
                  console.log('Using custom selector:', customSelector, 'Found:', targets.length);
              }
          } catch(e) {
              console.error('Invalid custom selector:', customSelector);
          }
      }

      // 2. Если селектор не дал результатов или не задан, используем эвристику
      if (targets.length === 0) {
          targets = Array.from(
            document.querySelectorAll(
              'a, button, [role="button"], .btn, .button, span, div',
            ),
          ).filter((el) => {
            const txt = el.innerText || "";
            return txt.length > 2 && txt.length < 30 && isMoney(txt);
          });
      }

      targets.forEach((el) => {
        // Ищем контейнер карточки
        let card = null;

        // Если это элементы по кастомному селектору, то они сами и есть карточки (или их прямые контейнеры)
        if (customSelector && customSelector.trim()) {
             card = el;
        } else {
            // Иначе ищем родителя-карточку
            let curr = el;
            for (let i = 0; i < 12; i++) {
              if (!curr || curr === document.body) break;

              const className = (curr.className || "").toString().toLowerCase();
              const rect = curr.getBoundingClientRect();
              const innerText = (curr.innerText || "").toLowerCase();

              // Критерии Cluster Match
              const hasImg = curr.querySelector("img");
              const hasKnownBrand = knownBrands.some((b) =>
                innerText.includes(b.toLowerCase()),
              );
              const hasFinTerms =
                finTerms.filter((t) => innerText.includes(t)).length >= 2;
              const isCardClass =
                className.includes("card") ||
                className.includes("offer") ||
                className.includes("item") ||
                className.includes("row") ||
                className.includes("tile");
              const isSignificant = rect.height > 60 && rect.width > 100;

              // Анализ ссылки
              const cardLink = curr.querySelector('a[href*="http"]');
              const hasAffLink =
                cardLink && topDomain && cardLink.href.includes(topDomain);

              let factors = 0;
              if (isCardClass) factors++;
              if (hasKnownBrand) factors += 2;
              if (hasFinTerms) factors++;
              if (hasImg) factors++;
              if (hasAffLink) factors += 2;

              // Понижаем порог для Zyamer, если есть сильные маркеры
              if (
                (factors >= 3 || (hasKnownBrand && factors >= 2)) &&
                isSignificant
              ) {
                card = curr;
                break;
              }
              curr = curr.parentElement;
            }
        }

        if (card && !processedContainers.has(card)) {
          processedContainers.add(card);

          const img = card.querySelector("img");
          let name = "";

          // -- Извлекаем название МФО --
          // 1. Из альта картинки
          if (img) name = img.alt || img.title || "";

          // 2. Из имени файла картинки (часто там бренд)
          if (img && (!name || isTrashName(name))) {
            const src = img.src || "";
            const fileName = src
              .split("/")
              .pop()
              .split(".")[0]
              .replace(/[-_]/g, " ");
            if (fileName.length > 3 && !isTrashName(fileName)) name = fileName;
          }

          // 3. Из заголовков внутри
          if (!name || isTrashName(name)) {
            const heads = Array.from(
              card.querySelectorAll(
                'h1, h2, h3, h4, b, strong, [class*="title"], [class*="name"]',
              ),
            );
            for (const h of heads) {
              const val = h.innerText.trim();
              if (val && !isTrashName(val)) {
                name = val;
                break;
              }
            }
          }

          // 4. Из всех текстов (первое не-мусорное)
          if (!name || isTrashName(name)) {
            const allText = card.innerText
              .split("\n")
              .map((t) => t.trim())
              .filter((t) => t.length > 2);
            name = allText.find((t) => !isTrashName(t)) || "Offer";
          }

          // Финальная очистка
          name = name
            .split(/[.,!?;|]/)[0]
            .substring(0, 35)
            .trim();
          if (isTrashName(name)) name = "Offer";

          // Исправленное извлечение ссылки
          let href = el.getAttribute('href');
          
          // Если у триггера нет ссылки, ищем внутри карточки
          if (!href || href === '#' || href.startsWith('javascript')) {
              const innerLink = card.querySelector('a[href^="http"], a[href^="/"]');
              if (innerLink) href = innerLink.getAttribute('href');
          }
          
          // Если все еще нет, пробуем у самой карточки
          if (!href) href = card.getAttribute('href');

           // Формируем абсолютный URL
          let finalLink = "";
          if (href) {
              if (href.startsWith('http')) finalLink = href;
              else if (href.startsWith('/')) finalLink = window.location.origin + href;
              else finalLink = window.location.origin + '/' + href;
          } else {
               // Если ссылки совсем нет, пропускаем (чтобы не спамить заглушками)
               finalLink = null; 
          }
          
          if (!finalLink) return; // Skip invalid links

          results.push({
            company_name: name,
            link: finalLink,
            image_url: img?.src || null,
            placement_type: "main",
          });
        }
      });

      // Дедупликация по имени МФО
      const final = [];
      const seen = new Set();
      results.forEach((item) => {
        const key = item.company_name.toLowerCase();
        if (!seen.has(key) && item.company_name !== "Offer") {
          seen.add(key);
          final.push(item);
        }
      });

      return final;
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
      db.prepare(
        `UPDATE parsing_runs SET parsing_method = ? WHERE id = ?`
      ).run(parsingMethod, runId);
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
