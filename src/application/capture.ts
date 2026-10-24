import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { contentHash, duplicateReason, extractionSchema, inboxAddressFor, minutesApart, missingForAccept, type ExtractedMovement } from '../domain/capture.js';
import { formatISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { ExtractorError, type Extractor, type FileStore } from '../infra/capture/ports.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import { assertActiveCategory } from './categories.js';
import { ts, type Ctx } from './context.js';
import type { Deduction } from './goals.js';
import { createOperation, getOperation, requireOwned, reverseOperationCore } from './operations.js';

export interface CaptureDeps { extractor: Extractor; files: FileStore; inboxDomain: string; dailyLimit: number; maxBytes: number }

const m = (v: string | bigint) => (typeof v === 'bigint' ? formatMoney(v) : formatMoney(parseMoney(v)));
const DUP_WINDOW_DAYS = 1; // 24 h (D-23)
const SOURCE_OF = { email: 'email', photo: 'photo', pdf: 'photo', text: 'manual' } as const;

// ───────────────────────── Dirección de recepción ─────────────────────────

interface AddrRow { id: string; address: string; status: string; created_at: unknown }

export async function getInboxAddress(ctx: Ctx, deps: CaptureDeps) {
  const cur = await one<AddrRow>(ctx.trx, sql<AddrRow>`select id, address, status, created_at from inbox_address where owner_id = ${ctx.ownerId} and status = 'active'`);
  if (cur) return { address: cur.address, createdAt: ts(cur.created_at) };
  return createAddress(ctx, deps);
}

async function createAddress(ctx: Ctx, deps: CaptureDeps) {
  const prof = await one<{ display_name: string }>(ctx.trx, sql<{ display_name: string }>`select display_name from user_profile where id = ${ctx.ownerId}`);
  const n = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from inbox_address where owner_id = ${ctx.ownerId}`);
  for (let k = Number(n?.n ?? 0); k < Number(n?.n ?? 0) + 50; k++) {
    const address = inboxAddressFor(ctx.ownerId, prof?.display_name ?? '', deps.inboxDomain, k);
    const r = await one<AddrRow>(ctx.trx, sql<AddrRow>`insert into inbox_address (owner_id, address) values (${ctx.ownerId}, ${address}) on conflict do nothing returning id, address, status, created_at`);
    if (r) {
      await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'inbox.create', entityType: 'inbox_address', entityId: r.id });
      return { address: r.address, createdAt: ts(r.created_at) };
    }
  }
  throw conflict('INBOX_ADDRESS_UNAVAILABLE', 'No se pudo generar una dirección de recepción única');
}

/** Rotar o revocar si se compromete (07 §3): la anterior deja de recibir. */
export async function rotateInboxAddress(ctx: Ctx, deps: CaptureDeps) {
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`update inbox_address set status = 'revoked', revoked_at = now() where owner_id = ${ctx.ownerId} and status = 'active' returning id`);
  const created = await createAddress(ctx, deps);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'inbox.rotate', entityType: 'inbox_address', entityId: r?.id ?? ctx.ownerId });
  return created;
}

export async function revokeInboxAddress(ctx: Ctx) {
  await sql`update inbox_address set status = 'revoked', revoked_at = now() where owner_id = ${ctx.ownerId} and status = 'active'`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'inbox.revoke', entityType: 'inbox_address', entityId: ctx.ownerId });
  return { revoked: true };
}

/** Propietario de una dirección activa (webhook de correo entrante). */
export async function ownerOfAddress(trx: Ctx['trx'], address: string) {
  const r = await one<{ owner_id: string }>(trx, sql<{ owner_id: string }>`select owner_id from inbox_address where lower(address) = lower(${address}) and status = 'active'`);
  return r?.owner_id ?? null;
}

// ───────────────────────── Reglas por remitente ─────────────────────────

export interface SenderRuleInput { sender: string; accountId?: string | null; categoryId?: string | null; contactId?: string | null }
interface RuleRow { id: string; sender: string; account_id: string | null; category_id: string | null; contact_id: string | null; status: string; created_at: unknown }
const ruleView = (r: RuleRow) => ({ id: r.id, sender: r.sender, accountId: r.account_id, categoryId: r.category_id, contactId: r.contact_id, status: r.status, createdAt: ts(r.created_at) });

export async function listSenderRules(ctx: Ctx) {
  return (await rows<RuleRow>(ctx.trx, sql<RuleRow>`select id, sender, account_id, category_id, contact_id, status, created_at from sender_rule where owner_id = ${ctx.ownerId} and status = 'active' order by lower(sender)`)).map(ruleView);
}

export async function createSenderRule(ctx: Ctx, i: SenderRuleInput) {
  if (!i.accountId && !i.categoryId && !i.contactId) throw unprocessable('VALIDATION_ERROR', 'Una regla por remitente debe fijar cuenta, categoría o contacto');
  if (i.accountId) await requireOwned(ctx, 'account', i.accountId);
  if (i.contactId) await requireOwned(ctx, 'contact', i.contactId);
  if (i.categoryId) await assertActiveCategory(ctx, i.categoryId);
  const dup = await one(ctx.trx, sql`select 1 as x from sender_rule where owner_id = ${ctx.ownerId} and status = 'active' and lower(sender) = lower(${i.sender.trim()})`);
  if (dup) throw conflict('SENDER_RULE_EXISTS', 'Ya hay una regla para ese remitente');
  const r = await one<RuleRow>(ctx.trx, sql<RuleRow>`insert into sender_rule (owner_id, sender, account_id, category_id, contact_id) values (${ctx.ownerId}, ${i.sender.trim()}, ${i.accountId ?? null}, ${i.categoryId ?? null}, ${i.contactId ?? null}) returning id, sender, account_id, category_id, contact_id, status, created_at`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'sender_rule.create', entityType: 'sender_rule', entityId: r!.id });
  return ruleView(r!);
}

export async function archiveSenderRule(ctx: Ctx, id: string) {
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`update sender_rule set status = 'archived' where owner_id = ${ctx.ownerId} and id = ${id} and status = 'active' returning id`);
  if (!r) throw notFound('SenderRule');
  return { id, status: 'archived' };
}

async function matchSenderRule(ctx: Ctx, sender: string | null) {
  if (!sender) return null;
  const s = sender.toLowerCase();
  const all = await rows<RuleRow>(ctx.trx, sql<RuleRow>`select id, sender, account_id, category_id, contact_id, status, created_at from sender_rule where owner_id = ${ctx.ownerId} and status = 'active'`);
  // La regla más específica (texto más largo) gana.
  return all.filter((r) => s.includes(r.sender.toLowerCase())).sort((a, b) => b.sender.length - a.sender.length)[0] ?? null;
}

// ───────────────────────── Uso de IA (D-27) ─────────────────────────

export async function usageSummary(ctx: Ctx, deps: CaptureDeps) {
  const day = formatISO(ctx.today);
  const today = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from usage_record where owner_id = ${ctx.ownerId} and local_day = ${day}`);
  const month = await one<{ n: string; i: string; o: string; c: string }>(ctx.trx, sql<{ n: string; i: string; o: string; c: string }>`
    select count(*) as n, coalesce(sum(tokens_in),0) as i, coalesce(sum(tokens_out),0) as o, coalesce(sum(cost_estimate),0) as c
    from usage_record where owner_id = ${ctx.ownerId} and date_trunc('month', local_day) = date_trunc('month', ${day}::date)`);
  return {
    today: { used: Number(today?.n ?? 0), limit: deps.dailyLimit },
    month: { tasks: Number(month?.n ?? 0), tokensIn: Number(month?.i ?? 0), tokensOut: Number(month?.o ?? 0), costEstimate: String(month?.c ?? '0') },
    provider: { name: deps.extractor.provider, model: deps.extractor.model },
  };
}

// ───────────────────────── Documentos ─────────────────────────

export interface IngestInput {
  origin: 'email' | 'photo' | 'pdf' | 'text';
  mime: string;
  filename?: string | null;
  bytes?: Buffer | null;
  text?: string | null;
  subject?: string | null;
  sender?: string | null;
  messageId?: string | null;
}

interface DocRow {
  id: string; origin: string; sender: string | null; subject: string | null; mime: string; filename: string | null; size_bytes: number; file_key: string | null; body_text: string | null;
  received_at: unknown; status: string; error_code: string | null; error_detail: string | null; attempts: number; file_deleted_at: unknown; version: number;
}
const docSel = sql`select id, origin, sender, subject, mime, filename, size_bytes, file_key, body_text, received_at, status, error_code, error_detail, attempts, file_deleted_at, version from source_document`;

const docView = (d: DocRow) => ({
  id: d.id, origin: d.origin, sender: d.sender, subject: d.subject, mime: d.mime, filename: d.filename, sizeBytes: d.size_bytes, hasFile: d.file_key !== null,
  receivedAt: ts(d.received_at), status: d.status, error: d.error_code ? { code: d.error_code, detail: d.error_detail } : null, attempts: d.attempts, version: d.version,
});

async function loadDoc(ctx: Ctx, id: string, lock = false) {
  const d = await one<DocRow>(ctx.trx, lock ? sql<DocRow>`${docSel} where owner_id = ${ctx.ownerId} and id = ${id} for update` : sql<DocRow>`${docSel} where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!d) throw notFound('Document');
  return d;
}

/** Recibe un documento. Una reentrega exacta no crea nada nuevo (RN-DU01). Con `process` la extracción corre en la misma petición. */
export async function ingest(ctx: Ctx, deps: CaptureDeps, i: IngestInput) {
  const size = i.bytes?.length ?? 0;
  if (size > deps.maxBytes) throw unprocessable('FILE_TOO_LARGE', `El archivo supera el máximo de ${Math.floor(deps.maxBytes / 1048576)} MB`);
  if (size === 0 && !(i.text && i.text.trim())) throw unprocessable('EMPTY_DOCUMENT', 'No hay contenido que analizar');
  const hash = contentHash({ bytes: i.bytes, text: i.text, subject: i.subject });
  const existing = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    select id from source_document where owner_id = ${ctx.ownerId} and (content_hash = ${hash} or (${i.messageId ?? null}::text is not null and message_id = ${i.messageId ?? null}))`);
  if (existing) return { duplicate: true as const, ...(await getDocument(ctx, existing.id)) };

  const id = randomUUID();
  const fileKey = size > 0 ? `${ctx.ownerId}/${id}` : null;
  if (fileKey) await deps.files.put(fileKey, i.bytes!);
  await sql`
    insert into source_document (id, owner_id, origin, content_hash, message_id, sender, subject, mime, filename, size_bytes, file_key, body_text, received_at)
    values (${id}, ${ctx.ownerId}, ${i.origin}, ${hash}, ${i.messageId ?? null}, ${i.sender?.trim() || null}, ${i.subject?.trim() || null}, ${i.mime}, ${i.filename ?? null}, ${size}, ${fileKey}, ${i.text ?? null}, ${new Date(ctx.nowMs).toISOString()})`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'capture.receive', entityType: 'source_document', entityId: id, changes: { origin: i.origin, size } });
  await processDocument(ctx, deps, id);
  return { duplicate: false as const, ...(await getDocument(ctx, id)) };
}

async function markFailed(ctx: Ctx, id: string, code: string, detail: string) {
  await sql`update source_document set status = 'failed', error_code = ${code}, error_detail = ${detail} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
}

/** Extrae y crea propuestas. Nunca modifica dinero. Un fallo deja el documento en `failed` y recuperable (07 §6.6). */
export async function processDocument(ctx: Ctx, deps: CaptureDeps, id: string) {
  const d = await loadDoc(ctx, id, true);
  if (!['received', 'failed'].includes(d.status)) throw unprocessable('DOCUMENT_NOT_PROCESSABLE', 'El documento ya fue procesado');
  await sql`update source_document set attempts = attempts + 1, status = 'received', error_code = null, error_detail = null where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);

  const day = formatISO(ctx.today);
  const used = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from usage_record where owner_id = ${ctx.ownerId} and local_day = ${day}`);
  if (Number(used?.n ?? 0) >= deps.dailyLimit) {
    await markFailed(ctx, id, 'AI_LIMIT_REACHED', 'Se alcanzó el tope diario de tareas de IA; reintenta mañana o registra a mano');
    return;
  }
  let bytes: Buffer | null = null;
  if (d.file_key) bytes = await deps.files.get(d.file_key);

  const log = (status: 'ok' | 'failed', o: { code?: string; raw?: unknown; usage?: { tokensIn: number; tokensOut: number; costEstimate: number }; provider?: string; model?: string }) =>
    sql`insert into extraction_run (owner_id, document_id, status, provider, model, tokens_in, tokens_out, cost_estimate, error_code, raw)
        values (${ctx.ownerId}, ${id}, ${status}, ${o.provider ?? deps.extractor.provider}, ${o.model ?? deps.extractor.model}, ${o.usage?.tokensIn ?? 0}, ${o.usage?.tokensOut ?? 0}, ${o.usage?.costEstimate ?? 0}, ${o.code ?? null}, ${o.raw === undefined ? null : JSON.stringify(o.raw)}::jsonb)`.execute(ctx.trx);
  const consume = (o: { usage: { tokensIn: number; tokensOut: number; costEstimate: number }; provider: string; model: string }) =>
    sql`insert into usage_record (owner_id, kind, provider, model, tokens_in, tokens_out, retries, cost_estimate, local_day)
        values (${ctx.ownerId}, 'extraction', ${o.provider}, ${o.model}, ${o.usage.tokensIn}, ${o.usage.tokensOut}, ${d.attempts}, ${o.usage.costEstimate}, ${day})`.execute(ctx.trx);

  let out;
  try {
    out = await deps.extractor.extract({ mime: d.mime, text: d.body_text, bytes, sender: d.sender, subject: d.subject, today: day });
  } catch (e) {
    const err = e instanceof ExtractorError ? e : new ExtractorError('EXTRACTOR_ERROR', 'Falló la extracción', true);
    await log('failed', { code: err.code });
    await markFailed(ctx, id, err.code, err.message);
    return;
  }
  await consume(out);
  const parsed = extractionSchema.safeParse(out.raw);
  if (!parsed.success) {
    await log('failed', { code: 'EXTRACTION_INVALID', raw: { issues: parsed.error.issues.slice(0, 10).map((x) => `${x.path.join('.')}: ${x.message}`) }, usage: out.usage, provider: out.provider, model: out.model });
    await markFailed(ctx, id, 'EXTRACTION_INVALID', 'El resultado de la IA no cumple el formato esperado; registra a mano o reintenta');
    return;
  }
  await log('ok', { raw: parsed.data, usage: out.usage, provider: out.provider, model: out.model });
  const x = parsed.data;
  if (!x.isTransaction || x.movements.length === 0) {
    await sql`update source_document set status = 'no_transaction' where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
    return;
  }
  const rule = await matchSenderRule(ctx, d.sender);
  const defAccount = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`select id from account where owner_id = ${ctx.ownerId} and is_default and status = 'active'`);
  for (const mv of x.movements) await createProposal(ctx, id, mv, x.confidence, x.warnings, { accountId: rule?.account_id ?? defAccount?.id ?? null, categoryId: rule?.category_id ?? null, contactId: rule?.contact_id ?? null });
  await sql`update source_document set status = 'proposed' where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
}

async function createProposal(ctx: Ctx, docId: string, mv: ExtractedMovement, confidence: number, warnings: string[], pre: { accountId: string | null; categoryId: string | null; contactId: string | null }) {
  const description = [mv.counterparty, mv.concept].filter(Boolean).join(' · ') || null;
  const draft = { direction: mv.direction, amount: mv.amount, occurredOn: mv.occurredOn, accountId: pre.accountId, toAccountId: null, currency: mv.currency.toUpperCase() };
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into movement_proposal (owner_id, document_id, direction, amount, currency, occurred_on, occurred_time, counterparty, channel, operation_ref, concept, suggested_category, items, account_id, category_id, contact_id, description, missing, warnings, confidence)
    values (${ctx.ownerId}, ${docId}, ${mv.direction}, ${mv.amount}, ${draft.currency}, ${mv.occurredOn}, ${mv.occurredTime}, ${mv.counterparty}, ${mv.channel}, ${mv.operationId}, ${mv.concept}, ${mv.suggestedCategory}, ${JSON.stringify(mv.items)}::jsonb,
      ${pre.accountId}, ${pre.categoryId}, ${pre.contactId}, ${description}, ${JSON.stringify(missingForAccept(draft))}::jsonb, ${JSON.stringify(warnings)}::jsonb, ${confidence}) returning id`);
  await refreshDuplicates(ctx, r!.id);
  return r!.id;
}

export async function getDocument(ctx: Ctx, id: string) {
  const d = await loadDoc(ctx, id);
  const runs = await rows<{ status: string; provider: string; model: string; tokens_in: number; tokens_out: number; error_code: string | null; created_at: unknown }>(ctx.trx, sql`
    select status, provider, model, tokens_in, tokens_out, error_code, created_at from extraction_run where owner_id = ${ctx.ownerId} and document_id = ${id} order by created_at, id`);
  const props = await rows<PropRow>(ctx.trx, sql<PropRow>`${propSel} where p.owner_id = ${ctx.ownerId} and p.document_id = ${id} order by p.created_at, p.id`);
  return {
    ...docView(d),
    runs: runs.map((r) => ({ status: r.status, provider: r.provider, model: r.model, tokensIn: r.tokens_in, tokensOut: r.tokens_out, errorCode: r.error_code, at: ts(r.created_at) })),
    proposals: await Promise.all(props.map((p) => proposalView(ctx, p))),
  };
}

export async function listDocuments(ctx: Ctx, status?: string) {
  const r = await rows<DocRow>(ctx.trx, sql<DocRow>`${docSel} where owner_id = ${ctx.ownerId} and (${status ?? null}::text is null or status = ${status ?? null}) order by received_at desc, id limit 200`);
  return r.map(docView);
}

export async function retryDocument(ctx: Ctx, deps: CaptureDeps, id: string) {
  const d = await loadDoc(ctx, id, true);
  if (d.status !== 'failed') throw unprocessable('DOCUMENT_NOT_FAILED', 'Solo se reintenta un documento fallido');
  await processDocument(ctx, deps, id);
  return getDocument(ctx, id);
}

export async function discardDocument(ctx: Ctx, id: string) {
  const d = await loadDoc(ctx, id, true);
  if (!['failed', 'no_transaction'].includes(d.status)) throw unprocessable('DOCUMENT_NOT_DISCARDABLE', 'Solo se descarta un documento fallido o sin transacción; las propuestas se descartan una a una');
  await sql`update source_document set status = 'discarded' where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'capture.discard_document', entityType: 'source_document', entityId: id });
  return getDocument(ctx, id);
}

export async function readFile(ctx: Ctx, deps: CaptureDeps, id: string) {
  const d = await loadDoc(ctx, id);
  if (!d.file_key) throw unprocessable('FILE_NOT_AVAILABLE', 'El archivo original ya no está disponible');
  return { bytes: await deps.files.get(d.file_key), mime: d.mime, filename: d.filename };
}

// ───────────────────────── Propuestas ─────────────────────────

interface PropRow {
  id: string; document_id: string; status: string; direction: 'income' | 'expense' | 'transfer'; amount: string | null; currency: string; occurred_on: string | null; occurred_time: string | null; counterparty: string | null; channel: string | null;
  operation_ref: string | null; concept: string | null; suggested_category: string | null; items: unknown; account_id: string | null; to_account_id: string | null; category_id: string | null; contact_id: string | null;
  description: string | null; missing: string[]; warnings: string[]; confidence: string | null; operation_id: string | null; version: number; doc_origin: string; doc_sender: string | null; doc_subject: string | null; created_at: unknown;
}
const propSel = sql`
  select p.id, p.document_id, p.status, p.direction, p.amount, p.currency, p.occurred_on, p.occurred_time, p.counterparty, p.channel, p.operation_ref, p.concept, p.suggested_category, p.items, p.account_id, p.to_account_id,
         p.category_id, p.contact_id, p.description, p.missing, p.warnings, p.confidence, p.operation_id, p.version, p.created_at, d.origin as doc_origin, d.sender as doc_sender, d.subject as doc_subject
  from movement_proposal p join source_document d on d.id = p.document_id and d.owner_id = p.owner_id`;

async function duplicatesOf(ctx: Ctx, proposalId: string) {
  return rows<{ other_proposal_id: string | null; operation_id: string | null; reason: string }>(ctx.trx, sql`
    select other_proposal_id, operation_id, reason from duplicate_candidate where owner_id = ${ctx.ownerId} and proposal_id = ${proposalId} order by created_at, id`);
}

async function proposalView(ctx: Ctx, p: PropRow) {
  const dups = p.status === 'pending' ? await duplicatesOf(ctx, p.id) : [];
  return {
    id: p.id, documentId: p.document_id, status: p.status, direction: p.direction, amount: p.amount === null ? null : m(p.amount), currency: p.currency, occurredOn: p.occurred_on, occurredTime: p.occurred_time ? p.occurred_time.slice(0, 5) : null,
    counterparty: p.counterparty, channel: p.channel, operationRef: p.operation_ref, concept: p.concept, suggestedCategory: p.suggested_category, items: p.items,
    accountId: p.account_id, toAccountId: p.to_account_id, categoryId: p.category_id, contactId: p.contact_id, description: p.description,
    missing: p.missing, warnings: p.warnings, confidence: p.confidence === null ? null : Number(p.confidence), canAccept: p.status === 'pending' && p.missing.length === 0,
    duplicates: dups.map((d) => ({ type: d.operation_id ? 'operation' : 'proposal', id: d.operation_id ?? d.other_proposal_id, reason: d.reason })),
    operationId: p.operation_id, source: { origin: p.doc_origin, sender: p.doc_sender, subject: p.doc_subject }, version: p.version, createdAt: ts(p.created_at),
  };
}

async function loadProposal(ctx: Ctx, id: string, lock = false) {
  const p = await one<PropRow>(ctx.trx, sql<PropRow>`${propSel} where p.owner_id = ${ctx.ownerId} and p.id = ${id}${lock ? sql` for update of p` : sql``}`);
  if (!p) throw notFound('Proposal');
  return p;
}

/** Recalcula lo que falta y las posibles coincidencias (RN-DU02) tras crear o editar una propuesta. */
async function refreshDuplicates(ctx: Ctx, id: string) {
  const p = await loadProposal(ctx, id);
  await sql`update movement_proposal set missing = ${JSON.stringify(missingForAccept({ direction: p.direction, amount: p.amount, occurredOn: p.occurred_on, accountId: p.account_id, toAccountId: p.to_account_id, currency: p.currency }))}::jsonb where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await sql`delete from duplicate_candidate where owner_id = ${ctx.ownerId} and proposal_id = ${id}`.execute(ctx.trx);
  if (p.status !== 'pending') return;
  const hm = (t: string | null) => (t ? t.slice(0, 5) : null);
  const me = { amount: p.amount === null ? null : m(p.amount), occurredOn: p.occurred_on, occurredTime: hm(p.occurred_time), operationRef: p.operation_ref, accountId: p.account_id, channel: p.channel };

  // Otras propuestas (de otro documento) pendientes o ya aceptadas.
  const others = await rows<PropRow>(ctx.trx, sql<PropRow>`${propSel} where p.owner_id = ${ctx.ownerId} and p.id <> ${id} and p.document_id <> ${p.document_id} and p.status in ('pending','accepted','linked')`);
  for (const o of others) {
    const why = duplicateReason(me, { amount: o.amount === null ? null : m(o.amount), occurredOn: o.occurred_on, occurredTime: hm(o.occurred_time), operationRef: o.operation_ref, accountId: o.account_id, channel: o.channel }, DUP_WINDOW_DAYS);
    if (!why) continue;
    // Si la otra ya generó un movimiento, la coincidencia es con ese movimiento.
    if (o.operation_id) await sql`insert into duplicate_candidate (owner_id, proposal_id, operation_id, reason) values (${ctx.ownerId}, ${id}, ${o.operation_id}, ${why})`.execute(ctx.trx);
    else await sql`insert into duplicate_candidate (owner_id, proposal_id, other_proposal_id, reason) values (${ctx.ownerId}, ${id}, ${o.id}, ${why})`.execute(ctx.trx);
  }
  // Movimientos ya registrados con el mismo importe en la misma cuenta dentro de la ventana.
  if (p.amount && p.occurred_on && p.account_id && p.direction !== 'transfer') {
    const found = await rows<{ id: string; occurred_on: string; occurred_time: string | null }>(ctx.trx, sql<{ id: string; occurred_on: string; occurred_time: string | null }>`
      select o.id, o.occurred_on, o.occurred_time from financial_operation o join account_entry e on e.owner_id = o.owner_id and e.operation_id = o.id
      where o.owner_id = ${ctx.ownerId} and o.kind = ${p.direction} and o.status = 'confirmed' and e.account_id = ${p.account_id} and abs(e.amount) = ${m(p.amount)}::numeric
        and o.occurred_on between (${p.occurred_on}::date - ${DUP_WINDOW_DAYS}::int) and (${p.occurred_on}::date + ${DUP_WINDOW_DAYS}::int)
        and not exists (select 1 from movement_proposal q where q.owner_id = o.owner_id and q.operation_id = o.id and q.document_id = ${p.document_id})
        and not exists (select 1 from duplicate_candidate d where d.owner_id = o.owner_id and d.proposal_id = ${id} and d.operation_id = o.id)
      order by o.occurred_on desc, o.id limit 20`);
    // Con hora en ambos lados la ventana es de 24 h reales; sin hora, de ±1 día.
    const ops = found.filter((o) => !p.occurred_time || !o.occurred_time || minutesApart(p.occurred_on!, p.occurred_time.slice(0, 5), o.occurred_on, o.occurred_time.slice(0, 5)) <= DUP_WINDOW_DAYS * 1440).slice(0, 5);
    for (const o of ops) await sql`insert into duplicate_candidate (owner_id, proposal_id, operation_id, reason) values (${ctx.ownerId}, ${id}, ${o.id}, 'amount_account_window')`.execute(ctx.trx);
  }
}

export async function listProposals(ctx: Ctx, status = 'pending') {
  const r = await rows<PropRow>(ctx.trx, sql<PropRow>`${propSel} where p.owner_id = ${ctx.ownerId} and p.status = ${status} order by p.created_at desc, p.id limit 200`);
  return Promise.all(r.map((p) => proposalView(ctx, p)));
}

export async function getProposal(ctx: Ctx, id: string) {
  return proposalView(ctx, await loadProposal(ctx, id));
}

export interface ProposalPatch {
  direction?: 'income' | 'expense' | 'transfer'; amount?: string | null; occurredOn?: string | null; occurredTime?: string | null; accountId?: string | null; toAccountId?: string | null;
  categoryId?: string | null; contactId?: string | null; description?: string | null;
}

export async function patchProposal(ctx: Ctx, id: string, version: number, i: ProposalPatch) {
  const p = await loadProposal(ctx, id, true);
  if (p.version !== version) throw conflict('VERSION_CONFLICT', 'La propuesta cambió; recárgala');
  if (p.status !== 'pending') throw unprocessable('PROPOSAL_NOT_PENDING', 'Solo se edita una propuesta pendiente');
  if (i.accountId) await requireOwned(ctx, 'account', i.accountId);
  if (i.toAccountId) await requireOwned(ctx, 'account', i.toAccountId);
  if (i.contactId) await requireOwned(ctx, 'contact', i.contactId);
  if (i.categoryId) await assertActiveCategory(ctx, i.categoryId);
  const has = <K extends keyof ProposalPatch>(k: K) => k in i;
  const next = {
    direction: i.direction ?? p.direction,
    amount: has('amount') ? (i.amount ? m(i.amount) : null) : p.amount,
    occurred_on: has('occurredOn') ? i.occurredOn ?? null : p.occurred_on,
    occurred_time: has('occurredTime') ? i.occurredTime ?? null : p.occurred_time,
    account_id: has('accountId') ? i.accountId ?? null : p.account_id,
    to_account_id: has('toAccountId') ? i.toAccountId ?? null : p.to_account_id,
    category_id: has('categoryId') ? i.categoryId ?? null : p.category_id,
    contact_id: has('contactId') ? i.contactId ?? null : p.contact_id,
    description: has('description') ? i.description?.trim() || null : p.description,
  };
  await sql`
    update movement_proposal set direction = ${next.direction}, amount = ${next.amount}, occurred_on = ${next.occurred_on}, occurred_time = ${next.occurred_time}, account_id = ${next.account_id}, to_account_id = ${next.to_account_id},
      category_id = ${next.category_id}, contact_id = ${next.contact_id}, description = ${next.description}
    where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await refreshDuplicates(ctx, id);
  return getProposal(ctx, id);
}

const fingerprint = (p: PropRow, dups: Array<{ id: string | null }>) => ({ version: p.version, dups: dups.map((d) => d.id).sort() });

/** Vista previa de aceptar: qué falta, qué pasaría con la cuenta y las posibles coincidencias (RN-CA05). */
export async function previewAccept(ctx: Ctx, id: string) {
  const p = await loadProposal(ctx, id);
  if (p.status !== 'pending') throw unprocessable('PROPOSAL_NOT_PENDING', 'La propuesta ya fue resuelta');
  const view = await proposalView(ctx, p);
  const balance = async (accountId: string) => parseMoney((await one<{ b: string }>(ctx.trx, sql<{ b: string }>`select coalesce(sum(amount),0) as b from account_entry where owner_id = ${ctx.ownerId} and account_id = ${accountId}`))!.b, { allowNegative: true });
  const effects: Array<{ accountId: string; before: string; after: string }> = [];
  if (view.canAccept) {
    const amount = parseMoney(p.amount!);
    const moves = p.direction === 'transfer' ? [{ a: p.account_id!, d: -amount }, { a: p.to_account_id!, d: amount }] : [{ a: p.account_id!, d: p.direction === 'income' ? amount : -amount }];
    for (const mv of moves) { const b = await balance(mv.a); effects.push({ accountId: mv.a, before: formatMoney(b), after: formatMoney(b + mv.d) }); }
  }
  const token = makePreviewToken(ctx.previewSecret, { scope: 'capture.accept', ownerId: ctx.ownerId, inputs: { id }, state: fingerprint(p, view.duplicates) }, ctx.nowMs);
  return { valid: view.canAccept, missing: view.missing, effects, duplicates: view.duplicates, proposal: view, previewToken: token };
}

export interface AcceptInput { previewToken: string; acknowledgeDuplicates?: boolean; goalDeductions?: Deduction[]; acceptReserveShortfall?: boolean }

/** Aceptar es atómico e idempotente: dos veces no duplican (RN-CA02). */
export async function acceptProposal(ctx: Ctx, id: string, i: AcceptInput) {
  const p = await loadProposal(ctx, id, true);
  if (p.status === 'accepted') return { alreadyAccepted: true, proposal: await proposalView(ctx, p), operation: await getOperation(ctx, p.operation_id!) };
  if (p.status !== 'pending') throw unprocessable('PROPOSAL_NOT_PENDING', 'La propuesta ya fue resuelta');
  const dups = await duplicatesOf(ctx, id);
  checkPreviewToken(ctx.previewSecret, i.previewToken, { scope: 'capture.accept', ownerId: ctx.ownerId, inputs: { id }, state: fingerprint(p, dups.map((d) => ({ id: d.operation_id ?? d.other_proposal_id }))) }, ctx.nowMs);
  const missing = missingForAccept({ direction: p.direction, amount: p.amount, occurredOn: p.occurred_on, accountId: p.account_id, toAccountId: p.to_account_id, currency: p.currency });
  if (missing.length > 0) throw unprocessable('PROPOSAL_INCOMPLETE', 'Faltan datos para aceptar la propuesta', { missing });
  if (dups.length > 0 && !i.acknowledgeDuplicates) throw conflict('DUPLICATE_SUSPECTED', 'Parece repetir un movimiento ya registrado o propuesto: confirma que es otra operación, o vincúlala al existente', { duplicates: dups.map((d) => ({ type: d.operation_id ? 'operation' : 'proposal', id: d.operation_id ?? d.other_proposal_id, reason: d.reason })) });

  const doc = await loadDoc(ctx, p.document_id);
  const op = await createOperation(ctx, {
    kind: p.direction, accountId: p.account_id!, ...(p.direction === 'transfer' ? { toAccountId: p.to_account_id! } : {}), amount: m(p.amount!), date: p.occurred_on!, time: p.occurred_time ? p.occurred_time.slice(0, 5) : null,
    description: p.description ?? '', categoryId: p.category_id, contactId: p.contact_id, source: SOURCE_OF[doc.origin as keyof typeof SOURCE_OF],
    ...(i.goalDeductions ? { goalDeductions: i.goalDeductions } : {}), ...(i.acceptReserveShortfall ? { acceptReserveShortfall: true } : {}),
  });
  await sql`update movement_proposal set status = 'accepted', operation_id = ${op.id}, decided_at = ${new Date(ctx.nowMs).toISOString()} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await sql`insert into evidence_link (owner_id, document_id, operation_id) values (${ctx.ownerId}, ${p.document_id}, ${op.id}) on conflict do nothing`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'capture.accept', entityType: 'movement_proposal', entityId: id, changes: { operationId: op.id } });
  return { alreadyAccepted: false, proposal: await getProposal(ctx, id), operation: op };
}

/** Une la evidencia a un movimiento existente sin crear otro (RN-DU04). */
export async function linkProposal(ctx: Ctx, id: string, operationId: string) {
  const p = await loadProposal(ctx, id, true);
  if (p.status === 'linked' && p.operation_id === operationId) return getProposal(ctx, id);
  if (p.status !== 'pending') throw unprocessable('PROPOSAL_NOT_PENDING', 'La propuesta ya fue resuelta');
  const op = await one<{ status: string; kind: string }>(ctx.trx, sql<{ status: string; kind: string }>`select status, kind from financial_operation where owner_id = ${ctx.ownerId} and id = ${operationId}`);
  if (!op) throw notFound('Operation');
  if (op.status !== 'confirmed' || !['income', 'expense', 'transfer'].includes(op.kind)) throw unprocessable('OPERATION_NOT_LINKABLE', 'Solo se vincula a un movimiento vigente de ingreso, gasto o transferencia');
  await sql`update movement_proposal set status = 'linked', operation_id = ${operationId}, decided_at = ${new Date(ctx.nowMs).toISOString()} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await sql`insert into evidence_link (owner_id, document_id, operation_id) values (${ctx.ownerId}, ${p.document_id}, ${operationId}) on conflict do nothing`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'capture.link', entityType: 'movement_proposal', entityId: id, changes: { operationId } });
  return getProposal(ctx, id);
}

/** Descartar no afecta saldos (RN-CA03). */
export async function discardProposal(ctx: Ctx, id: string) {
  const p = await loadProposal(ctx, id, true);
  if (p.status === 'discarded') return getProposal(ctx, id);
  if (p.status !== 'pending') throw unprocessable('PROPOSAL_NOT_PENDING', 'La propuesta ya fue resuelta; deshaz la aceptación primero');
  await sql`update movement_proposal set status = 'discarded', decided_at = ${new Date(ctx.nowMs).toISOString()} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'capture.discard', entityType: 'movement_proposal', entityId: id });
  return getProposal(ctx, id);
}

/** Deshacer la aceptación: revierte el movimiento y devuelve la propuesta a revisión (RN-CA04). */
export async function undoProposal(ctx: Ctx, id: string, reason: string) {
  const p = await loadProposal(ctx, id, true);
  if (!['accepted', 'linked'].includes(p.status)) throw unprocessable('PROPOSAL_NOT_RESOLVED', 'Solo se deshace una propuesta aceptada o vinculada');
  if (p.status === 'accepted') await reverseOperationCore(ctx, p.operation_id!, reason);
  await sql`delete from evidence_link where owner_id = ${ctx.ownerId} and document_id = ${p.document_id} and operation_id = ${p.operation_id!}
            and not exists (select 1 from movement_proposal q where q.owner_id = ${ctx.ownerId} and q.document_id = ${p.document_id} and q.operation_id = ${p.operation_id!} and q.id <> ${id})`.execute(ctx.trx);
  await sql`update movement_proposal set status = 'pending', operation_id = null, decided_at = null where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await refreshDuplicates(ctx, id);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'capture.undo', entityType: 'movement_proposal', entityId: id, reason });
  return getProposal(ctx, id);
}

// ───────────────────────── Conservación de originales (RN-AR) ─────────────────────────

async function deleteFile(ctx: Ctx, deps: CaptureDeps, d: { id: string; file_key: string | null }) {
  if (!d.file_key) return false;
  await deps.files.delete(d.file_key);
  await sql`update source_document set file_key = null, file_deleted_at = now() where owner_id = ${ctx.ownerId} and id = ${d.id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'capture.delete_file', entityType: 'source_document', entityId: d.id });
  return true;
}

/** Eliminar el archivo no borra movimientos ni la procedencia (RN-AR03); no se permite con propuestas pendientes (RN-AR05). */
export async function deleteDocumentFile(ctx: Ctx, deps: CaptureDeps, id: string) {
  const d = await loadDoc(ctx, id, true);
  const pending = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from movement_proposal where owner_id = ${ctx.ownerId} and document_id = ${id} and status = 'pending'`);
  if (Number(pending?.n ?? 0) > 0) throw unprocessable('DOCUMENT_HAS_PENDING', 'El documento tiene propuestas pendientes: resuélvelas antes de eliminar el archivo');
  if (!d.file_key) throw unprocessable('FILE_NOT_AVAILABLE', 'El archivo original ya no está disponible');
  await deleteFile(ctx, deps, d);
  return getDocument(ctx, id);
}

/** Elimina los originales cuya última decisión supera el plazo (90 días por defecto, D-24). */
export async function purgeExpired(ctx: Ctx, deps: CaptureDeps, olderThanDays = 90) {
  const cutoff = new Date(ctx.nowMs - olderThanDays * 86_400_000).toISOString();
  const docs = await rows<{ id: string; file_key: string | null }>(ctx.trx, sql<{ id: string; file_key: string | null }>`
    select d.id, d.file_key from source_document d
    where d.owner_id = ${ctx.ownerId} and d.file_key is not null and d.status in ('proposed','no_transaction','discarded','failed')
      and not exists (select 1 from movement_proposal p where p.document_id = d.id and p.status = 'pending')
      and coalesce((select max(p.decided_at) from movement_proposal p where p.document_id = d.id), d.received_at) < ${cutoff}::timestamptz
    order by d.id limit 500 for update of d`);
  let deleted = 0;
  for (const d of docs) if (await deleteFile(ctx, deps, d)) deleted++;
  return { deleted };
}
