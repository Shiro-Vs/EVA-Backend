// Cuenta de identidad (Supabase Auth). Eliminar los datos de EVA no elimina el usuario del proveedor de identidad: para eso hace falta la
// clave de servicio, que vive SOLO en el servidor (nunca en la app) y es opcional.

export interface IdentityAdmin {
  /** Devuelve true si el proveedor eliminó (o ya no tenía) al usuario. */
  deleteUser(userId: string): Promise<boolean>;
}

export function createSupabaseAdmin(o: { url: string; serviceKey: string; fetchFn?: typeof fetch }): IdentityAdmin {
  const f = o.fetchFn ?? fetch;
  const base = o.url.replace(/\/+$/, '');
  return {
    async deleteUser(userId) {
      try {
        const res = await f(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', headers: { apikey: o.serviceKey, authorization: `Bearer ${o.serviceKey}` }, signal: AbortSignal.timeout(15_000) });
        return res.ok || res.status === 404;
      } catch {
        return false;
      }
    },
  };
}

/** Sin clave de servicio (desarrollo, pruebas): no hay nada que borrar fuera de EVA. */
export const noIdentityAdmin: IdentityAdmin = { async deleteUser() { return false; } };
