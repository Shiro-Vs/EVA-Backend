import { z } from 'zod';
import { parseISO } from './localDate.js';

// Primitivas compartidas por los esquemas de extracción (captura y préstamos bancarios).
export const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'importe decimal con punto y hasta 2 decimales');
export const optText = z.string().trim().max(300).nullable().optional().transform((v) => (v ? v : null));
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => { try { parseISO(s); return true; } catch { return false; } }, 'fecha inexistente');
