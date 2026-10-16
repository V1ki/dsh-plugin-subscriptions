type Schema = Record<string, unknown>;
/** Detach and normalize one tool's root object without changing the registry schema. */
export declare function antigravityToolParameters(parameters: Schema, legacy: boolean): Schema;
export {};
