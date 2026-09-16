import { createHash } from 'node:crypto';

/**
 * Git blob object id of a UTF-8 text. Remote tree entries carry the same id, so a file whose id is
 * unchanged since the last sync never has to be downloaded again.
 */
export function gitBlobSha(text: string): string {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest('hex');
}
