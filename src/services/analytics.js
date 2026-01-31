const db = require('../db/schema');

const AnalyticsService = {
    // Получить среднюю позицию для каждого оффера (с нормализацией брендов)
    getAveragePositions: () => {
        const { NormalizationService } = require('./normalization');
        const totalShowcases = db.prepare('SELECT COUNT(*) as count FROM showcases WHERE is_active = 1').get().count;
        
        const rawData = db.prepare(`
            SELECT os.company_name, os.position, os.link, os.image_url, pr.showcase_id
            FROM offer_stats os
            JOIN parsing_runs pr ON os.run_id = pr.id
            WHERE os.placement_type = 'main'
            AND pr.id IN (
                SELECT id FROM parsing_runs 
                WHERE status = 'success' 
                GROUP BY showcase_id 
                HAVING id = MAX(id)
            )
        `).all();

        const brands = {};

        rawData.forEach(row => {
            const BrandName = NormalizationService.normalize(row.company_name, row.link);
            if (!brands[BrandName]) {
                brands[BrandName] = { 
                    company_name: BrandName, 
                    total_pos: 0, 
                    appearances: 0,
                    showcases: new Set(),
                    logo: row.image_url 
                };
            }
            brands[BrandName].total_pos += row.position;
            brands[BrandName].appearances += 1;
            brands[BrandName].showcases.add(row.showcase_id);
            if (!brands[BrandName].logo && row.image_url) {
                brands[BrandName].logo = row.image_url;
            }
        });

        return Object.values(brands)
            .map(b => ({
                company_name: b.company_name,
                avg_pos: Math.round((b.total_pos / b.appearances) * 10) / 10,
                appearances: b.appearances,
                showcase_count: b.showcases.size,
                total_showcases: totalShowcases,
                frequency_pct: Math.round((b.showcases.size / totalShowcases) * 100),
                logo: b.logo
            }))
            .sort((a, b) => a.avg_pos - b.avg_pos);
    },

    // Данные для графика (история позиций конкретных офферов)
    getOfferHistory: (companyNames) => {
        const placeholders = companyNames.map(() => '?').join(',');
        return db.prepare(`
            SELECT company_name, position, captured_at
            FROM offer_stats
            WHERE company_name IN (${placeholders})
            AND placement_type = 'main'
            ORDER BY captured_at ASC
        `).all(companyNames);
    },

    // Последние результаты по витрине
    getLatestShowcaseResults: (showcaseId) => {
        const run = db.prepare(`
            SELECT id, run_date, screenshot_path 
            FROM parsing_runs 
            WHERE showcase_id = ? AND status = 'success'
            ORDER BY run_date DESC LIMIT 1
        `).get(showcaseId);

        if (!run) return null;

        const offers = db.prepare(`
            SELECT * FROM offer_stats WHERE run_id = ? ORDER BY placement_type, position
        `).all(run.id);

        return { run, offers };
    },

    // Получить последние ошибки за 24 часа
    getErrorLogs: () => {
        return db.prepare(`
            SELECT pr.*, s.name as showcase_name
            FROM parsing_runs pr
            JOIN showcases s ON pr.showcase_id = s.id
            WHERE pr.status = 'error'
            AND pr.run_date >= datetime('now', '-24 hours')
            ORDER BY pr.run_date DESC
        `).all();
    },

    // Данные для графика: динамика Топ-5 офферов за 7 дней
    getTopOffersHistory: () => {
        const { NormalizationService } = require('./normalization');
        
        // 1. Находим Топ-5 офферов за последние 7 дней (по частоте встречаемости)
        const rawTop = db.prepare(`
            SELECT os.company_name, os.link, COUNT(*) as count
            FROM offer_stats os
            JOIN parsing_runs pr ON os.run_id = pr.id
            WHERE pr.run_date >= date('now', '-7 days')
            AND os.placement_type = 'main'
            AND pr.status = 'success'
            GROUP BY os.company_name, os.link
        `).all();

        // Схлопываем бренды (нормализация)
        const brands = {};
        rawTop.forEach(r => {
            const name = NormalizationService.normalize(r.company_name, r.link);
            brands[name] = (brands[name] || 0) + r.count;
        });

        // Сортируем и берем топ 5 имен
        const topNames = Object.entries(brands)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(e => e[0]);

        if (topNames.length === 0) return { labels: [], datasets: [] };

        // 2. Генерируем даты за 7 дней (ось X)
        const days = [];
        const today = new Date();
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(today.getDate() - i);
            days.push(d.toISOString().split('T')[0]);
        }

        // 3. Собираем данные (средняя позиция) для каждого из топ-офферов по дням
        const datasets = [];
        // Фикс цвета на фронте, здесь просто данные
        
        for (const name of topNames) {
            // Для нормализации в SQL это сложно, поэтому вытащим всё за 7 дней и отфильтруем в JS
            // Или сделаем запрос конкретно по этому нормализованному имени?
            // Проще вытащить всю статистику за 7 дней и пройтись по ней.
            const stats = db.prepare(`
                SELECT date(pr.run_date) as run_day, os.company_name, os.link, AVG(os.position) as avg
                FROM offer_stats os
                JOIN parsing_runs pr ON os.run_id = pr.id
                WHERE pr.run_date >= date('now', '-7 days')
                AND os.placement_type = 'main'
                AND pr.status = 'success'
                GROUP BY run_day, os.company_name, os.link
            `).all();

            const dataPoints = days.map(day => {
                // Находим все записи за этот день, которые соответствуют нашему нормализованному имени
                const matches = stats.filter(s => 
                    s.run_day === day && 
                    NormalizationService.normalize(s.company_name, s.link) === name
                );
                
                if (matches.length === 0) return null;
                
                // Считаем среднее среди всех вариаций этого бренда за день
                const sum = matches.reduce((acc, curr) => acc + curr.avg, 0);
                return Number((sum / matches.length).toFixed(1));
            });

            datasets.push({
                label: name,
                data: dataPoints
            });
        }

        return { labels: days, datasets };
    },

    // Получить историю запусков для конкретной витрины
    getShowcaseHistory: (showcaseId) => {
        return db.prepare(`
            SELECT id, run_date, status
            FROM parsing_runs
            WHERE showcase_id = ? AND status = 'success'
            ORDER BY run_date DESC
        `).all(showcaseId);
    },

    // Получить данные конкретного запуска
    getShowcaseRun: (runId) => {
        const run = db.prepare(`
            SELECT id, run_date, screenshot_path 
            FROM parsing_runs 
            WHERE id = ? AND status = 'success'
        `).get(runId);

        if (!run) return null;

        const offers = db.prepare(`
            SELECT * FROM offer_stats WHERE run_id = ? ORDER BY placement_type, position
        `).all(run.id);

        return { run, offers };
    }
};

module.exports = AnalyticsService;
