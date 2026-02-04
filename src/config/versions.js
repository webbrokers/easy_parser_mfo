/**
 * Центральная конфигурация версий
 */
const VERSIONS = {
  SYSTEM: "1.3.0",
  PARSER: {
    STABLE: "Cluster Match v5.6",
    LEGACY: "Cluster Match v4.0"
  },
  DESCRIPTIONS: {
    STABLE: "Cluster Match v5.6: Исправлена дедупликация и поиск контейнеров. Восстановлена работоспособность парсинга.",
    LEGACY: "Классический алгоритм Cluster Match v4.0. Используйте, если в новой версии возникли проблемы."
  }
};

module.exports = VERSIONS;
