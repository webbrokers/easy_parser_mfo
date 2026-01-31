require('dotenv').config();
const express = require('express');
const path = require('path');
const AnalyticsService = require('./services/analytics');
const { parseShowcase } = require('./scraper/index');
const db = require('./db/schema');

const cron = require('node-cron');
const { dailyTask } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Принудительно слушаем на всех интерфейсах для облака
// Принудительно слушаем на всех интерфейсах для облака
const HOST = '0.0.0.0';

// --- STARTUP MAINTENANCE ---
try {
    console.log('[Startup] Выполняю обслуживание базы...');
    // 1. Отключаем Sravni.ru (по запросу пользователя)
    const info = db.prepare("UPDATE showcases SET is_active = 0 WHERE url LIKE '%sravni.ru%' AND is_active = 1").run();
    if (info.changes > 0) console.log(`[Startup] Sravni.ru отключен (${info.changes} записей)`);

    // 2. Очистка старых логов (кеш ошибок)
    // Оставляем только свежие (последние 24 часа), остальное удаляем, чтобы не путать
    // Или можно удалить вообще всё, как просили "сбросить кеш"
    db.prepare("DELETE FROM parsing_runs WHERE status = 'error'").run(); 
    console.log('[Startup] Логи ошибок очищены');
} catch (e) {
    console.error('[Startup] Ошибка обслуживания:', e);
}

// Настройка EJS и статики
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// Маршруты
app.get('/', async (req, res) => {
    try {
        const showcases = db.prepare(`
            SELECT 
                s.*,
                (SELECT COUNT(*) FROM offer_stats WHERE run_id = (
                    SELECT id FROM parsing_runs WHERE showcase_id = s.id AND status = 'success' ORDER BY run_date DESC LIMIT 1
                )) as last_offers_count,
                (SELECT screenshot_path FROM parsing_runs WHERE showcase_id = s.id AND status = 'success' ORDER BY run_date DESC LIMIT 1) as screenshot_path,
                CAST((julianday('now') - julianday(s.created_at)) AS INTEGER) as days_active
            FROM showcases s
            ORDER BY s.id DESC
        `).all();
        const avgPos = AnalyticsService.getAveragePositions();
        
        const stats = {
            totalShowcases: showcases.length,
            activeShowcases: showcases.filter(s => s.is_active).length,
            // Считаем уникальные МФО, а не просто количество записей
            totalOffers: db.prepare('SELECT count(DISTINCT company_name) as count FROM offer_stats').get().count,
            runsToday: db.prepare("SELECT count(*) as count FROM parsing_runs WHERE date(run_date) = date('now')").get().count,
            errorsToday: db.prepare("SELECT count(*) as count FROM parsing_runs WHERE date(run_date) = date('now') AND status = 'error'").get().count
        };

        // Получаем информацию о последнем полном парсинге
        const lastFullRun = db.prepare(`
            SELECT 
                MIN(run_date) as start_time,
                MAX(run_date) as end_time,
                COUNT(DISTINCT showcase_id) as total_runs
            FROM parsing_runs
            WHERE date(run_date) = (
                SELECT date(run_date) 
                FROM parsing_runs 
                WHERE status = 'success' 
                ORDER BY run_date DESC 
                LIMIT 1
            )
            AND status = 'success'
        `).get();

        const chartData = AnalyticsService.getTopOffersHistory();

        res.render('index', { 
            title: 'Дашборд', 
            showcases, 
            avgPos, 
            stats,
            chartData,
            lastFullRun 
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/showcase/:id', async (req, res) => {
    try {
        const showcase = db.prepare('SELECT * FROM showcases WHERE id = ?').get(req.params.id);
        if (!showcase) return res.status(404).send('Not Found');

        // Получаем историю запусков
        const history = AnalyticsService.getShowcaseHistory(req.params.id);

        let latest = null;

        // Если передан run_id, пытаемся получить конкретный запуск
        if (req.query.run_id) {
            latest = AnalyticsService.getShowcaseRun(req.query.run_id);
        } 
        
        // Если run_id нет или запуск не найден, берем самый свежий (первый из истории)
        if (!latest && history.length > 0) {
            latest = AnalyticsService.getShowcaseRun(history[0].id);
        }

        res.render('showcase', { title: showcase.name, showcase, latest, history });
    } catch (e) {
        console.error(e);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/offers', async (req, res) => {
    try {
        const offers = AnalyticsService.getAveragePositions();
        res.render('offers', { title: 'Все офферы', offers });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error');
    }
});

// API для получения ТОП-5 офферов по периоду
app.get('/api/top-offers/:period', async (req, res) => {
    try {
        const { period } = req.params;
        let dateFilter = '';
        
        switch(period) {
            case 'today':
                dateFilter = "AND date(pr.run_date) = date('now')";
                break;
            case '7days':
                dateFilter = "AND pr.run_date >= datetime('now', '-7 days')";
                break;
            case '14days':
                dateFilter = "AND pr.run_date >= datetime('now', '-14 days')";
                break;
            case '30days':
                dateFilter = "AND pr.run_date >= datetime('now', '-30 days')";
                break;
            case 'month':
                dateFilter = "AND strftime('%Y-%m', pr.run_date) = strftime('%Y-%m', 'now')";
                break;
            default:
                dateFilter = "AND pr.run_date >= datetime('now', '-7 days')";
        }
        
        const { NormalizationService } = require('./services/normalization');
        const rawData = db.prepare(`
            SELECT os.company_name, os.position, os.link
            FROM offer_stats os
            JOIN parsing_runs pr ON os.run_id = pr.id
            WHERE os.placement_type = 'main'
            AND pr.status = 'success'
            ${dateFilter}
        `).all();

        const brands = {};
        rawData.forEach(row => {
            const brandName = NormalizationService.normalize(row.company_name, row.link);
            if (!brands[brandName]) {
                brands[brandName] = { company_name: brandName, total_pos: 0, appearances: 0 };
            }
            brands[brandName].total_pos += row.position;
            brands[brandName].appearances += 1;
        });

        const topOffers = Object.values(brands)
            .map(b => ({
                company_name: b.company_name,
                avg_pos: Math.round((b.total_pos / b.appearances) * 10) / 10,
                appearances: b.appearances
            }))
            .sort((a, b) => a.avg_pos - b.avg_pos)
            .slice(0, 5);

        res.json(topOffers);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// API: Запуск выборочного парсинга
app.post('/api/run-selected-showcases', async (req, res) => {
    try {
        const { showcase_ids } = req.body;
        if (!showcase_ids || !Array.isArray(showcase_ids) || showcase_ids.length === 0) {
            return res.status(400).json({ error: 'Не выбраны витрины' });
        }

        console.log(`[API] Запуск выборочного парсинга для: ${showcase_ids.join(', ')}`);
        
        // Запускаем асинхронно, не блокируя ответ
        (async () => {
            const showcases = db.prepare(`SELECT * FROM showcases WHERE id IN (${showcase_ids.join(',')})`).all();
            for (const showcase of showcases) {
                try {
                    console.log(`[API] Парсинг витрины ${showcase.url}...`);
                    await parseShowcase(showcase);
                } catch (e) {
                    console.error(`[API] Ошибка парсинга ${showcase.url}:`, e);
                }
            }
            console.log(`[API] Выборочный парсинг завершен`);
        })();

        res.json({ success: true, message: 'Парсинг запущен' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// API: Генерация тестовых данных за 7 дней
app.post('/api/seed-test-data', async (req, res) => {
    try {
        console.log('[API] Генерация тестовых данных...');
        const showcases = db.prepare('SELECT * FROM showcases WHERE is_active = 1').all();
        // Используем require внутри функции, чтобы избежать проблем с циклическими зависимостями или порядком загрузки
        const { DateTime } = require('luxon');

        const offersList = [
            'MoneyMan', 'Webbankir', 'Zaymer', 'Ekapusta', 'Lime-Zaim', 
            'Vivus', 'SrochnoDengi', 'Kviku', 'DobroZaim', 'Moneza', 
            'JoyMoney', 'Platiza', 'Web-Zaim', 'Turboloan', 'Kredito24'
        ];

        // Транзакция для скорости
        const insertRun = db.prepare('INSERT INTO parsing_runs (showcase_id, run_date, status, screenshot_path) VALUES (?, ?, ?, ?)');
        const insertOffer = db.prepare('INSERT INTO offer_stats (run_id, position, company_name, link, image_url, placement_type) VALUES (?, ?, ?, ?, ?, ?)');

        db.transaction(() => {
            // Генерируем данные за последние 7 дней
            for (let i = 6; i >= 0; i--) {
                const date = DateTime.now().minus({ days: i }).toFormat('yyyy-MM-dd HH:mm:ss');
                
                showcases.forEach(showcase => {
                    // Создаем parsing_run
                    const runResult = insertRun.run(showcase.id, date, 'success', '');
                    const runId = runResult.lastInsertRowid;

                    // Генерируем 10-15 офферов
                    const offersCount = Math.floor(Math.random() * 6) + 10;
                    
                    // Перемешиваем массив офферов
                    const shuffledOffers = [...offersList].sort(() => 0.5 - Math.random());

                    for (let j = 0; j < offersCount; j++) {
                        insertOffer.run(
                            runId, 
                            j + 1, // position
                            shuffledOffers[j], // company_name
                            `https://example.com/click/${shuffledOffers[j]}`, // link
                            '', // image_url
                            'main' // placement_type
                        );
                    }
                });
            }
        })();

        console.log('[API] Тестовые данные успешно сгенерированы');
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/logs', async (req, res) => {
    try {
        const errors = AnalyticsService.getErrorLogs();
        res.render('logs', { title: 'Логи ошибок', errors });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error');
    }
});

app.get('/settings', async (req, res) => {
    try {
        const showcases = db.prepare('SELECT * FROM showcases').all();
        res.render('settings', { title: 'Настройки', showcases });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error');
    }
});

// Планировщик ежедневного парсинга (03:00)
cron.schedule('0 3 * * *', () => {
    dailyTask();
});

// API для получения списка активных витрин
app.get('/api/showcases/active', (req, res) => {
    const sites = db.prepare('SELECT id, name FROM showcases WHERE is_active = 1').all();
    res.json(sites);
});

// API для запуска парсинга одной витрины
app.post('/api/run-showcase/:id', async (req, res) => {
    try {
        const result = await parseShowcase(req.params.id);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// API для переключения статуса витрины
app.post('/api/showcase/:id/toggle', (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;
        db.prepare('UPDATE showcases SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// API для обновления настроек витрины (селектор)
app.post('/api/showcase/:id/update', (req, res) => {
    try {
        const { id } = req.params;
        const { custom_selector } = req.body;
        db.prepare('UPDATE showcases SET custom_selector = ? WHERE id = ?').run(custom_selector || null, id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// API для запуска парсинга
app.post('/api/run-all', async (req, res) => {
    const sites = db.prepare('SELECT id FROM showcases WHERE is_active = 1').all();
    const results = [];
    
    // Запускаем последовательно, чтобы не положить систему
    for (const site of sites) {
        const result = await parseShowcase(site.id);
        results.push({ id: site.id, ...result });
    }
    
    res.json({ success: true, results });
});

// Добавление новой витрины
app.post('/api/showcases', express.urlencoded({ extended: true }), (req, res) => {
    const { name, url } = req.body;
    try {
        db.prepare('INSERT INTO showcases (name, url) VALUES (?, ?)').run(name, url);
        res.redirect('/settings');
    } catch (e) {
        res.status(500).send('Ошибка при добавлении: ' + e.message);
    }
});

// Удаление витрины
app.post('/api/showcases/delete/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM showcases WHERE id = ?').run(req.params.id);
        res.redirect('/settings');
    } catch (e) {
        res.status(500).send('Ошибка при удалении');
    }
});

// Запуск сервера
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Сервер запущен на порту ${PORT} (0.0.0.0)`);
    });
}

module.exports = app;
