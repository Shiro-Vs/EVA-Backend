import { ExtractorError, type ExtractInput, type ExtractOutput, type Extractor } from './ports.js';

const AMOUNT = /(?:S\/\.?|PEN)\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i;
const DMY = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/;
const YMD = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const INCOME = /recibiste|te (?:yapearon|plineron|enviaron|transfirieron)|abono|dep[oó]sito a tu/i;
const OP_REF = /(?:operaci[oó]n|nro\.?|n[uú]mero|c[oó]digo)\D{0,12}(\d{5,})/i;
const CHANNEL = /\b(yape|plin|bcp|bbva|interbank|scotiabank|tunki|agora)\b/i;
const WHO = /\b(?:a|en|de)\s+([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ.&]*(?:\s+[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ.&]*){0,3})/;

function toDecimal(raw: string): string {
  // "1.234,50" | "1,234.50" | "10,5" | "10.25" → "1234.50" | "10.50" | "10.25"
  const last = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'));
  if (last === -1) return `${raw}.00`;
  const dec = raw.slice(last + 1);
  const int = raw.slice(0, last).replace(/[.,]/g, '');
  return dec.length <= 2 ? `${int}.${dec.padEnd(2, '0')}` : `${int}${dec}.00`;
}

/** Extractor sin IA para desarrollo y pruebas: reconoce textos simples de comprobantes (importe en S/, fecha, canal). No lee imágenes ni PDF. */
export function createHeuristicExtractor(): Extractor {
  return {
    provider: 'heuristic',
    model: 'heuristic-1',
    async extract(i: ExtractInput): Promise<ExtractOutput> {
      if (!i.text || i.text.trim() === '') throw new ExtractorError('EXTRACTOR_UNSUPPORTED', 'Este extractor solo lee texto; para fotos y PDF hace falta el modelo de IA', true);
      const t = i.text;
      const usage = { tokensIn: 0, tokensOut: 0, costEstimate: 0 };
      const a = AMOUNT.exec(t);
      if (!a) return { provider: 'heuristic', model: 'heuristic-1', usage, raw: { documentType: 'other', isTransaction: false, confidence: 0.2, movements: [], missingFields: [], warnings: [] } };
      let occurredOn: string | null = null;
      const ymd = YMD.exec(t); const dmy = DMY.exec(t);
      if (ymd) occurredOn = ymd[0];
      else if (dmy) occurredOn = `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
      const who = WHO.exec(t.replace(/^.*?(?:S\/\.?\s*[\d.,]+)/i, ''));
      return {
        provider: 'heuristic', model: 'heuristic-1', usage,
        raw: {
          documentType: 'payment_receipt', isTransaction: true, confidence: 0.6,
          movements: [{
            direction: INCOME.test(t) ? 'income' : 'expense', amount: toDecimal(a[1]!), currency: 'PEN', occurredOn,
            counterparty: who?.[1] ?? null, channel: CHANNEL.exec(t)?.[1] ?? null, operationId: OP_REF.exec(t)?.[1] ?? null,
            concept: null, suggestedCategory: null, items: [],
          }],
          missingFields: occurredOn ? [] : ['occurredOn'], warnings: [],
        },
      };
    },
  };
}

/** Sin proveedor configurado: toda captura falla de forma recuperable y el registro manual sigue disponible (07 §6.6). */
export function createUnavailableExtractor(): Extractor {
  return {
    provider: 'none', model: 'none',
    async extract(): Promise<ExtractOutput> { throw new ExtractorError('EXTRACTOR_UNAVAILABLE', 'No hay un modelo de extracción configurado', true); },
  };
}
