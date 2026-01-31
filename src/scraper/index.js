const puppeteer = require('puppeteer');
const db = require('../db/schema');
const { DateTime } = require('luxon');
const path = require('path');
const fs = require('fs');

async function parseShowcase(showcaseId) {
    const showcase = db.prepare('SELECT * FROM showcases WHERE id = ?').get(showcaseId);
    if (!showcase) throw new Error('Showcase not found');

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    // Эмуляция реального пользователя
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 1080 });

    try {
        console.log(`[Scraper] Начинаю парсинг: ${showcase.url}`);
        await page.goto(showcase.url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // 1. Ждем немного для прогрузки JS-виджетов
        await new Promise(r => setTimeout(r, 4000));

        // 2. Эмуляция прокрутки (триггер ленивой загрузки)
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                let distance = 300;
                let timer = setInterval(() => {
                    let scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if(totalHeight >= scrollHeight || totalHeight > 5000){
                        clearInterval(timer);
                        window.scrollTo(0, 0);
                        resolve();
                    }
                }, 100);
            });
        });

        // Генерация имени скриншота
        const urlObj = new URL(showcase.url);
        const domainSlug = urlObj.hostname.replace(/\./g, '_');
        const timestamp = DateTime.now().toFormat('yyyy-MM-dd_HH-mm');
        const screenshotName = `${domainSlug}_${timestamp}.png`;
        const screenshotPath = path.join(__dirname, '../../public/screenshots', screenshotName);
        
        const screenshotDir = path.dirname(screenshotPath);
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch (e) { console.error('Screen error:', e.message); }

        const runResult = db.prepare(`
            INSERT INTO parsing_runs (showcase_id, status, screenshot_path)
            VALUES (?, ?, ?)
        `).run(showcaseId, 'success', `/screenshots/${screenshotName}`);
        
        const runId = runResult.lastInsertRowid;

        // 3. Логика парсинга офферов (Container-Based Logic v2.0)
        const data = await page.evaluate(() => {
            const results = [];
            const keywords = ['займ', 'деньги', 'получить', 'оформить', 'взять', 'заявку', 'отправить', 'кредит', 'на карту', 'выплата', 'микрозайм'];
            const stopWords = ['получить деньги', 'оформить заявку', 'взять займ', 'подробнее', 'подать заявку', 'получить на карту', 'выплата', 'деньги на карту'];
            
            function hasKeyword(text) {
                const low = (text || "").toLowerCase().trim();
                return keywords.some(k => low.includes(k));
            }

            function isStopWord(text) {
                const low = (text || "").toLowerCase().trim();
                return stopWords.some(s => low === s || low.includes(s) && low.length < 20);
            }

            const processedContainers = new Set();
            const actionElements = Array.from(document.querySelectorAll('a, button, [role="button"], .btn, .button'));
            
            actionElements.forEach(el => {
                const text = el.innerText || el.textContent || "";
                const href = el.href || el.getAttribute('href') || "";
                
                // Если это кнопка или ссылка с целевым действием
                if (hasKeyword(text) && (href.length > 3 || el.tagName === 'BUTTON')) {
                    // Ищем контейнер карточки (проходим вверх до 8 уровней)
                    let container = el.parentElement;
                    let foundCard = null;
                    
                    for (let i = 0; i < 8; i++) {
                        if (!container) break;
                        // Признаки карточки: наличие картинки и определенного размера, или специфичные классы
                        const hasImg = container.querySelector('img');
                        const rect = container.getBoundingClientRect();
                        const isCardLike = rect.height > 80 && rect.width > 150;
                        
                        // Если в контейнере есть картинка и он похож на карточку
                        if (hasImg && isCardLike) {
                            foundCard = container;
                            // Если нашли контейнер с явным классом "card" или "offer", берем его как финальный
                            if (container.className.toLowerCase().includes('card') || container.className.toLowerCase().includes('offer')) break;
                        }
                        container = container.parentElement;
                    }

                    const card = foundCard || el.parentElement;
                    if (processedContainers.has(card)) return;
                    processedContainers.add(card);

                    // --- Извлечение данных из карточки ---
                    const img = card.querySelector('img');
                    let companyName = "";

                    // 1. Пытаемся взять имя из логотипа (самый надежный способ)
                    if (img) {
                        companyName = img.alt || img.title || "";
                    }

                    // 2. Если в логотипе пусто, ищем заголовки или жирный текст
                    if (!companyName || isStopWord(companyName)) {
                        const headings = Array.from(card.querySelectorAll('h1, h2, h3, h4, h5, h6, b, strong, [class*="title"], [class*="name"]'));
                        for (const h of headings) {
                            const val = h.innerText.trim();
                            if (val && !isStopWord(val) && val.length > 2 && val.length < 40) {
                                companyName = val;
                                break;
                            }
                        }
                    }

                    // 3. Крайний случай - берем первую строку текста, которая не является стоп-словом
                    if (!companyName || isStopWord(companyName)) {
                        const lines = card.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 2);
                        companyName = lines.find(l => !isStopWord(l)) || "Offer";
                    }

                    // Чистка финального имени
                    companyName = companyName.split(/[.,!?;|]/)[0].substring(0, 40).trim();
                    if (isStopWord(companyName)) companyName = "Offer";

                    const finalLink = href.startsWith('http') ? href : window.location.origin + (href.startsWith('/') ? href : '/' + href);

                    results.push({
                        company_name: companyName,
                        link: finalLink,
                        image_url: img?.src || null,
                        placement_type: 'main'
                    });
                }
            });

            // Финальная фильтрация: убираем дубли по имени и те, где имя осталось стоп-словом
            const finalData = [];
            const seen = new Set();
            results.forEach(item => {
                const key = item.company_name.toLowerCase();
                if (!seen.has(key) && item.company_name !== "Offer") {
                    seen.add(key);
                    finalData.push(item);
                }
            });

            return finalData;
        });

        console.log(`[Scraper] Финальный результат: ${data.length} офферов для ${showcase.url}`);

        const insertOffer = db.prepare(`
            INSERT INTO offer_stats (run_id, position, company_name, link, image_url, placement_type)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        data.forEach((offer, index) => {
            insertOffer.run(runId, index + 1, offer.company_name, offer.link, offer.image_url, offer.placement_type);
        });

        return { success: true, count: data.length };

    } catch (error) {
        console.error(`Ошибка при парсинге ${showcase.url}:`, error);
        db.prepare(`
            INSERT INTO parsing_runs (showcase_id, status, error_message)
            VALUES (?, ?, ?)
        `).run(showcaseId, 'error', error.message);
        return { success: false, error: error.message };
    } finally {
        await browser.close();
    }
}

module.exports = { parseShowcase };
