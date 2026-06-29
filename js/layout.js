// layout.js — pure geometry for a top-down descendant family tree.
// No DOM, no dependencies. Given the family data, returns node positions
// plus the connectors (marriage lines and parent→child links) to draw.

export const NODE_W = 204;
export const NODE_H = 92;
const H_GAP = 22; // horizontal gap between sibling sub-trees
const COUPLE_GAP = 22; // gap between two spouses in a couple
const V_GAP = 76; // vertical gap between generations
export const ROW_H = NODE_H + V_GAP;

// Build quick lookup maps from the flat relationship list.
export function buildIndex(data) {
  const people = new Map((data.people || []).map((p) => [p.id, p]));
  const spouse = new Map();
  const children = new Map();
  const parents = new Map();
  const push = (m, k, v) => {
    if (!m.has(k)) m.set(k, []);
    if (!m.get(k).includes(v)) m.get(k).push(v);
  };
  for (const r of data.relationships || []) {
    if (r.type === 'spouse' && people.has(r.a) && people.has(r.b)) {
      push(spouse, r.a, r.b);
      push(spouse, r.b, r.a);
    } else if (r.type === 'parent' && people.has(r.parent) && people.has(r.child)) {
      push(children, r.parent, r.child);
      push(parents, r.child, r.parent);
    }
  }
  return {
    people,
    spousesOf: (id) => (spouse.get(id) || []).filter((x) => people.has(x)),
    childrenOf: (id) => (children.get(id) || []).filter((x) => people.has(x)),
    parentsOf: (id) => (parents.get(id) || []).filter((x) => people.has(x)),
  };
}

function birthYear(p) {
  const m = /\d{4}/.exec(p && p.birth ? String(p.birth) : '');
  return m ? parseInt(m[0], 10) : 9999;
}

// Main entry. Returns { nodes, couples, groups, bbox }.
//   nodes:   [{ id, x, y, depth }]            top-left corner of each box
//   couples: [{ a, b }]                       spouse pairs drawn side by side
//   groups:  [{ focus, spouse, children:[] }] a parent (or couple) and its kids
export function computeLayout(data) {
  const idx = buildIndex(data);
  const { people, spousesOf, childrenOf, parentsOf } = idx;

  const visited = new Set();
  const couples = [];
  const groups = [];
  const relX = new Map(); // id -> x (filled during recursion, root offset added later)
  const depthOf = new Map();

  const primarySpouse = (id) => spousesOf(id)[0] || null;

  // Recursively lay out the descendant sub-tree rooted at `focusId`.
  // Returns { id, width, anchorX } where anchorX is the x of the focus box's
  // centre (relative to this sub-tree's left edge = 0).
  function layout(focusId, depth) {
    visited.add(focusId);
    depthOf.set(focusId, depth);

    const sp = primarySpouse(focusId);
    const hasSpouse = sp && !visited.has(sp);
    if (hasSpouse) {
      visited.add(sp);
      depthOf.set(sp, depth);
    }
    const coupleW = hasSpouse ? NODE_W * 2 + COUPLE_GAP : NODE_W;

    const kids = childrenOf(focusId).filter((c) => !visited.has(c));

    if (kids.length === 0) {
      relX.set(focusId, 0);
      if (hasSpouse) {
        relX.set(sp, NODE_W + COUPLE_GAP);
        couples.push({ a: focusId, b: sp });
      }
      return { id: focusId, width: coupleW, anchorX: NODE_W / 2 };
    }

    // Pack children left-to-right.
    let cursor = 0;
    const placed = [];
    for (const c of kids) {
      if (visited.has(c)) continue;
      const r = layout(c, depth + 1);
      placed.push({ r, offset: cursor });
      shiftSubtree(c, cursor); // bake this child's offset into stored x's
      cursor += r.width + H_GAP;
    }

    if (placed.length === 0) {
      relX.set(focusId, 0);
      if (hasSpouse) {
        relX.set(sp, NODE_W + COUPLE_GAP);
        couples.push({ a: focusId, b: sp });
      }
      return { id: focusId, width: coupleW, anchorX: NODE_W / 2 };
    }

    const childrenWidth = cursor - H_GAP;
    const centers = placed.map(({ r, offset }) => offset + r.anchorX);
    const childMid = (centers[0] + centers[centers.length - 1]) / 2;

    let coupleLeft = childMid - coupleW / 2;
    let childShift = 0;
    if (coupleLeft < 0) {
      childShift = -coupleLeft;
      coupleLeft = 0;
    }
    if (childShift > 0) {
      for (const { r } of placed) shiftSubtree(r.id, childShift);
    }

    relX.set(focusId, coupleLeft);
    if (hasSpouse) {
      relX.set(sp, coupleLeft + NODE_W + COUPLE_GAP);
      couples.push({ a: focusId, b: sp });
    }
    groups.push({ focus: focusId, spouse: hasSpouse ? sp : null, children: placed.map(({ r }) => r.id) });

    const width = Math.max(coupleLeft + coupleW, childrenWidth + childShift);
    return { id: focusId, width, anchorX: coupleLeft + NODE_W / 2 };
  }

  // Move an already-laid-out sub-tree (everything below & including `rootId`)
  // by dx. We only track which ids belong to a sub-tree via descendants walk.
  function shiftSubtree(rootId, dx) {
    if (dx === 0) return;
    for (const id of subtreeIds(rootId)) {
      if (relX.has(id)) relX.set(id, relX.get(id) + dx);
    }
  }

  // Collect every id placed as part of rootId's sub-tree (focus, its spouse,
  // and all descendants + their spouses).
  const subtreeCache = new Map();
  function subtreeIds(rootId) {
    if (subtreeCache.has(rootId)) return subtreeCache.get(rootId);
    const out = new Set();
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop();
      if (out.has(id)) continue;
      out.add(id);
      const sp = primarySpouse(id);
      if (sp && relX.has(sp) && depthOf.get(sp) === depthOf.get(id)) out.add(sp);
      for (const c of childrenOf(id)) if (relX.has(c)) stack.push(c);
    }
    subtreeCache.set(rootId, out);
    return out;
  }

  // Roots = people with no parents, who aren't the inline spouse of someone
  // who DOES have parents (that person is drawn under their own parents).
  const roots = [...people.values()]
    .filter((p) => parentsOf(p.id).length === 0)
    .filter((p) => {
      const sp = primarySpouse(p.id);
      return !(sp && parentsOf(sp).length > 0);
    })
    .sort((a, b) => birthYear(a) - birthYear(b) || a.id.localeCompare(b.id));

  let rootCursor = 0;
  for (const root of roots) {
    if (visited.has(root.id)) continue;
    subtreeCache.clear();
    const r = layout(root.id, 0);
    shiftSubtree(root.id, rootCursor);
    rootCursor += r.width + H_GAP * 2;
  }

  // Safety net: anyone never placed (e.g. orphaned spouse) gets parked in a row.
  let parkX = 0;
  const parkDepth = (Math.max(0, ...[...depthOf.values()]) || 0) + 1;
  for (const p of people.values()) {
    if (!relX.has(p.id)) {
      relX.set(p.id, parkX);
      depthOf.set(p.id, parkDepth);
      parkX += NODE_W + H_GAP;
    }
  }

  const nodes = [...people.values()].map((p) => ({
    id: p.id,
    x: relX.get(p.id),
    depth: depthOf.get(p.id),
    y: depthOf.get(p.id) * ROW_H,
  }));

  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const bbox = {
    minX: Math.min(0, ...xs),
    minY: Math.min(0, ...ys),
    maxX: Math.max(NODE_W, ...xs.map((x) => x + NODE_W)),
    maxY: Math.max(NODE_H, ...ys.map((y) => y + NODE_H)),
  };

  return { nodes, couples, groups, bbox };
}
