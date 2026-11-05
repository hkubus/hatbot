import { z } from "zod";

/** A secret kept in Hatbot, by name; its value is only ever shown to you. */
export type KeptSecret = { name: string; setAt: string };

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const SecretName = z
  .string()
  .regex(SECRET_NAME, "A name in capitals, digits and underscores, like GITEA_TOKEN.");
export const SecretValue = z.string().min(1, "Enter it first.").max(20_000);
export const SetSecret = z.object({ value: SecretValue });

/** Where a kept secret goes in a file's text; the brain puts the value in as it writes. */
export const secretPlaceholder = (name: string) => `{{secret:${name}}}`;

/** The names `text` puts secrets in by, each once. */
export function secretsIn(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\{\{secret:([A-Z][A-Z0-9_]{0,63})\}\}/g)].map((m) => m[1] as string),
    ),
  ];
}
