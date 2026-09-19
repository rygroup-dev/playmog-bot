// Port of the official client's v2 static-delta merge (21accs chunk, fn `d`).
export function mergeState(base: any | null, next: any): any {
  const delta = next?.v2StaticDelta;
  if (!delta) return next;
  if (!base) throw new Error("v2 static delta without base state");
  if (base.runId !== next.runId || base.currentFloor !== next.currentFloor)
    throw new Error(`delta base mismatch run ${base.runId}->${next.runId} floor ${base.currentFloor}->${next.currentFloor}`);
  const h = base.mapData.length, w = base.mapData[0]?.length ?? 0;
  if (!h || !w) throw new Error("delta base has empty grids");
  const map = base.mapData.map((r: number[]) => r.slice());
  const tile = base.tileData.map((r: number[]) => r.slice());
  const wall = base.wallTileData.map((r: number[]) => r.slice());
  const rv: number[] = delta.reveals ?? [];
  for (let i = 0; i + 4 < rv.length; i += 5) {
    const x = rv[i], y = rv[i + 1];
    if (y < 0 || y >= h || x < 0 || x >= w) continue;
    map[y][x] = rv[i + 2]; tile[y][x] = rv[i + 3]; wall[y][x] = rv[i + 4];
  }
  let fog: number[][];
  if (delta.visible === null) fog = map.map((r: number[]) => Array(r.length).fill(2));
  else {
    fog = map.map((r: number[]) => r.map((v) => +(v !== 2)));
    const vis: number[] = delta.visible ?? [];
    for (let i = 0; i + 1 < vis.length; i += 2) { const x = vis[i], y = vis[i + 1]; if (y >= 0 && y < h && x >= 0 && x < w) fog[y][x] = 2; }
  }
  return {
    ...next, mapData: map, tileData: tile, wallTileData: wall, fogMask: fog,
    decorationTiles: delta.decorationsIncluded ? next.decorationTiles : base.decorationTiles,
    wallDecorations: delta.decorationsIncluded ? next.wallDecorations : base.wallDecorations,
    v2StaticDelta: undefined,
  };
}
