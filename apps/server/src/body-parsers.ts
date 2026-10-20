import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * Bodyless POSTs (workspace actions, image pull, …) must not fail because a reverse proxy adds a
 * Content-Type to them: an empty body is accepted with any type; non-empty bodies keep the usual rules.
 */
export function tolerateEmptyBodies(app: FastifyInstance) {
  const json = app.getDefaultJsonParser('error', 'ignore');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '') return done(null, undefined);
    json(req, body as string, done);
  });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    if ((body as Buffer).length === 0) return done(null, undefined);
    const err = new Error('Unsupported Media Type') as FastifyError;
    err.statusCode = 415;
    err.code = 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
    done(err, undefined);
  });
}
