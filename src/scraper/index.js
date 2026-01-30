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
        console.log(`Начинаю парсинг: ${showcase.url}`);
        await page.goto(showcase.url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Генерация имени скриншота в формате: site_tld_YYYY-MM-DD_HH-mm.png
        const urlObj = new URL(showcase.url);
        const domainSlug = urlObj.hostname.replace(/\./g, '_');
        const timestamp = DateTime.now().toFormat('yyyy-MM-dd_HH-mm');
        const screenshotName = `${domainSlug}_${timestamp}.png`;
        
        const screenshotPath = path.join(__dirname, '../../public/screenshots', screenshotName);
        
        // Создаем папку, если её нет
        const screenshotDir = path.dirname(screenshotPath);
        if (!fs.existsSync(screenshotDir)) {
            fs.mkdirSync(screenshotDir, { recursive: true });
        }

        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch (e) {
            console.error('Не удалось сделать скриншот:', e.message);
        }

        // Лог запуска
        const runResult = db.prepare(`
            INSERT INTO parsing_runs (showcase_id, status, screenshot_path)
            VALUES (?, ?, ?)
        `).run(showcaseId, 'success', `/screenshots/${screenshotName}`);
        
        const runId = runResult.lastInsertRowid;

        // Логика парсинга офферов
        const offers = await page.evaluate(() => {
            const results = [];
            const keywords = ['деньги', 'заявку', 'получить', 'оформить', 'взять', 'займ', 'кредит', 'на карту', 'выплата'];
            
            function isMoneyLink(el) {
                const text = (el.textContent || el.innerText || '').toLowerCase();
                return keywords.some(k => text.includes(k));
            }

            // 1. Поиск в попапах / плавающих блоках (B1, B2...)
            const popupSelectors = ['.popup', '.modal', '.banner', '[class*="sticky"]', '[id*="popup"]', '[class*="modal"]'];
            let bIndex = 1;
            
            popupSelectors.forEach(selector => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                    const links = Array.from(el.querySelectorAll('a, button'));
                    links.forEach(link => {
                        if (isMoneyLink(link)) {
                            const img = el.querySelector('img');
                            results.push({
                                position: bIndex,
                                company_name: img?.alt || el.innerText.split('\n')[0].trim() || "Banner Offer",
                                link: link.href || link.onclick?.toString() || "#",
                                image_url: img?.src || null,
                                placement_type: `b${bIndex++}`
                            });
                        }
                    });
                });
            });

            // 2. Поиск в основном контенте
            const offerBlocks = document.querySelectorAll('.offer-item, .card, .row, div[class*="offer"], div[class*="item"], div[class*="mfo"]');
            let mainPos = 1;

            if (offerBlocks.length > 0) {
                offerBlocks.forEach(block => {
                    const links = Array.from(block.querySelectorAll('a'));
                    const moneyLink = links.find(l => isMoneyLink(l));
                    
                    if (moneyLink) {
                        const img = block.querySelector('img');
                        results.push({
                            position: mainPos++,
                            company_name: img?.alt || block.textContent.split('\n').map(s => s.trim()).filter(s => s.length > 2)[0] || "Offer",
                            link: moneyLink.href,
                            image_url: img?.src || null,
                            placement_type: 'main'
                        });
                    }
                });
            }

            // 3. Фоллбек: если ничего не нашли или нашли мало, ищем по всем ссылкам
            if (results.length < 2) {
                const allLinks = Array.from(document.querySelectorAll('a'));
                allLinks.forEach(link => {
                    if (isMoneyLink(link) && link.href.includes('http')) {
                        // Пытаемся найти родительский контейнер
                        let parent = link.parentElement;
                        for (let i = 0; i < 3; i++) {
                            if (!parent) break;
                            const text = parent.textContent.length;
                            if (text > 20 && text < 1000) break;
                            parent = parent.parentElement;
                        }
                        
                        const img = parent?.querySelector('img');
                        const alreadyFound = results.some(r => r.link === link.href);
                        
                        if (!alreadyFound) {
                            results.push({
                                position: mainPos++,
                                company_name: img?.alt || link.textContent.trim() || "Unknown",
                                link: link.href,
                                image_url: img?.src || null,
                                placement_type: 'main'
                            });
                        }
                    }
                });
            }

            return results;
        });

        console.log(`[Scraper] Найдено офферов: ${offers.length}`);

        // Сохранение в БД
        const insertOffer = db.prepare(`
            INSERT INTO offer_stats (run_id, position, company_name, link, image_url, placement_type)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        for (const offer of offers) {
            insertOffer.run(
                runId,
                offer.position,
                offer.company_name,
                offer.link,
                offer.image_url,
                offer.placement_type
            );
        }

        console.log(`Успешно спарсено ${offers.length} офферов для ${showcase.url}`);
        return { success: true, count: offers.length };

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
