// End-to-end test for the /v1/responses -> /v1/chat/completions bridge.
// Tests both non-streaming and streaming bridge, including reasoning preservation.
import http from 'http';
import express from 'express';
import { loadConfig } from '../config';
import { Logger } from '../logger';
import { ModelRegistry } from '../models';
import { ThinkingConverter } from '../thinking';
import { ResponsesBridge } from '../responses-bridge';
import { GatewayProxy, type GatewayRequest } from '../proxy';

const bridgeConverter = new ResponsesBridge();

// --- Unit tests for the converters ------------------------------------------
const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, cond: unknown, detail?: string): void {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : ' :: ' + detail));
}

// requestToChatCompletions: simple string input + instructions
{
  const out = bridgeConverter.requestToChatCompletions({
    model: 'x',
    instructions: 'be nice',
    input: 'hello',
    max_output_tokens: 100,
    temperature: 0.5,
    stream: false,
  });
  check('req: instructions -> system message', out.messages![0].role === 'system' && out.messages![0].content === 'be nice', JSON.stringify(out.messages![0]));
  check('req: string input -> user message', out.messages![1].role === 'user' && out.messages![1].content === 'hello', JSON.stringify(out.messages![1]));
  check('req: max_output_tokens -> max_completion_tokens', out.max_completion_tokens === 100 && out.max_tokens === undefined, JSON.stringify(out));
  check('req: temperature passthrough', out.temperature === 0.5, JSON.stringify(out));
  check('req: model preserved', out.model === 'x', JSON.stringify(out));
  check('req: no input field leaked', out.input === undefined, JSON.stringify(out));
}

// requestToChatCompletions: item array with multimodal + tools + tool_choice
{
  const out = bridgeConverter.requestToChatCompletions({
    model: 'x',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this' },
          { type: 'input_image', image_url: 'data:image/png;x' },
        ],
      },
    ],
    tools: [
      { type: 'function', name: 'get_weather', description: 'weather', parameters: { type: 'object' }, strict: true },
    ],
    tool_choice: { type: 'function', name: 'get_weather' },
    text: { format: { type: 'json_schema', json_schema: { name: 'p', schema: {} } } },
    reasoning: { effort: 'medium' },
  });
  const um = out.messages![0];
  check('req: multimodal input_text -> text part', (um.content as Array<{ type: string; text: string }>)[0].type === 'text' && (um.content as Array<{ type: string; text: string }>)[0].text === 'what is this', JSON.stringify((um.content as unknown[])[0]));
  check('req: multimodal input_image -> image_url part', (um.content as Array<{ type: string; image_url: { url: string } }>)[1].type === 'image_url' && (um.content as Array<{ type: string; image_url: { url: string } }>)[1].image_url.url === 'data:image/png;x', JSON.stringify((um.content as unknown[])[1]));
  check('req: tools internally-tagged -> externally-tagged', out.tools![0].type === 'function' && (out.tools![0].function as { name: string; strict: boolean }).name === 'get_weather' && (out.tools![0].function as { name: string; strict: boolean }).strict === true, JSON.stringify(out.tools));
  check('req: tool_choice specific fn shape', (out.tool_choice as { type: string; function: { name: string } }).type === 'function' && (out.tool_choice as { type: string; function: { name: string } }).function.name === 'get_weather', JSON.stringify(out.tool_choice));
  check('req: text.format -> response_format', out.response_format && (out.response_format as { type: string; json_schema: { name: string } }).type === 'json_schema' && (out.response_format as { type: string; json_schema: { name: string } }).json_schema.name === 'p', JSON.stringify(out.response_format));
  check('req: reasoning.effort -> reasoning_effort', out.reasoning_effort === 'medium', JSON.stringify(out));
}

// requestToChatCompletions: function_call + function_call_output grouping
{
  const out = bridgeConverter.requestToChatCompletions({
    model: 'x',
    input: [
      { type: 'message', role: 'user', content: 'weather?' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"loc":"sf"}' },
      { type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
      { type: 'function_call_output', call_id: 'call_2', output: 'noon' },
    ],
  });
  check('req: user message first', out.messages![0].role === 'user', JSON.stringify(out.messages![0]));
  check('req: two function_calls grouped into one assistant message', out.messages![1].role === 'assistant' && Array.isArray(out.messages![1].tool_calls) && out.messages![1].tool_calls!.length === 2, JSON.stringify(out.messages![1]));
  check('req: function_call_output -> role:tool messages',
    out.messages![2].role === 'tool' && out.messages![2].tool_call_id === 'call_1' && out.messages![2].content === 'sunny' &&
    out.messages![3].role === 'tool' && out.messages![3].tool_call_id === 'call_2' && out.messages![3].content === 'noon',
    JSON.stringify(out.messages!.slice(2)));
}

// responseFromChatCompletions: text answer
{
  const out = bridgeConverter.responseFromChatCompletions({
    id: 'chatcmpl-1', object: 'chat.completion', created: 1234567890, model: 'gpt-5',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'Hi there!' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  })!;
  check('resp: object=response', out.object === 'response', JSON.stringify(out));
  check('resp: created_at from created', out.created_at === 1234567890, JSON.stringify(out));
  check('resp: status from finish_reason', out.status === 'completed', JSON.stringify(out));
  check('resp: message output item', out.output.some((i) => i.type === 'message' && (i.content![0] as { type: string; text: string }).type === 'output_text' && (i.content![0] as { type: string; text: string }).text === 'Hi there!'), JSON.stringify(out.output));
  check('resp: output_text helper', out.output_text === 'Hi there!', JSON.stringify(out));
  check('resp: usage token rename', out.usage!.input_tokens === 5 && out.usage!.output_tokens === 3 && out.usage!.total_tokens === 8, JSON.stringify(out.usage));
  check('resp: id has resp_ prefix', /^resp_/.test(out.id), out.id);
}

// responseFromChatCompletions: tool calls
{
  const out = bridgeConverter.responseFromChatCompletions({
    id: 'chatcmpl-2', object: 'chat.completion', created: 1, model: 'gpt-5',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"loc":"sf"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
  })!;
  check('resp: function_call output item present', out.output.some((i) => i.type === 'function_call' && i.call_id === 'call_1' && i.name === 'get_weather' && i.arguments === '{"loc":"sf"}'), JSON.stringify(out.output));
  check('resp: no empty message item when only tool_calls', !out.output.some((i) => i.type === 'message'), JSON.stringify(out.output));
}

// responseFromChatCompletions: reasoning from <thinking> conversion
{
  const out = bridgeConverter.responseFromChatCompletions({
    id: 'c3', object: 'chat.completion', created: 1, model: 'gpt-5',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'final answer',
        reasoning: 'thoughts',
        reasoning_details: [
          { type: 'reasoning.text', text: 'thoughts', format: 'unknown', index: 0 },
        ],
      },
      finish_reason: 'stop',
    }],
  })!;
  const rs = out.output.find((i) => i.type === 'reasoning');
  check('resp: reasoning item emitted from reasoning_details', !!rs && rs.summary![0].type === 'summary_text' && rs.summary![0].text === 'thoughts', JSON.stringify(out.output));
  const msg = out.output.find((i) => i.type === 'message');
  check('resp: message content preserved alongside reasoning', !!msg && (msg.content![0] as { text: string }).text === 'final answer', JSON.stringify(out.output));
}

console.log('\n--- end-to-end bridge tests ---');

// --- End-to-end: real proxy + bridge middleware -----------------------------
// Patch two test models into config: one bridged, one native-responses.
const config = loadConfig();
config.models.mappings['__bridge_test_chat'] = { upstream: 'upstream-chat', contextWindow: 8000 };
config.models.mappings['__bridge_test_native'] = { upstream: 'upstream-native', contextWindow: 8000, responses: true };

type PendingHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Record<string, unknown>,
) => void;
let pending: PendingHandler | null = null;

const upstream = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => (buf += c));
  req.on('end', () => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(buf || '{}');
    } catch (_) {
      /* keep empty */
    }
    const h = pending;
    pending = null;
    if (!h) {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    h(req, res, body);
  });
});

// Build a short, deterministic description of the translated request so the
// e2e test can assert the bridge actually translated fields. Concatenates
// every message's role + a short content snippet.
function describe(body: { messages?: Array<{ role: string; content?: unknown }> }): string {
  if (!Array.isArray(body.messages)) return 'no-messages';
  return body.messages
    .map((m) => {
      const c = typeof m.content === 'string' ? (m.content as string).slice(0, 20) : 'parts';
      return m.role + ':' + c;
    })
    .join(',');
}

upstream.listen(0, async () => {
  config.upstream = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

  const logger = new Logger();
  const models = new ModelRegistry(config.models);
  const thinking = new ThinkingConverter();
  const proxy = new GatewayProxy(config, logger, models, thinking, bridgeConverter);

  const app = express();
  app.use('/v1', express.json({ limit: '100mb' }));
  // Inline the gateway.ts bridge middleware (so we don't import the whole
  // Gateway class which would call app.listen at start()).
  app.post('/v1/responses', (req, res, next) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') return next();
    const model = typeof body.model === 'string' ? body.model : null;
    if (!model) return next();
    if (models.usesResponsesEndpoint(model)) return next();
    const gwReq = req as GatewayRequest;
    try {
      req.body = bridgeConverter.requestToChatCompletions(body);
      gwReq.__gatewayRewritePath = '/chat/completions';
      gwReq.__gatewayResponsesBridge = true;
      if (body.stream === true) {
        gwReq.__gatewayStreamBridge = true;
      }
    } catch (err) {
      return res.status(400).json({ error: { type: 'invalid_request_error', message: 'Bridge translation failed' } });
    }
    next();
  });
  app.use('/v1', proxy.createMiddleware());

  const gateway = http.createServer(app);
  await new Promise<void>((r) => gateway.listen(0, r));
  const gwPort = (gateway.address() as { port: number }).port;

  // Re-spin mock upstream handlers per test.
  // 1) chat completions upstream
  const chatHandler: PendingHandler = (_req, res, body) => {
    json(res, {
      id: 'chatcmpl-e2e',
      object: 'chat.completion',
      created: 1700000000,
      model: (body.model as string) || 'echo',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'echo:' + describe(body as { messages?: Array<{ role: string; content?: unknown }> }) },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
    });
  };
  const responsesHandler: PendingHandler = (_req, res, body) => {
    json(res, {
      id: 'resp_native', object: 'response', created_at: 1700000000, model: (body.model as string) || 'echo',
      output: [{
        type: 'message', id: 'msg_x', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'native-responses-echo', annotations: [] }],
      }],
    });
  };

  function json(res: http.ServerResponse, obj: unknown, status = 200): void {
    const s = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  }

  async function call(path: string, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${gwPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // 1) Bridged model: client sends /v1/responses, upstream sees /v1/chat/completions
  pending = chatHandler;
  {
    const r = await call('/v1/responses', {
      model: 'anthropic/__bridge_test_chat',
      instructions: 'sys',
      input: 'hi',
    });
    const j = (await r.json()) as {
      object: string;
      status: string;
      output: Array<{ type: string; content?: Array<{ text: string }> }>;
      output_text?: string;
      usage?: { input_tokens: number; output_tokens: number };
    };
    check('e2e: bridged response object=response', j.object === 'response', JSON.stringify(j));
    check('e2e: bridged output has message item with translated text',
      j.output && j.output.some((i) => i.type === 'message' && /^echo:/.test(i.content![0].text)),
      JSON.stringify(j));
    check('e2e: bridged usage token rename',
      j.usage && j.usage.input_tokens === 7 && j.usage.output_tokens === 11,
      JSON.stringify(j.usage));
    check('e2e: bridged status completed', j.status === 'completed', JSON.stringify(j));
    const text = j.output.find((i) => i.type === 'message')!.content![0].text;
    check('e2e: translated body reached upstream as chat completion',
      text.includes('system:sys') && text.includes('user:hi'), text);
  }

  // 2) Native-responses model: passthrough, upstream sees /v1/responses
  pending = responsesHandler;
  {
    const r = await call('/v1/responses', {
      model: 'anthropic/__bridge_test_native',
      input: 'hi',
    });
    const j = (await r.json()) as { id: string; output: Array<{ content: Array<{ text: string }> }> };
    check('e2e: native passthrough preserves id', j.id === 'resp_native', JSON.stringify(j));
    check('e2e: native passthrough preserves content',
      j.output && j.output[0].content[0].text === 'native-responses-echo', JSON.stringify(j));
  }

  // 3) Bridged model with <thinking> in upstream chat response (module-level)
  {
    const chatBody = {
      id: 'c', object: 'chat.completion', created: 1, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: '<thinking>plan</thinking>done' }, finish_reason: 'stop' }],
    };
    thinking.applyToChatCompletion(chatBody);
    const out = bridgeConverter.responseFromChatCompletions(chatBody)!;
    const rs = out.output.find((i) => i.type === 'reasoning');
    const msg = out.output.find((i) => i.type === 'message');
    check('e2e: bridge + thinking emits reasoning item',
      rs && rs.summary![0].text === 'plan', JSON.stringify(out.output));
    check('e2e: bridge + thinking keeps stripped message text',
      msg && (msg.content![0] as { text: string }).text === 'done', JSON.stringify(out.output));
  }

  // --- Streaming bridge tests ---
  console.log('\n--- streaming bridge tests ---');

  type StreamPendingHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let streamPending: StreamPendingHandler | null = null;

  // For streaming, the upstream responds immediately (doesn't wait for body)
  const streamUpstream = http.createServer((req, res) => {
    const h = streamPending;
    streamPending = null;
    if (!h) {
      res.writeHead(404);
      res.end();
      return;
    }
    h(req, res);
  });

  await new Promise<void>((r) => streamUpstream.listen(0, r));
  config.upstream = `http://127.0.0.1:${(streamUpstream.address() as { port: number }).port}`;

  const streamGateway = http.createServer(app);
  await new Promise<void>((r) => streamGateway.listen(0, r));
  const streamGwPort = (streamGateway.address() as { port: number }).port;

  async function readSse(resp: Response): Promise<Array<{ type: string; [k: string]: unknown }>> {
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        // Parse data: lines
        for (const line of raw.split('\n')) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              events.push(JSON.parse(data));
            } catch (_) { /* skip */ }
          }
        }
      }
    }
    return events;
  }

  function chatSse(res: http.ServerResponse, chunks: string[]): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const c of chunks) res.write(c);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  // Streaming test 1: basic text response
  streamPending = (_req, res) => {
    chatSse(res, [
      `data: ${JSON.stringify({ id: 'sc1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'sc1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'sc1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${streamGwPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/__bridge_test_chat', input: 'hi', stream: true }),
    });
    const events = await readSse(r);
    const types = events.map((e) => e.type);
    check('stream: response.created emitted', types.includes('response.created'), JSON.stringify(types));
    check('stream: response.in_progress emitted', types.includes('response.in_progress'), JSON.stringify(types));
    check('stream: response.completed emitted', types.includes('response.completed'), JSON.stringify(types));
    const contentDelta = events.find((e) => e.type === 'response.output_text.delta');
    check('stream: output_text_delta has content',
      !!(contentDelta && (contentDelta as { delta?: string })?.delta === 'Hello'),
      JSON.stringify(contentDelta));
  }

  // Streaming test 2: reasoning from <thinking> conversion
  streamPending = (_req, res) => {
    chatSse(res, [
      `data: ${JSON.stringify({ id: 'sc2', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'sc2', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { reasoning_content: 'thinking text', reasoning_details: [{ type: 'reasoning.text', text: 'thinking text', format: 'unknown', index: 0 }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'sc2', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'final' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'sc2', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${streamGwPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/__bridge_test_chat', input: 'think', stream: true }),
    });
    const events = await readSse(r);
    const reasoningDelta = events.find((e) => e.type === 'response.reasoning_text.delta');
    check('stream: reasoning_delta emitted',
      !!(reasoningDelta && (reasoningDelta as { delta?: string })?.delta === 'thinking text'),
      JSON.stringify(reasoningDelta));
    const contentDelta = events.find((e) => e.type === 'response.output_text.delta');
    check('stream: content after reasoning preserved',
      !!(contentDelta && (contentDelta as { delta?: string })?.delta === 'final'),
      JSON.stringify(contentDelta));
  }

  // Streaming test 3: tool calls preserved
  streamPending = (_req, res) => {
    chatSse(res, [
      `data: ${JSON.stringify({ id: 'sc3', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'sc3', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{"loc' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'sc3', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '":"ny"}' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'sc3', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${streamGwPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/__bridge_test_chat', input: 'weather', stream: true }),
    });
    const events = await readSse(r);
    const fnStart = events.find((e) => e.type === 'response.output_item.added' && (e.item as { type?: string })?.type === 'function_call');
    check('stream: function_call output_item added',
      !!(fnStart && (fnStart.item as { name?: string })?.name === 'get_weather'),
      JSON.stringify(fnStart));
    const jsonDelta = events.find((e) => e.type === 'response.function_call_arguments.delta');
    check('stream: function_call_arguments.delta emitted', !!jsonDelta, JSON.stringify(jsonDelta));
    const status = events.find((e) => e.type === 'response.completed');
    check('stream: completed with tool_calls status',
      !!(status && (status.response as { status?: string })?.status === 'completed'),
      JSON.stringify(status));
  }

  // Streaming test 4: reasoning + tool calls together
  streamPending = (_req, res) => {
    chatSse(res, [
      `data: ${JSON.stringify({ id: 'sc4', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'sc4', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { reasoning_content: 'analyzing' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'sc4', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_y', type: 'function', function: { name: 'search', arguments: '{}' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'sc4', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${streamGwPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/__bridge_test_chat', input: 'search', stream: true }),
    });
    const events = await readSse(r);
    const reasoningDelta = events.find((e) => e.type === 'response.reasoning_text.delta');
    check('stream: reasoning + tools: reasoning_delta emitted',
      !!(reasoningDelta && (reasoningDelta as { delta?: string })?.delta === 'analyzing'),
      JSON.stringify(reasoningDelta));
    const fnStart = events.find((e) => e.type === 'response.output_item.added' && (e.item as { type?: string })?.type === 'function_call');
    check('stream: reasoning + tools: function_call present', !!fnStart, JSON.stringify(fnStart));
  }

  await Promise.all([
    new Promise<void>((r) => streamGateway.close(() => r())),
    new Promise<void>((r) => streamUpstream.close(() => r())),
  ]);

  await Promise.all([
    new Promise<void>((r) => gateway.close(() => r())),
    new Promise<void>((r) => upstream.close(() => r())),
  ]);
  const failed = results.filter((x) => !x.ok);
  console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL PASS'));
  process.exitCode = failed.length ? 1 : 0;
});
