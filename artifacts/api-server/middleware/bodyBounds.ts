import type { NextFunction, Request, Response } from 'express';

// ---------------------------------------------------------------------------
// How many members a request body may hold (audit SUP-4).
//
// A schema checks an array element by element and keeps an issue for every one
// that fails. A body of 100 kb can hold 51,200 elements: measured on
// 2026-11-10, one such request cost 20 MB of heap and 179 ms of CPU, with the
// schema's own `.max(20)` in place, because the length is only checked after
// the elements. Six a second hold the API's event loop.
//
// zod 4.6.6 stops an oversized array before its elements, but only where the
// schema names a maximum, and the version this API runs has no such fix. So
// the bound is set here, once, before any schema reads the body: no route of
// ours is sent anything near it.
// ---------------------------------------------------------------------------

/** Array elements and object entries a request body may hold in all, at every depth together. */
export const REQUEST_BODY_MAX_MEMBERS_V1 = 5_000;

/**
 * Counts the members of a parsed JSON value: every array element and every object entry, at any depth.
 * Stops as soon as the count passes `limit`, so an oversized body costs no more than the limit to refuse.
 */
export function bodyMembersV1(value: unknown, limit: number): number {
  let count = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== 'object' || current === null) continue;
    const members = Array.isArray(current) ? current : Object.values(current);
    count += members.length;
    if (count > limit) return count;
    for (const member of members) {
      if (typeof member === 'object' && member !== null) pending.push(member);
    }
  }
  return count;
}

/** Refuses a body with more members than any route reads, before a schema is asked about it. */
export function boundedBody(limit: number = REQUEST_BODY_MAX_MEMBERS_V1) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (bodyMembersV1(req.body, limit) > limit) {
      res.status(413).json({ error: 'request_body_too_many_members', code: 'request_body_too_many_members' });
      return;
    }
    next();
  };
}
