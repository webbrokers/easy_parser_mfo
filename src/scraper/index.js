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

        // 3. Логика парсинга офферов (Container-Based Logic v3.0 - "Smart Card Detector")
        const data = await page.evaluate(() => {
            const results = [];
            const keywords = ['займ', 'деньги', 'получить', 'оформить', 'взять', 'заявку', 'отправить', 'кредит', 'на карту', 'выплата', 'микрозайм', 'заполнить'];
            const stopWords = ['получить деньги', 'оформить заявку', 'взять займ', 'подробнее', 'подать заявку', 'получить на карту', 'выплата', 'деньги на карту', 'сумма', 'срок', 'ставка', 'одобрение', 'заявка'];
            
            function isMoney(text) {
                const low = (text || "").toLowerCase().trim();
                return keywords.some(k => low.includes(k));
            }

            function isTrashName(text) {
                const low = (text || "").toLowerCase().trim();
                if (!low || low.length < 2) return true;
                if (stopWords.some(s => low === s || low.includes(s) && low.length < 20)) return true;
                if (/^[0-9\s%рубдней.]+$/.test(low)) return true; // Только цифры, валюты, знаки
                if (low.startsWith('до ') || low.startsWith('от ')) return true; // Суммы
                return false;
            }

            const processedContainers = new Set();
            
            // 1. Ищем все ссылки и элементы, которые выглядят как кнопки
            const targets = Array.from(document.querySelectorAll('a, button, [role="button"], .btn, .button'));
            
            targets.forEach(el => {
                const text = el.innerText || el.textContent || "";
                
                if (isMoney(text)) {
                    // Ищем контейнер карточки
                    let card = null;
                    let curr = el;
                    
                    for (let i = 0; i < 10; i++) {
                        if (!curr || curr === document.body) break;
                        
                        const className = (curr.className || "").toString().toLowerCase();
                        const tagName = curr.tagName.toLowerCase();
                        const rect = curr.getBoundingClientRect();
                        
                        // Признак карточки: класс содержит card/offer/item или это ссылка-обертка с картинкой
                        const isCardClass = className.includes('card') || className.includes('offer') || className.includes('item');
                        const hasImg = curr.querySelector('img');
                        const isSignificant = rect.height > 80 && rect.width > 120;

                        if ((isCardClass || (tagName === 'a' && hasImg)) && isSignificant) {
                            card = curr;
                            // Если нашли явный класс из примеров пользователя, останавливаемся сразу
                            if (className.includes('lightweightcardview_container')) break;
                            if (className.includes('offer_usp_inside')) break;
                        }
                        curr = curr.parentElement;
                    }

                    if (card && !processedContainers.has(card)) {
                        processedContainers.add(card);
                        
                        const img = card.querySelector('img');
                        let name = "";

                        // -- Извлекаем название МФО --
                        // 1. Из альта картинки
                        if (img) name = img.alt || img.title || "";
                        
                        // 2. Из имени файла картинки (часто там бренд)
                        if (img && (!name || isTrashName(name))) {
                            const src = img.src || "";
                            const fileName = src.split('/').pop().split('.')[0].replace(/[-_]/g, ' ');
                            if (fileName.length > 3 && !isTrashName(fileName)) name = fileName;
                        }

                        // 3. Из заголовков внутри
                        if (!name || isTrashName(name)) {
                            const heads = Array.from(card.querySelectorAll('h1, h2, h3, h4, b, strong, [class*="title"], [class*="name"]'));
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
                            const allText = card.innerText.split('\n').map(t => t.trim()).filter(t => t.length > 2);
                            name = allText.find(t => !isTrashName(t)) || "Offer";
                        }

                        // Финальная очистка
                        name = name.split(/[.,!?;|]/)[0].substring(0, 35).trim();
                        if (isTrashName(name)) name = "Offer";

                        const href = el.href || el.getAttribute('href') || card.href || card.getAttribute('href') || "";
                        const finalLink = href.startsWith('http') ? href : window.location.origin + (href.startsWith('/') ? href : '/' + href);

                        results.push({
                            company_name: name,
                            link: finalLink,
                            image_url: img?.src || null,
                            placement_type: 'main'
                        });
                    }
                }
            });

            // Дедупликация по имени МФО
            const final = [];
            const seen = new Set();
            results.forEach(item => {
                const key = item.company_name.toLowerCase();
                if (!seen.has(key) && item.company_name !== "Offer") {
                    seen.add(key);
                    final.push(item);
                }
            });

            return final;
        });

        console.log(`[Scraper] Парсинг завершен. Найдено карточек: ${data.length}`);

        const { NormalizationService } = require('../services/normalization');
        const insertOffer = db.prepare(`
            INSERT INTO offer_stats (run_id, position, company_name, link, image_url, placement_type)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        data.forEach((offer, index) => {
            const normalizedName = NormalizationService.normalize(offer.company_name, offer.link);
            insertOffer.run(runId, index + 1, normalizedName, offer.link, offer.image_url, offer.placement_type);
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
