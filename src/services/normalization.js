/**
 * Сервис для сопоставления разных названий офферов в единый бренд.
 */

const BRAND_ALIASES = {
    'Займер': ['zaymer', 'robot zaymer', 'робот займер', 'robot-zaymer', 'займер'],
    'Манимен': ['moneyman', 'манимен', 'мани мен', 'money man'],
    'Веббанкир': ['webbankir', 'веббанкир', 'веб-банкир', 'web-bankir'],
    'Екапуста': ['ekapusta', 'екапуста', 'е-капуста', 'e-kapusta'],
    'Лайм-Займ': ['lime', 'лайм', 'lime-zaim', 'лаймзайм'],
    'Быстроденьги': ['bistrodengi', 'быстроденьги', 'быстро деньги'],
    'Веб-займ': ['web-zaim', 'вебзайм', 'веб займ', 'webzaim'],
    'Кредит7': ['credit7', 'кредит7', 'credit-7', 'кредит 7'],
    'Белка Кредит': ['belkazaym', 'белкакредит', 'belkacredit', 'белка кредит'],
    'Турбозайм': ['turbozaim', 'турбозайм', 'турбо займ'],
    'Гринмани': ['greenmoney', 'гринмани', 'грин мани', 'green money'],
    'МигКредит': ['migcredit', 'мигкредит', 'миг кредит'],
    'ДжойМани': ['joymoney', 'джоймани', 'джой мани'],
    'До Зарплаты': ['dozarplati', 'до зарплаты', 'дозпрплата'],
    'Viva Деньги': ['vivadengi', 'виваденьги', 'вива деньги'],
    'Срочноденьги': ['srochnodengi', 'срочноденьги', 'срочно деньги'],
    'Деньги Сразу': ['dengisrazu', 'деньгисразу', 'деньги сразу', 'dengi-srazu'],
    'Финтерс': ['finters', 'finlaba'],
    'Юкки': ['yukki', 'юкки', 'ukki'],
    'Vldmnt': ['vldmnt'],
    'Целевые Финансы': ['celfin', 'целевые финансы'],
    'OneClickMoney': ['oneclickmoney', 'ван клик мани'],
    'Займиго': ['zaymigo', 'займиго'],
    'А-Деньги': ['adengi', 'аденьги', 'а-деньги'],
    'Плисков': ['pliskov', 'плисков'],
    'Умные Наличные': ['smartcash', 'умные наличные'],
    'Надо Денег': ['nadodeneg', 'надо денег'],
    'Бустра': ['boostra', 'бустра', 'buustra'],
    'Кредиска': ['krediska', 'кредиска', 'mkk-krediska'],
    'Кредитплюс': ['creditplus', 'кредитплюс', 'кредит плюс'],
    'Езаем': ['ezaem', 'езаем', 'е-заем'],
    'Монеза': ['moneza', 'монеза'],
    'Квику': ['kviku', 'квику'],
    'Пей П.С.': ['payps', 'пей пс', 'pay p.s.'],
    'Вивус': ['vivus', 'вивус'],
    'Кредиттер': ['creditter', 'кредиттер', 'smartcredit'],
    'Кредито24': ['kredito24', 'кредито24', 'кредито 24'],
    'Фастмани': ['fastmoney', 'фастмани', 'фаст мани'],
    'Микроклад': ['microklad', 'микроклад'],
    'Лайм': ['lime-zaim', 'лаймзайм', 'лайм займ'],
    'Макс.Кредит': ['max.credit', 'макс кредит', 'макс.кредит'],
    'Хороший Займ': ['horoshizaim', 'хороший займ'],
    'Бустра': ['boostra', 'бустра'],
    'Кредиска': ['krediska', 'кредиска'],
    'Доброзайм': ['dobrozaim', 'доброзайм', 'добро займ'],
    'Центрофинанс': ['centrofinance', 'центрофинанс'],
    'Главфинанс': ['glavfinans', 'главфинанс'],
};

class NormalizationService {
    static BRAND_ALIASES = BRAND_ALIASES;

    /**
     * Превращает любое название в эталонное имя бренда.
     */
    static normalize(name, url = '') {
        if (!name) return 'Unknown';

        let cleanName = name.toLowerCase()
            .replace(/['"«»]/g, '')
            .replace(/(мфо|мкк|ооо|зао|пао|мфк)/gi, '')
            .trim();

        // 1. Проверяем по справочнику алиасов
        for (const [brand, aliases] of Object.entries(BRAND_ALIASES)) {
            if (aliases.some(a => cleanName.includes(a.toLowerCase()))) {
                return brand;
            }
        }

        // 2. Если в имени нет зацепок, проверяем URL
        if (url) {
            const lowUrl = url.toLowerCase();
            for (const [brand, aliases] of Object.entries(BRAND_ALIASES)) {
                if (aliases.some(a => lowUrl.includes(a.toLowerCase()))) {
                    return brand;
                }
            }
        }

        // 3. Если ничего не подошло, возвращаем причесанное исходное имя
        return name.split(/[.,!?;|]/)[0].trim().substring(0, 30);
    }
}

module.exports = { NormalizationService, BRAND_ALIASES };
