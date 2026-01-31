const db = require('../db/schema');

const AnalyticsService = {
    // Получить среднюю позицию для каждого оффера (с нормализацией брендов)
    getAveragePositions: () => {
        const { NormalizationService } = require('./normalization');
        const rawData = db.prepare(`
            SELECT company_name, position, link
            FROM offer_stats
            WHERE placement_type = 'main'
        `).all();

        const brands = {};

        rawData.forEach(row => {
            const BrandName = NormalizationService.normalize(row.company_name, row.link);
            if (!brands[BrandName]) {
                brands[BrandName] = { 
                    company_name: BrandName, 
                    total_pos: 0, 
                    appearances: 0 
                };
            }
            brands[BrandName].total_pos += row.position;
            brands[BrandName].appearances += 1;
        });

        return Object.values(brands)
            .map(b => ({
                company_name: b.company_name,
                avg_pos: Math.round((b.total_pos / b.appearances) * 10) / 10,
                appearances: b.appearances
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
    }
};

module.exports = AnalyticsService;
