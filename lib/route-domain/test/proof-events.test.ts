import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRouteProofEventV1,
  findDuplicateRouteProofEventV1,
  nextRouteProofEventV1,
  RouteProofEventV1Schema,
  type RouteProofEventV1,
} from '../src/index.js';
import { completedRouteProofFixture, routeProofEventHistoryFixture } from './fixtures.js';

const NOW = new Date('2026-07-18T10:00:00.000Z');

test('buildRouteProofEventV1 produces a schema-valid, hash-chained event', () => {
  const event = buildRouteProofEventV1({
    proof: completedRouteProofFixture,
    eventIndex: 0,
    previousEventHash: null,
    eventType: 'blueprint_created',
    payload: { blueprintHash: completedRouteProofFixture.blueprintHash },
    now: NOW,
  });
  assert.equal(RouteProofEventV1Schema.safeParse(event).success, true);
  assert.equal(event.eventIndex, 0);
  assert.equal(event.previousEventHash, null);
  assert.equal(event.routeProofId, completedRouteProofFixture.id);
});

test('buildRouteProofEventV1 links previousEventHash for a later index', () => {
  const first = buildRouteProofEventV1({
    proof: completedRouteProofFixture,
    eventIndex: 0,
    previousEventHash: null,
    eventType: 'blueprint_created',
    payload: { a: 1 },
    now: NOW,
  });
  const second = buildRouteProofEventV1({
    proof: completedRouteProofFixture,
    eventIndex: 1,
    previousEventHash: first.eventHash,
    eventType: 'calls_approved',
    payload: { b: 2 },
    now: NOW,
  });
  assert.equal(second.previousEventHash, first.eventHash);
  assert.equal(RouteProofEventV1Schema.safeParse(second).success, true);
});

test('findDuplicateRouteProofEventV1 matches on eventType + payloadHash only', () => {
  const events: readonly RouteProofEventV1[] = routeProofEventHistoryFixture;
  const dup = findDuplicateRouteProofEventV1(events, 'blueprint_created', {
    blueprintHash: events[0]!.payload.blueprintHash,
  });
  assert.equal(dup, events[0]);
  const notDup = findDuplicateRouteProofEventV1(events, 'blueprint_created', { blueprintHash: '0xdead' });
  assert.equal(notDup, null);
});

test('nextRouteProofEventV1 returns null for a duplicate payload (idempotent no-op)', () => {
  const events: readonly RouteProofEventV1[] = routeProofEventHistoryFixture;
  const result = nextRouteProofEventV1({
    proof: completedRouteProofFixture,
    existingEvents: events,
    eventType: events[0]!.eventType,
    payload: events[0]!.payload,
    now: NOW,
  });
  assert.equal(result, null);
});

test('nextRouteProofEventV1 builds the next hash-chained event when not a duplicate', () => {
  const events: readonly RouteProofEventV1[] = routeProofEventHistoryFixture;
  const result = nextRouteProofEventV1({
    proof: completedRouteProofFixture,
    existingEvents: events,
    eventType: 'reconciliation_updated',
    payload: { previousState: 'pending', nextState: 'matched' },
    now: NOW,
  });
  assert.ok(result);
  assert.equal(result!.eventIndex, events.length);
  assert.equal(result!.previousEventHash, events.at(-1)!.eventHash);
  assert.equal(RouteProofEventV1Schema.safeParse(result).success, true);
});
