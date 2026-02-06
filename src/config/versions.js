/**
 * Центральная конфигурация версий
 */
const VERSIONS = {
  SYSTEM: "1.5.0",
  PARSER: {
    STABLE: "Cluster Match v5.6",
    STABLE_V3: "Pattern Match v3.0",
    LEGACY: "Cluster Match v4.0"
  },
  DESCRIPTIONS: {
    STABLE: "Cluster Match v5.6: Исправлена дедупликация и поиск контейнеров. Оптимизирован под 2 потока (System v1.4).",
    STABLE_V3: "Pattern Match v3.0: Глубокий анализ JSON, Яндекс.Метрики и Redirect Resolve. Самая мощная версия.",
    LEGACY: "Классический алгоритм Cluster Match v4.0. Используйте, если в новой версии возникли проблемы."
  }
};

module.exports = VERSIONS;
