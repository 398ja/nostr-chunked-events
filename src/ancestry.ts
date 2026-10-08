import type { AncestrySnapshotLike, SnapshotParentReference } from './types';

export const MAX_WALK = 32;

type SnapshotPool =
  | Map<string, AncestrySnapshotLike>
  | Iterable<AncestrySnapshotLike>
  | Record<string, AncestrySnapshotLike>;

function getSnapshotId(snapshot: AncestrySnapshotLike | null | undefined): string | null {
  return typeof snapshot?.snapshotId === 'string' && snapshot.snapshotId
    ? snapshot.snapshotId
    : null;
}

function getContentHash(snapshot: AncestrySnapshotLike | null | undefined): string | null {
  if (typeof snapshot?.contentHash === 'string' && snapshot.contentHash) {
    return snapshot.contentHash;
  }
  if (typeof snapshot?.payloadHash === 'string' && snapshot.payloadHash) {
    return snapshot.payloadHash;
  }
  return null;
}

function normalizeParents(snapshot: AncestrySnapshotLike | null | undefined): SnapshotParentReference[] {
  if (!Array.isArray(snapshot?.parents)) {
    return [];
  }

  return snapshot.parents
    .filter((parent) => parent && typeof parent.snapshotId === 'string' && typeof parent.contentHash === 'string')
    .map((parent) => ({
      snapshotId: parent.snapshotId,
      contentHash: parent.contentHash,
    }));
}

function snapshotKey(snapshotId: string | null | undefined, contentHash: string | null | undefined): string {
  return `${snapshotId || ''}:${contentHash || ''}`;
}

function referenceMatchesSnapshot(reference: SnapshotParentReference, snapshot: AncestrySnapshotLike): boolean {
  const snapshotId = getSnapshotId(snapshot);
  if (!snapshotId || snapshotId !== reference.snapshotId) {
    return false;
  }

  const contentHash = getContentHash(snapshot);
  return !reference.contentHash || !contentHash || reference.contentHash === contentHash;
}

function buildPoolIndex(pool: SnapshotPool | null | undefined): Map<string, AncestrySnapshotLike[]> {
  const index = new Map<string, AncestrySnapshotLike[]>();
  if (!pool) {
    return index;
  }

  const values: AncestrySnapshotLike[] =
    pool instanceof Map
      ? Array.from(pool.values())
      : Symbol.iterator in Object(pool)
        ? Array.from(pool as Iterable<AncestrySnapshotLike>)
        : Object.values(pool as Record<string, AncestrySnapshotLike>);

  for (const snapshot of values) {
    const snapshotId = getSnapshotId(snapshot);
    if (!snapshotId) {
      continue;
    }
    const existing = index.get(snapshotId);
    if (existing) {
      existing.push(snapshot);
    } else {
      index.set(snapshotId, [snapshot]);
    }
  }

  return index;
}

function resolveReference(
  reference: SnapshotParentReference,
  poolIndex: Map<string, AncestrySnapshotLike[]>,
): AncestrySnapshotLike | null {
  const candidates = poolIndex.get(reference.snapshotId) || [];
  for (const candidate of candidates) {
    if (referenceMatchesSnapshot(reference, candidate)) {
      return candidate;
    }
  }
  return null;
}

function reachesTarget(
  source: AncestrySnapshotLike,
  target: SnapshotParentReference,
  poolIndex: Map<string, AncestrySnapshotLike[]>,
  maxWalk = MAX_WALK,
): boolean {
  const visited = new Set<string>();
  let frontier = normalizeParents(source);
  let steps = 0;

  while (frontier.length > 0 && steps < maxWalk) {
    const nextFrontier: SnapshotParentReference[] = [];

    for (const parent of frontier) {
      const key = snapshotKey(parent.snapshotId, parent.contentHash);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      if (parent.snapshotId === target.snapshotId
          && (!target.contentHash || !parent.contentHash || parent.contentHash === target.contentHash)) {
        return true;
      }

      const resolved = resolveReference(parent, poolIndex);
      if (resolved) {
        nextFrontier.push(...normalizeParents(resolved));
      }
    }

    frontier = nextFrontier;
    steps += 1;
  }

  return false;
}

/**
 * Return the ordered ancestry references reachable from a snapshot.
 */
export function ancestryOf(
  snapshot: AncestrySnapshotLike,
  pool: SnapshotPool | null | undefined,
  maxWalk = MAX_WALK,
): SnapshotParentReference[] {
  const poolIndex = buildPoolIndex(pool);
  const visited = new Set<string>();
  const ancestry: SnapshotParentReference[] = [];
  let frontier = normalizeParents(snapshot);
  let steps = 0;

  while (frontier.length > 0 && steps < maxWalk) {
    const nextFrontier: SnapshotParentReference[] = [];

    for (const parent of frontier) {
      const key = snapshotKey(parent.snapshotId, parent.contentHash);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      ancestry.push(parent);

      const resolved = resolveReference(parent, poolIndex);
      if (resolved) {
        nextFrontier.push(...normalizeParents(resolved));
      }
    }

    frontier = nextFrontier;
    steps += 1;
  }

  return ancestry;
}

/**
 * Compare two snapshots using ancestry references.
 */
export function supersedesRelation(
  a: AncestrySnapshotLike,
  b: AncestrySnapshotLike,
  pool: SnapshotPool | null | undefined,
  maxWalk = MAX_WALK,
): 'a-supersedes-b' | 'b-supersedes-a' | 'divergent' | 'equal' {
  const aSnapshotId = getSnapshotId(a);
  const bSnapshotId = getSnapshotId(b);
  const aContentHash = getContentHash(a);
  const bContentHash = getContentHash(b);

  if (!aSnapshotId || !bSnapshotId) {
    return 'divergent';
  }

  if (aSnapshotId === bSnapshotId && (!aContentHash || !bContentHash || aContentHash === bContentHash)) {
    return 'equal';
  }

  const poolIndex = buildPoolIndex(pool);
  const aSupersedesB = reachesTarget(
    a,
    { snapshotId: bSnapshotId, contentHash: bContentHash || '' },
    poolIndex,
    maxWalk,
  );
  const bSupersedesA = reachesTarget(
    b,
    { snapshotId: aSnapshotId, contentHash: aContentHash || '' },
    poolIndex,
    maxWalk,
  );

  if (aSupersedesB && bSupersedesA) {
    return 'equal';
  }
  if (aSupersedesB) {
    return 'a-supersedes-b';
  }
  if (bSupersedesA) {
    return 'b-supersedes-a';
  }
  return 'divergent';
}
