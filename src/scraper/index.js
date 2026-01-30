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
        await page.screenshot({ path: screenshotPath, fullPage: true });

        // Лог запуска
        const runResult = db.prepare(`
            INSERT INTO parsing_runs (showcase_id, status, screenshot_path)
            VALUES (?, ?, ?)
        `).run(showcaseId, 'success', `/screenshots/${screenshotName}`);
        
        const runId = runResult.lastInsertRowid;

        // Логика парсинга офферов
        const offers = await page.evaluate(() => {
            const results = [];
            
            // 1. Поиск в попапах / плавающих блоках (B1, B2...)
            // Часто у них есть классы popup, modal, banner, sticky
            const popupSelectors = ['.popup', '.modal', '.banner', '[class*="sticky"]', '[id*="popup"]'];
            let bIndex = 1;
            
            popupSelectors.forEach(selector => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                    const links = el.querySelectorAll('a');
                    links.forEach(link => {
                        const text = link.innerText.toLowerCase();
                        if (text.includes('деньги') || text.includes('заявку') || text.includes('получить')) {
                            const img = el.querySelector('img');
                            results.push({
                                position: bIndex,
                                company_name: img?.alt || el.innerText.split('\n')[0] || "Banner Offer",
                                link: link.href,
                                image_url: img?.src || null,
                                placement_type: `b${bIndex++}`
                            });
                        }
                    });
                });
            });

            // 2. Поиск в основном контенте
            const offerBlocks = document.querySelectorAll('.offer-item, .card, .row, div[class*="offer"]');
            let mainPos = 1;

            if (offerBlocks.length > 0) {
                offerBlocks.forEach(block => {
                    const link = block.querySelector('a');
                    if (link && (link.innerText.includes('деньги') || link.innerText.includes('получить'))) {
                        const img = block.querySelector('img');
                        results.push({
                            position: mainPos++,
                            company_name: img?.alt || block.innerText.split('\n')[0] || "Offer",
                            link: link.href,
                            image_url: img?.src || null,
                            placement_type: 'main'
                        });
                    }
                });
            } else {
                // Фоллбек на старую логику, если блоки не найдены
                const allLinks = Array.from(document.querySelectorAll('a'));
                allLinks.forEach(link => {
                    const text = link.innerText.toLowerCase();
                    if ((text.includes('деньги') || text.includes('получить')) && link.href.includes('http')) {
                        const parent = link.parentElement.parentElement;
                        const img = parent.querySelector('img');
                        results.push({
                            position: mainPos++,
                            company_name: img?.alt || "Unknown",
                            link: link.href,
                            image_url: img?.src || null,
                            placement_type: 'main'
                        });
                    }
                });
            }

            return results;
        });

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
