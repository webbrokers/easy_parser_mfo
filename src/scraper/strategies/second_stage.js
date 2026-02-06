const { NormalizationService } = require("../../services/normalization");

/**
 * Логика второго этапа (Second Stage).
 * Запускается для офферов, которые не удалось определить ("Unknown", "Offer" и т.д.)
 * или для тех, у которых есть подозрительные имена.
 * 
 * НЕ ДЕЛАЕТ сетевых запросов (чтобы не замедлять), работает только с текстом/ссылками.
 * Для сетевых запросов есть RedirectResolve в основном файле.
 */
class SecondStageStrategy {
    constructor() {
        // Дополнительный словарь для "сложных" случаев, которые не попали в основной конфиг
        this.hardcodedMap = {
            "joy.money": "JoyMoney",
            "joymoney": "JoyMoney",
            "kredito24": "Kredito24",
            "zaymer": "Займер",
            "turbozaim": "Турбозайм",
            "webbankir": "Webbankir",
            "moneyman": "MoneyMan",
            "vivus": "Vivus",
            "smsfinance": "Смсфинанс",
            "lime": "Lime",
            "kviku": "Kviku",
            "mikkro": "Mikkro",
            "web-zaim": "Веб-займ",
            "dozarplati": "ДоЗарплаты",
            "ekapusta": "Екапуста",
            "migcredit": "МигКредит",
            "creditplus": "CreditPlus",
            "viva": "Viva Деньги",
            "adengi": "А-Деньги",
            "belkacredit": "БелкаКредит",
            "cash-u": "Cash-U",
            "dobrozaim": "ДоброЗайм",
            "fastmoney": "FastMoney",
            "oneclickmoney": "OneClickMoney",
            "payps": "Pay P.S.",
            "pliskov": "Pliskov",
            "srochnodengi": "СрочноДеньги",
            "umnye-nalichnye": "Умные Наличные",
            "zaymigo": "Zaymigo"
        };
    }

    /**
     * Основной метод запуска стратегий
     * @param {Array} items - Список офферов
     * @returns {Array} - Обновленный список (мутирует объекты внутри, но возвращает массив)
     */
    process(items) {
        console.log(`[SecondStage] Запуск Strict Analysis для ${items.length} офферов...`);
        let fixedCount = 0;
        let unknownCount = 0;

        const { BRAND_ALIASES } = require("../../services/normalization");

        for (const item of items) {
            let currentName = item.company_name;
            
            // 0. Base Filter: сразу отсекаем явный мусор (Base64, тех. имена)
            if (this.isJunk(currentName)) {
                console.log(`[SecondStage] Junk detected: ${currentName.substring(0, 20)}... -> Unknown`);
                item.company_name = "Unknown";
                item.is_recognized = false;
                unknownCount++;
                continue;
            }

            // 1. Попытка нормализации текущего имени (если вдруг v3 пропустил)
            const normalized = NormalizationService.normalize(currentName, item.link);
            if (normalized !== currentName && normalized !== "Unknown") {
                console.log(`[SecondStage] Normalization fix: "${currentName}" -> "${normalized}"`);
                item.company_name = normalized;
                item.is_recognized = true;
                fixedCount++;
                continue;
            }

            // 2. Санитайзер (Мягкий): чистим от "logo", "icon" и пробуем снова
            if (!item.is_recognized || currentName === "Unknown") {
                const cleaned = this.sanitizeName(currentName);
                if (cleaned !== currentName && cleaned.length > 2) {
                    // Пробуем найти этот cleaned в базе алиасов
                    const match = this.findBrandInDictionary(cleaned, BRAND_ALIASES);
                    if (match) {
                         console.log(`[SecondStage] Sanitizer Success: "${currentName}" -> "${cleaned}" -> "${match}"`);
                         item.company_name = match;
                         item.is_recognized = true;
                         fixedCount++;
                         continue;
                    }
                }
            }

            // 3. Fallback: URL Matching (если имя все еще Unknown или мусорное)
            if (!item.is_recognized || item.company_name === "Unknown") {
                const domainName = this.extractBrandFromUrl(item.link);
                if (domainName) {
                    // Проверяем, есть ли этот domainName в нашем словаре BRAND_ALIASES (через normalize)
                    const normDomain = NormalizationService.normalize(domainName);
                    console.log(`[SecondStage] URL Rescue: "${item.link}" -> "${domainName}" -> "${normDomain}"`);
                    item.company_name = normDomain;
                    item.is_recognized = true;
                    fixedCount++;
                    continue;
                }
            }

            // 4. Final strict check: Если после всего имя не в нашем "белом списке" (не нормализовалось)
            // И это не "Unknown" — значит это какой-то "logo icon..." который мы не смогли опознать.
            // Превращаем его в Unknown.
            const finalCheck = NormalizationService.normalize(item.company_name);
            if (finalCheck === item.company_name && !this.isKnownBrand(item.company_name, BRAND_ALIASES)) {
                 if (item.company_name !== "Unknown") {
                     console.log(`[SecondStage] Unrecognized garbage: "${item.company_name}" -> Unknown`);
                     item.company_name = "Unknown";
                     item.is_recognized = false;
                     unknownCount++;
                 }
            }
        }

        console.log(`[SecondStage] Завершено. Исправлено: ${fixedCount}, Сброшено в Unknown: ${unknownCount}`);
        return items;
    }

    isJunk(name) {
        if (!name) return true;
        if (name.startsWith('data:image')) return true; // Base64
        if (name.length > 50 && !name.includes(' ')) return true; // Hash/Token
        return false;
    }

    sanitizeName(name) {
        if (!name) return "";
        // Удаляем технические слова и расширения
        let clean = name.toLowerCase()
            .replace(/\.png|\.svg|\.jpg|\.jpeg|\.gif|logo|icon|image|brand|alt|title/gi, ' ')
            .replace(/[-_]/g, ' ') // Заменяем разделители на пробелы
            .replace(/\s+/g, ' ')  // Схлопываем пробелы
            .trim();
        return clean;
    }

    findBrandInDictionary(text, aliasesMap) {
        const textLow = text.toLowerCase();
        for (const [brand, aliases] of Object.entries(aliasesMap)) {
            // Прямое совпадение
            if (aliases.includes(textLow)) return brand;
            // Частичное, но аккуратное (если текст целиком содержится в алиасе или наоборот)
             if (aliases.some(a => a === textLow)) return brand;
        }
        return null; // Strict mode: если нет в словаре — null
    }

    isKnownBrand(name, aliasesMap) {
        return Object.keys(aliasesMap).includes(name);
    }
    
    // ... extractBrandFromUrl оставляем (можно чуть доработать, но пока ок) ...
    extractBrandFromUrl(url) {
        if (!url || url.includes("#unknown") || !url.startsWith("http")) return null;
        try {
            const urlObj = new URL(url);
            let hostname = urlObj.hostname.toLowerCase().replace("www.", "");
            
            // Проверка по хардкод-мапе
            for (const [key, brand] of Object.entries(this.hardcodedMap)) {
                if (hostname.includes(key)) return brand;
            }
            return null;
        } catch (e) { return null; }
    }
}

module.exports = new SecondStageStrategy();
