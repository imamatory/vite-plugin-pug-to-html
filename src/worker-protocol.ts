import type { ModuleSpec } from './compiler.js';
import type { PugToHtmlPugOptions } from './types.js';

/** `workerData` of a compile worker. */
export interface WorkerData {
  templateParams: ModuleSpec;
  filters: ModuleSpec;
  pugOptions: PugToHtmlPugOptions;
}

export interface WorkerRequest {
  id: number;
  filePath: string;
}

export type WorkerMessage =
  | { id: number; html: string; dependencies: string[] }
  | { id: number; error: { message: string; stack?: string | undefined } };
