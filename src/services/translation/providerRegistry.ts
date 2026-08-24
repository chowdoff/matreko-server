import { TranslationEngine } from '@prisma/client';
import { TranslationProvider } from './types';
import { googleProvider } from './google.provider';
import { deeplProvider } from './deepl.provider';

/** 引擎适配层注册表（T4-01 / backend §7.1） */
const registry: Record<TranslationEngine, TranslationProvider> = {
  [TranslationEngine.GOOGLE]: googleProvider,
  [TranslationEngine.DEEPL]: deeplProvider,
};

export function getProvider(engine: TranslationEngine): TranslationProvider {
  const provider = registry[engine];
  if (!provider) {
    throw new Error(`未注册的翻译引擎：${engine}`);
  }
  return provider;
}

export const SUPPORTED_ENGINES: TranslationEngine[] = [
  TranslationEngine.GOOGLE,
  TranslationEngine.DEEPL,
];
