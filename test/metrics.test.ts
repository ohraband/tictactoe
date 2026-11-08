import test from 'node:test';
import assert from 'node:assert/strict';
import { start, sleep } from './helpers.ts';

test('metrics are exposed in Prometheus format', async () => {
  const t = await start();
  try {
    await t.post('/api/rooms');
    await fetch(t.base + '/api/health');
    await sleep(100); // request metrics are recorded when the response closes
    const text = await t.app.renderMetrics();
    assert.match(text, /# TYPE tictactoe_http_requests_total counter/);
    assert.match(text, /tictactoe_http_requests_total\{method="POST",route="room_create",status="201"\} 1/);
    assert.match(text, /tictactoe_rooms_created_total 1/);
    assert.match(text, /tictactoe_rooms_active 1/);
    assert.match(text, /tictactoe_http_request_duration_seconds_bucket\{le="\+Inf",route="health"\} 1/);
    assert.match(text, /process_resident_memory_bytes \d+/);
  } finally { await t.stop(); }
});
