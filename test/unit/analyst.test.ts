import { describe, expect, it } from 'vitest';
import { createGeminiAnalyst } from '../../src/infra/capture/analyst.js';
import { ExtractorError } from '../../src/infra/capture/ports.js';

function fakeFetch(payload: unknown, status = 200) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, requests };
}

const sampleInput = {
  system: 'Eres analista.',
  context: { totals: { income: '100.00', expense: '40.00', net: '60.00' } },
  history: [],
  question: '¿En qué gasto más?',
};

describe('createGeminiAnalyst', () => {
  it('desactiva thinking en gemini-2.5-flash y usa maxOutputTokens 2048', async () => {
    const { fn, requests } = fakeFetch({
      candidates: [{ content: { parts: [{ text: 'Gastaste S/ 40.00.' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
    });
    const analyst = createGeminiAnalyst({ apiKey: 'test-key', model: 'gemini-2.5-flash', fetchFn: fn, sleep: async () => {} });
    const out = await analyst.answer(sampleInput);
    expect(out.text).toBe('Gastaste S/ 40.00.');
    expect(requests[0]!.body.generationConfig).toEqual({
      temperature: 0.2,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it('no envía thinkingBudget: 0 en modelos que no son gemini-2.5-flash', async () => {
    const { fn, requests } = fakeFetch({
      candidates: [{ content: { parts: [{ text: 'Ok.' }] } }],
    });
    const analyst = createGeminiAnalyst({ apiKey: 'test-key', model: 'gemini-2.5-pro', fetchFn: fn, sleep: async () => {} });
    await analyst.answer(sampleInput);
    expect(requests[0]!.body.generationConfig).toEqual({
      temperature: 0.2,
      maxOutputTokens: 2048,
    });
  });

  it('ignora partes thought: true y devuelve solo la respuesta visible', async () => {
    const { fn } = fakeFetch({
      candidates: [{
        content: {
          parts: [
            { text: 'razonamiento interno...', thought: true },
            { text: 'Tu mayor gasto fue Alimentación.' },
          ],
        },
      }],
    });
    const analyst = createGeminiAnalyst({ apiKey: 'test-key', model: 'gemini-2.5-flash', fetchFn: fn, sleep: async () => {} });
    const out = await analyst.answer(sampleInput);
    expect(out.text).toBe('Tu mayor gasto fue Alimentación.');
  });

  it('lanza ANALYST_EMPTY si solo llegan partes de thought sin texto visible', async () => {
    const { fn } = fakeFetch({
      candidates: [{ content: { parts: [{ text: 'solo pensamiento', thought: true }] } }],
    });
    const analyst = createGeminiAnalyst({ apiKey: 'test-key', model: 'gemini-2.5-flash', fetchFn: fn, sleep: async () => {} });
    await expect(analyst.answer(sampleInput)).rejects.toMatchObject({ code: 'ANALYST_EMPTY' } satisfies Partial<ExtractorError>);
  });
});
