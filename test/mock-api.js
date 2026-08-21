import { createServer } from 'node:http';

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export async function startMockApi(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const rawBody = await readBody(request);
    let body = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = rawBody;
    }
    const record = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
      rawBody,
    };
    requests.push(record);

    try {
      const result = await handler(record);
      if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
      response.statusCode = result.status ?? 200;
      for (const [key, value] of Object.entries(result.headers ?? {})) response.setHeader(key, value);
      response.end(result.body ?? '');
    } catch (error) {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'mock_handler_error', message: error.message }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

export function jsonResponse(value, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

export function ndjsonResponse(lines, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/x-ndjson' },
    body: `${lines.join('\n')}\n`,
  };
}
