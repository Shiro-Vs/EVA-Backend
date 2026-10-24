// Puertos de la captura (D-52): el núcleo no conoce a Gemini, al proveedor de correo ni al almacenamiento concreto.

export interface ExtractInput {
  mime: string;
  /** Cuerpo del correo o texto pegado: dato NO confiable, se analiza, nunca se obedece (07 §6.2). */
  text?: string | null;
  bytes?: Buffer | null;
  sender?: string | null;
  subject?: string | null;
  /** Fecha local de hoy, para resolver "ayer" o fechas sin año. */
  today: string;
}

export interface ExtractUsage { tokensIn: number; tokensOut: number; costEstimate: number }

export interface ExtractOutput {
  /** JSON sin validar: el servidor lo valida con `extractionSchema` antes de proponer. */
  raw: unknown;
  usage: ExtractUsage;
  provider: string;
  model: string;
}

/** Error de un proveedor de extracción. `recoverable`: el usuario puede reintentar más tarde o registrar a mano. */
export class ExtractorError extends Error {
  constructor(public readonly code: string, message: string, public readonly recoverable = true) {
    super(message);
  }
}

export interface Extractor {
  readonly provider: string;
  readonly model: string;
  extract(input: ExtractInput): Promise<ExtractOutput>;
}

/** Almacenamiento privado por propietario (RN-AR04). Las claves las genera el servidor. */
export interface FileStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
