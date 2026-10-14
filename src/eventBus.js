// GeoPulse - EventBus Leve e Desacoplado para Comunicação entre Módulos
class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  /**
   * Registra um listener para um evento
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} Função para desinscrever
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  /**
   * Registra um listener de execução única
   * @param {string} event
   * @param {Function} callback
   */
  once(event, callback) {
    const unregister = this.on(event, (...args) => {
      unregister();
      callback(...args);
    });
  }

  /**
   * Remove um listener
   * @param {string} event
   * @param {Function} callback
   */
  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  /**
   * Dispara um evento com dados opcionais
   * @param {string} event
   * @param {*} data
   */
  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach((cb) => {
        try {
          cb(data);
        } catch (err) {
          console.error(`[EventBus] Erro ao executar listener de "${event}":`, err);
        }
      });
    }
  }

  /**
   * Limpa todos os listeners
   */
  clear() {
    this.listeners.clear();
  }
}

export const eventBus = new EventBus();
