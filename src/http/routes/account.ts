import type { FastifyInstance } from 'fastify';
import * as account from '../../application/account.js';
import { parse, withCtx, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

/** Eliminar mi cuenta y todos mis datos (09 §8). */
export function accountRoutes(app: FastifyInstance, deps: HttpDeps) {
  app.get('/me/deletion/preview', async (req) => withCtx(deps, req, (ctx) => account.previewDeletion(ctx)));
  app.post('/me/deletion', async (req) => {
    const b = parse(s.accountDelete, req.body);
    const userId = req.user!.userId;
    const done = await withCtx(deps, req, (ctx) => account.deleteAccount(ctx, { files: deps.capture.files }, b));
    // Después de confirmar el borrado de los datos, se pide al proveedor de identidad que elimine también al usuario (si hay clave de servicio).
    const identityDeleted = await deps.identity.deleteUser(userId);
    req.log.info({ userId, rows: done.rows, files: done.files, identityDeleted }, 'account deleted');
    return { ...done, identityDeleted };
  });
}
