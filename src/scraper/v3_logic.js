const { NormalizationService, BRAND_ALIASES } = require("../services/normalization");

/**
 * Логика парсинга v3.0 (Pattern Match)
 * Реализует 6 этапов поиска для максимальной точности.
 */
async function parseV3(page, browser, config) {
    const { brandNames, brandAliases, allAliasesMap, version } = config;
    const currentHost = new URL(page.url()).hostname;
    const topDomain = currentHost.split('.').slice(-2).join('.');
    const affiliateDomains = ['leads.su', 'leadgid.ru', 'pdl-profit.com', 'guruleads.ru', 'leadsid.ru', 'leadprofit.pro'];

    console.log(`[Scraper v3.0] Запуск расширенного алгоритма...`);

    // 1. JSON & Scripts Scan
    const jsonData = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"], script:not([src])'));
        for (const script of scripts) {
            try {
                const content = script.innerText;
                if (content.includes('company') || content.includes('offers') || content.includes('brand')) {
                    // Ищем массивы объектов, похожих на офферы
                    const match = content.match(/\[\s*\{.*\}\s*\]/s);
                    if (match) {
                        const data = JSON.parse(match[0]);
                        if (Array.isArray(data) && data.length > 3) {
                            return data;
                        }
                    }
                }
            } catch (e) {}
        }
        return null;
    });

    if (jsonData) {
        console.log(`[Scraper v3.0] Обнаружены структурированные данные (JSON/Script)!`);
        // Здесь можно было бы обработать JSON, но для надежности объединим его с визуальным парсингом ниже
    }

    // Основной сбор данных через визуальные паттерны
    const rawOffers = await page.evaluate((brandAliases, allAliasesMap, currentHost, topDomain, affiliateDomains) => {
        const finTerms = ['руб', 'день', 'ставка', 'бесплатно', 'сумма', 'срок'];
        const actionWords = ['оформить', 'получить', 'взять', 'заявка', 'занять'];
        
        const results = [];
        const processedContainers = new Set();

        // Поиск всех элементов, которые могут быть кнопками или ссылками действий
        const potentialActions = Array.from(document.querySelectorAll('a, button, [role="button"], .btn'))
            .filter(el => {
                const text = (el.innerText || "").toLowerCase();
                return actionWords.some(w => text.includes(w));
            });

        potentialActions.forEach(el => {
            // Ищем контейнер-карточку (Пункт 2: Card Pattern)
            let card = null;
            let curr = el;
            for (let i = 0; i < 10; i++) {
                if (!curr || curr === document.body) break;
                
                const style = window.getComputedStyle(curr);
                const rect = curr.getBoundingClientRect();
                const text = curr.innerText.toLowerCase();
                
                // Признаки карточки:
                const hasMoney = text.includes('руб') || /\d+\s*000/.test(text);
                const hasDays = text.includes('дн') || text.includes('день');
                const hasActions = actionWords.filter(w => text.includes(w)).length >= 1;
                const isSignif = rect.height > 80 && rect.width > 150;
                const hasBorderOrShadow = style.borderWidth !== '0px' || style.boxShadow !== 'none';

                if (isSignif && hasActions && (hasMoney || hasDays || hasBorderOrShadow)) {
                    card = curr;
                    // Не прерываемся сразу, ищем самый внешний подходящий блок
                }
                curr = curr.parentElement;
            }

            if (card && !processedContainers.has(card)) {
                processedContainers.add(card);
                
                // --- СБОР ИНФОРМАЦИИ ИЗ КАРТОЧКИ ---
                const cardText = card.innerText;
                const cardTextLow = cardText.toLowerCase();

                // Пункт 3: Brand Base Alignment (Сверка со списком)
                let foundBrand = null;
                for (const [brand, aliases] of Object.entries(allAliasesMap)) {
                    if (aliases.some(a => cardTextLow.includes(a.toLowerCase()))) {
                        foundBrand = brand;
                        break;
                    }
                }

                // Пункт 4: Meta-Data (Alt/Title)
                let metaName = null;
                const imgs = Array.from(card.querySelectorAll('img'));
                for (const img of imgs) {
                    const alt = (img.alt || img.title || "").toLowerCase();
                    if (alt && alt.length > 2) {
                        // Тоже сверяем со списком
                        for (const [brand, aliases] of Object.entries(allAliasesMap)) {
                            if (aliases.some(a => alt.includes(a.toLowerCase()))) {
                                metaName = brand;
                                break;
                            }
                        }
                    }
                    if (metaName) break;
                }

                // Пункт 5: Analytics Targets (Метрика)
                let analyticsName = null;
                const analyticsElements = Array.from(card.querySelectorAll('[onclick], a[href*="click"], a[href*="jump"]'));
                for (const ae of analyticsElements) {
                    const attr = (ae.getAttribute('onclick') || ae.href || "").toLowerCase();
                    if (attr.includes('reachgoal') || attr.includes('click') || attr.includes('jump')) {
                        // Ищем упоминание бренда в коде цели
                        for (const [brand, aliases] of Object.entries(allAliasesMap)) {
                            if (aliases.some(a => attr.includes(a.toLowerCase()))) {
                                analyticsName = brand;
                                break;
                            }
                        }
                    }
                    if (analyticsName) break;
                }

                // Ссылка
                let link = el.tagName === 'A' ? el.href : null;
                if (!link || link.includes('javascript') || link === window.location.href) {
                    const anyLink = card.querySelector('a[href^="http"]:not([href*="' + currentHost + '"])');
                    if (anyLink) link = anyLink.href;
                }

                results.push({
                    raw_name: (foundBrand || metaName || analyticsName || "Unknown"),
                    original_text: cardText.substring(0, 100),
                    link: link,
                    img: (imgs[0] ? imgs[0].src : null),
                    is_recognized: !!(foundBrand || metaName || analyticsName)
                });
            }
        });

        return results;
    }, brandAliases, allAliasesMap, currentHost, topDomain, affiliateDomains);

    // Пункт 6: Deep Redirect & Meta Resolve
    const finalResults = [];
    for (let i = 0; i < rawOffers.length; i++) {
        const item = rawOffers[i];
        let brandName = item.raw_name;

        // Если бренд не распознан — пробуем редирект
        if (brandName === "Unknown" && item.link && item.link.startsWith('http')) {
            console.log(`[Scraper v3.0] Редирект для неизвестного оффера #${i+1}...`);
            const redirectedBrand = await resolveBrandFromRedirectV3(browser, item.link);
            if (redirectedBrand) {
                // Пытаемся нормализовать через сервис
                const normalized = NormalizationService.normalize(redirectedBrand);
                if (normalized !== redirectedBrand) {
                    brandName = normalized;
                } else {
                    // Если сервис не узнал, но мы получили чистое имя из титула — сохраним его как сырое
                    brandName = redirectedBrand;
                }
            }
        }

        finalResults.push({
            company_name: brandName,
            link: item.link || "#unknown",
            image_url: item.img,
            position: i + 1,
            is_recognized: brandName !== "Unknown" && !brandName.includes('#unknown')
        });
    }

    return finalResults;
}

/**
 * Расширенный Redirect Resolve для v3.0
 */
async function resolveBrandFromRedirectV3(browser, url) {
    let page = null;
    try {
        page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});

        const meta = await page.evaluate(() => {
            const title = document.title || "";
            const h1 = document.querySelector('h1')?.innerText || "";
            const metaOg = document.querySelector('meta[property="og:title"]')?.content || "";
            return { title, h1, metaOg };
        });

        await page.close();

        // Очистка названия
        const candidates = [meta.title, meta.h1, meta.metaOg].filter(c => c && c.length > 2);
        for (let text of candidates) {
            let clean = text.split(/[|-|—]/)[0]
                .replace(/(занять|займ|кредит|банк|официальный|сайт|вход|кабинет|онлайн|мфо|мкк)/gi, "")
                .trim();
            if (clean.length > 2) return clean;
        }
    } catch (e) {
        if (page) await page.close();
    }
    return null;
}

module.exports = { parseV3 };
