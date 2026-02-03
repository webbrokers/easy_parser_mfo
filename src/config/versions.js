/**
 * Центральная конфигурация версий
 */
const VERSIONS = {
  SYSTEM: "1.3.0",
  PARSER: {
    STABLE: "2.3",
    LEGACY: "1.0"
  },
  DESCRIPTIONS: {
    STABLE: "Cluster Match v5.3: Исключение навигационных блоков и фильтров, Redirect Resolve и асинхронный запуск.",
    LEGACY: "Классический алгоритм Cluster Match v4.0. Используйте, если в новой версии возникли проблемы."
  }
};

module.exports = VERSIONS;
