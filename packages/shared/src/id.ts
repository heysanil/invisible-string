/**
 * House id convention: `<2-letter-prefix>_<16 lowercase-alnum nanoid>`.
 * 16 chars over a 36-symbol alphabet is the medium-volume tier; new product
 * tables use this instead of uuid PKs (see the connectors redesign spec §3).
 */
import { customAlphabet } from "nanoid";

export const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

const generate = customAlphabet(ID_ALPHABET, 16);

export function newId(prefix: string): string {
  return `${prefix}_${generate()}`;
}
