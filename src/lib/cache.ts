/**
 * 进程内 TTL 内存缓存（backend §4.3 / §8.2）
 *
 * - 单实例部署使用；未来多实例可换 Redis 实现
 * - 支持按 key 主动失效（disable 团队/密钥时调用，保证 ≤1min 生效）
 */
interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class TTLCache<V> {
  private store = new Map<string, CacheEntry<V>>();

  constructor(private defaultTtlMs: number) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /** 主动失效（团队禁用、密钥禁用、配额调整等事件触发） */
  delete(key: string): void {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.store.clear();
  }
}
